const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const { spawn } = require('child_process')
const { spawnSync } = require('child_process')
const { pathToFileURL } = require('url')

let mainWindow = null
let tray = null
let installInFlight = false
let statsWriteChain = Promise.resolve()
let statsDashboardCache = null
let statsDashboardDirty = true
let cryptoModule = null
let yauzlModule = null
let isQuitRequested = false
let closeInterceptInFlight = false
let windowIconCache = null
let windowIconPathCache = ''
let versionCatalogCache = null
let launcherConfigCache = null
let settingsCache = null
let javaExecutableCache = null
let installController = null
let launchController = null
let runningClientWatcher = null
let installResumeStateCache = null
let javaInstallInFlight = null
const jsonFileCache = new Map()

const APP_ID = 'com.royale.launcher'
const APP_STORAGE_DIR = 'royale-launcher'
const BUNDLED_VERSION_CATALOG_PATH = path.join(__dirname, 'version-catalog.json')
const BUNDLED_LAUNCHER_CONFIG_PATH = path.join(__dirname, 'launcher-config.json')
const MAX_STATS_EVENTS = 4000
const APP_NETWORK_HEADERS = {
  'User-Agent': 'RoyaleLauncher',
  'Accept': '*/*'
}
const MINECRAFT_VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const FABRIC_PROFILE_BASE_URL = 'https://meta.fabricmc.net/v2/versions/loader'
const ADOPTIUM_API_BASE_URL = 'https://api.adoptium.net/v3/assets/latest'
const RUNTIME_DOWNLOAD_CONCURRENCY = 8

Menu.setApplicationMenu(null)
app.setName('Royale Launcher')
app.setPath('userData', path.join(app.getPath('appData'), APP_STORAGE_DIR))
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-sync')
app.commandLine.appendSwitch('metrics-recording-only')
app.commandLine.appendSwitch('no-default-browser-check')
app.commandLine.appendSwitch('no-first-run')

const shouldBypassSingleInstanceLock = process.argv.some((arg) => String(arg || '').startsWith('--smoke-test='))
const hasSingleInstanceLock = shouldBypassSingleInstanceLock ? true : app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  if (app.isReady()) {
    createWindow()
  }
})

function getCryptoModule() {
  if (!cryptoModule) {
    cryptoModule = require('crypto')
  }

  return cryptoModule
}

function getYauzlModule() {
  if (!yauzlModule) {
    yauzlModule = require('yauzl')
  }

  return yauzlModule
}

function getDefaultInstallFolder() {
  return process.platform === 'win32' ? 'C:\\Royale' : path.join(os.homedir(), 'Royale')
}

const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/

function sanitizeMinecraftPlayerName(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w]/g, '')
    .slice(0, 16)
}

function isValidMinecraftPlayerName(value) {
  return PLAYER_NAME_PATTERN.test(String(value || '').trim())
}

function isTemporarySmokeInstallFolder(folder) {
  const candidate = String(folder || '').trim()
  if (!candidate) {
    return false
  }

  const normalized = path.resolve(candidate).replace(/[\\/]+/g, '\\').toLowerCase()
  const baseName = path.basename(normalized).toLowerCase()
  return baseName.startsWith('royalesmoke') || normalized.includes('\\royale-launcher-smoke') || normalized.includes('\\royalesmoke')
}

const DEFAULT_SETTINGS = {
  installFolder: getDefaultInstallFolder(),
  playerName: '',
  javaArgs: '',
  memoryMb: 4096,
  autoMemoryEnabled: true,
  lastSelectedVersion: '1.21.11',
  hideLauncherOnGameLaunch: true,
  reopenLauncherOnGameExit: true,
  skipCancelConfirm: false,
  skipJavaPromptVersions: []
}

const DEFAULT_LAUNCHER_CONFIG = {
  updateRepo: 'SqwaTik/Royale-Launcher',
  releasePage: 'https://github.com/SqwaTik/Royale-Launcher/releases/latest'
}

function createInstallController() {
  return {
    paused: false,
    cancelled: false,
    waiters: [],
    resumeState: null
  }
}

function createLaunchController() {
  return {
    cancelled: false
  }
}

function resetInstallController() {
  installController = createInstallController()
  return installController
}

function resetLaunchController() {
  launchController = createLaunchController()
  return launchController
}

function getInstallController() {
  if (!installController) {
    return resetInstallController()
  }

  return installController
}

function getLaunchController() {
  if (!launchController) {
    return resetLaunchController()
  }

  return launchController
}

function releaseInstallWaiters() {
  const controller = getInstallController()
  const waiters = controller.waiters.splice(0, controller.waiters.length)
  for (const resolve of waiters) {
    resolve()
  }
}

async function pauseInstallFlow(paused) {
  const controller = getInstallController()
  controller.paused = Boolean(paused)

  if (controller.paused && controller.resumeState) {
    await saveInstallResumeState({
      ...controller.resumeState,
      paused: true,
      updatedAt: new Date().toISOString()
    })
  } else if (!controller.paused && controller.resumeState) {
    await saveInstallResumeState({
      ...controller.resumeState,
      paused: false,
      updatedAt: new Date().toISOString()
    })
  }

  if (!controller.paused) {
    releaseInstallWaiters()
  }

  return controller.paused
}

async function cancelInstallFlow() {
  const controller = getInstallController()
  const persistedResumeState = controller.resumeState || await loadInstallResumeState()
  controller.cancelled = true
  controller.paused = false
  const tempFile = persistedResumeState?.tempFile || ''
  controller.resumeState = null
  releaseInstallWaiters()
  await clearInstallResumeState()
  if (tempFile && fs.existsSync(tempFile)) {
    await fsp.rm(tempFile, { force: true })
  }
}

function cancelLaunchFlow() {
  getLaunchController().cancelled = true
}

function assertInstallNotCancelled() {
  if (getInstallController().cancelled) {
    throw new Error('Установка отменена пользователем.')
  }
}

function assertLaunchNotCancelled() {
  if (getLaunchController().cancelled) {
    throw new Error('Запуск отменён пользователем.')
  }
}

async function waitForInstallResumeIfNeeded() {
  const controller = getInstallController()
  while (controller.paused) {
    await new Promise((resolve) => {
      controller.waiters.push(resolve)
    })
    assertInstallNotCancelled()
  }
}

const DEFAULT_VERSION_CATALOG = [
  {
    versionName: '1.21.11',
    channel: 'Основная сборка',
    title: 'Royale Master',
    source: {
      type: 'github-release-asset',
      owner: 'SqwaTik',
      repo: 'Royale-Launcher-Versions',
      release: 'latest',
      asset: '1.21.11.zip',
      tokenEnv: 'ROYALE_GITHUB_TOKEN'
    },
    javaVersion: 21,
    notes: 'Клиент Royale Master для Minecraft 1.21.11 с отдельной установкой и прямым запуском.'
  },
  {
    versionName: '26.1',
    channel: 'Скоро',
    title: 'Версия готовится',
    source: '',
    javaVersion: 8,
    javaVersion: 8,
    javaVersion: 21,
    javaVersion: 21,
    notes: 'Эта версия появится позже.'
  },
  {
    versionName: '1.21.4',
    channel: 'Скоро',
    title: 'Версия готовится',
    source: '',
    notes: 'Эта версия появится позже.'
  },
  {
    versionName: '1.16.5',
    channel: 'Скоро',
    title: 'Версия готовится',
    source: '',
    notes: 'Эта версия появится позже.'
  },
  {
    versionName: '1.12.2',
    channel: 'Скоро',
    title: 'Версия готовится',
    source: '',
    notes: 'Эта версия появится позже.'
  }
]

const CLIENT_MANIFEST_FILE = 'royale-client.json'
const CLIENT_GAME_DIRS = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots']
const CLIENT_GAME_FILES = ['options.txt', 'optionsof.txt', 'servers.dat']
const SHARED_MINECRAFT_DIRS = ['instances', 'versions', 'libraries', 'assets', 'jre']
const PACKAGED_SHARED_RUNTIME_DIRS = ['versions', 'libraries', 'assets', 'jre']
const SHARED_INSTANCE_LINKS = ['versions', 'libraries']
const SHARED_MINECRAFT_FILES = ['authlib-injection.json', 'launcher_profiles.json']
const MANAGED_RUNTIME_MOD_PATTERNS = [/^royale-.*\.jar$/i, /^fabric-api-.*\.jar$/i]
const INSTALL_SOURCE_EXCLUDES = new Set([
  CLIENT_MANIFEST_FILE,
  'instance.json',
  'versions',
  'libraries',
  'logs',
  'crash-reports',
  'downloads',
  'debug',
  'screenshots',
  'saves',
  'authlib-injector.log',
  'command_history.txt',
  'debug-profile.json',
  'usercache.json'
])
const DEFAULT_CLIENT_MANIFESTS = {
  '1.21.11': {
    type: 'fabric-instance',
    profileName: 'Royale Master 1.21.11',
    minecraftVersion: '1.21.11',
    fabricLoaderVersion: '0.18.4',
    gameDir: '.',
    icon: 'Grass',
    javaVersion: 21
  },
  '26.1': {
    type: 'fabric-instance',
    profileName: 'Royale Master 26.1',
    minecraftVersion: '26.1',
    fabricLoaderVersion: '0.18.5',
    gameDir: '.',
    icon: 'Grass',
    javaVersion: 21
  },
  '1.21.4': {
    type: 'fabric-instance',
    profileName: 'Royale Master 1.21.4',
    minecraftVersion: '1.21.4',
    fabricLoaderVersion: '0.18.5',
    gameDir: '.',
    icon: 'Grass',
    javaVersion: 21
  },
  '1.16.5': {
    type: 'fabric-instance',
    profileName: 'Royale Master 1.16.5',
    minecraftVersion: '1.16.5',
    fabricLoaderVersion: '0.18.4',
    gameDir: '.',
    icon: 'Grass',
    javaVersion: 8
  },
  '1.12.2': {
    type: 'fabric-instance',
    profileName: 'Royale Master 1.12.2',
    minecraftVersion: '1.12.2',
    fabricLoaderVersion: '0.16.10',
    gameDir: '.',
    icon: 'Grass',
    javaVersion: 8
  }
}

const ARCHIVE_SECTION_TITLES = {
  assets: 'assets',
  libraries: 'libraries',
  versions: 'versions',
  mods: 'mods',
  config: 'config',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  files: 'files'
}

function getIconCandidates() {
  const windowsCandidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'dist-renderer', 'launcher-mark.png'),
    path.join(app.getAppPath(), 'public', 'launcher-mark.png'),
    path.join(__dirname, '..', 'dist-renderer', 'launcher-mark.png'),
    path.join(__dirname, '..', 'public', 'launcher-mark.png')
  ]

  const genericCandidates = [
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'dist-renderer', 'launcher-mark.png'),
    path.join(app.getAppPath(), 'public', 'launcher-mark.png'),
    path.join(__dirname, '..', 'dist-renderer', 'launcher-mark.png'),
    path.join(__dirname, '..', 'public', 'launcher-mark.png'),
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico')
  ]

  return process.platform === 'win32'
    ? windowsCandidates
    : genericCandidates
}

function getWindowIconPath() {
  if (windowIconPathCache && fs.existsSync(windowIconPathCache)) {
    return windowIconPathCache
  }

  for (const candidate of getIconCandidates()) {
    if (fs.existsSync(candidate)) {
      windowIconPathCache = candidate
      return windowIconPathCache
    }
  }

  return ''
}

function getWindowIcon() {
  if (windowIconCache && !windowIconCache.isEmpty()) {
    return windowIconCache
  }

  const iconPath = getWindowIconPath()
  if (!iconPath) {
    return undefined
  }

  try {
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) {
      windowIconCache = image
      return windowIconCache
    }
  } catch {}

  for (const candidate of getIconCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue
      const image = nativeImage.createFromPath(candidate)
      if (!image.isEmpty()) {
        windowIconCache = image
        return windowIconCache
      }
    } catch {}
  }

  return undefined
}

function getTrayIconInput() {
  if (process.platform === 'win32') {
    return getWindowIconPath() || getWindowIcon() || nativeImage.createEmpty()
  }

  return getWindowIcon() || nativeImage.createEmpty()
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'launcher-settings.json')
}

function getStatsPath() {
  return path.join(app.getPath('userData'), 'launcher-stats.json')
}

function getInstallResumeStatePath() {
  return path.join(app.getPath('userData'), 'launcher-install-state.json')
}

function getInstallResumeTempFile(versionName, extension = '.zip') {
  const safeExtension = String(extension || '.zip').startsWith('.') ? String(extension || '.zip') : `.${String(extension || 'zip')}`
  return path.join(app.getPath('userData'), 'downloads', `${sanitizeVersionName(versionName)}${safeExtension}.part`)
}

function normalizeInstallResumeState(input) {
  const payload = input && typeof input === 'object' ? input : {}
  const versionName = String(payload.versionName || '').trim()
  const sourceUrl = String(payload.sourceUrl || '').trim()
  const tempFile = String(payload.tempFile || '').trim()
  const stage = String(payload.stage || '').trim()

  if (!versionName || !sourceUrl || !tempFile || !stage) {
    return null
  }

  return {
    versionName,
    sourceUrl,
    tempFile,
    stage,
    paused: Boolean(payload.paused),
    progress: Math.max(0, Math.min(1, Number(payload.progress) || 0)),
    current: Math.max(0, Number(payload.current) || 0),
    total: Math.max(0, Number(payload.total) || 0),
    label: String(payload.label || '').trim(),
    statusMessage: String(payload.statusMessage || '').trim(),
    updatedAt: String(payload.updatedAt || '').trim()
  }
}

async function loadInstallResumeState() {
  if (installResumeStateCache !== null) {
    return installResumeStateCache
  }

  const statePath = getInstallResumeStatePath()

  try {
    const raw = await fsp.readFile(statePath, 'utf8')
    const normalized = normalizeInstallResumeState(JSON.parse(raw))

    if (!normalized || !fs.existsSync(normalized.tempFile)) {
      installResumeStateCache = null
      await fsp.rm(statePath, { force: true })
      return null
    }

    try {
      const stats = await fsp.stat(normalized.tempFile)
      normalized.current = Math.max(normalized.current, Math.max(0, Number(stats.size) || 0))
      normalized.progress = normalized.total > 0
        ? Math.max(0, Math.min(1, normalized.current / normalized.total))
        : normalized.progress
    } catch {}

    installResumeStateCache = normalized
    return installResumeStateCache
  } catch {
    installResumeStateCache = null
    return null
  }
}

async function saveInstallResumeState(nextState) {
  const normalized = normalizeInstallResumeState(nextState)
  const statePath = getInstallResumeStatePath()

  if (!normalized) {
    installResumeStateCache = null
    await fsp.rm(statePath, { force: true })
    return null
  }

  await fsp.mkdir(path.dirname(statePath), { recursive: true })
  await fsp.writeFile(statePath, JSON.stringify(normalized, null, 2), 'utf8')
  installResumeStateCache = normalized
  return installResumeStateCache
}

async function clearInstallResumeState() {
  installResumeStateCache = null
  await fsp.rm(getInstallResumeStatePath(), { force: true })
}

async function getResumableInstallState(versionName, sourceUrl = '') {
  const state = await loadInstallResumeState()
  if (!state) return null
  if (String(state.versionName).toLowerCase() !== String(versionName || '').trim().toLowerCase()) return null
  if (sourceUrl && state.sourceUrl && state.sourceUrl !== sourceUrl) return null
  if (!fs.existsSync(state.tempFile)) {
    await clearInstallResumeState()
    return null
  }

  return state
}

function createGameplayStatsDurations() {
  return {
    menu: 0,
    connecting: 0,
    playing: 0,
    pvp: 0,
    afk: 0,
    pause: 0,
    death: 0
  }
}

function createGameplayStatsSnapshot() {
  return {
    available: false,
    filePath: '',
    firstSeenAt: '',
    firstSeenAtMs: 0,
    updatedAt: '',
    updatedAtMs: 0,
    sessionStartedAt: '',
    sessionStartedAtMs: 0,
    totals: {
      sessions: 0,
      combatEntries: 0,
      runtimeMs: 0,
      playtimeMs: 0,
      activeMs: 0,
      afkMs: 0,
      pvpMs: 0,
      pvpAfkMs: 0
    },
    currentSession: {
      combatEntries: 0,
      runtimeMs: 0,
      playtimeMs: 0,
      activeMs: 0,
      afkMs: 0,
      pvpMs: 0,
      pvpAfkMs: 0
    },
    statusTotals: createGameplayStatsDurations(),
    sessionStatusTotals: createGameplayStatsDurations(),
    runtime: {
      status: '',
      statusLabel: '',
      serverName: '',
      serverAddress: '',
      worldType: '',
      isInWorld: false,
      isInPvp: false,
      isAfk: false
    }
  }
}

function getKnownUserDataDirectories() {
  const appDataRoot = app.getPath('appData')
  return [...new Set([
    app.getPath('userData'),
    path.join(appDataRoot, APP_STORAGE_DIR),
    path.join(appDataRoot, 'Royale Launcher'),
    path.join(appDataRoot, 'royale-launcher-electron')
  ])]
}

function getLegacyUserDataDirectories() {
  return getKnownUserDataDirectories()
    .filter((dirPath) => path.resolve(dirPath) !== path.resolve(app.getPath('userData')))
}

async function findLatestLegacyFile(fileName) {
  const candidates = []

  for (const dirPath of getLegacyUserDataDirectories()) {
    const candidatePath = path.join(dirPath, fileName)
    try {
      const stats = await fsp.stat(candidatePath)
      if (stats.isFile()) {
        candidates.push({
          filePath: candidatePath,
          mtimeMs: stats.mtimeMs
        })
      }
    } catch {}
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.filePath || ''
}

async function migrateLegacyUserData() {
  const targetDir = app.getPath('userData')
  await fsp.mkdir(targetDir, { recursive: true })

  for (const fileName of ['launcher-settings.json', 'launcher-stats.json', 'running-client.json', 'launcher-install-state.json']) {
    const targetPath = path.join(targetDir, fileName)
    try {
      await fsp.access(targetPath)
      continue
    } catch {}

    const sourcePath = await findLatestLegacyFile(fileName)
    if (!sourcePath) continue

    try {
      await fsp.copyFile(sourcePath, targetPath)
    } catch {}
  }
}

async function cleanupLegacyInstallDirectory() {
  if (process.platform !== 'win32') {
    return
  }

  const localAppData = process.env.LOCALAPPDATA || path.resolve(app.getPath('appData'), '..', 'Local')
  const legacyProgramDir = path.join(localAppData, 'Programs', 'royale-launcher-electron')
  const currentExecPath = path.resolve(process.execPath || '')
  if (!legacyProgramDir || currentExecPath.startsWith(path.resolve(legacyProgramDir))) {
    return
  }

  try {
    await fsp.rm(legacyProgramDir, { recursive: true, force: true })
  } catch {}
}

function getRunningClientPath() {
  return path.join(app.getPath('userData'), 'running-client.json')
}

function getRunningClientPaths() {
  return getKnownUserDataDirectories().map((dirPath) => path.join(dirPath, 'running-client.json'))
}

function getVersionCatalogPath() {
  if (app.isPackaged) {
    return path.join(path.dirname(process.execPath), 'version-catalog.json')
  }

  return BUNDLED_VERSION_CATALOG_PATH
}

function getLauncherConfigPath() {
  if (app.isPackaged) {
    return path.join(path.dirname(process.execPath), 'launcher-config.json')
  }

  return BUNDLED_LAUNCHER_CONFIG_PATH
}

async function ensureVersionCatalog() {
  const catalogPath = getVersionCatalogPath()
  try {
    await fsp.access(catalogPath)
  } catch {
    await fsp.writeFile(catalogPath, JSON.stringify(DEFAULT_VERSION_CATALOG, null, 2), 'utf8')
  }
}

async function ensureLauncherConfig() {
  const launcherConfigPath = getLauncherConfigPath()
  try {
    await fsp.access(launcherConfigPath)
  } catch {
    await fsp.writeFile(launcherConfigPath, JSON.stringify(DEFAULT_LAUNCHER_CONFIG, null, 2), 'utf8')
  }
}

async function ensureSettings() {
  const settingsPath = getSettingsPath()
  try {
    await fsp.access(settingsPath)
  } catch {
    await saveSettings(DEFAULT_SETTINGS)
  }
}

function normalizeRunningClientState(input) {
  const payload = input && typeof input === 'object' ? input : {}
  return {
    versionName: String(payload.versionName || '').trim(),
    installDir: String(payload.installDir || '').trim(),
    pid: Math.max(0, Number(payload.pid) || 0),
    startedAt: String(payload.startedAt || '').trim()
  }
}

async function loadRunningClientState() {
  const states = []

  for (const filePath of getRunningClientPaths()) {
    try {
      const raw = await fsp.readFile(filePath, 'utf8')
      const normalized = normalizeRunningClientState(JSON.parse(raw))
      if (normalized.versionName && normalized.pid) {
        states.push(normalized)
      }
    } catch {}
  }

  if (states.length === 0) {
    return null
  }

  states.sort((left, right) => Date.parse(right.startedAt || 0) - Date.parse(left.startedAt || 0))
  return states[0]
}

async function saveRunningClientState(payload) {
  const normalized = normalizeRunningClientState(payload)
  if (!normalized.versionName || !normalized.pid) {
    return null
  }

  await Promise.allSettled(getRunningClientPaths().map(async (filePath) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8')
  }))
  return normalized
}

