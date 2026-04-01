import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const SOURCE_EXCLUDES = new Set(['instance.json', 'launch.bat', 'launch.cmd'])

function parseArgs(argv) {
  const args = [...argv]
  const positionals = []
  const flags = new Map()

  while (args.length > 0) {
    const current = args.shift()
    if (!current.startsWith('--')) {
      positionals.push(current)
      continue
    }

    const [key, inlineValue] = current.split('=', 2)
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue)
      continue
    }

    if (args[0] && !args[0].startsWith('--')) {
      flags.set(key, args.shift())
      continue
    }

    flags.set(key, true)
  }

  return { positionals, flags }
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

async function recreateDirectory(targetDir) {
  await fsp.rm(targetDir, { recursive: true, force: true })
  await fsp.mkdir(targetDir, { recursive: true })
}

function collectExternalManagedModNames(manifest) {
  const entries = Array.isArray(manifest?.managedMods) ? manifest.managedMods : []
  return new Set(
    entries
      .map((entry) => path.basename(String(entry?.fileName || entry?.name || '').trim()))
      .filter(Boolean)
  )
}

async function copySourceToStage(sourceDir, stageDir, manifest) {
  const externalManagedMods = collectExternalManagedModNames(manifest)
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (SOURCE_EXCLUDES.has(entry.name)) {
      continue
    }

    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(stageDir, entry.name)
    if (entry.isDirectory() && entry.name === 'mods' && externalManagedMods.size > 0) {
      await fsp.mkdir(destinationPath, { recursive: true })
      const modEntries = await fsp.readdir(sourcePath, { withFileTypes: true })
      for (const modEntry of modEntries) {
        if (!modEntry.isFile() || externalManagedMods.has(modEntry.name)) {
          continue
        }

        await fsp.cp(path.join(sourcePath, modEntry.name), path.join(destinationPath, modEntry.name), { recursive: true, force: true })
      }
      continue
    }

    await fsp.cp(sourcePath, destinationPath, { recursive: true, force: true })
  }
}

async function normalizeStageLayout(stageDir, manifestPath, manifest) {
  const currentGameDir = normalizeRelativeGamePath(manifest.gameDir ?? '.')
  if (currentGameDir !== '.') {
    const legacyGameDir = path.join(stageDir, currentGameDir)
    if (fs.existsSync(legacyGameDir)) {
      const entries = await fsp.readdir(legacyGameDir, { withFileTypes: true })
      for (const entry of entries) {
        const sourcePath = path.join(legacyGameDir, entry.name)
        const destinationPath = path.join(stageDir, entry.name)
        await fsp.cp(sourcePath, destinationPath, { recursive: true, force: true })
      }
      await fsp.rm(legacyGameDir, { recursive: true, force: true })
    }
  }

  const nextManifest = {
    ...manifest,
    gameDir: '.'
  }

  await fsp.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf8')
  return nextManifest
}

async function createZipFromDirectory(sourceDir, zipPath) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true })
  await fsp.rm(zipPath, { force: true })

  if (process.platform === 'win32') {
    const command = `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
      stdio: 'inherit'
    })

    if (result.status !== 0) {
      throw new Error('Не удалось собрать slim zip через PowerShell Compress-Archive')
    }

    return
  }

  const result = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: sourceDir,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    throw new Error('Не удалось собрать slim zip архив')
  }
}

async function prepareClientPackage(versionName) {
  const sourceDir = path.join(projectRoot, 'client-build', versionName)
  const manifestPath = path.join(sourceDir, 'royale-client.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Не найден manifest пакета: ${manifestPath}`)
  }

  const rawManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  const stageDir = path.join(projectRoot, '.client-package', `${versionName}-slim`)
  const zipPath = path.join(projectRoot, 'client-assets', `${versionName}.zip`)

  console.log(`Сборка slim-пакета ${versionName}`)
  console.log(`Исходник: ${sourceDir}`)
  console.log(`Staging: ${stageDir}`)
  console.log(`Архив: ${zipPath}`)

  await recreateDirectory(stageDir)
  await copySourceToStage(sourceDir, stageDir, rawManifest)
  const manifest = await normalizeStageLayout(stageDir, path.join(stageDir, 'royale-client.json'), rawManifest)

  if (manifest.gameDir !== '.') {
    throw new Error('Manifest staging не был нормализован до gameDir "."')
  }

  await createZipFromDirectory(stageDir, zipPath)
  const archiveStats = await fsp.stat(zipPath)
  console.log(`Готово: ${zipPath}`)
  console.log(`Размер: ${(archiveStats.size / (1024 * 1024)).toFixed(1)} MB`)
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const versionName = String(flags.get('--version') || positionals[0] || '').trim()
  if (!versionName) {
    throw new Error('Укажите версию: node scripts/build-client-package.mjs 1.21.11')
  }

  await prepareClientPackage(versionName)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
