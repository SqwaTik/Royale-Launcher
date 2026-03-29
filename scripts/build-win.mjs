import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const buildOutputRoot = path.resolve(projectRoot, '..', 'Royale-Launcher-Build')
const distRoot = path.join(projectRoot, 'dist-app')
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const mode = String(process.argv[2] || 'offline').toLowerCase()
const arch = String(process.argv[3] || 'x64').toLowerCase()
const SUPPORTED_MODES = new Set(['offline', 'portable'])

if (!SUPPORTED_MODES.has(mode)) {
  throw new Error(`Unsupported Windows build mode: ${mode}`)
}

function getUnpackedDir() {
  return path.join(distRoot, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    ...options
  })

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function getToolPath(...segments) {
  return path.join(projectRoot, ...segments)
}

function getBuilderTarget(currentMode) {
  if (currentMode === 'portable') return 'portable'
  return 'nsis'
}

function patchWindowsExecutable(executablePath) {
  if (process.platform !== 'win32' || !existsSync(executablePath)) {
    return
  }

  const rceditPath = getToolPath('node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
  if (!existsSync(rceditPath)) {
    throw new Error('rcedit.exe was not found')
  }

  const args = [
    executablePath,
    '--set-icon',
    getToolPath('build', 'icon.ico'),
    '--set-version-string',
    'ProductName',
    'Royale Launcher',
    '--set-version-string',
    'FileDescription',
    'Royale Launcher',
    '--set-version-string',
    'CompanyName',
    'sqwat',
    '--set-file-version',
    version,
    '--set-product-version',
    version
  ]

  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = spawnSync(rceditPath, args, {
      cwd: projectRoot,
      stdio: 'pipe',
      shell: false,
      encoding: 'utf8'
    })
    if (result.status === 0) {
      return
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    lastError = new Error(output || `rcedit failed with code ${result.status ?? 'unknown'}`)
    sleep(1500)
  }

  throw lastError || new Error('Unable to patch Royale Launcher.exe')
}

function listArtifacts() {
  if (!existsSync(distRoot)) {
    return []
  }

  const stack = [distRoot]
  const files = []

  while (stack.length > 0) {
    const currentDir = stack.pop()
    for (const entryName of readdirSync(currentDir)) {
      const entryPath = path.join(currentDir, entryName)
      const stats = statSync(entryPath)
      if (stats.isDirectory()) {
        if (entryName !== 'win-unpacked') {
          stack.push(entryPath)
        }
        continue
      }

      files.push(entryPath)
    }
  }

  return files
}

function findLatestArtifact(predicate) {
  const matches = listArtifacts()
    .filter(predicate)
    .map((entry) => ({
      entry,
      mtime: statSync(entry).mtimeMs
    }))
    .sort((left, right) => right.mtime - left.mtime)

  return matches[0]?.entry || ''
}

function ensureCleanDirectory(targetPath) {
  rmSync(targetPath, { recursive: true, force: true })
  mkdirSync(targetPath, { recursive: true })
}

function copyFileIfPresent(sourcePath, destinationPath) {
  if (!sourcePath || !existsSync(sourcePath)) {
    return
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true })
  cpSync(sourcePath, destinationPath, { force: true })
}

function syncShortcuts(executablePath) {
  if (process.platform !== 'win32' || !existsSync(executablePath)) {
    return
  }

  const escapedExePath = executablePath.replace(/'/g, "''")
  const shortcutScript = [
    `$exePath = '${escapedExePath}'`,
    '$workingDir = Split-Path -Parent $exePath',
    '$shell = New-Object -ComObject WScript.Shell',
    '$targets = @(',
    "  'C:\\Users\\sqwat\\Desktop\\Royale Launcher.lnk',",
    "  'C:\\Users\\sqwat\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Royale Launcher.lnk'",
    ')',
    'foreach ($shortcutPath in $targets) {',
    '  $shortcut = $shell.CreateShortcut($shortcutPath)',
    '  $shortcut.TargetPath = $exePath',
    '  $shortcut.WorkingDirectory = $workingDir',
    '  $shortcut.IconLocation = "$exePath,0"',
    '  $shortcut.Save()',
    '}',
    'ie4uinit.exe -show | Out-Null'
  ].join('\n')

  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', shortcutScript])
}

function cleanupLegacyInstall() {
  if (process.platform !== 'win32') {
    return
  }

  const cleanupScript = [
    "$legacyProgram = 'C:\\Users\\sqwat\\AppData\\Local\\Programs\\royale-launcher-electron'",
    "$legacyDesktop = 'C:\\Users\\sqwat\\Desktop\\Royale Launcher.lnk'",
    "$legacyStart = 'C:\\Users\\sqwat\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Royale Launcher.lnk'",
    "if (Test-Path $legacyProgram) { Remove-Item -LiteralPath $legacyProgram -Recurse -Force -ErrorAction SilentlyContinue }",
    "if (Test-Path $legacyDesktop) { Remove-Item -LiteralPath $legacyDesktop -Force -ErrorAction SilentlyContinue }",
    "if (Test-Path $legacyStart) { Remove-Item -LiteralPath $legacyStart -Force -ErrorAction SilentlyContinue }",
    'ie4uinit.exe -show | Out-Null'
  ].join('\n')

  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cleanupScript])
}