async function clearRunningClientState(expectedPid = 0) {
  await Promise.allSettled(getRunningClientPaths().map(async (filePath) => {
    if (expectedPid > 0) {
      try {
        const raw = await fsp.readFile(filePath, 'utf8')
        const current = normalizeRunningClientState(JSON.parse(raw))
        if (current.pid && current.pid !== expectedPid) {
          return
        }
      } catch {}
    }

    await fsp.rm(filePath, { force: true })
  }))
}

function isPidAlive(pid) {
  const targetPid = Math.max(0, Number(pid) || 0)
  if (!targetPid) {
    return false
  }

  try {
    process.kill(targetPid, 0)
    return true
  } catch {
    return false
  }
}

async function getActiveRunningClientState() {
  const state = await loadRunningClientState()
  if (!state) {
    return null
  }

  if (!isPidAlive(state.pid)) {
    await clearRunningClientState()
    return null
  }

  return state
}

function normalizeStatsStorage(input) {
  const payload = input && typeof input === 'object' ? input : {}
  const events = Array.isArray(payload.events) ? payload.events : []

  return {
    events: events
      .map((entry) => ({
        id: String(entry?.id || '').trim(),
        type: String(entry?.type || '').trim(),
        at: String(entry?.at || '').trim(),
        versionName: String(entry?.versionName || '').trim(),
        message: String(entry?.message || '').trim()
      }))
      .filter((entry) => entry.id && entry.type && entry.at)
      .slice(-MAX_STATS_EVENTS)
  }
}

async function ensureStatsFile() {
  const statsPath = getStatsPath()
  try {
    await fsp.access(statsPath)
  } catch {
    await fsp.mkdir(path.dirname(statsPath), { recursive: true })
    await fsp.writeFile(statsPath, JSON.stringify({ events: [] }, null, 2), 'utf8')
  }
}

async function loadStatsStorage() {
  await ensureStatsFile()
  const raw = await fsp.readFile(getStatsPath(), 'utf8')
  return normalizeStatsStorage(JSON.parse(raw))
}

async function saveStatsStorage(payload) {
  const normalized = normalizeStatsStorage(payload)
  await fsp.mkdir(path.dirname(getStatsPath()), { recursive: true })
  await fsp.writeFile(getStatsPath(), JSON.stringify(normalized, null, 2), 'utf8')
  statsDashboardCache = null
  statsDashboardDirty = true
  return normalized
}

function queueStatsWrite(task) {
  statsWriteChain = statsWriteChain
    .then(task)
    .catch(() => task())

  return statsWriteChain
}

function sanitizeStatsMessage(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

async function recordLauncherEvent(type, payload = {}) {
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: String(type || '').trim(),
    at: new Date().toISOString(),
    versionName: String(payload.versionName || '').trim(),
    message: sanitizeStatsMessage(payload.message)
  }

  if (!entry.type) {
    return null
  }

  return queueStatsWrite(async () => {
    const current = await loadStatsStorage()
    current.events.push(entry)
    if (current.events.length > MAX_STATS_EVENTS) {
      current.events = current.events.slice(-MAX_STATS_EVENTS)
    }
    await saveStatsStorage(current)
    return entry
  })
}

function getLocalDateParts(value) {
  const date = value instanceof Date ? value : new Date(value)
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hour: date.getHours()
  }
}

function toDayKey(value) {
  const parts = getLocalDateParts(value)
  const month = String(parts.month + 1).padStart(2, '0')
  const day = String(parts.day).padStart(2, '0')
  return `${parts.year}-${month}-${day}`
}

function getStartOfToday() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function getStartOfMonth() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function formatCompactDayLabel(value) {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit'
  }).format(date)
}

function formatRecentDateLabel(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function getStatsEventLabel(type) {
  if (type === 'session_start') return 'Открытие лаунчера'
  if (type === 'launch_success') return 'Успешный запуск'
  if (type === 'launch_failure') return 'Ошибка запуска'
  if (type === 'install_success') return 'Установка завершена'
  if (type === 'install_failure') return 'Ошибка установки'
  return 'Событие'
}

async function getStatsDashboard(versionName = '') {
  if (!statsDashboardDirty && statsDashboardCache) {
    if (!versionName) {
      return statsDashboardCache
    }

    const settings = await loadSettings()
    const selectedVersion = settings.versions.find((entry) => entry.versionName === versionName)?.versionName || settings.lastSelectedVersion
    const runningClient = await getActiveRunningClientState()
    const gameplay = await readGameplayStats(selectedVersion, resolveVersionDirectory(settings, selectedVersion))
    return {
      ...statsDashboardCache,
      gameplay: runningClient && runningClient.versionName.toLowerCase() === selectedVersion.toLowerCase()
        ? gameplay
        : markGameplayStatsInactive(gameplay),
      selectedVersion
    }
  }

  const settings = await loadSettings()
  const selectedVersion = settings.versions.find((entry) => entry.versionName === versionName)?.versionName || settings.lastSelectedVersion

  const [storage, catalog, gameplay, runningClient] = await Promise.all([
    loadStatsStorage(),
    loadVersionCatalog(),
    readGameplayStats(selectedVersion, resolveVersionDirectory(settings, selectedVersion)),
    getActiveRunningClientState()
  ])

  const events = storage.events
    .map((entry) => ({
      ...entry,
      timestamp: new Date(entry.at).getTime()
    }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)

  const now = Date.now()
  const startOfToday = getStartOfToday()
  const startOfMonth = getStartOfMonth()
  const versionMeta = new Map(catalog.map((entry) => [entry.versionName, entry]))

  const totals = { launches: 0, installs: 0, failures: 0, sessions: 0 }
  const todayTotals = { launches: 0, installs: 0, failures: 0, sessions: 0 }
  const monthTotals = { launches: 0, installs: 0, failures: 0, sessions: 0 }

  const timelineMap = new Map()
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - index)
    timelineMap.set(toDayKey(date), {
      dateKey: toDayKey(date),
      label: formatCompactDayLabel(date),
      launches: 0,
      installs: 0,
      failures: 0,
      sessions: 0
    })
  }

  const versions = new Map()
  for (const entry of events) {
    const versionName = entry.versionName
    const meta = versionMeta.get(versionName)
    const dayKey = toDayKey(entry.at)
    const timelineEntry = timelineMap.get(dayKey)
    const isLaunch = entry.type === 'launch_success'
    const isInstall = entry.type === 'install_success'
    const isSession = entry.type === 'session_start'
    const isFailure = entry.type.endsWith('_failure')

    if (isLaunch) totals.launches += 1
    if (isInstall) totals.installs += 1
    if (isSession) totals.sessions += 1
    if (isFailure) totals.failures += 1

    if (entry.timestamp >= startOfMonth) {
      if (isLaunch) monthTotals.launches += 1
      if (isInstall) monthTotals.installs += 1
      if (isSession) monthTotals.sessions += 1
      if (isFailure) monthTotals.failures += 1
    }

    if (entry.timestamp >= startOfToday) {
      if (isLaunch) todayTotals.launches += 1
      if (isInstall) todayTotals.installs += 1
      if (isSession) todayTotals.sessions += 1
      if (isFailure) todayTotals.failures += 1
    }

    if (timelineEntry) {
      if (isLaunch) timelineEntry.launches += 1
      if (isInstall) timelineEntry.installs += 1
      if (isSession) timelineEntry.sessions += 1
      if (isFailure) timelineEntry.failures += 1
    }

    if (versionName) {
      const current = versions.get(versionName) || {
        versionName,
        title: meta?.title || versionName,
        channel: meta?.channel || '',
        launches: 0,
        installs: 0,
        failures: 0,
        lastLaunchAt: ''
      }

      if (isLaunch) {
        current.launches += 1
        current.lastLaunchAt = entry.at
      }
      if (isInstall) {
        current.installs += 1
      }
      if (isFailure) {
        current.failures += 1
      }

      versions.set(versionName, current)
    }
  }

  const timeline = [...timelineMap.values()]
  const versionRows = [...versions.values()]
    .sort((left, right) => {
      if (right.launches !== left.launches) return right.launches - left.launches
      if (right.installs !== left.installs) return right.installs - left.installs
      return left.versionName.localeCompare(right.versionName)
    })
    .map((entry) => ({
      ...entry,
      total: entry.launches + entry.installs + entry.failures
    }))

  const peakLaunchDay = timeline.reduce((best, entry) => (entry.launches > (best?.launches || 0) ? entry : best), null)
  const favoriteVersion = versionRows[0] || null
  const activeDays = timeline.filter((entry) => entry.launches || entry.installs || entry.failures || entry.sessions).length
  const lastLaunch = [...events].reverse().find((entry) => entry.type === 'launch_success')
  const firstSeen = events[0] || null

  statsDashboardCache = {
    generatedAt: new Date(now).toISOString(),
    totals,
    periods: {
      today: todayTotals,
      month: monthTotals,
      allTime: totals
    },
    highlights: {
      activeDays,
      favoriteVersion: favoriteVersion ? {
        versionName: favoriteVersion.versionName,
        title: favoriteVersion.title,
        launches: favoriteVersion.launches
      } : null,
      peakLaunchDay: peakLaunchDay ? {
        label: peakLaunchDay.label,
        launches: peakLaunchDay.launches
      } : null,
      lastLaunchAt: lastLaunch?.at || '',
      firstSeenAt: firstSeen?.at || ''
    },
    timeline
  }

  statsDashboardDirty = false
  return {
    ...statsDashboardCache,
    gameplay: runningClient && runningClient.versionName.toLowerCase() === selectedVersion.toLowerCase()
      ? gameplay
      : markGameplayStatsInactive(gameplay),
    selectedVersion
  }
}

function sanitizeVersionName(value) {
  const cleaned = String(value ?? '').trim().replace(/,/g, '.')
  return cleaned.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'default'
}

function normalizeSourceDefinition(input) {
  if (typeof input === 'string') {
    return String(input || '').trim()
  }

  if (!input || typeof input !== 'object') {
    return ''
  }

  const payload = input
  const type = String(payload.type || payload.kind || '').trim().toLowerCase()

  if (type === 'github-release-asset' || type === 'github_asset' || type === 'github-release') {
    const owner = String(payload.owner || '').trim()
    const repo = String(payload.repo || '').trim()
    const asset = String(payload.asset || payload.assetName || '').trim()
    if (!owner || !repo || !asset) {
      return ''
    }

    return {
      type: 'github-release-asset',
      owner,
      repo,
      release: String(payload.release || payload.tag || 'latest').trim() || 'latest',
      asset,
      tokenEnv: String(payload.tokenEnv || payload.authEnv || '').trim()
    }
  }

  if (typeof payload.url === 'string' || typeof payload.path === 'string') {
    return String(payload.url || payload.path || '').trim()
  }

  return ''
}

function normalizeManagedModDefinitions(input) {
  const items = Array.isArray(input) ? input : []

  return items
    .map((item) => {
      const fileName = path.basename(String(item?.fileName || item?.name || item?.asset || '').trim())
      const source = normalizeSourceDefinition(item?.source ?? item?.url ?? '')
      if (!fileName || !source) {
        return null
      }

      return {
        fileName,
        source
      }
    })
    .filter(Boolean)
}

function normalizeCatalog(input) {
  const items = Array.isArray(input) ? input : DEFAULT_VERSION_CATALOG

  const normalized = items
    .map((item) => ({
      versionName: sanitizeVersionName(item?.versionName),
      channel: String(item?.channel ?? '').trim() || 'Каталог',
      title: String(item?.title ?? '').trim() || 'Royale Build',
      source: normalizeSourceDefinition(item?.source),
      notes: String(item?.notes ?? '').trim(),
      javaVersion: Math.max(0, Number(item?.javaVersion) || 0)
    }))
    .filter((item) => item.versionName)
    .filter((item, index, list) => list.findIndex((entry) => entry.versionName.toLowerCase() === item.versionName.toLowerCase()) === index)

  return normalized.length ? normalized : DEFAULT_VERSION_CATALOG
}

function normalizeSettings(input) {
  const payload = input && typeof input === 'object' ? input : {}
  const requestedInstallFolder = String(payload.installFolder || DEFAULT_SETTINGS.installFolder).trim() || DEFAULT_SETTINGS.installFolder
  const skipJavaPromptVersions = Array.isArray(payload.skipJavaPromptVersions)
    ? payload.skipJavaPromptVersions
      .map((item) => Math.max(0, Number(item) || 0))
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
    : DEFAULT_SETTINGS.skipJavaPromptVersions

  return {
    installFolder: isTemporarySmokeInstallFolder(requestedInstallFolder) ? DEFAULT_SETTINGS.installFolder : requestedInstallFolder,
    playerName: sanitizeMinecraftPlayerName(payload.playerName || ''),
    javaArgs: String(payload.javaArgs ?? payload.launchCommand ?? '').trim(),
    memoryMb: Math.max(1024, Number(payload.memoryMb) || DEFAULT_SETTINGS.memoryMb),
    autoMemoryEnabled: payload.autoMemoryEnabled !== false,
    lastSelectedVersion: String(payload.lastSelectedVersion || DEFAULT_SETTINGS.lastSelectedVersion).trim() || DEFAULT_SETTINGS.lastSelectedVersion,
    hideLauncherOnGameLaunch: payload.hideLauncherOnGameLaunch !== false,
    reopenLauncherOnGameExit: payload.reopenLauncherOnGameExit !== false,
    skipCancelConfirm: payload.skipCancelConfirm === true,
    skipJavaPromptVersions
  }
}

function normalizeLauncherConfig(input) {
  const payload = input && typeof input === 'object' ? input : {}

  return {
    updateRepo: String(payload.updateRepo || '').trim(),
    releasePage: String(payload.releasePage || '').trim()
  }
}

function mergeSettingsWithCatalog(settings, catalog) {
  const nextSettings = { ...settings, versions: catalog }

  if (!catalog.some((entry) => entry.versionName.toLowerCase() === nextSettings.lastSelectedVersion.toLowerCase())) {
    nextSettings.lastSelectedVersion = catalog[0]?.versionName || DEFAULT_SETTINGS.lastSelectedVersion
  }

  return nextSettings
}

async function loadVersionCatalog() {
  if (versionCatalogCache) {
    return versionCatalogCache
  }

  await ensureVersionCatalog()
  const raw = await fsp.readFile(getVersionCatalogPath(), 'utf8')
  versionCatalogCache = normalizeCatalog(JSON.parse(raw))
  return versionCatalogCache
}

async function loadLauncherConfig() {
  if (launcherConfigCache) {
    return launcherConfigCache
  }

  await ensureLauncherConfig()
  const raw = await fsp.readFile(getLauncherConfigPath(), 'utf8')
  launcherConfigCache = normalizeLauncherConfig(JSON.parse(raw))
  return launcherConfigCache
}

async function loadSettings() {
  if (settingsCache) {
    return settingsCache
  }

  await ensureVersionCatalog()
  await ensureSettings()
  const [rawSettings, catalog] = await Promise.all([
    fsp.readFile(getSettingsPath(), 'utf8'),
    loadVersionCatalog()
  ])

  const parsedSettings = JSON.parse(rawSettings)
  settingsCache = mergeSettingsWithCatalog(normalizeSettings(parsedSettings), catalog)
  if (isTemporarySmokeInstallFolder(parsedSettings?.installFolder)) {
    await saveSettings(settingsCache)
  }
  return settingsCache
}

async function saveSettings(nextSettings) {
  await ensureVersionCatalog()
  const catalog = await loadVersionCatalog()
  const normalized = mergeSettingsWithCatalog(normalizeSettings(nextSettings), catalog)
  const payload = {
    installFolder: normalized.installFolder,
    playerName: normalized.playerName,
    javaArgs: normalized.javaArgs,
    memoryMb: normalized.memoryMb,
    autoMemoryEnabled: normalized.autoMemoryEnabled,
    lastSelectedVersion: normalized.lastSelectedVersion,
    hideLauncherOnGameLaunch: normalized.hideLauncherOnGameLaunch,
    reopenLauncherOnGameExit: normalized.reopenLauncherOnGameExit,
    skipCancelConfirm: normalized.skipCancelConfirm
  }

  await fsp.mkdir(path.dirname(getSettingsPath()), { recursive: true })
  await fsp.writeFile(getSettingsPath(), JSON.stringify(payload, null, 2), 'utf8')
  settingsCache = normalized
  return settingsCache
}

function resolveInstallRoot(settings) {
  return path.resolve(String(settings?.installFolder || getDefaultInstallFolder()).trim() || getDefaultInstallFolder())
}

function resolveSharedDirectory(settings, dirName) {
  return path.join(resolveInstallRoot(settings), dirName)
}

function resolveInstancesDirectory(settings) {
  return resolveSharedDirectory(settings, 'instances')
}

function resolveVersionDirectory(settings, versionName) {
  return path.join(resolveInstancesDirectory(settings), sanitizeVersionName(versionName))
}

function getDefaultClientManifest(versionName) {
  const payload = DEFAULT_CLIENT_MANIFESTS[String(versionName || '').trim()]
  return payload ? { ...payload } : null
}

function getClientManifestPath(installDir) {
  return path.join(installDir, CLIENT_MANIFEST_FILE)
}

function getMinecraftHome() {
  return path.join(app.getPath('appData'), '.minecraft')
}

function getSharedFabricVersionDirectoryName(manifest) {
  const minecraftVersion = String(manifest?.minecraftVersion || '').trim()
  const fabricLoaderVersion = String(manifest?.fabricLoaderVersion || '').trim()
  if (!minecraftVersion || !fabricLoaderVersion) {
    return ''
  }

  return `${minecraftVersion}-fabric${fabricLoaderVersion}`
}

function getSharedVersionDirectoryNames(manifest) {
  return [String(manifest?.minecraftVersion || '').trim(), getSharedFabricVersionDirectoryName(manifest)].filter(Boolean)
}

function getManagedFabricProfilePath(settings, manifest) {
  const sharedVersionName = getSharedFabricVersionDirectoryName(manifest)
  if (!sharedVersionName) {
    return ''
  }

  return resolveSharedDirectory(settings, path.join('versions', sharedVersionName, `${sharedVersionName}.json`))
}

function isManagedRuntimeModFile(fileName) {
  return MANAGED_RUNTIME_MOD_PATTERNS.some((pattern) => pattern.test(String(fileName || '')))
}

function resolveManagedRuntimeRoot(gameDir) {
  return path.join(gameDir, 'royale-runtime')
}

function resolveManagedRuntimeModsDir(gameDir) {
  return path.join(resolveManagedRuntimeRoot(gameDir), 'mods')
}

function listManagedRuntimeModFiles(gameDir) {
  const modsDir = resolveManagedRuntimeModsDir(gameDir)
  if (!modsDir || !fs.existsSync(modsDir)) {
    return []
  }

  try {
    return fs.readdirSync(modsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isManagedRuntimeModFile(entry.name))
      .map((entry) => path.join(modsDir, entry.name))
  } catch {
    return []
  }
}

