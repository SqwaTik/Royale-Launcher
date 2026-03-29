const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const { spawn } = require('child_process')
const yauzl = require('yauzl')
const { pathToFileURL } = require('url')

let mainWindow = null
let installInFlight = false

const APP_ID = 'com.royale.launcher'
const BUNDLED_VERSION_CATALOG_PATH = path.join(__dirname, 'version-catalog.json')
const BUNDLED_LAUNCHER_CONFIG_PATH = path.join(__dirname, 'launcher-config.json')

function getDefaultInstallFolder() {
  return process.platform === 'win32' ? 'C:\\Royale' : path.join(os.homedir(), 'Royale')
}

const DEFAULT_SETTINGS = {
  installFolder: getDefaultInstallFolder(),
  javaArgs: '',
  memoryMb: 4096,
  lastSelectedVersion: '1.21.11'
}

const DEFAULT_LAUNCHER_CONFIG = {
  updateRepo: 'SqwaTik/Royale-Launcher',
  releasePage: 'https://github.com/SqwaTik/Royale-Launcher/releases/latest'
}

const DEFAULT_VERSION_CATALOG = [
  {
    versionName: '1.21.11',
    channel: 'Основная сборка',
    title: 'Royale Master',
    source: 'https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/1.21.11.zip',
    notes: 'Готовая сборка Royale Master для модифицированного Minecraft-клиента.'
  },
  {
    versionName: '26.1',
    channel: 'Скоро',
    title: 'Версия готовится',
    source: '',
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
    icon: 'Grass'
  },
  '26.1': {
    type: 'fabric-instance',
    profileName: 'Royale Master 26.1',
    minecraftVersion: '26.1',
    fabricLoaderVersion: '0.18.5',
    gameDir: '.',
    icon: 'Grass'
  },
  '1.21.4': {
    type: 'fabric-instance',
    profileName: 'Royale Master 1.21.4',
    minecraftVersion: '1.21.4',
    fabricLoaderVersion: '0.18.5',
    gameDir: '.',
    icon: 'Grass'
  },
  '1.16.5': {
    type: 'fabric-instance',
    profileName: 'Royale Master 1.16.5',
    minecraftVersion: '1.16.5',
    fabricLoaderVersion: '0.18.4',
    gameDir: '.',
    icon: 'Grass'
  }
}

function getWindowIcon() {
  const candidates = [
    path.join(app.getAppPath(), 'dist-renderer', 'launcher-mark.png'),
    path.join(app.getAppPath(), 'public', 'launcher-mark.png'),
    path.join(__dirname, '..', 'dist-renderer', 'launcher-mark.png'),
    path.join(__dirname, '..', 'public', 'launcher-mark.png'),
    path.join(__dirname, '..', 'build', 'icon.ico')
  ]

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const image = nativeImage.createFromPath(candidate)
      if (!image.isEmpty()) {
        return image
      }
    } catch {}
  }

  return undefined
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'launcher-settings.json')
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

function sanitizeVersionName(value) {
  const cleaned = String(value ?? '').trim().replace(/,/g, '.')
  return cleaned.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'default'
}

function normalizeCatalog(input) {
  const items = Array.isArray(input) ? input : DEFAULT_VERSION_CATALOG

  const normalized = items
    .map((item) => ({
      versionName: sanitizeVersionName(item?.versionName),
      channel: String(item?.channel ?? '').trim() || 'Каталог',
      title: String(item?.title ?? '').trim() || 'Royale Build',
      source: String(item?.source ?? '').trim(),
      notes: String(item?.notes ?? '').trim()
    }))
    .filter((item) => item.versionName)
    .filter((item, index, list) => list.findIndex((entry) => entry.versionName.toLowerCase() === item.versionName.toLowerCase()) === index)

  return normalized.length ? normalized : DEFAULT_VERSION_CATALOG
}

