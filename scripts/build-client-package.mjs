import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const APP_ID = 'RoyaleLauncherPackageBuilder'
const MINECRAFT_VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const DEFAULT_CONCURRENCY = 16
const SOURCE_EXCLUDES = new Set(['instance.json'])

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

function defaultMinecraftHome() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft')
  }

  return path.join(os.homedir(), '.minecraft')
}

function sharedFabricVersionName(minecraftVersion, fabricLoaderVersion) {
  return `${minecraftVersion}-fabric${fabricLoaderVersion}`
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

function libraryPathFromName(name, classifier = '', extension = 'jar') {
  const parts = String(name || '').split(':')
  if (parts.length < 3) {
    throw new Error(`Некорректное имя библиотеки: ${name}`)
  }

  const [group, artifact, version] = parts
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.${extension}`
    : `${artifact}-${version}.${extension}`

  return path.join(...group.split('.'), artifact, version, fileName)
}

function uniqueByPath(items) {
  const map = new Map()
  for (const item of items) {
    map.set(item.relativePath, item)
  }
  return [...map.values()]
}

function collectLibraryDownloads(libraries, minecraftHome) {
  const items = []

  for (const library of libraries || []) {
    if (!library || typeof library !== 'object') continue

    const downloads = library.downloads && typeof library.downloads === 'object' ? library.downloads : null
    if (downloads?.artifact?.url && downloads.artifact.path) {
      items.push({
        url: downloads.artifact.url,
        relativePath: path.join('libraries', ...downloads.artifact.path.split('/')),
        cacheCandidates: [
          path.join(minecraftHome, 'libraries', ...downloads.artifact.path.split('/'))
        ]
      })
    }

    if (downloads?.classifiers && typeof downloads.classifiers === 'object') {
      for (const entry of Object.values(downloads.classifiers)) {
        if (!entry?.url || !entry.path) continue
        items.push({
          url: entry.url,
          relativePath: path.join('libraries', ...entry.path.split('/')),
          cacheCandidates: [
            path.join(minecraftHome, 'libraries', ...entry.path.split('/'))
          ]
        })
      }
    }

    if (downloads) {
      continue
    }

    if (!library.name) {
      continue
    }

    const relativePath = path.join('libraries', libraryPathFromName(library.name))
    const baseUrl = String(library.url || 'https://libraries.minecraft.net/').replace(/\/+$/, '')
    const url = `${baseUrl}/${relativePath.slice('libraries'.length + 1).replace(/\\/g, '/')}`
    items.push({
      url,
      relativePath,
      cacheCandidates: [
        path.join(minecraftHome, relativePath)
      ]
    })
  }

  return uniqueByPath(items)
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': APP_ID
    }
  })

  if (!response.ok) {
    throw new Error(`Не удалось загрузить JSON: ${response.status} ${url}`)
  }

  return response.json()
}

async function recreateDirectory(targetDir) {
  await fsp.rm(targetDir, { recursive: true, force: true })
  await fsp.mkdir(targetDir, { recursive: true })
}

async function copyIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return false
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
  await fsp.copyFile(sourcePath, destinationPath)
  return true
}

async function downloadToFile(url, destinationPath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': APP_ID
    }
  })

  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать файл: ${response.status} ${url}`)
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
  const output = fs.createWriteStream(destinationPath)
  await pipeline(response.body, output)
}

async function materializeFile(rootDir, relativePath, url, cacheCandidates = []) {
  const destinationPath = path.join(rootDir, relativePath)
  if (fs.existsSync(destinationPath)) {
    return
  }

  for (const candidate of cacheCandidates) {
    if (await copyIfExists(candidate, destinationPath)) {
      return
    }
  }

  await downloadToFile(url, destinationPath)
}

async function runWithConcurrency(items, concurrency, label, worker) {
  if (!items.length) {
    return
  }

  let cursor = 0
  let completed = 0
  const logStep = items.length >= 100 ? 100 : Math.max(1, Math.floor(items.length / 5))

  async function next() {
    const currentIndex = cursor
    cursor += 1
    if (currentIndex >= items.length) {
      return
    }

    await worker(items[currentIndex], currentIndex)
    completed += 1
    if (completed === items.length || completed % logStep === 0) {
      console.log(`${label}: ${completed}/${items.length}`)
    }

    await next()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()))
}

async function copySourceToStage(sourceDir, stageDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (SOURCE_EXCLUDES.has(entry.name)) {
      continue
    }

    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(stageDir, entry.name)
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

async function resolveMinecraftVersionPayload(minecraftVersion) {
  const manifest = await fetchJson(MINECRAFT_VERSION_MANIFEST_URL)
  const versionEntry = (manifest.versions || []).find((entry) => entry.id === minecraftVersion)
  if (!versionEntry?.url) {
    throw new Error(`Версия Minecraft ${minecraftVersion} не найдена в официальном manifest`)
  }

  return fetchJson(versionEntry.url)
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function collectAssetDownloads(assetIndex, minecraftHome) {
  return Object.values(assetIndex.objects || {}).map((entry) => {
    const hash = String(entry.hash || '')
    const prefix = hash.slice(0, 2)
    const relativePath = path.join('assets', 'objects', prefix, hash)
    return {
      url: `https://resources.download.minecraft.net/${prefix}/${hash}`,
      relativePath,
      cacheCandidates: [
        path.join(minecraftHome, 'assets', 'objects', prefix, hash)
      ]
    }
  })
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
      throw new Error('Не удалось собрать zip через PowerShell Compress-Archive')
    }

    return
  }

  const result = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: sourceDir,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    throw new Error('Не удалось собрать zip архив')
  }
}