function getLegacyManagedRuntimeRoots(gameDir) {
  return [
    path.join(gameDir, '.royale-runtime')
  ].filter((candidate) => path.resolve(candidate) !== path.resolve(resolveManagedRuntimeRoot(gameDir)))
}

function markPathHiddenOnWindows(targetPath) {
  if (process.platform !== 'win32' || !targetPath || !fs.existsSync(targetPath)) {
    return
  }

  try {
    spawnSync('attrib.exe', ['+h', targetPath], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {}
}

function unmarkPathHiddenOnWindows(targetPath) {
  if (process.platform !== 'win32' || !targetPath || !fs.existsSync(targetPath)) {
    return
  }

  try {
    spawnSync('attrib.exe', ['-h', targetPath], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {}
}

async function normalizeManagedRuntimeVisibility(gameDir) {
  const runtimeRoot = resolveManagedRuntimeRoot(gameDir)
  const modsDir = resolveManagedRuntimeModsDir(gameDir)
  if (!runtimeRoot || !fs.existsSync(runtimeRoot)) {
    return []
  }

  await fsp.mkdir(modsDir, { recursive: true })

  unmarkPathHiddenOnWindows(runtimeRoot)
  unmarkPathHiddenOnWindows(modsDir)

  const managedModFiles = listManagedRuntimeModFiles(gameDir)
  for (const modFile of managedModFiles) {
    unmarkPathHiddenOnWindows(modFile)
  }

  markPathHiddenOnWindows(runtimeRoot)
  markPathHiddenOnWindows(modsDir)

  return managedModFiles
}

function normalizeRelativeGamePath(value) {
  const normalized = String(value ?? '.').trim().replace(/[\\/]+/g, path.sep)
  if (!normalized || normalized === '.') {
    return '.'
  }

  const segments = normalized
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment !== '.')
    .filter((segment) => segment !== '..')

  return segments.join(path.sep) || '.'
}

function normalizeClientManifest(input, versionName) {
  const fallback = getDefaultClientManifest(versionName)
  const payload = input && typeof input === 'object' ? input : {}
  const type = String(payload.type || fallback?.type || '').trim()
  const minecraftVersion = String(payload.minecraftVersion || fallback?.minecraftVersion || versionName || '').trim()
  const fabricLoaderVersion = String(payload.fabricLoaderVersion || fallback?.fabricLoaderVersion || '').trim()
  const javaVersion = Math.max(0, Number(payload.javaVersion || fallback?.javaVersion) || 0)

  if (type !== 'fabric-instance' || !minecraftVersion || !fabricLoaderVersion) {
    return fallback
  }

  const requestedProfileName = String(payload.profileName || fallback?.profileName || `Royale Master ${minecraftVersion || versionName}`).trim()
  const profileName = !requestedProfileName || /^royale master$/i.test(requestedProfileName)
    ? `Royale Master ${minecraftVersion || versionName}`
    : requestedProfileName

  return {
    type,
    profileName,
    minecraftVersion,
    fabricLoaderVersion,
    javaVersion,
    gameDir: normalizeRelativeGamePath(payload.gameDir ?? fallback?.gameDir ?? '.'),
    icon: String(payload.icon || fallback?.icon || '').trim(),
    managedMods: normalizeManagedModDefinitions(payload.managedMods ?? fallback?.managedMods)
  }
}

async function loadClientManifest(installDir, versionName) {
  const manifestPath = getClientManifestPath(installDir)

  try {
    const raw = await fsp.readFile(manifestPath, 'utf8')
    return normalizeClientManifest(JSON.parse(raw), versionName)
  } catch {
    return getDefaultClientManifest(versionName)
  }
}

function getManifestManagedMods(manifest) {
  return normalizeManagedModDefinitions(manifest?.managedMods)
}

async function ensureManagedModsFromManifest(manifest, gameDir, options = {}) {
  const entries = getManifestManagedMods(manifest)
  if (entries.length === 0) {
    return normalizeManagedRuntimeVisibility(gameDir)
  }

  const installStage = options.stage === 'install'
  const downloadMissing = options.downloadMissing !== false
  const reportProgress = (label, progressPayload = {}) => {
    const message = String(label || '').trim()
    if (!message) {
      return
    }

    if (installStage) {
      setInstallStatus(message)
      setInstallProgress({
        stage: 'prepare',
        label: message,
        progress: Math.max(0, Math.min(1, Number(progressPayload.progress) || 0)),
        current: Math.max(0, Number(progressPayload.current) || 0),
        total: Math.max(0, Number(progressPayload.total) || 0)
      })
      return
    }

    setLaunchStatus(message)
  }
  const beforeRead = installStage
    ? async () => {
      await waitForInstallResumeIfNeeded()
      assertInstallNotCancelled()
    }
    : async () => {
      assertLaunchNotCancelled()
    }

  const managedModsDir = resolveManagedRuntimeModsDir(gameDir)
  const managedRuntimeRoot = resolveManagedRuntimeRoot(gameDir)
  await fsp.mkdir(managedModsDir, { recursive: true })
  unmarkPathHiddenOnWindows(managedRuntimeRoot)
  unmarkPathHiddenOnWindows(managedModsDir)

  const resolvedFiles = []
  let completed = 0
  for (const entry of entries) {
    const targetPath = path.join(managedModsDir, entry.fileName)
    if (!fs.existsSync(targetPath)) {
      if (!downloadMissing) {
        throw new Error(`Не найден managed-мод ${entry.fileName}. Переустановите клиент и попробуйте снова.`)
      }

      const source = resolveSourceDescriptor(entry.source)
      if (source.kind === 'none') {
        throw new Error(`Для managed-мода ${entry.fileName} не настроен источник.`)
      }

      if (source.kind === 'local') {
        if (!source.exists) {
          throw new Error(`Не найден локальный managed-мод: ${source.value}`)
        }
        await fsp.copyFile(source.value, targetPath)
      } else {
        const request = await resolveSourceDownloadRequest(source)
        await downloadRemoteFile(request.url, targetPath, {
          requestOptions: request.requestOptions,
          beforeRead
        })
      }
    }

    completed += 1
    reportProgress(`Подготавливаю managed-моды ${completed}/${entries.length}`, {
      current: completed,
      total: entries.length,
      progress: entries.length > 0 ? completed / entries.length : 1
    })
    resolvedFiles.push(targetPath)
  }

  await normalizeManagedRuntimeVisibility(gameDir)
  return resolvedFiles
}

async function ensureSharedMinecraftLayout(settings) {
  await fsp.mkdir(resolveInstallRoot(settings), { recursive: true })
  await Promise.all(SHARED_MINECRAFT_DIRS.map((name) => fsp.mkdir(resolveSharedDirectory(settings, name), { recursive: true })))
}

async function seedDirectoryIfMissing(sourceDir, targetDir) {
  if (!sourceDir || !targetDir) return
  if (!fs.existsSync(sourceDir)) return
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return

  const targetHasFiles = await directoryHasFiles(targetDir)
  if (targetHasFiles) return

  await fsp.mkdir(path.dirname(targetDir), { recursive: true })
  await fsp.cp(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false })
}

async function seedFileIfMissing(sourceFile, targetFile) {
  if (!sourceFile || !targetFile) return
  if (!fs.existsSync(sourceFile)) return
  if (fs.existsSync(targetFile)) return
  if (path.resolve(sourceFile) === path.resolve(targetFile)) return

  await fsp.mkdir(path.dirname(targetFile), { recursive: true })
  await fsp.copyFile(sourceFile, targetFile)
}

async function moveFileReplacing(sourcePath, destinationPath) {
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    return
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
  await fsp.rm(destinationPath, { recursive: true, force: true })

  try {
    await fsp.rename(sourcePath, destinationPath)
  } catch {
    await fsp.cp(sourcePath, destinationPath, { recursive: true, force: true })
    await fsp.rm(sourcePath, { recursive: true, force: true })
  }
}

async function copyDirectorySourceToInstallDir(sourceDir, installDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })

  setInstallStatus(`Копирование локальной сборки ${path.basename(sourceDir)}`)
  setInstallProgress({
    stage: 'copy',
    progress: 0,
    current: 0,
    total: entries.length || 1
  })

  let current = 0
  for (const entry of entries) {
    if (INSTALL_SOURCE_EXCLUDES.has(entry.name)) {
      current += 1
      setInstallProgress({
        stage: 'copy',
        progress: entries.length > 0 ? current / entries.length : 1,
        current,
        total: entries.length || 1
      })
      continue
    }

    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(installDir, entry.name)
    await fsp.cp(sourcePath, destinationPath, { recursive: true, force: true })

    current += 1
    setInstallProgress({
      stage: 'copy',
      progress: entries.length > 0 ? current / entries.length : 1,
      current,
      total: entries.length || 1
    })
  }
}

async function absorbManagedInstanceDirectory(installDir, settings, dirName) {
  const sourceDir = path.join(installDir, dirName)
  if (!fs.existsSync(sourceDir)) {
    return
  }

  const targetDir = resolveSharedDirectory(settings, dirName)
  await fsp.mkdir(targetDir, { recursive: true })

  try {
    const stats = await fsp.lstat(sourceDir)
    if (stats.isSymbolicLink()) {
      await fsp.rm(sourceDir, { recursive: true, force: true })
      return
    }
  } catch {}

  await fsp.cp(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false })
  await fsp.rm(sourceDir, { recursive: true, force: true })
}

async function absorbManagedRootFile(installDir, settings, fileName) {
  const sourceFile = path.join(installDir, fileName)
  const targetFile = path.join(resolveInstallRoot(settings), fileName)
  if (!fs.existsSync(sourceFile)) {
    return
  }

  await seedFileIfMissing(sourceFile, targetFile)
  await fsp.rm(sourceFile, { force: true })
}

async function ensureInstanceLink(installDir, settings, dirName) {
  const linkPath = path.join(installDir, dirName)
  const targetDir = resolveSharedDirectory(settings, dirName)

  await fsp.mkdir(targetDir, { recursive: true })

  try {
    const resolvedLinkPath = await fsp.realpath(linkPath)
    if (path.resolve(resolvedLinkPath) === path.resolve(targetDir)) {
      return
    }
  } catch {}

  await fsp.rm(linkPath, { recursive: true, force: true })
  await fsp.symlink(targetDir, linkPath, 'junction')
}

async function writeInstanceDescriptor(installDir, versionName, manifest) {
  const now = Date.now()
  const payload = {
    name: sanitizeVersionName(versionName),
    author: 'Royale Launcher',
    description: '',
    version: '',
    runtime: {
      minecraft: String(manifest?.minecraftVersion || versionName || '').trim(),
      forge: '',
      neoForged: '',
      fabricLoader: String(manifest?.fabricLoaderVersion || '').trim(),
      quiltLoader: '',
      optifine: '',
      labyMod: ''
    },
    java: '',
    url: '',
    icon: '',
    fileApi: '',
    server: null,
    lastAccessDate: now,
    lastPlayedDate: 0,
    playtime: 0,
    creationDate: now,
    path: installDir
  }

  await fsp.writeFile(path.join(installDir, 'instance.json'), JSON.stringify(payload, null, 2), 'utf8')
}

function resolveClientGameDir(installDir, manifest) {
  const relativeGameDir = normalizeRelativeGamePath(manifest?.gameDir ?? '.')
  const gameDir = path.resolve(installDir, relativeGameDir)
  const resolvedRoot = path.resolve(installDir) + path.sep

  if (gameDir !== path.resolve(installDir) && !gameDir.startsWith(resolvedRoot)) {
    throw new Error('Папка клиента вышла за пределы версии')
  }

  return gameDir
}

async function removeManagedRuntimeModJars(targetModsDir) {
  try {
    const entries = await fsp.readdir(targetModsDir, { withFileTypes: true })
    await Promise.all(entries
      .filter((entry) => entry.isFile() && isManagedRuntimeModFile(entry.name))
      .map((entry) => fsp.rm(path.join(targetModsDir, entry.name), { force: true })))
  } catch {}
}

async function migrateLegacyManagedRuntime(gameDir) {
  const targetRoot = resolveManagedRuntimeRoot(gameDir)

  for (const legacyRoot of getLegacyManagedRuntimeRoots(gameDir)) {
    if (!fs.existsSync(legacyRoot)) {
      continue
    }

    await fsp.mkdir(targetRoot, { recursive: true })
    await fsp.cp(legacyRoot, targetRoot, { recursive: true, force: true })
    await fsp.rm(legacyRoot, { recursive: true, force: true })
  }

  if (fs.existsSync(targetRoot)) {
    await normalizeManagedRuntimeVisibility(gameDir)
  }
}

async function moveManagedRuntimeMods(gameDir) {
  const sourceModsDir = path.join(gameDir, 'mods')
  if (!fs.existsSync(sourceModsDir)) {
    return
  }

  const managedRuntimeRoot = resolveManagedRuntimeRoot(gameDir)
  const targetModsDir = resolveManagedRuntimeModsDir(gameDir)
  const entries = await fsp.readdir(sourceModsDir, { withFileTypes: true })
  const managedEntries = entries.filter((entry) => entry.isFile() && isManagedRuntimeModFile(entry.name))

  if (managedEntries.length === 0) {
    return
  }

  await fsp.mkdir(targetModsDir, { recursive: true })
  unmarkPathHiddenOnWindows(managedRuntimeRoot)
  unmarkPathHiddenOnWindows(targetModsDir)

  for (const entry of managedEntries) {
    const destinationPath = path.join(targetModsDir, entry.name)
    await moveFileReplacing(path.join(sourceModsDir, entry.name), destinationPath)
  }

  await normalizeManagedRuntimeVisibility(gameDir)
}

async function moveLegacyClientFilesIntoGameDir(installDir, gameDir) {
  for (const name of CLIENT_GAME_DIRS) {
    const sourcePath = path.join(installDir, name)
    if (!fs.existsSync(sourcePath)) continue

    const destinationPath = path.join(gameDir, name)
    if (path.resolve(sourcePath) === path.resolve(destinationPath)) continue

    if (name === 'mods') {
      await fsp.mkdir(destinationPath, { recursive: true })
      await removeManagedRuntimeModJars(destinationPath)
    }

    await fsp.cp(sourcePath, destinationPath, { recursive: true, force: true })
    await fsp.rm(sourcePath, { recursive: true, force: true })
  }

  for (const name of CLIENT_GAME_FILES) {
    const sourcePath = path.join(installDir, name)
    if (!fs.existsSync(sourcePath)) continue

    const destinationPath = path.join(gameDir, name)
    if (path.resolve(sourcePath) === path.resolve(destinationPath)) continue

    await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
    await fsp.copyFile(sourcePath, destinationPath)
    await fsp.rm(sourcePath, { force: true })
  }
}

async function prepareInstalledClientLayout(settings, installDir, versionName) {
  const manifest = await loadClientManifest(installDir, versionName)
  if (!manifest) {
    return null
  }

  const manifestPath = getClientManifestPath(installDir)
  const gameDir = resolveClientGameDir(installDir, manifest)

  await ensureSharedMinecraftLayout(settings)
  await fsp.mkdir(gameDir, { recursive: true })
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  await moveLegacyClientFilesIntoGameDir(installDir, gameDir)
  await migrateLegacyManagedRuntime(gameDir)
  await moveManagedRuntimeMods(gameDir)
  await Promise.all(PACKAGED_SHARED_RUNTIME_DIRS.map((dirName) => absorbManagedInstanceDirectory(installDir, settings, dirName)))
  await Promise.all(SHARED_MINECRAFT_FILES.map((fileName) => absorbManagedRootFile(installDir, settings, fileName)))
  await Promise.all(SHARED_INSTANCE_LINKS.map(async (dirName) => {
    await ensureInstanceLink(installDir, settings, dirName)
  }))
  await writeInstanceDescriptor(installDir, versionName, manifest)

  return {
    manifest,
    gameDir
  }
}

async function directoryHasFiles(dir) {
  try {
    const entries = await fsp.readdir(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

async function findMatchingFile(rootDir, pattern) {
  try {
    const entries = await fsp.readdir(rootDir, { withFileTypes: true })
    const match = entries.find((entry) => entry.isFile() && pattern.test(entry.name))
    return match ? path.join(rootDir, match.name) : ''
  } catch {
    return ''
  }
}

async function inspectInstalledClient(installDir, versionName) {
  const manifest = await loadClientManifest(installDir, versionName)

  if (manifest?.type === 'fabric-instance') {
    const gameDir = resolveClientGameDir(installDir, manifest)
    const modsDir = path.join(gameDir, 'mods')
    const managedModsDirCandidates = [
      resolveManagedRuntimeModsDir(gameDir),
      ...getLegacyManagedRuntimeRoots(gameDir).map((rootDir) => path.join(rootDir, 'mods'))
    ]
    const requiredManagedMods = getManifestManagedMods(manifest)
    if (requiredManagedMods.length > 0) {
      const requiredPaths = await Promise.all(requiredManagedMods.map(async (entry) => {
        for (const managedModsDir of managedModsDirCandidates) {
          const candidate = path.join(managedModsDir, entry.fileName)
          if (fs.existsSync(candidate)) {
            return candidate
          }
        }

        const gameDirCandidate = path.join(modsDir, entry.fileName)
        return fs.existsSync(gameDirCandidate) ? gameDirCandidate : ''
      }))

      return {
        installed: requiredPaths.every(Boolean),
        launchableFile: requiredPaths.find(Boolean) || ''
      }
    }

    let royaleJar = ''
    let fabricApiJar = ''

    for (const managedModsDir of managedModsDirCandidates) {
      royaleJar = royaleJar || await findMatchingFile(managedModsDir, /^royale-.*\.jar$/i)
      fabricApiJar = fabricApiJar || await findMatchingFile(managedModsDir, /^fabric-api-.*\.jar$/i)
    }

    royaleJar = royaleJar || await findMatchingFile(modsDir, /^royale-.*\.jar$/i)
    fabricApiJar = fabricApiJar || await findMatchingFile(modsDir, /^fabric-api-.*\.jar$/i)

    return {
      installed: Boolean(royaleJar && fabricApiJar),
      launchableFile: royaleJar || fabricApiJar || ''
    }
  }

  const installed = await directoryHasFiles(installDir)
  const launchableFile = installed ? await findLaunchableFile(installDir) : ''

  return {
    installed,
    launchableFile
  }
}

async function findLaunchableFile(rootDir) {
  const preferredExtensions = ['.exe', '.jar']

  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true })
    const files = []

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        files.push(...await walk(fullPath))
      } else if (preferredExtensions.includes(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }

    return files
  }

  try {
    const candidates = await walk(rootDir)
    candidates.sort((left, right) => {
      const extLeft = preferredExtensions.indexOf(path.extname(left).toLowerCase())
      const extRight = preferredExtensions.indexOf(path.extname(right).toLowerCase())
      if (extLeft !== extRight) return extLeft - extRight
      return left.localeCompare(right)
    })
    return candidates[0] || ''
  } catch {
    return ''
  }
}

function isRemoteSource(source) {
  return /^https?:\/\//i.test(String(source))
}

function resolveLocalSourceCandidates(source) {
  if (!source) return []
  if (path.isAbsolute(source)) return [source]

  const normalized = source.replace(/[\\/]+/g, path.sep)
  const candidates = []

  if (app.isPackaged) {
    candidates.push(path.join(path.dirname(process.execPath), normalized))
    candidates.push(path.join(process.resourcesPath, normalized))
  } else {
    candidates.push(path.join(__dirname, '..', normalized))
    candidates.push(path.join(process.cwd(), normalized))
  }

  return [...new Set(candidates)]
}

function buildGitHubReleaseAssetResumeKey(source) {
  const release = String(source?.release || 'latest').trim() || 'latest'
  return `github-release-asset:${source.owner}/${source.repo}:${release}:${source.asset}`
}

function getSourceDescriptorResumeKey(sourceDescriptor) {
  return String(sourceDescriptor?.resumeKey || sourceDescriptor?.value || '').trim()
}

