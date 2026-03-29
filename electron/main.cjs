const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
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

const DEFAULT_SETTINGS = {
  installFolder: 'C:\\Royale',
  javaArgs: '',
  memoryMb: 4096,
  lastSelectedVersion: '1.21.11'
}

const DEFAULT_LAUNCHER_CONFIG = {
  updateRepo: '',
  releasePage: ''
}

const DEFAULT_VERSION_CATALOG = [
  {
    versionName: '1.21.11',
    channel: 'Основная сборка',
    title: 'Royale Master',
    source: 'client-assets/1.21.11.zip',
    notes: 'Главная актуальная версия клиента.'
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

function resolveVersionDirectory(settings, versionName) {
  return path.join(settings.installFolder, sanitizeVersionName(versionName))
}

async function directoryHasFiles(dir) {
  try {
    const entries = await fsp.readdir(dir)
    return entries.length > 0
  } catch {
    return false
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
  return {
    kind: 'local',
    value: localMatch || candidates[0] || value,
    exists: Boolean(localMatch)
  }
}

async function getVersionState(versionName) {
  const settings = await loadSettings()
  const version = settings.versions.find((entry) => entry.versionName === versionName) || settings.versions[0]
  const installDir = resolveVersionDirectory(settings, version.versionName)
  const installed = await directoryHasFiles(installDir)
  const launchableFile = installed ? await findLaunchableFile(installDir) : ''
  const source = resolveSourceDescriptor(version.source)

  return {
    installDir,
    installed,
    launchableFile,
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

    await fsp.mkdir(settings.installFolder, { recursive: true })
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

    if (extension === '.zip') {
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

    setInstallStatus('Установка завершена')
    return getVersionState(version.versionName)
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
    page: lookup('--page=') || 'home'
  }
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

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 790,
    minWidth: 1140,
    minHeight: 720,
    frame: false,
    show: false,
    backgroundColor: '#07090d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadURL(resolveRendererUrl(cli.page))

  mainWindow.once('ready-to-show', async () => {
    mainWindow.show()
    if (cli.screenshotPath) {
      await new Promise((resolve) => setTimeout(resolve, 900))
      const image = await mainWindow.webContents.capturePage()
      await fsp.mkdir(path.dirname(cli.screenshotPath), { recursive: true })
      await fsp.writeFile(cli.screenshotPath, image.toPNG())
      app.quit()
    }
  })
}

app.whenReady().then(async () => {
  app.setAppUserModelId(APP_ID)
  Menu.setApplicationMenu(null)
  await Promise.all([ensureVersionCatalog(), ensureLauncherConfig(), ensureSettings()])
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