function normalizeSettings(input) {
  const payload = input && typeof input === 'object' ? input : {}

  return {
    installFolder: String(payload.installFolder || DEFAULT_SETTINGS.installFolder).trim() || DEFAULT_SETTINGS.installFolder,
    javaArgs: String(payload.javaArgs ?? payload.launchCommand ?? '').trim(),
    memoryMb: Math.max(1024, Number(payload.memoryMb) || DEFAULT_SETTINGS.memoryMb),
    lastSelectedVersion: String(payload.lastSelectedVersion || DEFAULT_SETTINGS.lastSelectedVersion).trim() || DEFAULT_SETTINGS.lastSelectedVersion
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
  await ensureVersionCatalog()
  const raw = await fsp.readFile(getVersionCatalogPath(), 'utf8')
  return normalizeCatalog(JSON.parse(raw))
}

async function loadLauncherConfig() {
  await ensureLauncherConfig()
  const raw = await fsp.readFile(getLauncherConfigPath(), 'utf8')
  return normalizeLauncherConfig(JSON.parse(raw))
}

async function loadSettings() {
  await ensureVersionCatalog()
  await ensureSettings()
  const [rawSettings, catalog] = await Promise.all([
    fsp.readFile(getSettingsPath(), 'utf8'),
    loadVersionCatalog()
  ])

  return mergeSettingsWithCatalog(normalizeSettings(JSON.parse(rawSettings)), catalog)
}

async function saveSettings(nextSettings) {
  await ensureVersionCatalog()
  const catalog = await loadVersionCatalog()
  const normalized = mergeSettingsWithCatalog(normalizeSettings(nextSettings), catalog)
  const payload = {
    installFolder: normalized.installFolder,
    javaArgs: normalized.javaArgs,
    memoryMb: normalized.memoryMb,
    lastSelectedVersion: normalized.lastSelectedVersion
  }

  await fsp.mkdir(path.dirname(getSettingsPath()), { recursive: true })
  await fsp.writeFile(getSettingsPath(), JSON.stringify(payload, null, 2), 'utf8')
  return normalized
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
    gameDir: normalizeRelativeGamePath(payload.gameDir ?? fallback?.gameDir ?? '.'),
    icon: String(payload.icon || fallback?.icon || '').trim()
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

async function removeRoyaleModJars(targetModsDir) {
  try {
    const entries = await fsp.readdir(targetModsDir, { withFileTypes: true })
    await Promise.all(entries
      .filter((entry) => entry.isFile() && /^royale-.*\.jar$/i.test(entry.name))
      .map((entry) => fsp.rm(path.join(targetModsDir, entry.name), { force: true })))
  } catch {}
}

async function moveLegacyClientFilesIntoGameDir(installDir, gameDir) {
  for (const name of CLIENT_GAME_DIRS) {
    const sourcePath = path.join(installDir, name)
    if (!fs.existsSync(sourcePath)) continue

    const destinationPath = path.join(gameDir, name)
    if (path.resolve(sourcePath) === path.resolve(destinationPath)) continue

    if (name === 'mods') {
      await fsp.mkdir(destinationPath, { recursive: true })
      await removeRoyaleModJars(destinationPath)
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
    const royaleJar = await findMatchingFile(modsDir, /^royale-.*\.jar$/i)
    const fabricApiJar = await findMatchingFile(modsDir, /^fabric-api-.*\.jar$/i)
    const launchableFile = await findMatchingFile(installDir, /^launch\.(bat|cmd)$/i)

    return {
      installed: Boolean(royaleJar && fabricApiJar),
      launchableFile: launchableFile || royaleJar || ''
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
  const preferredExtensions = ['.exe', '.bat', '.cmd', '.jar']

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

function resolveSourceDescriptor(source) {
  const value = String(source ?? '').trim()
  if (!value) {
    return { kind: 'none', value: '' }
  }

  if (isRemoteSource(value)) {
    return { kind: 'remote', value }
  }

  const candidates = resolveLocalSourceCandidates(value)
  const localMatch = candidates.find((candidate) => fs.existsSync(candidate))
  const localStats = localMatch ? fs.statSync(localMatch) : null
  return {
    kind: 'local',
    value: localMatch || candidates[0] || value,
    exists: Boolean(localMatch),
    isDirectory: Boolean(localStats?.isDirectory())
  }
}

async function getVersionState(versionName) {
  const settings = await loadSettings()
  const version = settings.versions.find((entry) => entry.versionName === versionName) || settings.versions[0]
  const installDir = resolveVersionDirectory(settings, version.versionName)
  const installedClient = await inspectInstalledClient(installDir, version.versionName)
  const source = resolveSourceDescriptor(version.source)

  return {
    installDir,
    installed: installedClient.installed,
    launchableFile: installedClient.launchableFile,
    hasSource: source.kind === 'remote' || source.exists,
    sourceKind: source.kind,
    title: version.title,
    channel: version.channel,
    notes: version.notes
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

function getMemoryProfile() {
  const totalMemoryMb = Math.max(2048, Math.round(os.totalmem() / (1024 * 1024)))
  const safeBudgetMb = Math.max(2048, totalMemoryMb - 3072)
  const halfMemoryMb = Math.max(2048, Math.floor(totalMemoryMb * 0.5))
  const rawRecommendedMb = Math.min(safeBudgetMb, halfMemoryMb, 8192)
  const recommendedMemoryMb = Math.max(2048, Math.floor(rawRecommendedMb / 512) * 512 || 2048)

  return {
    totalMemoryMb,
    recommendedMemoryMb
  }
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

function buildLauncherJavaArgs(settings) {
  const args = splitCommandLikeArgs(String(settings.javaArgs || '').replaceAll('{memoryMb}', String(settings.memoryMb)))
  if (!args.some((item) => /^-Xmx/i.test(item))) {
    args.unshift(`-Xmx${settings.memoryMb}M`)
  }

  return args.join(' ').trim()
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

  const javaArgs = buildLauncherJavaArgs(settings)
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

function findMinecraftLauncherExecutable() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env.ProgramFiles || '', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env.LocalAppData || '', 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env.LocalAppData || '', 'Microsoft', 'WindowsApps', 'MinecraftLauncher.exe')
  ].filter(Boolean)

  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

async function launchClientInstance(settings, versionName, installDir) {
  const preparedClient = await prepareInstalledClientLayout(settings, installDir, versionName)
  if (!preparedClient) {
    return false
  }

  await syncSharedRuntimeToMinecraftHome(settings, preparedClient.manifest)
  const versionId = await ensureFabricVersionProfile(settings, preparedClient.manifest)
  await updateMinecraftLauncherProfile(settings, versionName, installDir, preparedClient.manifest, versionId)

  const launcherExecutable = findMinecraftLauncherExecutable()
  if (!launcherExecutable) {
    throw new Error('Minecraft Launcher не найден. Установите его и попробуйте снова.')
  }

  spawn(launcherExecutable, [], {
    detached: true,
    stdio: 'ignore'
  }).unref()

  return true
}

async function prepareClientProfile(settings, versionName, installDir) {
  const preparedClient = await prepareInstalledClientLayout(settings, installDir, versionName)
  if (!preparedClient) {
    return null
  }

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

    return {
      available: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0,
      version: latestVersion,
      url: htmlUrl,
      currentVersion
    }
  } catch {
    return {
      available: false,
      version: '',
      url: launcherConfig.releasePage || '',
      currentVersion
    }
  }
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function setInstallStatus(message) {
  emit('install:status', { message })
}

function setInstallProgress(payload) {
  emit('install:progress', {
    stage: payload.stage || 'idle',
    progress: Math.max(0, Math.min(1, Number(payload.progress) || 0)),
    current: Math.max(0, Number(payload.current) || 0),
    total: Math.max(0, Number(payload.total) || 0)
  })
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
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
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

async function inspectZipFile(zipPath) {
  const zipFile = await openZipFile(zipPath)

  return new Promise((resolve, reject) => {
    let totalItems = 0

    zipFile.on('entry', (entry) => {
      if (!entry.fileName.endsWith('/')) {
        totalItems += 1
      }
      zipFile.readEntry()
    })

    zipFile.on('end', () => resolve({ totalItems: totalItems || 1 }))
    zipFile.on('error', reject)
    zipFile.readEntry()
  })
}

async function extractZipWithProgress(zipPath, installDir) {
  const { totalItems } = await inspectZipFile(zipPath)
  const zipFile = await openZipFile(zipPath)

  setInstallProgress({
    stage: 'extract',
    progress: 0,
    current: 0,
    total: totalItems
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
        total: totalItems
      })
      resolve({ current: totalItems, total: totalItems })
    })

    zipFile.on('error', fail)
    zipFile.readEntry()

    async function handleEntry(entry) {
      const destinationPath = resolveArchiveEntryPath(installDir, entry.fileName)

      if (entry.fileName.endsWith('/')) {
        await fsp.mkdir(destinationPath, { recursive: true })
        zipFile.readEntry()
        return
      }

      await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
      const readStream = await openZipEntryStream(zipFile, entry)
      await pipeStreamToFile(readStream, destinationPath)

      current += 1
      setInstallProgress({
        stage: 'extract',
        progress: totalItems > 0 ? current / totalItems : 1,
        current,
        total: totalItems
      })

      zipFile.readEntry()
    }
  })
}

async function downloadToFile(downloadUrl, outputPath) {
  const response = await fetch(downloadUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Ошибка загрузки: ${response.status}`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const stream = fs.createWriteStream(outputPath)
  let received = 0

  setInstallProgress({
    stage: 'download',
    progress: 0,
    current: 0,
    total
  })

  while (true) {
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
}

async function installVersion(versionName) {
  if (installInFlight) {
    throw new Error('Установка уже выполняется')
  }

  installInFlight = true
  let tempFile = ''

  try {
    const settings = await loadSettings()
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

    setInstallStatus(`Подготовка ${version.versionName}`)
    setInstallProgress({
      stage: 'prepare',
      progress: 0,
      current: 0,
      total: 0
    })
    await fsp.mkdir(installDir, { recursive: true })

    let installSourcePath = source.value

    if (source.kind === 'remote') {
      const fileName = guessFileName(source.value, version.versionName)
      const extension = path.extname(fileName).toLowerCase() || '.zip'
      tempFile = path.join(os.tmpdir(), `royale-${Date.now()}${extension}`)
      setInstallStatus(`Загрузка ${version.versionName}`)
      await downloadToFile(source.value, tempFile)
      installSourcePath = tempFile
    }

    const extension = path.extname(installSourcePath).toLowerCase()

    if (source.kind === 'local' && source.isDirectory) {
      await copyDirectorySourceToInstallDir(installSourcePath, installDir)
    } else if (extension === '.zip') {
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

    try {
      await prepareClientProfile(settings, version.versionName, installDir)
    } catch {}

    const installedState = await getVersionState(version.versionName)
    setInstallStatus('')
    if (!installedState.installed) {
      throw new Error('Клиент установлен не полностью. Проверьте пакет версии и попробуйте ещё раз.')
    }

    return installedState
  } finally {
    installInFlight = false
    if (tempFile && fs.existsSync(tempFile)) {
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
  const rawArgs = String(settings.javaArgs || '')
    .replaceAll('{installDir}', installDir)
    .replaceAll('{clientFile}', launchableFile)
    .replaceAll('{version}', versionName)
    .replaceAll('{memoryMb}', String(settings.memoryMb))

  const args = splitCommandLikeArgs(rawArgs)
  if (!args.some((item) => /^-Xmx/i.test(item))) {
    args.unshift(`-Xmx${settings.memoryMb}M`)
  }

  return args
}

async function launchVersion(versionName) {
  const settings = await loadSettings()
  const version = settings.versions.find((entry) => entry.versionName === versionName)
  if (!version) {
    throw new Error('Версия не найдена')
  }

  const installDir = resolveVersionDirectory(settings, version.versionName)
  const launchedAsClient = await launchClientInstance(settings, version.versionName, installDir)
  if (launchedAsClient) {
    return { ok: true }
  }

  const launchableFile = await findLaunchableFile(installDir)

  if (!launchableFile) {
    throw new Error('Файл для запуска не найден в папке версии')
  }

  const extension = path.extname(launchableFile).toLowerCase()
  if (extension === '.jar') {
    spawn('javaw', [...buildJavaArgs(settings, version.versionName, installDir, launchableFile), '-jar', launchableFile], {
      cwd: path.dirname(launchableFile),
      detached: true,
      stdio: 'ignore'
    }).unref()
  } else {
    spawn(launchableFile, [], {
      cwd: path.dirname(launchableFile),
      detached: true,
      stdio: 'ignore',
      shell: extension === '.cmd' || extension === '.bat'
    }).unref()
  }

  return { ok: true }
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
      await launchVersion(versionName)
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

function createWindow() {
  const cli = parseCliArgs()
  const windowIcon = getWindowIcon()

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 790,
    minWidth: 1140,
    minHeight: 720,
    frame: false,
    show: false,
    backgroundColor: '#07090d',
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (windowIcon) {
    mainWindow.setIcon(windowIcon)
  }

  mainWindow.loadURL(resolveRendererUrl(cli.page))

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

app.whenReady().then(async () => {
  const cli = parseCliArgs()
  app.setAppUserModelId(APP_ID)
  Menu.setApplicationMenu(null)
  await Promise.all([ensureVersionCatalog(), ensureLauncherConfig(), ensureSettings()])

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

ipcMain.handle('settings:get', async () => loadSettings())
ipcMain.handle('settings:save', async (_event, payload) => saveSettings(payload))
ipcMain.handle('system:get-memory-profile', async () => getMemoryProfile())
ipcMain.handle('system:get-storage-info', async (_event, targetPath) => getStorageInfo(targetPath))
ipcMain.handle('launcher:check-update', async () => checkLauncherUpdate())
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
ipcMain.handle('version:get-state', async (_event, versionName) => getVersionState(versionName))
ipcMain.handle('version:install', async (_event, versionName) => installVersion(versionName))
ipcMain.handle('version:launch', async (_event, versionName) => launchVersion(versionName))
ipcMain.handle('window:action', async (_event, action) => {
  if (!mainWindow) return false
  if (action === 'minimize') mainWindow.minimize()
  if (action === 'close') mainWindow.close()
  return true
})