function resolveSourceDescriptor(source) {
  if (source && typeof source === 'object') {
    const type = String(source.type || '').trim().toLowerCase()
    if (type === 'github-release-asset') {
      const owner = String(source.owner || '').trim()
      const repo = String(source.repo || '').trim()
      const asset = String(source.asset || '').trim()
      if (!owner || !repo || !asset) {
        return { kind: 'none', value: '' }
      }

      const normalizedSource = normalizeSourceDefinition(source)
      return {
        kind: 'github-release-asset',
        value: normalizedSource,
        resumeKey: buildGitHubReleaseAssetResumeKey(normalizedSource)
      }
    }
  }

  const value = String(source ?? '').trim()
  if (!value) {
    return { kind: 'none', value: '' }
  }

  if (isRemoteSource(value)) {
    return { kind: 'remote', value, resumeKey: value }
  }

  const candidates = resolveLocalSourceCandidates(value)
  const localMatch = candidates.find((candidate) => fs.existsSync(candidate))
  const localStats = localMatch ? fs.statSync(localMatch) : null
  return {
    kind: 'local',
    value: localMatch || candidates[0] || value,
    exists: Boolean(localMatch),
    isDirectory: Boolean(localStats?.isDirectory()),
    resumeKey: localMatch || candidates[0] || value
  }
}

function resolveGitHubSourceToken(source) {
  const tokenEnv = String(source?.tokenEnv || '').trim()
  const candidates = [
    tokenEnv ? process.env[tokenEnv] : '',
    process.env.ROYALE_GITHUB_TOKEN,
    process.env.GITHUB_TOKEN
  ]

  return candidates
    .map((item) => String(item || '').trim())
    .find(Boolean) || ''
}

function buildGitHubApiHeaders(token, accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28'
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  return headers
}

async function resolveGithubReleaseAssetRequest(source) {
  const token = resolveGitHubSourceToken(source)
  const releaseName = String(source.release || 'latest').trim() || 'latest'
  const releaseEndpoint = releaseName.toLowerCase() === 'latest'
    ? `https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`
    : `https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/${encodeURIComponent(releaseName)}`

  const releaseResponse = await fetchWithRetry(releaseEndpoint, {
    headers: buildGitHubApiHeaders(token)
  })

  if (!releaseResponse.ok) {
    if ([401, 403, 404].includes(releaseResponse.status) && !token) {
      throw new Error(`Для защищённого источника ${source.owner}/${source.repo} нужен GitHub token. Укажите переменную окружения ${source.tokenEnv || 'ROYALE_GITHUB_TOKEN'} и попробуйте снова.`)
    }

    throw new Error(`Не удалось получить release ${source.owner}/${source.repo}: ${releaseResponse.status}`)
  }

  const releasePayload = await releaseResponse.json()
  const assets = Array.isArray(releasePayload?.assets) ? releasePayload.assets : []
  const matchedAsset = assets.find((entry) => String(entry?.name || '').trim().toLowerCase() === source.asset.toLowerCase())
  if (!matchedAsset) {
    throw new Error(`В release ${source.owner}/${source.repo} не найден asset ${source.asset}.`)
  }

  const browserDownloadUrl = String(matchedAsset.browser_download_url || '').trim()
  const assetApiUrl = String(matchedAsset.url || '').trim()
  if (token && assetApiUrl) {
    return {
      url: assetApiUrl,
      fileName: source.asset,
      requestOptions: {
        headers: buildGitHubApiHeaders(token, 'application/octet-stream')
      }
    }
  }

  return {
    url: browserDownloadUrl || assetApiUrl,
    fileName: source.asset,
    requestOptions: token
      ? {
          headers: buildGitHubApiHeaders(token)
        }
      : {}
  }
}

async function resolveSourceDownloadRequest(sourceDescriptor) {
  if (!sourceDescriptor || sourceDescriptor.kind === 'none') {
    return { kind: 'none', fileName: '', url: '', requestOptions: {} }
  }

  if (sourceDescriptor.kind === 'remote') {
    return {
      kind: 'remote',
      fileName: guessFileName(sourceDescriptor.value),
      url: sourceDescriptor.value,
      requestOptions: {}
    }
  }

  if (sourceDescriptor.kind === 'github-release-asset') {
    const request = await resolveGithubReleaseAssetRequest(sourceDescriptor.value)
    return {
      kind: sourceDescriptor.kind,
      fileName: request.fileName || guessFileName(request.url),
      url: request.url,
      requestOptions: request.requestOptions || {}
    }
  }

  return {
    kind: sourceDescriptor.kind,
    fileName: guessFileName(sourceDescriptor.value),
    url: '',
    requestOptions: {}
  }
}

async function getVersionStateFromSettings(settings, versionName) {
  const version = settings.versions.find((entry) => entry.versionName === versionName) || settings.versions[0]
  const installDir = resolveVersionDirectory(settings, version.versionName)
  const installedClient = await inspectInstalledClient(installDir, version.versionName)
  const source = resolveSourceDescriptor(version.source)
  const runningClient = await getActiveRunningClientState()
  const pendingInstall = source.kind === 'remote' || source.kind === 'github-release-asset'
    ? await getResumableInstallState(version.versionName, getSourceDescriptorResumeKey(source))
    : null
  const running = Boolean(runningClient && runningClient.versionName.toLowerCase() === version.versionName.toLowerCase())
  const gameplayStats = await readGameplayStats(version.versionName, installDir)

  return {
    installDir,
    installed: installedClient.installed,
    launchableFile: installedClient.launchableFile,
    hasSource: source.kind === 'remote' || source.kind === 'github-release-asset' || source.exists,
    sourceKind: source.kind,
    title: version.title,
    channel: version.channel,
    notes: version.notes,
    gameplayStats: running ? gameplayStats : markGameplayStatsInactive(gameplayStats),
    pendingInstall,
    running,
    runningPid: running ? runningClient.pid : 0
  }
}

async function getVersionState(versionName) {
  const settings = await loadSettings()
  return getVersionStateFromSettings(settings, versionName)
}

async function getJavaStatusForVersion(versionName) {
  const settings = await loadSettings()
  const installDir = resolveVersionDirectory(settings, versionName)
  const manifest = await loadClientManifest(installDir, versionName)
  const status = await resolveJavaStatus(settings, versionName, manifest)

  return {
    available: status.available,
    source: status.source,
    javaExecutable: status.javaExecutable,
    requiredJavaVersion: status.requiredJavaVersion
  }
}

async function getBootstrapPayload() {
  const settings = await loadSettings()
  const preferredVersion = settings.versions.find((entry) => entry.versionName === settings.lastSelectedVersion && entry.source)
  const fallbackVersion = preferredVersion?.versionName || settings.versions.find((entry) => entry.source)?.versionName || settings.lastSelectedVersion
  const normalizedSettings = fallbackVersion === settings.lastSelectedVersion
    ? settings
    : await saveSettings({ ...settings, lastSelectedVersion: fallbackVersion })

  return {
    appVersion: app.getVersion(),
    settings: normalizedSettings,
    memoryProfile: getMemoryProfile(),
    versionState: await getVersionStateFromSettings(normalizedSettings, normalizedSettings.lastSelectedVersion)
  }
}

function stripVersionPrefix(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

function compareVersions(left, right) {
  const leftParts = stripVersionPrefix(left).split('.').map((item) => Number(item) || 0)
  const rightParts = stripVersionPrefix(right).split('.').map((item) => Number(item) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0
    const rightValue = rightParts[index] || 0
    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }

  return 0
}

function inferJavaVersionFromMinecraftVersion(minecraftVersion) {
  const normalized = stripVersionPrefix(minecraftVersion)
  const match = normalized.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) {
    return 21
  }

  const major = Number(match[1]) || 0
  const minor = Number(match[2]) || 0
  const patch = Number(match[3]) || 0

  if (major > 1) {
    return 21
  }

  if (minor >= 21) {
    return 21
  }

  if (minor === 20 && patch >= 5) {
    return 21
  }

  if (minor >= 18) {
    return 17
  }

  if (minor === 17) {
    return 16
  }

  return 8
}

function resolveCatalogEntry(settings, versionName) {
  return settings?.versions?.find((entry) => String(entry?.versionName || '').trim().toLowerCase() === String(versionName || '').trim().toLowerCase()) || null
}

function resolveRequiredJavaVersion(settings, versionName, manifest = null) {
  const fromCatalog = Math.max(0, Number(resolveCatalogEntry(settings, versionName)?.javaVersion) || 0)
  if (fromCatalog) {
    return fromCatalog
  }

  const fromManifest = Math.max(0, Number(manifest?.javaVersion) || 0)
  if (fromManifest) {
    return fromManifest
  }

  const minecraftVersion = String(manifest?.minecraftVersion || versionName || '').trim()
  return inferJavaVersionFromMinecraftVersion(minecraftVersion)
}

function getJavaRuntimeDirectory(settings, javaVersion) {
  return resolveSharedDirectory(settings, path.join('jre', `java-${Math.max(0, Number(javaVersion) || 0)}`))
}

function getJavaDownloadTempFile(javaVersion, fileName = '') {
  const suffix = String(fileName || '').trim() || `java-${Math.max(0, Number(javaVersion) || 0)}.zip`
  return path.join(app.getPath('userData'), 'downloads', suffix)
}

function getRuntimeDownloadPlatform() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function getRuntimeDownloadArchitecture() {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'aarch64'
  if (process.arch === 'ia32') return 'x86'
  return 'x64'
}

function parseJavaMajorVersion(rawOutput) {
  const value = String(rawOutput || '')
  const match = value.match(/version "(.*?)"/i)
  const versionString = match ? match[1] : ''
  if (!versionString) {
    return 0
  }

  const legacyMatch = versionString.match(/^1\.(\d+)\./)
  if (legacyMatch) {
    return Number(legacyMatch[1]) || 0
  }

  const modernMatch = versionString.match(/^(\d+)(?:[._-]|$)/)
  return modernMatch ? (Number(modernMatch[1]) || 0) : 0
}

function getJavaExecutableMajorVersion(executablePath) {
  if (!executablePath || !fs.existsSync(executablePath)) {
    return 0
  }

  try {
    const result = spawnSync(executablePath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true
    })
    return parseJavaMajorVersion(`${result.stderr || ''}\n${result.stdout || ''}`)
  } catch {
    return 0
  }
}

function isJavaExecutableCompatible(executablePath, requiredJavaVersion) {
  const required = Math.max(0, Number(requiredJavaVersion) || 0)
  if (!required) {
    return Boolean(executablePath && fs.existsSync(executablePath))
  }

  return getJavaExecutableMajorVersion(executablePath) === required
}

function normalizeMemoryStep(value, minimum = 2048) {
  const rounded = Math.floor((Number(value) || 0) / 512) * 512
  return Math.max(minimum, rounded || minimum)
}

function getMemoryProfile() {
  const totalMemoryMb = Math.max(2048, Math.round(os.totalmem() / (1024 * 1024)))
  const freeMemoryMb = Math.max(1024, Math.round(os.freemem() / (1024 * 1024)))
  const reserveMb = totalMemoryMb <= 6144 ? 1536 : totalMemoryMb <= 12288 ? 2048 : 3072
  const totalBudgetMb = totalMemoryMb <= 6144
    ? Math.floor(totalMemoryMb * 0.35)
    : totalMemoryMb <= 12288
      ? Math.floor(totalMemoryMb * 0.42)
      : Math.floor(totalMemoryMb * 0.5)
  const freeBudgetMb = Math.max(2048, freeMemoryMb - reserveMb)
  const rawRecommendedMb = Math.min(8192, Math.max(2048, totalBudgetMb), freeBudgetMb)
  const recommendedMemoryMb = normalizeMemoryStep(rawRecommendedMb)

  return {
    totalMemoryMb,
    freeMemoryMb,
    reserveMb,
    recommendedMemoryMb
  }
}

function resolveEffectiveMemoryMb(settings) {
  if (settings?.autoMemoryEnabled === false) {
    return normalizeMemoryStep(settings?.memoryMb, 1024)
  }

  return getMemoryProfile().recommendedMemoryMb
}

function getStorageRoot(targetPath) {
  const input = String(targetPath || '').trim()
  if (!input) {
    return process.platform === 'win32' ? 'C:\\' : path.parse(process.cwd()).root
  }

  const resolved = path.resolve(input)
  return path.parse(resolved).root || resolved
}

async function statfsSafe(targetPath) {
  try {
    return await fsp.statfs(targetPath)
  } catch {
    return null
  }
}

async function getStorageInfo(targetPath) {
  const rootPath = getStorageRoot(targetPath)
  const resolvedTarget = String(targetPath || '').trim() ? path.resolve(String(targetPath).trim()) : rootPath
  const stats = await statfsSafe(resolvedTarget) || await statfsSafe(rootPath)

  if (!stats) {
    return {
      available: false,
      drive: rootPath.replace(/[\\/]+$/, '') || rootPath,
      freeBytes: 0,
      totalBytes: 0
    }
  }

  const blockSize = Number(stats.bsize) || 0
  const totalBlocks = Number(stats.blocks) || 0
  const freeBlocks = Number(stats.bavail || stats.bfree) || 0

  return {
    available: true,
    drive: rootPath.replace(/[\\/]+$/, '') || rootPath,
    freeBytes: freeBlocks * blockSize,
    totalBytes: totalBlocks * blockSize
  }
}

function getFabricVersionId(manifest) {
  return `fabric-loader-${manifest.fabricLoaderVersion}-${manifest.minecraftVersion}`
}

function getSharedVersionJsonPath(settings, versionId) {
  return resolveSharedDirectory(settings, path.join('versions', versionId, `${versionId}.json`))
}

function getSharedVersionJarPath(settings, versionId) {
  return resolveSharedDirectory(settings, path.join('versions', versionId, `${versionId}.jar`))
}

async function readJsonFile(filePath) {
  const stat = await fsp.stat(filePath)
  const cached = jsonFileCache.get(filePath)

  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value
  }

  const raw = await fsp.readFile(filePath, 'utf8')
  const value = JSON.parse(raw)
  jsonFileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    value
  })
  return value
}

function normalizeGameplayStatsSection(input = {}) {
  return {
    sessions: Math.max(0, Number(input.sessions) || 0),
    combatEntries: Math.max(0, Number(input.combatEntries) || 0),
    runtimeMs: Math.max(0, Number(input.runtimeMs) || 0),
    playtimeMs: Math.max(0, Number(input.playtimeMs) || 0),
    activeMs: Math.max(0, Number(input.activeMs) || 0),
    afkMs: Math.max(0, Number(input.afkMs) || 0),
    pvpMs: Math.max(0, Number(input.pvpMs) || 0),
    pvpAfkMs: Math.max(0, Number(input.pvpAfkMs) || 0)
  }
}

function normalizeGameplayDurations(input = {}) {
  const defaults = createGameplayStatsDurations()
  return {
    menu: Math.max(0, Number(input.menu) || defaults.menu),
    connecting: Math.max(0, Number(input.connecting) || defaults.connecting),
    playing: Math.max(0, Number(input.playing) || defaults.playing),
    pvp: Math.max(0, Number(input.pvp) || defaults.pvp),
    afk: Math.max(0, Number(input.afk) || defaults.afk),
    pause: Math.max(0, Number(input.pause) || defaults.pause),
    death: Math.max(0, Number(input.death) || defaults.death)
  }
}

function normalizeGameplayStats(input = {}, filePath = '') {
  const snapshot = createGameplayStatsSnapshot()
  return {
    ...snapshot,
    available: true,
    filePath,
    firstSeenAt: String(input.firstSeenAt || '').trim(),
    firstSeenAtMs: Math.max(0, Number(input.firstSeenAtMs) || 0),
    updatedAt: String(input.updatedAt || '').trim(),
    updatedAtMs: Math.max(0, Number(input.updatedAtMs) || 0),
    sessionStartedAt: String(input.sessionStartedAt || '').trim(),
    sessionStartedAtMs: Math.max(0, Number(input.sessionStartedAtMs) || 0),
    totals: normalizeGameplayStatsSection(input.totals || {}),
    currentSession: normalizeGameplayStatsSection(input.currentSession || {}),
    statusTotals: normalizeGameplayDurations(input.statusTotals || {}),
    sessionStatusTotals: normalizeGameplayDurations(input.sessionStatusTotals || {}),
    runtime: {
      status: String(input.runtime?.status || '').trim(),
      statusLabel: String(input.runtime?.statusLabel || '').trim(),
      serverName: String(input.runtime?.serverName || '').trim(),
      serverAddress: String(input.runtime?.serverAddress || '').trim(),
      worldType: String(input.runtime?.worldType || '').trim(),
      isInWorld: Boolean(input.runtime?.isInWorld),
      isInPvp: Boolean(input.runtime?.isInPvp),
      isAfk: Boolean(input.runtime?.isAfk)
    }
  }
}

function getGameplayStatsPath(installDir) {
  return path.join(installDir, 'Royale', 'stats', 'launcher-game-stats.json')
}

function getGameplayStatsCachePath(versionName = '') {
  const safeVersionName = sanitizeVersionName(versionName || 'global')
  return path.join(app.getPath('userData'), 'gameplay-stats', `${safeVersionName}.json`)
}

async function persistGameplayStatsCache(versionName, payload) {
  const cachePath = getGameplayStatsCachePath(versionName)
  await fsp.mkdir(path.dirname(cachePath), { recursive: true })
  await fsp.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8')
}

async function readGameplayStats(versionName, installDir) {
  const cachePath = getGameplayStatsCachePath(versionName)
  const statsPath = installDir ? getGameplayStatsPath(installDir) : ''

  if (statsPath) {
    try {
      await fsp.access(statsPath)
      const value = await readJsonFile(statsPath)
      await persistGameplayStatsCache(versionName, value).catch(() => {})
      return normalizeGameplayStats(value, statsPath)
    } catch {}
  }

  try {
    await fsp.access(cachePath)
    const cachedValue = await readJsonFile(cachePath)
    return normalizeGameplayStats(cachedValue, cachePath)
  } catch {
    return {
      ...createGameplayStatsSnapshot(),
      filePath: statsPath || cachePath
    }
  }
}

function markGameplayStatsInactive(input = {}) {
  const gameplay = {
    ...createGameplayStatsSnapshot(),
    ...input,
    runtime: {
      ...(input.runtime && typeof input.runtime === 'object' ? input.runtime : {}),
      status: '',
      statusLabel: '',
      serverName: '',
      serverAddress: '',
      worldType: '',
      isInWorld: false,
      isInPvp: false,
      isAfk: false
    }
  }

  return gameplay
}

function getCurrentRuleOsName() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'osx'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

function getCurrentRuleArchitectures() {
  const values = new Set([String(process.arch || '').trim().toLowerCase()])

  if (process.arch === 'x64') {
    values.add('amd64')
    values.add('x86_64')
  }

  if (process.arch === 'ia32') {
    values.add('x86')
    values.add('i386')
  }

  if (process.arch === 'arm64') {
    values.add('aarch64')
  }

  return values
}

function doesRuleMatch(rule, featureFlags = {}) {
  if (!rule || typeof rule !== 'object') {
    return true
  }

  if (rule.os && typeof rule.os === 'object') {
    const expectedName = String(rule.os.name || '').trim().toLowerCase()
    if (expectedName && expectedName !== getCurrentRuleOsName()) {
      return false
    }

    const expectedArch = String(rule.os.arch || '').trim().toLowerCase()
    if (expectedArch && !getCurrentRuleArchitectures().has(expectedArch)) {
      return false
    }

    const expectedVersion = String(rule.os.version || '').trim()
    if (expectedVersion) {
      try {
        if (!(new RegExp(expectedVersion).test(os.release()))) {
          return false
        }
      } catch {
        return false
      }
    }
  }

  if (rule.features && typeof rule.features === 'object') {
    for (const [featureName, expectedValue] of Object.entries(rule.features)) {
      if (Boolean(featureFlags[featureName]) !== Boolean(expectedValue)) {
        return false
      }
    }
  }

  return true
}

function shouldApplyRules(rules, featureFlags = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return true
  }

  let allowed = false
  for (const rule of rules) {
    if (!doesRuleMatch(rule, featureFlags)) {
      continue
    }

    allowed = String(rule?.action || 'allow').trim().toLowerCase() !== 'disallow'
  }

  return allowed
}

