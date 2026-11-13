// ============================================================
// 形象库：把仓库里的 manifest / 缩略图，与本机安装的原图合并成一个视图。
//
// 仓库里永远只有：
//   assets/character/dandan/manifest.json
//   assets/character/dandan/*-thumb.webp
//   assets/character-packs.json
// 原图在 GitHub Release，装到：
//   data/characters/packs/dandan-initial/
// 用户以后上传的图：
//   data/characters/uploads/
// 两边都不进 Git。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { removeDirectory } from '../utils/fs-retry.js'
import { downloadPack } from './download.js'

const DEFAULT_PACK_ID = 'dandan-initial'
const MANIFEST_REL = 'assets/character/dandan/manifest.json'
const PACKS_REL = 'assets/character-packs.json'
const PACKS_DIR_REL = 'data/characters/packs'
const STATE_REL = 'data/state/character.json'

function safeId(value) {
  return String(value || '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
}

function isPathInside(base, candidate) {
  const root = path.resolve(base)
  const file = path.resolve(candidate)
  return file === root || file.startsWith(root + path.sep)
}

function mimeOf(file) {
  if (/\.png$/i.test(file)) return 'image/png'
  if (/\.jpg$/i.test(file) || /\.jpeg$/i.test(file)) return 'image/jpeg'
  if (/\.webp$/i.test(file)) return 'image/webp'
  return 'application/octet-stream'
}

export function createCharacterLibrary({ config, logger = console } = {}) {
  const manifestPath = fromRoot(MANIFEST_REL)
  const packsFile = fromRoot(PACKS_REL)
  const packsRoot = fromRoot(config?.characters?.packsDir || PACKS_DIR_REL)
  const stateFile = fromRoot(config?.characters?.statePath || STATE_REL)

  let manifest = readJsonSafe(manifestPath, null, (err) => logger.warn?.(`形象 manifest 读取失败：${err.message}`))
  let registry = readJsonSafe(packsFile, { schemaVersion: 1, packs: [] }, (err) => logger.warn?.(`形象资源包清单读取失败：${err.message}`))
  if (!manifest || !Array.isArray(manifest.images)) manifest = null
  if (!registry || !Array.isArray(registry.packs)) registry = { schemaVersion: 1, packs: [] }

  function requireManifest() {
    if (!manifest) throw new Error('形象库 manifest 缺失或损坏')
    return manifest
  }

  function packById(packId = DEFAULT_PACK_ID) {
    const id = safeId(packId)
    return registry.packs.find((pack) => pack && pack.id === id) || null
  }

  function installDir(packId) {
    const id = safeId(packId)
    if (!id) throw new Error('资源包 id 不合法')
    return path.join(packsRoot, id)
  }

  function readInstallMeta(packId) {
    if (!packById(packId)) return null
    return readJsonSafe(path.join(installDir(packId), 'install.json'), null)
  }

  function originalPath(image, packId = DEFAULT_PACK_ID) {
    if (!image || !packById(packId)) return null
    const dir = installDir(packId)
    const file = path.resolve(dir, image.file)
    if (!isPathInside(dir, file)) return null
    return file
  }

  function originalReady(image, packId = DEFAULT_PACK_ID) {
    const file = originalPath(image, packId)
    if (!file) return false
    try {
      const stat = fs.statSync(file)
      return stat.isFile() && (!image.bytes || stat.size === image.bytes)
    } catch {
      return false
    }
  }

  function packState(packId = DEFAULT_PACK_ID) {
    const pack = packById(packId)
    if (!pack) return null
    const meta = readInstallMeta(packId)
    const images = requireManifest().images
    const readyCount = meta ? images.filter((image) => originalReady(image, packId)).length : 0
    const originalReadyAll = Boolean(meta) && readyCount === images.length
    return {
      id: pack.id,
      characterId: pack.characterId,
      title: pack.title,
      version: pack.version,
      releaseTag: pack.releaseTag,
      totalBytes: Number(pack.totalBytes) || 0,
      fileCount: Number(pack.fileCount) || (Array.isArray(pack.files) ? pack.files.length : 0),
      license: pack.license,
      commercialUse: pack.commercialUse === true,
      attribution: pack.attribution,
      releaseNotesUrl: pack.releaseNotesUrl,
      installed: Boolean(meta),
      installedVersion: meta?.version || null,
      installedAt: meta?.installedAt || null,
      originalReady: originalReadyAll,
      filesReady: readyCount,
      filesTotal: images.length,
      needsUpdate: Boolean(meta) && meta.version !== pack.version,
    }
  }

  function readPrimary() {
    const fallback = requireManifest().primaryImageId
    const state = readJsonSafe(stateFile, null)
    const id = String(state?.primaryImageId || '')
    return requireManifest().images.some((image) => image.id === id) ? id : fallback
  }

  function imageById(id) {
    const key = safeId(id)
    return requireManifest().images.find((image) => image.id === key) || null
  }

  function thumbnailPath(id) {
    const image = imageById(id)
    if (!image) return null
    const base = path.dirname(manifestPath)
    const file = path.resolve(base, image.thumbFile)
    return isPathInside(base, file) ? file : null
  }

  function fullImagePath(id, packId = DEFAULT_PACK_ID) {
    const image = imageById(id)
    if (!image) return null
    const pack = packById(packId)
    if (!pack) return null
    const packInfo = packState(packId)
    if (!packInfo?.originalReady) return null
    const file = originalPath(image, packId)
    if (!file || !fs.existsSync(file)) return null
    return file
  }

  function state(packId = DEFAULT_PACK_ID) {
    const m = requireManifest()
    const pack = packState(packId)
    const primary = readPrimary()
    const counts = { total: m.images.length, child: 0, teen: 0, adult: 0 }
    for (const image of m.images) {
      if (counts[image.ageGroup] != null) counts[image.ageGroup] += 1
    }
    const items = m.images.map((image) => {
      const ready = Boolean(pack?.originalReady) && originalReady(image, packId)
      return {
        ...image,
        isPrimary: image.id === primary,
        thumbUrl: `/characters/thumb?id=${encodeURIComponent(image.id)}`,
        fileUrl: ready ? `/characters/file?id=${encodeURIComponent(image.id)}` : null,
        originalReady: ready,
      }
    })
    return {
      ok: true,
      character: {
        id: m.characterId,
        displayName: m.displayName,
        aliases: m.aliases || [],
        description: m.description || '',
        usage: m.usage || [],
        rights: m.rights || {},
        distribution: m.distribution || {},
      },
      groups: m.groups || [],
      outfits: m.outfits || [],
      pack,
      primaryImageId: primary,
      counts,
      items,
    }
  }

  function setPrimary(id) {
    const image = imageById(id)
    if (!image) throw new Error('没有这张形象')
    writeJsonAtomic(stateFile, {
      schemaVersion: 1,
      primaryImageId: image.id,
      updatedAt: new Date().toISOString(),
    })
    return state()
  }

  function listPacks() {
    return registry.packs.map((pack) => packState(pack.id)).filter(Boolean)
  }

  async function removePack(packId = DEFAULT_PACK_ID) {
    const pack = packById(packId)
    if (!pack) throw new Error('没有这个资源包')
    const dir = installDir(pack.id)
    if (!isPathInside(packsRoot, dir)) throw new Error('资源包路径不合法')
    await removeDirectory(dir, { logger })
    return state(pack.id)
  }

  async function installPack(packId = DEFAULT_PACK_ID, { onProgress } = {}) {
    const pack = packById(packId)
    if (!pack) throw new Error('没有这个资源包')
    const targetDir = installDir(pack.id)
    return await downloadPack({
      pack,
      targetDir,
      onProgress,
      logger,
    })
  }

  return {
    state,
    listPacks,
    packState,
    setPrimary,
    removePack,
    installPack,
    thumbnailPath,
    fullImagePath,
    mimeOf,
    imageById,
    packById,
  }
}

export { DEFAULT_PACK_ID }