function syncBuildOutputs(currentMode) {
  const unpackedDir = getUnpackedDir()
  if (!existsSync(unpackedDir)) {
    return
  }

  mkdirSync(buildOutputRoot, { recursive: true })
  for (const staleFile of [
    'RoyaleLauncher-new.exe',
    'RoyaleLauncher-new-ia32.exe',
    'RoyaleLauncher.exe',
    'RoyaleLauncherSetup.exe',
    'RoyaleLauncherSetup-ia32.exe',
    'RoyaleLauncherPortable.exe',
    'RoyaleLauncherPortable-ia32.exe',
    'RoyaleLauncherPackage.7z',
    'RoyaleLauncherPackage.zip'
  ]) {
    rmSync(path.join(buildOutputRoot, staleFile), { force: true })
  }

  const targetUnpackedDir = path.join(buildOutputRoot, 'win-unpacked')
  if (arch === 'x64') {
    ensureCleanDirectory(targetUnpackedDir)
    cpSync(unpackedDir, targetUnpackedDir, { recursive: true, force: true })
  }

  const unpackedExe = path.join(unpackedDir, 'Royale Launcher.exe')
  const archSuffix = arch === 'x64' ? '' : `-${arch}`
  copyFileIfPresent(unpackedExe, path.join(buildOutputRoot, `RoyaleLauncher-new${archSuffix}.exe`))
  if (arch === 'x64') {
    copyFileIfPresent(unpackedExe, path.join(buildOutputRoot, 'RoyaleLauncher.exe'))
  }

  const installedDir = path.join('C:\\Users\\sqwat\\AppData\\Local\\Programs\\royale-launcher', 'Royale Launcher')
  if (arch === 'x64' && existsSync(path.dirname(installedDir))) {
    mkdirSync(installedDir, { recursive: true })
    cpSync(unpackedDir, installedDir, { recursive: true, force: true })
    cleanupLegacyInstall()
    syncShortcuts(path.join(installedDir, 'Royale Launcher.exe'))
  }

  if (currentMode === 'portable') {
    const portableExe = findLatestArtifact((entry) => entry.endsWith('.exe') && path.basename(entry).toLowerCase().includes(version))
    copyFileIfPresent(portableExe, path.join(buildOutputRoot, `RoyaleLauncherPortable${archSuffix}.exe`))
    return
  }

  const installerExe = findLatestArtifact((entry) => {
    const filename = path.basename(entry).toLowerCase()
    return filename.endsWith('.exe') && !filename.includes('blockmap')
  })
  copyFileIfPresent(installerExe, path.join(buildOutputRoot, `RoyaleLauncherSetup${archSuffix}.exe`))

  if (currentMode !== 'offline') {
    const packageArchive = findLatestArtifact((entry) => {
      const filename = path.basename(entry).toLowerCase()
      return filename.endsWith('.7z') || filename.endsWith('.zip')
    })
    if (packageArchive) {
      const extension = path.extname(packageArchive)
      copyFileIfPresent(packageArchive, path.join(buildOutputRoot, `RoyaleLauncherPackage${extension}`))
    }
  }
}

rmSync(distRoot, { recursive: true, force: true })
run(process.execPath, [getToolPath('node_modules', 'vite', 'bin', 'vite.js'), 'build'])

if (process.platform === 'win32') {
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', getToolPath('scripts', 'generate-installer-art.ps1')])
}

run(process.execPath, [getToolPath('node_modules', 'electron-builder', 'cli.js'), '--win', 'dir', `--${arch}`, '--publish', 'never'])
patchWindowsExecutable(path.join(getUnpackedDir(), 'Royale Launcher.exe'))
run(process.execPath, [
  getToolPath('node_modules', 'electron-builder', 'cli.js'),
  '--prepackaged',
  getUnpackedDir(),
  '--win',
  getBuilderTarget(mode),
  `--${arch}`,
  '--publish',
  'never'
])
syncBuildOutputs(mode)