function replaceLaunchTokens(value, replacements) {
  return String(value ?? '').replace(/\$\{([^}]+)\}/g, (_match, key) => String(replacements[key] ?? ''))
}

function collectLaunchArguments(entries, replacements, featureFlags = {}) {
  const result = []

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === 'string') {
      const value = replaceLaunchTokens(entry, replacements)
      if (value !== '') {
        result.push(value)
      }
      continue
    }

    if (!entry || typeof entry !== 'object' || !shouldApplyRules(entry.rules, featureFlags)) {
      continue
    }

    const values = Array.isArray(entry.value) ? entry.value : [entry.value]
    for (const value of values) {
      const resolved = replaceLaunchTokens(value, replacements)
      if (resolved !== '') {
        result.push(resolved)
      }
    }
  }

  return result
}

function parseLibraryName(value) {
  const parts = String(value || '').trim().split(':')
  if (parts.length < 3) {
    return null
  }

  const group = parts[0]
  const artifact = parts[1]
  let version = parts[2]
  let classifier = parts[3] || ''
  let extension = 'jar'

  if (version.includes('@')) {
    const fragments = version.split('@', 2)
    version = fragments[0]
    extension = fragments[1] || extension
  }

  if (classifier.includes('@')) {
    const fragments = classifier.split('@', 2)
    classifier = fragments[0]
    extension = fragments[1] || extension
  }

  return {
    group,
    artifact,
    version,
    classifier,
    extension
  }
}

function resolveLibraryRelativePath(library) {
  const artifactPath = String(library?.downloads?.artifact?.path || '').trim()
  if (artifactPath) {
    return artifactPath.replace(/[\\/]+/g, path.sep)
  }

  const parsed = parseLibraryName(library?.name)
  if (!parsed) {
    return ''
  }

  const fileName = parsed.classifier
    ? `${parsed.artifact}-${parsed.version}-${parsed.classifier}.${parsed.extension}`
    : `${parsed.artifact}-${parsed.version}.${parsed.extension}`

  return path.join(...parsed.group.split('.'), parsed.artifact, parsed.version, fileName)
}

function resolveLibraryAbsolutePath(settings, library) {
  const relativePath = resolveLibraryRelativePath(library)
  return relativePath ? resolveSharedDirectory(settings, path.join('libraries', relativePath)) : ''
}

function isNativeLibraryEntry(library) {
  const parsed = parseLibraryName(library?.name)
  return Boolean(parsed?.classifier && /^natives-/i.test(parsed.classifier))
}

function mergeLibraries(baseLibraries, extraLibraries) {
  const merged = new Map()

  for (const library of [...(baseLibraries || []), ...(extraLibraries || [])]) {
    if (!library || typeof library !== 'object') {
      continue
    }

    const key = String(library.name || resolveLibraryRelativePath(library)).trim()
    if (!key) {
      continue
    }

    const current = merged.get(key)
    merged.set(key, current ? { ...current, ...library } : library)
  }

  return [...merged.values()]
}

function sleep(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastError = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        redirect: options.redirect || 'follow',
        headers: {
          ...APP_NETWORK_HEADERS,
          ...(options.headers || {})
        }
      })

      if (response.ok) {
        return response
      }

      if (attempt >= retries || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        return response
      }

      await sleep(450 * (attempt + 1))
    } catch (error) {
      lastError = error
      if (attempt >= retries) {
        throw error
      }
      await sleep(450 * (attempt + 1))
    }
  }

  throw lastError || new Error(`Не удалось получить ответ от ${url}`)
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`Ошибка загрузки JSON: ${response.status} ${url}`)
  }

  return response.json()
}

async function downloadRemoteFile(url, destinationPath, options = {}) {
  const response = await fetchWithRetry(url, options.requestOptions || {})
  if (!response.ok || !response.body) {
    throw new Error(`Ошибка загрузки файла: ${response.status} ${url}`)
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
  const output = fs.createWriteStream(destinationPath)
  const reader = response.body.getReader()
  const total = Math.max(0, Number(response.headers.get('content-length')) || 0)
  let current = 0

  await options.beforeRead?.()
  options.onProgress?.({
    current,
    total,
    progress: total > 0 ? current / total : 0
  })

  while (true) {
    await options.beforeRead?.()
    const { done, value } = await reader.read()
    if (done) break
    output.write(Buffer.from(value))
    current += value.length
    options.onProgress?.({
      current,
      total,
      progress: total > 0 ? current / total : 0
    })
  }

  await new Promise((resolve, reject) => {
    output.end(() => resolve())
    output.on('error', reject)
  })

  options.onProgress?.({
    current: total > 0 ? total : current,
    total,
    progress: 1
  })
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return
  }

  let cursor = 0
  async function next() {
    const currentIndex = cursor
    cursor += 1
    if (currentIndex >= items.length) {
      return
    }

    await worker(items[currentIndex], currentIndex)
    await next()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()))
}

async function resolveMinecraftVersionPayload(minecraftVersion) {
  const manifest = await fetchJson(MINECRAFT_VERSION_MANIFEST_URL)
  const versionEntry = (manifest.versions || []).find((entry) => entry.id === minecraftVersion)
  if (!versionEntry?.url) {
    throw new Error(`Minecraft ${minecraftVersion} не найден в официальном manifest.`)
  }

  return fetchJson(versionEntry.url)
}

async function resolveFabricProfilePayload(manifest) {
  const minecraftVersion = String(manifest?.minecraftVersion || '').trim()
  const fabricLoaderVersion = String(manifest?.fabricLoaderVersion || '').trim()
  if (!minecraftVersion || !fabricLoaderVersion) {
    throw new Error('В manifest клиента не хватает minecraftVersion или fabricLoaderVersion.')
  }

  return fetchJson(`${FABRIC_PROFILE_BASE_URL}/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(fabricLoaderVersion)}/profile/json`)
}

async function findJavaExecutableInDirectory(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return ''
  }

  const preferredFiles = process.platform === 'win32' ? ['javaw.exe', 'java.exe'] : ['java']
  const queue = [rootDir]

  while (queue.length > 0) {
    const currentDir = queue.shift()
    let entries = []

    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const fileName of preferredFiles) {
      const candidate = path.join(currentDir, fileName)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(currentDir, entry.name))
      }
    }
  }

  return ''
}

function emitJavaInstallStatus(message) {
  emit('java-install:status', { message: String(message || '').trim() })
}

function emitJavaInstallProgress(payload) {
  emit('java-install:progress', {
    phase: String(payload?.phase || '').trim(),
    current: Math.max(0, Number(payload?.current) || 0),
    total: Math.max(0, Number(payload?.total) || 0),
    progress: Math.max(0, Math.min(1, Number(payload?.progress) || 0))
  })
}

function getSystemJavaLookupCommand() {
  return process.platform === 'win32'
    ? { command: 'where.exe', args: ['javaw.exe', 'java.exe'] }
    : { command: 'which', args: ['java'] }
}

function findCompatibleJavaInText(rawText, requiredJavaVersion) {
  const candidates = String(rawText || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((candidate) => fs.existsSync(candidate))

  return candidates.find((candidate) => isJavaExecutableCompatible(candidate, requiredJavaVersion)) || ''
}

async function resolveJavaStatus(settings, versionName, manifest = null) {
  const requiredJavaVersion = resolveRequiredJavaVersion(settings, versionName, manifest)
  const installRoot = resolveInstallRoot(settings)
  const cacheKey = `${installRoot}::${requiredJavaVersion}`
  if (javaExecutableCache?.key === cacheKey && javaExecutableCache.path && fs.existsSync(javaExecutableCache.path)) {
    return {
      available: true,
      source: javaExecutableCache.source || 'cache',
      javaExecutable: javaExecutableCache.path,
      requiredJavaVersion
    }
  }

  const bundledJava = await findJavaExecutableInDirectory(getJavaRuntimeDirectory(settings, requiredJavaVersion))
  if (isJavaExecutableCompatible(bundledJava, requiredJavaVersion)) {
    javaExecutableCache = { key: cacheKey, path: bundledJava, source: 'bundled' }
    return {
      available: true,
      source: 'bundled',
      javaExecutable: bundledJava,
      requiredJavaVersion
    }
  }

  const legacyBundledJava = await findJavaExecutableInDirectory(resolveSharedDirectory(settings, 'jre'))
  if (isJavaExecutableCompatible(legacyBundledJava, requiredJavaVersion)) {
    javaExecutableCache = { key: cacheKey, path: legacyBundledJava, source: 'bundled' }
    return {
      available: true,
      source: 'bundled',
      javaExecutable: legacyBundledJava,
      requiredJavaVersion
    }
  }

  const lookup = getSystemJavaLookupCommand()
  try {
    const result = spawnSync(lookup.command, lookup.args, {
      encoding: 'utf8',
      windowsHide: true
    })
    const discoveredPath = result.status === 0 ? findCompatibleJavaInText(result.stdout, requiredJavaVersion) : ''
    if (discoveredPath) {
      javaExecutableCache = { key: cacheKey, path: discoveredPath, source: 'system' }
      return {
        available: true,
        source: 'system',
        javaExecutable: discoveredPath,
        requiredJavaVersion
      }
    }
  } catch {}

  return {
    available: false,
    source: '',
    javaExecutable: '',
    requiredJavaVersion
  }
}

async function resolveJavaExecutable(settings, versionName, manifest = null) {
  const status = await resolveJavaStatus(settings, versionName, manifest)
  if (status.available && status.javaExecutable) {
    return status.javaExecutable
  }

  throw new Error(`Java ${status.requiredJavaVersion || 21} не найден. Скачайте подходящий runtime и попробуйте снова.`)
}

async function resolveAdoptiumRuntimePackage(requiredJavaVersion) {
  const release = Math.max(8, Number(requiredJavaVersion) || 0)
  const osName = getRuntimeDownloadPlatform()
  const arch = getRuntimeDownloadArchitecture()

  for (const imageType of ['jre', 'jdk']) {
    const queryUrl = `${ADOPTIUM_API_BASE_URL}/${release}/hotspot?release_type=ga&os=${encodeURIComponent(osName)}&architecture=${encodeURIComponent(arch)}&image_type=${encodeURIComponent(imageType)}`
    const payload = await fetchJson(queryUrl)
    const candidate = Array.isArray(payload)
      ? payload.find((entry) => entry?.binary?.package?.link && entry?.binary?.package?.name)
      : null

    if (candidate?.binary?.package?.link && candidate?.binary?.package?.name) {
      return {
        url: String(candidate.binary.package.link).trim(),
        fileName: String(candidate.binary.package.name).trim(),
        imageType
      }
    }
  }

  throw new Error(`Не удалось найти Java ${release} для ${osName} ${arch}.`)
}

async function extractJavaArchive(archivePath, destinationDir) {
  const lowerName = archivePath.toLowerCase()
  await fsp.rm(destinationDir, { recursive: true, force: true })
  await fsp.mkdir(destinationDir, { recursive: true })

  if (lowerName.endsWith('.zip')) {
    await extractZipArchive(archivePath, destinationDir)
    return
  }

  const args = ['-xf', archivePath, '-C', destinationDir]
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Не удалось распаковать Java runtime: ${result.stderr || result.stdout || archivePath}`)
  }
}

async function installJavaRuntime(settings, versionName, manifest = null) {
  if (javaInstallInFlight) {
    return javaInstallInFlight
  }

  javaInstallInFlight = (async () => {
    const currentStatus = await resolveJavaStatus(settings, versionName, manifest)
    if (currentStatus.available) {
      emitJavaInstallStatus('')
      emitJavaInstallProgress({ phase: 'idle', progress: 0, current: 0, total: 0 })
      return currentStatus
    }

    const requiredJavaVersion = currentStatus.requiredJavaVersion || resolveRequiredJavaVersion(settings, versionName, manifest)
    const runtimeInfo = await resolveAdoptiumRuntimePackage(requiredJavaVersion)
    const tempFile = getJavaDownloadTempFile(requiredJavaVersion, runtimeInfo.fileName)
    const runtimeDir = getJavaRuntimeDirectory(settings, requiredJavaVersion)

    emitJavaInstallStatus(`Скачиваю Java ${requiredJavaVersion}...`)
    emitJavaInstallProgress({ phase: 'download', progress: 0, current: 0, total: 0 })
    await downloadRemoteFile(runtimeInfo.url, tempFile, {
      onProgress: (progress) => {
        emitJavaInstallProgress({
          phase: 'download',
          current: progress.current,
          total: progress.total,
          progress: progress.progress
        })
      }
    })

    emitJavaInstallStatus(`Распаковываю Java ${requiredJavaVersion}...`)
    emitJavaInstallProgress({ phase: 'extract', progress: 0.96, current: 96, total: 100 })
    await extractJavaArchive(tempFile, runtimeDir)
    await fsp.rm(tempFile, { force: true })

    const finalStatus = await resolveJavaStatus(settings, versionName, manifest)
    if (!finalStatus.available) {
      throw new Error(`Java ${requiredJavaVersion} скачалась, но не была найдена после распаковки.`)
    }

    emitJavaInstallStatus(`Java ${requiredJavaVersion} готова.`)
    emitJavaInstallProgress({ phase: 'done', progress: 1, current: 1, total: 1 })
    return finalStatus
  })()

  try {
    return await javaInstallInFlight
  } finally {
    javaInstallInFlight = null
  }
}

function uniqueByRelativePath(items) {
  const map = new Map()
  for (const item of items) {
    if (!item?.destinationPath) continue
    map.set(item.destinationPath, item)
  }
  return [...map.values()]
}

function buildLibraryDownloadEntries(settings, libraries) {
  const items = []

  for (const library of libraries || []) {
    if (!library || typeof library !== 'object' || !shouldApplyRules(library.rules)) {
      continue
    }

    const artifactPath = String(library?.downloads?.artifact?.path || '').trim()
    const artifactUrl = String(library?.downloads?.artifact?.url || '').trim()
    const relativePath = artifactPath
      ? artifactPath.replace(/[\\/]+/g, path.sep)
      : resolveLibraryRelativePath(library)

    if (!relativePath) {
      continue
    }

    let url = artifactUrl
    if (!url) {
      const baseUrl = String(library?.url || 'https://libraries.minecraft.net/').replace(/\/+$/, '')
      url = `${baseUrl}/${relativePath.replace(/\\/g, '/')}`
    }

    items.push({
      destinationPath: resolveSharedDirectory(settings, path.join('libraries', relativePath)),
      url
    })
  }

  return uniqueByRelativePath(items)
}

function buildAssetDownloadEntries(settings, assetIndexPayload) {
  return Object.values(assetIndexPayload?.objects || {}).map((entry) => {
    const hash = String(entry?.hash || '').trim()
    const prefix = hash.slice(0, 2)
    return {
      destinationPath: resolveSharedDirectory(settings, path.join('assets', 'objects', prefix, hash)),
      url: `https://resources.download.minecraft.net/${prefix}/${hash}`
    }
  }).filter((entry) => entry.destinationPath && entry.url)
}

async function ensureDownloadEntries(entries, label) {
  return ensureDownloadEntriesWithOptions(entries, label)
}

async function ensureDownloadEntriesWithOptions(entries, label, options = {}) {
  const missingEntries = entries.filter((entry) => entry?.destinationPath && entry?.url && !fs.existsSync(entry.destinationPath))
  if (!missingEntries.length) {
    return
  }

  const safeLabel = String(label || '').trim()
  const report = typeof options.report === 'function'
    ? options.report
    : (message) => {
      setLaunchStatus(message)
    }

  report(`${safeLabel} 0/${missingEntries.length}`, {
    current: 0,
    total: missingEntries.length,
    progress: 0
  })

  let completed = 0
  await runWithConcurrency(missingEntries, RUNTIME_DOWNLOAD_CONCURRENCY, async (entry) => {
    await downloadRemoteFile(entry.url, entry.destinationPath, {
      beforeRead: options.beforeRead
    })
    completed += 1
    report(`${safeLabel} ${completed}/${missingEntries.length}`, {
      current: completed,
      total: missingEntries.length,
      progress: missingEntries.length > 0 ? completed / missingEntries.length : 1
    })
  })
}

async function ensureManagedClientRuntime(settings, versionName, manifest, options = {}) {
  const installStage = options.stage === 'install'
  const downloadMissing = options.downloadMissing !== false
  const reportProgress = (label, progressPayload = {}) => {
    const message = String(label || '').trim()
    if (installStage) {
      setInstallStatus(message)
      setInstallProgress({
        stage: 'prepare',
        label: message,
        progress: Math.max(0, Math.min(1, Number(progressPayload.progress) || 0)),
        current: Math.max(0, Number(progressPayload.current) || 0),
        total: Math.max(0, Number(progressPayload.total) || 0)
      })
      return
    }

    setLaunchStatus(message)
  }
  const beforeRead = installStage
    ? async () => {
      await waitForInstallResumeIfNeeded()
      assertInstallNotCancelled()
    }
    : async () => {
      assertLaunchNotCancelled()
    }
  const minecraftVersion = String(manifest?.minecraftVersion || versionName || '').trim()
  const sharedFabricVersion = getSharedFabricVersionDirectoryName(manifest)
  if (!minecraftVersion || !sharedFabricVersion) {
    throw new Error('Не удалось определить Minecraft или Fabric runtime для этой версии.')
  }

  const baseVersionJsonPath = getSharedVersionJsonPath(settings, minecraftVersion)
  const fabricVersionJsonPath = getSharedVersionJsonPath(settings, sharedFabricVersion)

  let baseProfile = fs.existsSync(baseVersionJsonPath)
    ? await readJsonFile(baseVersionJsonPath)
    : null

  if (!baseProfile) {
    if (!downloadMissing) {
      throw new Error('Не найдены метаданные Minecraft. Переустановите клиент и попробуйте снова.')
    }

    reportProgress('Проверяю метаданные Minecraft...')
    baseProfile = await resolveMinecraftVersionPayload(minecraftVersion)
    await fsp.mkdir(path.dirname(baseVersionJsonPath), { recursive: true })
    await fsp.writeFile(baseVersionJsonPath, JSON.stringify(baseProfile, null, 2), 'utf8')
  }

  let rawFabricProfile = fs.existsSync(fabricVersionJsonPath)
    ? await readJsonFile(fabricVersionJsonPath)
    : null

  if (!rawFabricProfile) {
    if (!downloadMissing) {
      throw new Error('Не найден профиль Fabric. Переустановите клиент и попробуйте снова.')
    }

    reportProgress('Проверяю профиль Fabric...')
    rawFabricProfile = await resolveFabricProfilePayload(manifest)
  }
  const fabricProfile = {
    ...rawFabricProfile,
    id: sharedFabricVersion,
    inheritsFrom: minecraftVersion
  }

  if (!manifest.javaVersion && baseProfile?.javaVersion?.majorVersion) {
    manifest.javaVersion = Math.max(0, Number(baseProfile.javaVersion.majorVersion) || 0)
  }

  if (!fs.existsSync(fabricVersionJsonPath)) {
    await fsp.mkdir(path.dirname(fabricVersionJsonPath), { recursive: true })
    await fsp.writeFile(fabricVersionJsonPath, JSON.stringify(fabricProfile, null, 2), 'utf8')
  }

  const clientJarPath = getSharedVersionJarPath(settings, minecraftVersion)
  if (!fs.existsSync(clientJarPath)) {
    if (!downloadMissing) {
      throw new Error('Не найден Minecraft client jar. Переустановите клиент и попробуйте снова.')
    }

    const clientUrl = String(baseProfile?.downloads?.client?.url || '').trim()
    if (!clientUrl) {
      throw new Error('Не удалось определить ссылку на Minecraft client.')
    }

    reportProgress('Скачиваю Minecraft client 0/1', { current: 0, total: 1, progress: 0 })
    await downloadRemoteFile(clientUrl, clientJarPath, { beforeRead })
    reportProgress('Скачиваю Minecraft client 1/1', { current: 1, total: 1, progress: 1 })
  }

  const libraries = mergeLibraries(baseProfile.libraries, fabricProfile.libraries)
  if (downloadMissing) {
    await ensureDownloadEntriesWithOptions(buildLibraryDownloadEntries(settings, libraries), 'Скачиваю libraries', {
      beforeRead,
      report: reportProgress
    })
  }

  const assetIndexId = String(baseProfile?.assetIndex?.id || baseProfile?.assets || '').trim()
  const assetIndexUrl = String(baseProfile?.assetIndex?.url || '').trim()
  if (!assetIndexId || !assetIndexUrl) {
    throw new Error('Не удалось определить asset index для клиента.')
  }

  const assetIndexPath = resolveSharedDirectory(settings, path.join('assets', 'indexes', `${assetIndexId}.json`))
  let assetIndexPayload = null
  if (fs.existsSync(assetIndexPath)) {
    assetIndexPayload = await readJsonFile(assetIndexPath)
  } else {
    if (!downloadMissing) {
      throw new Error('Не найден asset index клиента. Переустановите клиент и попробуйте снова.')
    }

    reportProgress('Скачиваю asset index 0/1', { current: 0, total: 1, progress: 0 })
    assetIndexPayload = await fetchJson(assetIndexUrl)
    await fsp.mkdir(path.dirname(assetIndexPath), { recursive: true })
    await fsp.writeFile(assetIndexPath, JSON.stringify(assetIndexPayload, null, 2), 'utf8')
    reportProgress('Скачиваю asset index 1/1', { current: 1, total: 1, progress: 1 })
  }

  const logConfigId = String(baseProfile?.logging?.client?.file?.id || '').trim()
  const logConfigUrl = String(baseProfile?.logging?.client?.file?.url || '').trim()
  if (logConfigId && logConfigUrl) {
    const logConfigPath = resolveSharedDirectory(settings, path.join('assets', 'log_configs', logConfigId))
    if (!fs.existsSync(logConfigPath)) {
      if (!downloadMissing) {
        throw new Error('Не найден log config клиента. Переустановите клиент и попробуйте снова.')
      }

      reportProgress('Скачиваю log config 0/1', { current: 0, total: 1, progress: 0 })
      await downloadRemoteFile(logConfigUrl, logConfigPath, { beforeRead })
      reportProgress('Скачиваю log config 1/1', { current: 1, total: 1, progress: 1 })
    }
  }

  if (downloadMissing) {
    await ensureDownloadEntriesWithOptions(buildAssetDownloadEntries(settings, assetIndexPayload), 'Скачиваю assets', {
      beforeRead,
      report: reportProgress
    })
  }

  return {
    baseProfile,
    fabricProfile
  }
}