async function prepareClientPackage(versionName, options) {
  const sourceDir = path.join(projectRoot, 'client-build', versionName)
  const manifestPath = path.join(sourceDir, 'royale-client.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Не найден manifest пакета: ${manifestPath}`)
  }

  const rawManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  const minecraftVersion = String(rawManifest.minecraftVersion || '').trim()
  const fabricLoaderVersion = String(rawManifest.fabricLoaderVersion || '').trim()
  if (!minecraftVersion || !fabricLoaderVersion) {
    throw new Error('В royale-client.json не хватает minecraftVersion или fabricLoaderVersion')
  }

  const stageDir = path.join(projectRoot, '.client-package', versionName)
  const zipPath = path.join(projectRoot, 'client-assets', `${versionName}.zip`)
  const minecraftHome = options.minecraftHome
  const withAssets = options.withAssets

  console.log(`Сборка пакета ${versionName}`)
  console.log(`Исходник: ${sourceDir}`)
  console.log(`Staging: ${stageDir}`)
  console.log(`Архив: ${zipPath}`)
  console.log(`Assets: ${withAssets ? 'включены' : 'только index'}`)

  await recreateDirectory(stageDir)
  await copySourceToStage(sourceDir, stageDir)

  const stagedManifestPath = path.join(stageDir, 'royale-client.json')
  const manifest = await normalizeStageLayout(stageDir, stagedManifestPath, rawManifest)
  const sharedFabricVersion = sharedFabricVersionName(minecraftVersion, fabricLoaderVersion)

  await Promise.all([
    fsp.mkdir(path.join(stageDir, 'versions'), { recursive: true }),
    fsp.mkdir(path.join(stageDir, 'libraries'), { recursive: true }),
    fsp.mkdir(path.join(stageDir, 'assets', 'indexes'), { recursive: true }),
    fsp.mkdir(path.join(stageDir, 'assets', 'objects'), { recursive: true }),
    fsp.mkdir(path.join(stageDir, 'assets', 'log_configs'), { recursive: true }),
    fsp.mkdir(path.join(stageDir, 'jre'), { recursive: true })
  ])

  console.log('Загрузка метаданных Minecraft')
  const baseVersionPayload = await resolveMinecraftVersionPayload(minecraftVersion)
  const fabricProfilePayload = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(fabricLoaderVersion)}/profile/json`)

  await writeJson(path.join(stageDir, 'versions', minecraftVersion, `${minecraftVersion}.json`), baseVersionPayload)
  await materializeFile(
    stageDir,
    path.join('versions', minecraftVersion, `${minecraftVersion}.jar`),
    baseVersionPayload.downloads.client.url,
    [
      path.join(minecraftHome, 'versions', minecraftVersion, `${minecraftVersion}.jar`)
    ]
  )

  const sharedFabricPayload = {
    ...fabricProfilePayload,
    id: sharedFabricVersion,
    inheritsFrom: minecraftVersion
  }
  await writeJson(path.join(stageDir, 'versions', sharedFabricVersion, `${sharedFabricVersion}.json`), sharedFabricPayload)

  const libraryDownloads = collectLibraryDownloads(
    [...(baseVersionPayload.libraries || []), ...(fabricProfilePayload.libraries || [])],
    minecraftHome
  )
  console.log(`Библиотеки: ${libraryDownloads.length}`)
  await runWithConcurrency(libraryDownloads, DEFAULT_CONCURRENCY, 'Библиотеки', async (entry) => {
    await materializeFile(stageDir, entry.relativePath, entry.url, entry.cacheCandidates)
  })

  if (baseVersionPayload.logging?.client?.file?.url && baseVersionPayload.logging.client.file.id) {
    await materializeFile(
      stageDir,
      path.join('assets', 'log_configs', baseVersionPayload.logging.client.file.id),
      baseVersionPayload.logging.client.file.url,
      [
        path.join(minecraftHome, 'assets', 'log_configs', baseVersionPayload.logging.client.file.id)
      ]
    )
  }

  const assetIndex = await fetchJson(baseVersionPayload.assetIndex.url)
  await writeJson(path.join(stageDir, 'assets', 'indexes', `${baseVersionPayload.assetIndex.id}.json`), assetIndex)

  if (withAssets) {
    const assetDownloads = collectAssetDownloads(assetIndex, minecraftHome)
    console.log(`Assets: ${assetDownloads.length}`)
    await runWithConcurrency(assetDownloads, DEFAULT_CONCURRENCY, 'Assets', async (entry) => {
      await materializeFile(stageDir, entry.relativePath, entry.url, entry.cacheCandidates)
    })
  }

  await createZipFromDirectory(stageDir, zipPath)
  const archiveStats = await fsp.stat(zipPath)
  console.log(`Готово: ${zipPath}`)
  console.log(`Размер: ${(archiveStats.size / (1024 * 1024)).toFixed(1)} MB`)

  if (manifest.gameDir !== '.') {
    throw new Error('Manifest staging не был нормализован до gameDir "."')
  }
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const versionName = String(flags.get('--version') || positionals[0] || '').trim()
  if (!versionName) {
    throw new Error('Укажите версию: node scripts/build-client-package.mjs 1.21.11')
  }

  await prepareClientPackage(versionName, {
    withAssets: !flags.has('--skip-assets'),
    minecraftHome: String(flags.get('--minecraft-home') || defaultMinecraftHome()).trim()
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