async function extractNativeJar(nativeJarPath, nativesDir) {
  const zipFile = await openZipFile(nativeJarPath)

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      try {
        if (typeof zipFile.close === 'function') {
          zipFile.close()
        }
      } catch {}

      reject(error)
    }

    zipFile.on('entry', (entry) => {
      handleEntry(entry).catch(fail)
    })

    zipFile.on('end', resolve)
    zipFile.on('error', fail)
    zipFile.readEntry()

    async function handleEntry(entry) {
      const entryName = String(entry.fileName || '').replace(/\\/g, '/')
      if (!entryName || entryName.endsWith('/') || entryName.startsWith('META-INF/')) {
        zipFile.readEntry()
        return
      }

      const destinationPath = path.resolve(nativesDir, entryName)
      const resolvedRoot = path.resolve(nativesDir) + path.sep
      if (destinationPath !== path.resolve(nativesDir) && !destinationPath.startsWith(resolvedRoot)) {
        throw new Error('Native jar пытается выйти за пределы папки runtime.')
      }

      await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
      const readStream = await openZipEntryStream(zipFile, entry)
      await pipeStreamToFile(readStream, destinationPath)
      zipFile.readEntry()
    }
  })
}

function getNativeCacheMetadataPath(nativesDir) {
  return path.join(nativesDir, '.royale-natives.json')
}

async function readNativeCacheKey(nativesDir) {
  try {
    const raw = await fsp.readFile(getNativeCacheMetadataPath(nativesDir), 'utf8')
    const payload = JSON.parse(raw)
    return String(payload?.cacheKey || '').trim()
  } catch {
    return ''
  }
}

async function writeNativeCacheKey(nativesDir, cacheKey) {
  await fsp.writeFile(getNativeCacheMetadataPath(nativesDir), JSON.stringify({ cacheKey }, null, 2), 'utf8')
}

async function buildNativeCacheKey(nativeLibraryPaths) {
  const parts = await Promise.all(nativeLibraryPaths.map(async (nativeJarPath) => {
    const stat = await fsp.stat(nativeJarPath)
    return `${nativeJarPath}:${stat.size}:${stat.mtimeMs}`
  }))

  return parts.join('|')
}

async function ensurePreparedNatives(nativeLibraryPaths, nativesDir, runtimeRoot) {
  await fsp.mkdir(runtimeRoot, { recursive: true })

  if (nativeLibraryPaths.length === 0) {
    await fsp.mkdir(nativesDir, { recursive: true })
    return
  }

  const cacheKey = await buildNativeCacheKey(nativeLibraryPaths)
  const currentCacheKey = await readNativeCacheKey(nativesDir)
  if (currentCacheKey && currentCacheKey === cacheKey) {
    return
  }

  await rimrafSafe(nativesDir, runtimeRoot)
  await fsp.mkdir(nativesDir, { recursive: true })

  for (const nativeJarPath of nativeLibraryPaths) {
    await extractNativeJar(nativeJarPath, nativesDir)
  }

  await writeNativeCacheKey(nativesDir, cacheKey)
}

function getLaunchPlayerName(settings) {
  const preferred = String(settings?.playerName || '').trim()
  if (isValidMinecraftPlayerName(preferred)) {
    return preferred
  }

  const candidate = String(process.env.MINECRAFT_USERNAME || process.env.USERNAME || process.env.USER || 'Player').trim()
  const sanitized = sanitizeMinecraftPlayerName(candidate)
  return sanitized || 'Player'
}

function createOfflineUuid(playerName) {
  const digest = getCryptoModule().createHash('md5').update(`OfflinePlayer:${playerName}`, 'utf8').digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

function buildManagedClientJavaArgs(settings, versionName, installDir, clientJarPath) {
  const effectiveMemoryMb = resolveEffectiveMemoryMb(settings)
  const rawArgs = String(settings.javaArgs || '')
    .replaceAll('{installDir}', installDir)
    .replaceAll('{clientFile}', clientJarPath)
    .replaceAll('{version}', versionName)
    .replaceAll('{memoryMb}', String(effectiveMemoryMb))

  const args = splitCommandLikeArgs(rawArgs)
  if (!args.some((item) => /^-Xmx/i.test(item))) {
    args.unshift(`-Xmx${effectiveMemoryMb}M`)
  }

  return args
}

async function buildManagedClientLaunchPlan(settings, versionName, installDir, preparedClient) {
  assertLaunchNotCancelled()
  setLaunchStatus('Проверяю клиент...')
  const manifest = preparedClient?.manifest
  const gameDir = preparedClient?.gameDir
  if (!manifest || manifest.type !== 'fabric-instance' || !gameDir) {
    return null
  }

  const baseVersionId = String(manifest.minecraftVersion || versionName || '').trim()
  const managedFabricVersionId = getSharedFabricVersionDirectoryName(manifest)
  if (!baseVersionId || !managedFabricVersionId) {
    throw new Error('Не удалось определить версию Minecraft или Fabric для запуска клиента.')
  }

  setLaunchStatus('Проверяю версии Minecraft и Fabric...')
  await ensureManagedClientRuntime(settings, versionName, manifest, { downloadMissing: false })
  const baseVersionJsonPath = getSharedVersionJsonPath(settings, baseVersionId)
  const fabricVersionJsonPath = getSharedVersionJsonPath(settings, managedFabricVersionId)
  const clientJarPath = getSharedVersionJarPath(settings, baseVersionId)

  if (!fs.existsSync(baseVersionJsonPath)) {
    throw new Error(`Не найден профиль Minecraft: ${baseVersionJsonPath}`)
  }

  if (!fs.existsSync(fabricVersionJsonPath)) {
    throw new Error(`Не найден профиль Fabric: ${fabricVersionJsonPath}`)
  }

  if (!fs.existsSync(clientJarPath)) {
    throw new Error(`Не найден клиентский jar: ${clientJarPath}`)
  }

  const [baseProfile, fabricProfile] = await Promise.all([
    readJsonFile(baseVersionJsonPath),
    readJsonFile(fabricVersionJsonPath)
  ])
  assertLaunchNotCancelled()

  const libraries = mergeLibraries(baseProfile.libraries, fabricProfile.libraries)
  const classpathEntries = []
  const nativeLibraryPaths = []

  setLaunchStatus('Проверяю libraries...')
  for (const library of libraries) {
    assertLaunchNotCancelled()
    if (!shouldApplyRules(library.rules)) {
      continue
    }

    const libraryPath = resolveLibraryAbsolutePath(settings, library)
    if (!libraryPath || !fs.existsSync(libraryPath)) {
      throw new Error(`Не найдена библиотека для запуска: ${library?.name || libraryPath}`)
    }

    if (isNativeLibraryEntry(library)) {
      nativeLibraryPaths.push(libraryPath)
    } else {
      classpathEntries.push(libraryPath)
    }
  }

  classpathEntries.push(clientJarPath)

  const runtimeRoot = resolveManagedRuntimeRoot(gameDir)
  const nativesDir = path.join(runtimeRoot, 'natives', sanitizeVersionName(managedFabricVersionId))
  await ensurePreparedNatives(nativeLibraryPaths, nativesDir, runtimeRoot)
  assertLaunchNotCancelled()

  const assetsRoot = resolveSharedDirectory(settings, 'assets')
  const assetIndexName = String(baseProfile.assetIndex?.id || baseProfile.assets || '').trim()
  const assetIndexPath = assetIndexName ? path.join(assetsRoot, 'indexes', `${assetIndexName}.json`) : ''
  setLaunchStatus('Проверяю assets...')
  if (!fs.existsSync(assetsRoot) || !fs.existsSync(path.join(assetsRoot, 'objects')) || !assetIndexPath || !fs.existsSync(assetIndexPath)) {
    throw new Error('Assets клиента найдены не полностью. Переустановите сборку и попробуйте снова.')
  }
  const logConfigId = String(baseProfile.logging?.client?.file?.id || '').trim()
  const logConfigPath = logConfigId ? path.join(assetsRoot, 'log_configs', logConfigId) : ''
  const playerName = getLaunchPlayerName(settings)
  const offlineUuid = createOfflineUuid(playerName)

  const replacements = {
    auth_access_token: '0',
    auth_player_name: playerName,
    auth_uuid: offlineUuid,
    auth_xuid: '0',
    assets_index_name: assetIndexName,
    assets_root: assetsRoot,
    classpath: classpathEntries.join(path.delimiter),
    clientid: '00000000-0000-0000-0000-000000000000',
    game_directory: gameDir,
    launcher_name: 'Royale Launcher',
    launcher_version: app.getVersion(),
    natives_directory: nativesDir,
    path: logConfigPath,
    quickPlayMultiplayer: '',
    quickPlayPath: '',
    quickPlayRealms: '',
    quickPlaySingleplayer: '',
    resolution_height: '720',
    resolution_width: '1280',
    version_name: String(fabricProfile.id || managedFabricVersionId || versionName).trim(),
    version_type: String(fabricProfile.type || baseProfile.type || 'release').trim()
  }

  const featureFlags = {
    has_custom_resolution: false,
    has_quick_plays_support: false,
    is_demo_user: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
    is_quick_play_singleplayer: false
  }

  const jvmArgs = [
    ...buildManagedClientJavaArgs(settings, versionName, installDir, clientJarPath)
  ]

  if (baseProfile.logging?.client?.argument && logConfigPath && fs.existsSync(logConfigPath)) {
    jvmArgs.push(replaceLaunchTokens(baseProfile.logging.client.argument, { path: logConfigPath }))
  }

  jvmArgs.push(...collectLaunchArguments(baseProfile.arguments?.jvm, replacements, featureFlags))
  jvmArgs.push(...collectLaunchArguments(fabricProfile.arguments?.jvm, replacements, featureFlags))

  setLaunchStatus('Проверяю managed-моды...')
  const managedModFiles = await ensureManagedModsFromManifest(manifest, gameDir, { downloadMissing: false })
  assertLaunchNotCancelled()
  if (managedModFiles.length > 0 && !jvmArgs.some((item) => /^-Dfabric\.addMods=/i.test(item))) {
    jvmArgs.push(`-Dfabric.addMods=${managedModFiles.join(path.delimiter)}`)
  }

  const mainClass = String(fabricProfile.mainClass || baseProfile.mainClass || '').trim()
  if (!mainClass) {
    throw new Error('Не найден mainClass для запуска клиента.')
  }

  const gameArgs = [
    ...collectLaunchArguments(baseProfile.arguments?.game, replacements, featureFlags),
    ...collectLaunchArguments(fabricProfile.arguments?.game, replacements, featureFlags)
  ]

  setLaunchStatus('Проверяю Java runtime...')
  const javaExecutable = await resolveJavaExecutable(settings, versionName, manifest)
  assertLaunchNotCancelled()

  return {
    javaExecutable,
    args: [...jvmArgs, mainClass, ...gameArgs],
    gameDir
  }
}

async function launchManagedClient(settings, versionName, installDir, preparedClient) {
  const launchPlan = await buildManagedClientLaunchPlan(settings, versionName, installDir, preparedClient)
  if (!launchPlan) {
    return null
  }

  setLaunchStatus('Запускаю Minecraft...')
  assertLaunchNotCancelled()
  const child = spawn(launchPlan.javaExecutable, launchPlan.args, {
    cwd: launchPlan.gameDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })

  child.royaleVersionName = versionName
  child.royaleInstallDir = installDir
  trackLaunchedProcess(child, settings)
  child.unref()

  return {
    ok: true,
    pid: child.pid || 0
  }
}

function formatCommandLikeArg(value) {
  const normalized = String(value ?? '')
  if (!normalized) {
    return '""'
  }

  if (!/[\s"]/u.test(normalized)) {
    return normalized
  }

  return `"${normalized.replace(/"/g, '\\"')}"`
}

function joinCommandLikeArgs(args) {
  return args
    .map((item) => formatCommandLikeArg(item))
    .join(' ')
    .trim()
}

function buildLauncherJavaArgs(settings, gameDir) {
  const effectiveMemoryMb = resolveEffectiveMemoryMb(settings)
  const args = splitCommandLikeArgs(String(settings.javaArgs || '').replaceAll('{memoryMb}', String(effectiveMemoryMb)))
  if (!args.some((item) => /^-Xmx/i.test(item))) {
    args.unshift(`-Xmx${effectiveMemoryMb}M`)
  }

  const managedModFiles = gameDir ? listManagedRuntimeModFiles(gameDir) : []
  if (managedModFiles.length > 0 && !args.some((item) => /^-Dfabric\.addMods=/i.test(item))) {
    args.push(`-Dfabric.addMods=${managedModFiles.join(path.delimiter)}`)
  }

  return joinCommandLikeArgs(args)
}

function getLauncherProfileCandidates() {
  const minecraftHome = getMinecraftHome()
  return [
    path.join(minecraftHome, 'launcher_profiles_microsoft_store.json'),
    path.join(minecraftHome, 'launcher_profiles.json')
  ]
}

async function resolveLauncherProfilesPath() {
  const candidates = getLauncherProfileCandidates()
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[candidates.length - 1]
}

async function syncSharedRuntimeToMinecraftHome(settings, manifest) {
  const minecraftHome = getMinecraftHome()
  const versionsHome = path.join(minecraftHome, 'versions')

  await fsp.mkdir(minecraftHome, { recursive: true })
  await fsp.mkdir(versionsHome, { recursive: true })

  for (const dirName of getSharedVersionDirectoryNames(manifest)) {
    const sourceDir = resolveSharedDirectory(settings, path.join('versions', dirName))
    const targetDir = path.join(versionsHome, dirName)
    await seedDirectoryIfMissing(sourceDir, targetDir)
  }

  for (const dirName of ['libraries', 'assets']) {
    await seedDirectoryIfMissing(resolveSharedDirectory(settings, dirName), path.join(minecraftHome, dirName))
  }
}

async function ensureFabricVersionProfile(settings, manifest) {
  const minecraftHome = getMinecraftHome()
  const versionId = getFabricVersionId(manifest)
  const versionDir = path.join(minecraftHome, 'versions', versionId)
  const versionJsonPath = path.join(versionDir, `${versionId}.json`)

  if (fs.existsSync(versionJsonPath)) {
    return versionId
  }

  const managedProfilePath = getManagedFabricProfilePath(settings, manifest)
  if (managedProfilePath && fs.existsSync(managedProfilePath)) {
    const raw = await fsp.readFile(managedProfilePath, 'utf8')
    const payload = JSON.parse(raw)
    const normalizedPayload = {
      ...payload,
      id: versionId,
      inheritsFrom: String(manifest.minecraftVersion || payload.inheritsFrom || '').trim() || payload.inheritsFrom
    }

    await fsp.mkdir(versionDir, { recursive: true })
    await fsp.writeFile(versionJsonPath, JSON.stringify(normalizedPayload, null, 2), 'utf8')
    return versionId
  }

  const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(manifest.minecraftVersion)}/${encodeURIComponent(manifest.fabricLoaderVersion)}/profile/json`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': APP_ID
    }
  })

  if (!response.ok) {
    throw new Error('Не удалось получить профиль Fabric для запуска клиента')
  }

  const payload = await response.json()
  if (!payload || typeof payload !== 'object' || !payload.id) {
    throw new Error('Fabric вернул некорректный профиль запуска')
  }

  await fsp.mkdir(versionDir, { recursive: true })
  await fsp.writeFile(versionJsonPath, JSON.stringify(payload, null, 2), 'utf8')
  return String(payload.id)
}

async function updateMinecraftLauncherProfile(settings, versionName, installDir, manifest, versionId) {
  const profilesPath = await resolveLauncherProfilesPath()
  const profileId = `royale-${sanitizeVersionName(versionName).toLowerCase()}`
  const now = new Date().toISOString()
  let payload = {}

  try {
    const raw = await fsp.readFile(profilesPath, 'utf8')
    payload = JSON.parse(raw)
  } catch {}

  payload.profiles = payload.profiles && typeof payload.profiles === 'object' ? payload.profiles : {}

  const current = payload.profiles[profileId] && typeof payload.profiles[profileId] === 'object'
    ? payload.profiles[profileId]
    : {}

  const nextProfile = {
    ...current,
    created: current.created || now,
    lastUsed: now,
    lastVersionId: versionId,
    name: manifest.profileName || `Royale Master ${versionName}`,
    type: current.type || 'custom',
    gameDir: resolveClientGameDir(installDir, manifest)
  }

  if (manifest.icon) {
    nextProfile.icon = manifest.icon
  }

  const javaArgs = buildLauncherJavaArgs(settings, resolveClientGameDir(installDir, manifest))
  if (javaArgs) {
    nextProfile.javaArgs = javaArgs
  } else {
    delete nextProfile.javaArgs
  }

  payload.profiles[profileId] = nextProfile
  payload.selectedProfile = profileId

  await fsp.mkdir(path.dirname(profilesPath), { recursive: true })
  await fsp.writeFile(profilesPath, JSON.stringify(payload, null, 2), 'utf8')

  return nextProfile
}

function findExistingPathFromText(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)

  return lines.find((candidate) => fs.existsSync(candidate)) || ''
}

function queryAppPathExecutable(registryKey) {
  try {
    const result = spawnSync('reg.exe', ['query', registryKey, '/ve'], {
      encoding: 'utf8',
      windowsHide: true
    })

    if (result.status !== 0) {
      return ''
    }

    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)

    const line = lines.find((item) => /REG_SZ/i.test(item))
    if (!line) {
      return ''
    }

    const match = line.match(/REG_SZ\s+(.+)$/i)
    const candidate = match ? match[1].trim() : ''
    return candidate && fs.existsSync(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

function findMinecraftLauncherAppxTarget() {
  try {
    const script = [
      "$packages = Get-AppxPackage -Name 'Microsoft.4297127D64EC6*' -ErrorAction SilentlyContinue",
      'foreach ($pkg in $packages) {',
      "  $manifestPath = Join-Path $pkg.InstallLocation 'AppxManifest.xml'",
      '  if (-not (Test-Path -LiteralPath $manifestPath)) { continue }',
      '  try {',
      '    [xml]$manifest = Get-Content -LiteralPath $manifestPath',
      "    $apps = Select-Xml -Xml $manifest -XPath '/*[local-name()=\"Package\"]/*[local-name()=\"Applications\"]/*[local-name()=\"Application\"]'",
      "    $preferred = $apps | Where-Object { $_.Node.Id -match 'Launcher|Minecraft' } | Select-Object -First 1",
      '    if (-not $preferred) { $preferred = $apps | Select-Object -First 1 }',
      '    if ($preferred -and $preferred.Node.Id) {',
      '      Write-Output \"$($pkg.PackageFamilyName)|$($preferred.Node.Id)\"',
      '      exit 0',
      '    }',
      '  } catch {}',
      '}'
    ].join('; ')

    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    })

    if (result.status !== 0) {
      return null
    }

    const output = String(result.stdout || '').trim()
    if (!output) {
      return null
    }

    const [packageFamilyName, appId] = output.split('|').map((item) => item.trim())
    if (!packageFamilyName || !appId) {
      return null
    }

    return {
      kind: 'appx',
      command: 'explorer.exe',
      args: [`shell:AppsFolder\\${packageFamilyName}!${appId}`]
    }
  } catch {
    return null
  }
}

function findMinecraftLauncherTarget() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env.ProgramFiles || '', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env.LocalAppData || '', 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env.LocalAppData || '', 'Microsoft', 'WindowsApps', 'MinecraftLauncher.exe')
  ].filter(Boolean)

  const directExecutable = candidates.find((candidate) => fs.existsSync(candidate))
  if (directExecutable) {
    return {
      kind: 'exe',
      command: directExecutable,
      args: []
    }
  }

  const appPathExecutable = queryAppPathExecutable('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\MinecraftLauncher.exe')
    || queryAppPathExecutable('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\MinecraftLauncher.exe')

  if (appPathExecutable) {
    return {
      kind: 'exe',
      command: appPathExecutable,
      args: []
    }
  }

  try {
    const result = spawnSync('where.exe', ['MinecraftLauncher.exe'], {
      encoding: 'utf8',
      windowsHide: true
    })
    const discoveredPath = result.status === 0 ? findExistingPathFromText(result.stdout) : ''
    if (discoveredPath) {
      return {
        kind: 'exe',
        command: discoveredPath,
        args: []
      }
    }
  } catch {}

  return findMinecraftLauncherAppxTarget()
}

async function launchClientInstance(settings, versionName, installDir) {
  setLaunchStatus('Проверяю файлы клиента...')
  const preparedClient = await prepareInstalledClientLayout(settings, installDir, versionName)
  if (!preparedClient) {
    return null
  }

  return launchManagedClient(settings, versionName, installDir, preparedClient)
}

async function prepareClientProfile(settings, versionName, installDir) {
  const preparedClient = await prepareInstalledClientLayout(settings, installDir, versionName)
  if (!preparedClient) {
    return null
  }

  await ensureManagedClientRuntime(settings, versionName, preparedClient.manifest, { stage: 'install' })
  await ensureManagedModsFromManifest(preparedClient.manifest, preparedClient.gameDir, { stage: 'install' })
  await fsp.writeFile(getClientManifestPath(installDir), JSON.stringify(preparedClient.manifest, null, 2), 'utf8')
  await syncSharedRuntimeToMinecraftHome(settings, preparedClient.manifest)
  const versionId = await ensureFabricVersionProfile(settings, preparedClient.manifest)
  await updateMinecraftLauncherProfile(settings, versionName, installDir, preparedClient.manifest, versionId)

  return {
    manifest: preparedClient.manifest,
    versionId
  }
}

async function checkLauncherUpdate() {
  const launcherConfig = await loadLauncherConfig()
  const currentVersion = app.getVersion()

  if (!launcherConfig.updateRepo) {
    return {
      available: false,
      version: '',
      url: launcherConfig.releasePage || '',
      currentVersion
    }
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${launcherConfig.updateRepo}/releases/latest`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': APP_ID
      }
    })

    if (!response.ok) {
      return { available: false, version: '', url: launcherConfig.releasePage || '', currentVersion }
    }

    const release = await response.json()
    const latestVersion = stripVersionPrefix(release.tag_name || release.name || '')
    const htmlUrl = String(release.html_url || launcherConfig.releasePage || '').trim()
    const assets = Array.isArray(release?.assets) ? release.assets : []
    const installerAsset = assets.find((asset) => String(asset?.name || '').toLowerCase() === 'royalelauncherinstaller.exe')
      || assets.find((asset) => String(asset?.name || '').toLowerCase().endsWith('.exe'))
    const installerUrl = String(installerAsset?.browser_download_url || '').trim()
    const installerName = String(installerAsset?.name || '').trim()

    return {
      available: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0,
      version: latestVersion,
      url: installerUrl || htmlUrl,
      pageUrl: htmlUrl,
      assetName: installerName,
      currentVersion
    }
  } catch {
    return {
      available: false,
      version: '',
      url: launcherConfig.releasePage || '',
      pageUrl: launcherConfig.releasePage || '',
      assetName: '',
      currentVersion
    }
  }
}

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''")
}

async function installLauncherUpdate() {
  const update = await checkLauncherUpdate()
  if (!update.available) {
    return { started: false, reason: 'up-to-date' }
  }

  if (!update.url || !/\.exe(\?|$)/i.test(update.url)) {
    throw new Error('Не найден installer для обновления лаунчера.')
  }

  const updateDir = path.join(app.getPath('temp'), 'RoyaleLauncherUpdate')
  const installerName = update.assetName || `RoyaleLauncherInstaller-v${update.version || app.getVersion()}.exe`
  const installerPath = path.join(updateDir, installerName)
  await downloadRemoteFile(update.url, installerPath)

  const currentExe = process.execPath
  const currentPid = process.pid
  const psScript = [
    `$installer = '${escapePowerShellSingleQuoted(installerPath)}'`,
    `$app = '${escapePowerShellSingleQuoted(currentExe)}'`,
    `$targetPid = ${currentPid}`,
    "while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 350 }",
    "Start-Process -FilePath $installer -ArgumentList '/S' -Wait",
    "Start-Process -FilePath $app"
  ].join('; ')

  const helper = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-Command',
    psScript
  ], {
    detached: true,
    stdio: 'ignore'
  })
  helper.unref()

  isQuitRequested = true
  setTimeout(() => app.quit(), 120)
  return { started: true, version: update.version }
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function setInstallStatus(message) {
  const normalizedMessage = String(message || '').trim()
  const controller = getInstallController()
  if (controller.resumeState) {
    controller.resumeState = {
      ...controller.resumeState,
      statusMessage: normalizedMessage
    }
  }
  emit('install:status', { message: normalizedMessage })
}

function setLaunchStatus(message) {
  emit('launch:status', { message: String(message || '').trim() })
}

function setInstallProgress(payload) {
  const progressPayload = {
    stage: payload.stage || 'idle',
    progress: Math.max(0, Math.min(1, Number(payload.progress) || 0)),
    current: Math.max(0, Number(payload.current) || 0),
    total: Math.max(0, Number(payload.total) || 0),
    section: String(payload.section || '').trim(),
    sectionCurrent: Math.max(0, Number(payload.sectionCurrent) || 0),
    sectionTotal: Math.max(0, Number(payload.sectionTotal) || 0),
    label: String(payload.label || '').trim()
  }

  const controller = getInstallController()
  if (controller.resumeState) {
    controller.resumeState = progressPayload.stage === 'download'
      ? {
        ...controller.resumeState,
        stage: progressPayload.stage,
        progress: progressPayload.progress,
        current: progressPayload.current,
        total: progressPayload.total,
        label: progressPayload.label || controller.resumeState.label || '',
        paused: controller.paused
      }
      : {
        ...controller.resumeState,
        stage: progressPayload.stage,
        progress: progressPayload.progress,
        label: progressPayload.label || controller.resumeState.label || '',
        paused: controller.paused
      }
  }

  emit('install:progress', progressPayload)
}

async function rimrafSafe(targetDir, rootDir) {
  const resolvedRoot = path.resolve(rootDir) + path.sep
  const resolvedTarget = path.resolve(targetDir) + path.sep
  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error('Целевая папка вышла за пределы Royale')
  }

  if (fs.existsSync(targetDir)) {
    await fsp.rm(targetDir, { recursive: true, force: true })
  }
}

function guessFileName(sourceValue, versionName) {
  if (isRemoteSource(sourceValue)) {
    try {
      const url = new URL(sourceValue)
      const fileName = path.basename(url.pathname)
      if (fileName) return fileName
    } catch {}
  } else if (sourceValue) {
    const fileName = path.basename(sourceValue)
    if (fileName) return fileName
  }

  return `Royale-${sanitizeVersionName(versionName)}.zip`
}

function openZipFile(zipPath) {
  return new Promise((resolve, reject) => {
    getYauzlModule().open(zipPath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
      if (error) {
        reject(error)
        return
      }

      resolve(zipFile)
    })
  })
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error)
        return
      }

      resolve(stream)
    })
  })
}

function pipeStreamToFile(readStream, destinationPath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destinationPath)
    const fail = (error) => reject(error)

    readStream.on('error', fail)
    writeStream.on('error', fail)
    writeStream.on('close', resolve)
    readStream.pipe(writeStream)
  })
}

function resolveArchiveEntryPath(rootDir, entryName) {
  const normalized = entryName.replace(/\\/g, '/')
  const destinationPath = path.resolve(rootDir, normalized)
  const resolvedRoot = path.resolve(rootDir) + path.sep

  if (destinationPath !== path.resolve(rootDir) && !destinationPath.startsWith(resolvedRoot)) {
    throw new Error('Архив пытается выйти из папки установки')
  }

  return destinationPath
}

function getArchiveSectionKey(entryName) {
  const normalized = String(entryName || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')

  const [firstSegment] = normalized.split('/')
  return ARCHIVE_SECTION_TITLES[firstSegment] ? firstSegment : 'files'
}

async function inspectZipFile(zipPath) {
  const zipFile = await openZipFile(zipPath)

  return new Promise((resolve, reject) => {
    let totalItems = 0
    const sectionTotals = {}

    zipFile.on('entry', (entry) => {
      if (!entry.fileName.endsWith('/')) {
        totalItems += 1
        const sectionKey = getArchiveSectionKey(entry.fileName)
        sectionTotals[sectionKey] = (sectionTotals[sectionKey] || 0) + 1
      }
      zipFile.readEntry()
    })

    zipFile.on('end', () => resolve({ totalItems: totalItems || 1, sectionTotals }))
    zipFile.on('error', reject)
    zipFile.readEntry()
  })
}

async function extractZipWithProgress(zipPath, installDir) {
  const { totalItems, sectionTotals } = await inspectZipFile(zipPath)
  const zipFile = await openZipFile(zipPath)
  const sectionProgress = {}

  setInstallProgress({
    stage: 'extract',
    progress: 0,
    current: 0,
    total: totalItems,
    label: 'Подготавливаю файлы клиента'
  })

  return new Promise((resolve, reject) => {
    let current = 0

    const fail = (error) => {
      try {
        if (typeof zipFile.close === 'function') {
          zipFile.close()
        }
      } catch {}

      reject(error)
    }

    zipFile.on('entry', (entry) => {
      handleEntry(entry).catch(fail)
    })

    zipFile.on('end', () => {
      setInstallProgress({
        stage: 'extract',
        progress: 1,
        current: totalItems,
        total: totalItems,
        label: 'Установка завершена'
      })
      resolve({ current: totalItems, total: totalItems })
    })

    zipFile.on('error', fail)
    zipFile.readEntry()

    async function handleEntry(entry) {
      await waitForInstallResumeIfNeeded()
      assertInstallNotCancelled()
      const destinationPath = resolveArchiveEntryPath(installDir, entry.fileName)

      if (entry.fileName.endsWith('/')) {
        await fsp.mkdir(destinationPath, { recursive: true })
        zipFile.readEntry()
        return
      }

      await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
      const readStream = await openZipEntryStream(zipFile, entry)
      await pipeStreamToFile(readStream, destinationPath)
      assertInstallNotCancelled()

      current += 1
      const sectionKey = getArchiveSectionKey(entry.fileName)
      const sectionCurrent = (sectionProgress[sectionKey] || 0) + 1
      const sectionTotal = sectionTotals[sectionKey] || 0
      const sectionTitle = ARCHIVE_SECTION_TITLES[sectionKey] || ARCHIVE_SECTION_TITLES.files
      const label = `Устанавливаю ${sectionTitle} ${sectionCurrent}/${sectionTotal || 1}`

      sectionProgress[sectionKey] = sectionCurrent
      setInstallStatus(label)
      setInstallProgress({
        stage: 'extract',
        progress: totalItems > 0 ? current / totalItems : 1,
        current,
        total: totalItems,
        section: sectionTitle,
        sectionCurrent,
        sectionTotal,
        label
      })

      zipFile.readEntry()
    }
  })
}

async function extractZipArchive(zipPath, destinationDir) {
  const zipFile = await openZipFile(zipPath)

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      try {
        if (typeof zipFile.close === 'function') {
          zipFile.close()
        }
      } catch {}

      reject(error)
    }

    zipFile.on('entry', (entry) => {
      handleEntry(entry).catch(fail)
    })

    zipFile.on('end', resolve)
    zipFile.on('error', fail)
    zipFile.readEntry()

    async function handleEntry(entry) {
      const destinationPath = resolveArchiveEntryPath(destinationDir, entry.fileName)

      if (entry.fileName.endsWith('/')) {
        await fsp.mkdir(destinationPath, { recursive: true })
        zipFile.readEntry()
        return
      }

      await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
      const readStream = await openZipEntryStream(zipFile, entry)
      await pipeStreamToFile(readStream, destinationPath)
      zipFile.readEntry()
    }
  })
}

async function downloadToFile(downloadUrl, outputPath, options = {}) {
  const versionName = String(options.versionName || '').trim()
  const sourceKey = String(options.sourceKey || downloadUrl || '').trim()
  const baseRequestOptions = options.requestOptions && typeof options.requestOptions === 'object'
    ? options.requestOptions
    : {}
  let received = Math.max(0, Number(options.resumeFrom) || 0)
  let total = Math.max(0, Number(options.total) || 0)
  let append = received > 0 && fs.existsSync(outputPath)
  const headers = {
    ...(baseRequestOptions.headers || {})
  }

  if (append && total > 0 && received >= total) {
    let remoteTotal = 0

    try {
      const headResponse = await fetchWithRetry(downloadUrl, {
        ...baseRequestOptions,
        method: 'HEAD'
      })
      remoteTotal = Math.max(0, Number(headResponse.headers.get('content-length')) || 0)
    } catch {}

    if (!(remoteTotal > 0 && remoteTotal === received)) {
      append = false
      received = 0
      total = 0
      await fsp.rm(outputPath, { force: true })
    }
  }

  if (append && total > 0 && received >= total) {
    const controller = getInstallController()
    controller.resumeState = {
      versionName,
      sourceUrl: sourceKey,
      tempFile: outputPath,
      stage: 'download',
      paused: controller.paused,
      progress: 1,
      current: received,
      total,
      label: 'Загружаю пакет',
      statusMessage: controller.resumeState?.statusMessage || '',
      updatedAt: new Date().toISOString()
    }

    setInstallProgress({
      stage: 'download',
      progress: 1,
      current: received,
      total,
      label: 'Загружаю пакет'
    })
    return
  }

  if (append) {
    headers.Range = `bytes=${received}-`
  }

  let response = await fetchWithRetry(downloadUrl, {
    ...baseRequestOptions,
    headers
  })
  if (append && response.status === 416) {
    append = false
    received = 0
    total = 0
    await fsp.rm(outputPath, { force: true })
    response = await fetchWithRetry(downloadUrl, {
      ...baseRequestOptions,
      headers: baseRequestOptions.headers || {}
    })
  }
  if (!response.ok || !response.body) {
    throw new Error(`Ошибка загрузки: ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length')) || 0
  if (append && response.status !== 206) {
    append = false
    received = 0
    total = 0
    await fsp.rm(outputPath, { force: true })
  }

  total = append
    ? Math.max(total, received + contentLength)
    : Math.max(total, contentLength)

  const reader = response.body.getReader()
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const stream = fs.createWriteStream(outputPath, { flags: append ? 'a' : 'w' })
  const controller = getInstallController()
  let lastPersistedAt = 0

  controller.resumeState = {
    versionName,
    sourceUrl: sourceKey,
    tempFile: outputPath,
    stage: 'download',
    paused: controller.paused,
    progress: total > 0 ? received / total : 0,
    current: received,
    total,
    label: 'Загружаю пакет',
    statusMessage: controller.resumeState?.statusMessage || '',
    updatedAt: new Date().toISOString()
  }

  await saveInstallResumeState({
    ...controller.resumeState,
    paused: controller.paused
  })

  async function persistResumeState(force = false) {
    if (!controller.resumeState) {
      return
    }

    const now = Date.now()
    if (!force && now - lastPersistedAt < 800) {
      return
    }

    lastPersistedAt = now
    controller.resumeState = {
      ...controller.resumeState,
      paused: controller.paused,
      updatedAt: new Date(now).toISOString()
    }
    await saveInstallResumeState(controller.resumeState)
  }

  setInstallProgress({
    stage: 'download',
    progress: total > 0 ? received / total : 0,
    current: received,
    total,
    label: 'Загружаю пакет'
  })

  while (true) {
    await waitForInstallResumeIfNeeded()
    assertInstallNotCancelled()
    const { done, value } = await reader.read()
    if (done) break
    stream.write(Buffer.from(value))
    received += value.length

    setInstallProgress({
      stage: 'download',
      progress: total > 0 ? received / total : 0,
      current: received,
      total
    })
    await persistResumeState()
  }

  await new Promise((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })

  setInstallProgress({
    stage: 'download',
    progress: 1,
    current: total > 0 ? total : received,
    total
  })

  controller.resumeState = {
    ...controller.resumeState,
    progress: 1,
    current: total > 0 ? total : received,
    total,
    paused: false,
    updatedAt: new Date().toISOString()
  }
  await persistResumeState(true)
}

async function installVersion(versionName) {
  if (installInFlight) {
    throw new Error('Установка уже выполняется')
  }

  installInFlight = true
  resetInstallController()
  let tempFile = ''

  try {
    const settings = await loadSettings()
    assertInstallNotCancelled()
    const version = settings.versions.find((entry) => entry.versionName === versionName)
    if (!version) {
      throw new Error('Версия не найдена')
    }

    const source = resolveSourceDescriptor(version.source)
    if (source.kind === 'none') {
      throw new Error('Источник для этой версии еще не подключен')
    }
    if (source.kind === 'local' && !source.exists) {
      throw new Error(`Локальный пакет не найден: ${source.value}`)
    }

    await ensureSharedMinecraftLayout(settings)
    const installDir = resolveVersionDirectory(settings, version.versionName)
    assertInstallNotCancelled()

    setInstallStatus(`Подготовка ${version.versionName}`)
    setInstallProgress({
      stage: 'prepare',
      progress: 0,
      current: 0,
      total: 0
    })
    await fsp.mkdir(installDir, { recursive: true })

    let installSourcePath = source.value

    if (source.kind === 'remote' || source.kind === 'github-release-asset') {
      const sourceRequest = await resolveSourceDownloadRequest(source)
      const fileName = guessFileName(sourceRequest.fileName || sourceRequest.url, version.versionName)
      const extension = path.extname(fileName).toLowerCase() || '.zip'
      const resumeState = await getResumableInstallState(version.versionName, getSourceDescriptorResumeKey(source))
      tempFile = resumeState?.tempFile || getInstallResumeTempFile(version.versionName, extension)
      setInstallStatus(`Загрузка ${version.versionName}`)
      await downloadToFile(sourceRequest.url, tempFile, {
        versionName: version.versionName,
        sourceKey: getSourceDescriptorResumeKey(source),
        requestOptions: sourceRequest.requestOptions,
        resumeFrom: resumeState?.current || 0,
        total: resumeState?.total || 0
      })
      assertInstallNotCancelled()
      installSourcePath = tempFile
    }

    const normalizedSourcePath = String(installSourcePath || '').toLowerCase()
    const extension = path.extname(installSourcePath).toLowerCase()
    const isZipSource = extension === '.zip' || normalizedSourcePath.endsWith('.zip.part')

    if (source.kind === 'local' && source.isDirectory) {
      await copyDirectorySourceToInstallDir(installSourcePath, installDir)
    } else if (isZipSource) {
      setInstallStatus(`Установка ${version.versionName}`)
      await extractZipWithProgress(installSourcePath, installDir)
    } else {
      const fileName = guessFileName(installSourcePath, version.versionName)
      setInstallStatus(`Копирование ${version.versionName}`)
      setInstallProgress({
        stage: 'copy',
        progress: 0,
        current: 0,
        total: 1
      })
      await fsp.copyFile(installSourcePath, path.join(installDir, fileName))
      setInstallProgress({
        stage: 'copy',
        progress: 1,
        current: 1,
        total: 1
      })
    }
    assertInstallNotCancelled()

    await prepareClientProfile(settings, version.versionName, installDir)

    const installedClient = await inspectInstalledClient(installDir, version.versionName)
    const installedState = {
      installDir,
      installed: installedClient.installed,
      launchableFile: installedClient.launchableFile,
      hasSource: source.kind === 'remote' || source.kind === 'github-release-asset' || source.exists,
      sourceKind: source.kind,
      title: version.title,
      channel: version.channel,
      notes: version.notes
    }
    setInstallStatus('')
    if (!installedState.installed) {
      throw new Error('Клиент установлен не полностью. Проверьте пакет версии и попробуйте ещё раз.')
    }

    await clearInstallResumeState()
    getInstallController().resumeState = null
    await recordLauncherEvent('install_success', { versionName: version.versionName })
    return installedState
  } catch (error) {
    await recordLauncherEvent('install_failure', {
      versionName,
      message: error instanceof Error ? error.message : String(error || '')
    })
    throw error
  } finally {
    installInFlight = false
    const controller = getInstallController()
    const keepPartialDownload = Boolean(
      !controller.cancelled
      && controller.resumeState?.stage === 'download'
      && controller.resumeState?.tempFile
      && fs.existsSync(controller.resumeState.tempFile)
      && controller.resumeState.current > 0
    )
    if (!keepPartialDownload) {
      controller.resumeState = null
      await clearInstallResumeState()
    }
    if (!keepPartialDownload && tempFile && fs.existsSync(tempFile)) {
      await fsp.rm(tempFile, { force: true })
    }
  }
}

function splitCommandLikeArgs(value) {
  const input = String(value || '').trim()
  if (!input) return []

  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) || []
  return matches.map((item) => item.replace(/^["']|["']$/g, ''))
}

function buildJavaArgs(settings, versionName, installDir, launchableFile) {
  const effectiveMemoryMb = resolveEffectiveMemoryMb(settings)
  const rawArgs = String(settings.javaArgs || '')
    .replaceAll('{installDir}', installDir)
    .replaceAll('{clientFile}', launchableFile)
    .replaceAll('{version}', versionName)
    .replaceAll('{memoryMb}', String(effectiveMemoryMb))

  const args = splitCommandLikeArgs(rawArgs)
  if (!args.some((item) => /^-Xmx/i.test(item))) {
    args.unshift(`-Xmx${effectiveMemoryMb}M`)
  }

  return args
}

async function startLaunchableFileProcess(settings, version, installDir, launchableFile) {
  const extension = path.extname(launchableFile).toLowerCase()
  const spawnOptions = {
    cwd: path.dirname(launchableFile),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }

  if (extension === '.jar') {
    const manifest = await loadClientManifest(installDir, version.versionName)
    const javaExecutable = await resolveJavaExecutable(settings, version.versionName, manifest)
    return spawn(javaExecutable, [...buildJavaArgs(settings, version.versionName, installDir, launchableFile), '-jar', launchableFile], spawnOptions)
  }

  if (extension === '.exe') {
    return spawn(launchableFile, [], spawnOptions)
  }

  throw new Error('Поддерживаются только .jar и .exe launch-файлы.')
}

async function launchVersion(versionName) {
  resetLaunchController()
  try {
  setLaunchStatus('Проверяю наличие обновлений...')
  setLaunchStatus('Проверяю запуск клиента...')
  const settings = await loadSettings()
  assertLaunchNotCancelled()
  const version = settings.versions.find((entry) => entry.versionName === versionName)
  if (!version) {
    throw new Error('Версия не найдена')
  }

  const installDir = resolveVersionDirectory(settings, version.versionName)
  const clientLaunch = await launchClientInstance(settings, version.versionName, installDir)
  if (clientLaunch?.ok) {
    await recordLauncherEvent('launch_success', { versionName: version.versionName })
    return clientLaunch
  }

  setLaunchStatus('Проверяю launch-файлы...')
  assertLaunchNotCancelled()
  const launchableFile = await findLaunchableFile(installDir)

  if (!launchableFile) {
    throw new Error('Файл для запуска не найден в папке версии')
  }

  const extension = path.extname(launchableFile).toLowerCase()
  let child = null
  assertLaunchNotCancelled()
  setLaunchStatus('Запускаю Minecraft...')
  if (extension === '.jar') {
    child = spawn('javaw', [...buildJavaArgs(settings, version.versionName, installDir, launchableFile), '-jar', launchableFile], {
      cwd: path.dirname(launchableFile),
      detached: true,
      stdio: 'ignore'
    })
  } else {
    child = spawn(launchableFile, [], {
      cwd: path.dirname(launchableFile),
      detached: true,
      stdio: 'ignore',
      shell: extension === '.cmd' || extension === '.bat'
    })
  }
  child.royaleVersionName = version.versionName
  child.royaleInstallDir = installDir
  trackLaunchedProcess(child, settings)
  child.unref()
  await recordLauncherEvent('launch_success', { versionName: version.versionName })
  return { ok: true, pid: child.pid || 0 }
  } catch (error) {
    setLaunchStatus('')
    await recordLauncherEvent('launch_failure', {
      versionName,
      message: error instanceof Error ? error.message : String(error || '')
    })
    throw error
  }
}

async function launchVersionFlow(versionName) {
  resetLaunchController()

  try {
    setLaunchStatus('РџСЂРѕРІРµСЂСЏСЋ Р·Р°РїСѓСЃРє РєР»РёРµРЅС‚Р°...')
    const settings = await loadSettings()
    assertLaunchNotCancelled()
    const version = settings.versions.find((entry) => entry.versionName === versionName)
    if (!version) {
      throw new Error('Р’РµСЂСЃРёСЏ РЅРµ РЅР°Р№РґРµРЅР°')
    }

    const installDir = resolveVersionDirectory(settings, version.versionName)
    assertLaunchNotCancelled()
    const clientLaunch = await launchClientInstance(settings, version.versionName, installDir)
    if (clientLaunch?.ok) {
      await recordLauncherEvent('launch_success', { versionName: version.versionName })
      return clientLaunch
    }

    setLaunchStatus('РџСЂРѕРІРµСЂСЏСЋ launch-С„Р°Р№Р»С‹...')
    assertLaunchNotCancelled()
    const launchableFile = await findLaunchableFile(installDir)

    if (!launchableFile) {
      throw new Error('Р¤Р°Р№Р» РґР»СЏ Р·Р°РїСѓСЃРєР° РЅРµ РЅР°Р№РґРµРЅ РІ РїР°РїРєРµ РІРµСЂСЃРёРё')
    }

  assertLaunchNotCancelled()
  setLaunchStatus('Р—Р°РїСѓСЃРєР°СЋ Minecraft...')
  const child = await startLaunchableFileProcess(settings, version, installDir, launchableFile)

    child.royaleVersionName = version.versionName
    child.royaleInstallDir = installDir
    trackLaunchedProcess(child, settings)
    child.unref()
    await recordLauncherEvent('launch_success', { versionName: version.versionName })
    return { ok: true, pid: child.pid || 0 }
  } catch (error) {
    setLaunchStatus('')
    await recordLauncherEvent('launch_failure', {
      versionName,
      message: error instanceof Error ? error.message : String(error || '')
    })
    throw error
  }
}

async function launchVersionTask(versionName) {
  resetLaunchController()

  const checkingClientStatus = '\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e \u0437\u0430\u043f\u0443\u0441\u043a \u043a\u043b\u0438\u0435\u043d\u0442\u0430...'
  const checkingLaunchFileStatus = '\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e launch-\u0444\u0430\u0439\u043b\u044b...'
  const launchingStatus = '\u0417\u0430\u043f\u0443\u0441\u043a\u0430\u044e Minecraft...'
  const versionMissingMessage = '\u0412\u0435\u0440\u0441\u0438\u044f \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430'
  const launchFileMissingMessage = '\u0424\u0430\u0439\u043b \u0434\u043b\u044f \u0437\u0430\u043f\u0443\u0441\u043a\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d \u0432 \u043f\u0430\u043f\u043a\u0435 \u0432\u0435\u0440\u0441\u0438\u0438'

  try {
    setLaunchStatus(checkingClientStatus)
    const settings = await loadSettings()
    assertLaunchNotCancelled()
    const version = settings.versions.find((entry) => entry.versionName === versionName)
    if (!version) {
      throw new Error(versionMissingMessage)
    }

    const installDir = resolveVersionDirectory(settings, version.versionName)
    assertLaunchNotCancelled()
    const clientLaunch = await launchClientInstance(settings, version.versionName, installDir)
    if (clientLaunch?.ok) {
      await recordLauncherEvent('launch_success', { versionName: version.versionName })
      return clientLaunch
    }

    setLaunchStatus(checkingLaunchFileStatus)
    assertLaunchNotCancelled()
    const launchableFile = await findLaunchableFile(installDir)

    if (!launchableFile) {
      throw new Error(launchFileMissingMessage)
    }

    assertLaunchNotCancelled()
    setLaunchStatus(launchingStatus)
    const child = await startLaunchableFileProcess(settings, version, installDir, launchableFile)

    child.royaleVersionName = version.versionName
    child.royaleInstallDir = installDir
    trackLaunchedProcess(child, settings)
    child.unref()
    await recordLauncherEvent('launch_success', { versionName: version.versionName })
    return { ok: true, pid: child.pid || 0 }
  } catch (error) {
    setLaunchStatus('')
    await recordLauncherEvent('launch_failure', {
      versionName,
      message: error instanceof Error ? error.message : String(error || '')
    })
    throw error
  }
}

async function launchVersion(versionName) {
  return launchVersionTask(versionName)
}

async function launchVersionFlowLegacy(versionName) {
  return launchVersionTask(versionName)
}

function parseCliArgs() {
  const args = process.argv.slice(1)
  const lookup = (prefix) => {
    const entry = args.find((item) => item.startsWith(prefix))
    return entry ? entry.slice(prefix.length) : ''
  }

  return {
    screenshotPath: lookup('--screenshot='),
    page: lookup('--page=') || 'home',
    smokeTestVersion: lookup('--smoke-test='),
    smokeInstallRoot: lookup('--smoke-install-root='),
    smokeLaunch: args.includes('--smoke-launch')
  }
}

async function withTemporarySettingsOverride(override, task) {
  const settingsPath = getSettingsPath()
  const hadSettingsFile = fs.existsSync(settingsPath)
  const backup = hadSettingsFile ? await fsp.readFile(settingsPath, 'utf8') : ''

  try {
    const current = await loadSettings()
    await saveSettings({ ...current, ...override })
    return await task()
  } finally {
    if (hadSettingsFile) {
      await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
      await fsp.writeFile(settingsPath, backup, 'utf8')
    } else {
      await fsp.rm(settingsPath, { force: true })
    }
    settingsCache = null
  }
}

async function runSmokeTest(cli) {
  const versionName = String(cli.smokeTestVersion || '').trim()
  if (!versionName) {
    throw new Error('Не указана версия для smoke-test')
  }

  const installRoot = cli.smokeInstallRoot
    ? path.resolve(cli.smokeInstallRoot)
    : path.join(app.getPath('temp'), 'royale-launcher-smoke')

  const result = await withTemporarySettingsOverride({
    installFolder: installRoot,
    lastSelectedVersion: versionName
  }, async () => {
    const installedState = await installVersion(versionName)
    let launchTriggered = false

    if (cli.smokeLaunch) {
      await launchVersionTask(versionName)
      launchTriggered = true
    }

    const finalState = await getVersionState(versionName)
    return {
      versionName,
      installRoot,
      installedState,
      finalState,
      launchTriggered
    }
  })

  console.log(JSON.stringify({
    ok: true,
    ...result
  }, null, 2))
}

function resolveRendererUrl(page) {
  const query = `?page=${encodeURIComponent(page)}`
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    return `${process.env.VITE_DEV_SERVER_URL}${query}`
  }

  return `${pathToFileURL(path.join(__dirname, '..', 'dist-renderer', 'index.html')).toString()}${query}`
}

function destroyTray() {
  if (!tray) {
    return
  }

  tray.destroy()
  tray = null
}

function stopRunningClientWatcher() {
  if (runningClientWatcher) {
    clearInterval(runningClientWatcher)
    runningClientWatcher = null
  }
}

function startRunningClientWatcher(pid, settings) {
  stopRunningClientWatcher()
  const expectedPid = Math.max(0, Number(pid) || 0)
  if (!expectedPid) {
    return
  }

  runningClientWatcher = setInterval(async () => {
    if (isPidAlive(expectedPid)) {
      return
    }

    stopRunningClientWatcher()
    await clearRunningClientState(expectedPid).catch(() => {})
    const reopenOnExit = settings?.reopenLauncherOnGameExit !== false
    if (reopenOnExit && tray) {
      showMainWindow()
    } else {
      destroyTray()
    }
  }, 3000)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.show()
  mainWindow.focus()
  destroyTray()
}

function ensureTray() {
  if (tray) {
    return tray
  }

  tray = new Tray(getTrayIconInput())
  tray.setToolTip('Royale Launcher')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Открыть',
      click: () => showMainWindow()
    },
    {
      type: 'separator'
    },
    {
      label: 'Выход',
      click: () => {
        isQuitRequested = true
        destroyTray()
        app.quit()
      }
    }
  ]))
  tray.on('click', () => showMainWindow())
  return tray
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  ensureTray()
  mainWindow.hide()
}

async function shouldKeepLauncherAliveInTray() {
  const runningClient = await getActiveRunningClientState()
  return Boolean(runningClient?.pid)
}

function trackLaunchedProcess(child, settings) {
  if (!child) {
    return
  }

  const hideOnLaunch = settings.hideLauncherOnGameLaunch !== false
  const reopenOnExit = settings.reopenLauncherOnGameExit !== false

  if (child.pid) {
    saveRunningClientState({
      versionName: child.royaleVersionName || '',
      installDir: child.royaleInstallDir || '',
      pid: child.pid,
      startedAt: new Date().toISOString()
    }).catch(() => {})
    startRunningClientWatcher(child.pid, settings)
  }

  if (hideOnLaunch) {
    hideMainWindowToTray()
  }

  child.once('exit', () => {
    stopRunningClientWatcher()
    setLaunchStatus('')
    clearRunningClientState(child.pid || 0).catch(() => {})

    const windowHiddenToTray = Boolean(tray) || (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible())
    if (windowHiddenToTray) {
      if (reopenOnExit) {
        showMainWindow()
      }
      return
    }

    destroyTray()
  })
}

function createWindow() {
  const cli = parseCliArgs()
  const windowIcon = getWindowIcon()
  const delayInitialShow = Boolean(cli.screenshotPath)

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 790,
    minWidth: 1140,
    minHeight: 720,
    frame: false,
    show: !delayInitialShow,
    backgroundColor: '#07090d',
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
      devTools: !app.isPackaged
    }
  })

  if (windowIcon) {
    mainWindow.setIcon(windowIcon)
  }

  mainWindow.on('close', (event) => {
    if (isQuitRequested || closeInterceptInFlight) {
      return
    }

    event.preventDefault()
    closeInterceptInFlight = true

    shouldKeepLauncherAliveInTray()
      .then((keepInTray) => {
        if (keepInTray) {
          hideMainWindowToTray()
          return
        }

        isQuitRequested = true
        destroyTray()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.close()
        }
      })
      .catch(() => {
        isQuitRequested = true
        destroyTray()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.close()
        }
      })
      .finally(() => {
        closeInterceptInFlight = false
      })
  })

  mainWindow.once('closed', () => {
    mainWindow = null
  })

  setTimeout(() => {
    recordLauncherEvent('session_start').catch(() => {})
  }, 4000)
  mainWindow.loadURL(resolveRendererUrl(cli.page))

  if (delayInitialShow) {
    mainWindow.once('ready-to-show', async () => {
      mainWindow.show()
      if (cli.screenshotPath) {
        await new Promise((resolve) => setTimeout(resolve, 1700))
        const image = await mainWindow.webContents.capturePage()
        await fsp.mkdir(path.dirname(cli.screenshotPath), { recursive: true })
        await fsp.writeFile(cli.screenshotPath, image.toPNG())
        app.quit()
      }
    })
  }
}

app.whenReady().then(async () => {
  const cli = parseCliArgs()

  await migrateLegacyUserData().catch(() => {})
  cleanupLegacyInstallDirectory().catch(() => {})

  if (cli.smokeTestVersion) {
    try {
      await runSmokeTest(cli)
      app.quit()
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      app.exit(1)
    }
    return
  }

  createWindow()
  setTimeout(() => {
    Promise.allSettled([ensureVersionCatalog(), ensureLauncherConfig(), ensureSettings()]).catch(() => {})
  }, 1800)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitRequested = true
  stopRunningClientWatcher()
})

app.on('window-all-closed', () => {
  destroyTray()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

ipcMain.handle('settings:get', async () => loadSettings())
ipcMain.handle('settings:save', async (_event, payload) => saveSettings(payload))
ipcMain.handle('launcher:get-bootstrap', async () => getBootstrapPayload())
ipcMain.handle('system:get-memory-profile', async () => getMemoryProfile())
ipcMain.handle('system:get-storage-info', async (_event, targetPath) => getStorageInfo(targetPath))
ipcMain.handle('launcher:check-update', async () => checkLauncherUpdate())
ipcMain.handle('launcher:install-update', async () => installLauncherUpdate())
ipcMain.handle('dialog:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? '' : result.filePaths[0]
})
ipcMain.handle('shell:open-folder', async (_event, targetPath) => {
  if (targetPath) {
    await fsp.mkdir(targetPath, { recursive: true })
    await shell.openPath(targetPath)
  }
  return true
})
ipcMain.handle('shell:open-external', async (_event, targetUrl) => {
  if (targetUrl) {
    await shell.openExternal(targetUrl)
  }
  return true
})
ipcMain.handle('stats:get-dashboard', async (_event, versionName) => getStatsDashboard(versionName))
ipcMain.handle('version:get-state', async (_event, versionName) => getVersionState(versionName))
ipcMain.handle('java:get-status', async (_event, versionName) => getJavaStatusForVersion(versionName))
ipcMain.handle('java:install', async (_event, versionName) => {
  const settings = await loadSettings()
  const installDir = resolveVersionDirectory(settings, versionName)
  const manifest = await loadClientManifest(installDir, versionName)
  return installJavaRuntime(settings, versionName, manifest)
})
ipcMain.handle('version:install', async (_event, versionName) => installVersion(versionName))
ipcMain.handle('version:pause-install', async (_event, paused) => pauseInstallFlow(paused))
ipcMain.handle('version:cancel-install', async () => {
  await cancelInstallFlow()
  return true
})
ipcMain.handle('version:launch', async (_event, versionName) => launchVersionTask(versionName))
ipcMain.handle('version:cancel-launch', async () => {
  cancelLaunchFlow()
  return true
})
ipcMain.handle('window:action', async (_event, action) => {
  if (!mainWindow) return false
  if (action === 'minimize') mainWindow.minimize()
  if (action === 'close') mainWindow.close()
  return true
})
