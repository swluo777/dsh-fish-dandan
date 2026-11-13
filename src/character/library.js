// ============================================================
// 形象库：把仓库里的 manifest / 缩略图、本机安装的原图，以及
// 用户自己上传到本机的形象合并成一个视图。
//
// 仓库里永远只有：
//   assets/character/dandan/manifest.json
//   assets/character/dandan/*-thumb.webp
//   assets/character-packs.json
// 原图在 GitHub Release，装到：
//   data/characters/packs/dandan-initial/
// 用户自己上传的图：
//   data/characters/uploads/<id>/
//   data/characters/index.json
// 两边运行时目录都不进 Git。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { removeDirectory } from '../utils/fs-retry.js'
import { downloadPack } from './download.js'

const DEFAULT_PACK_ID = 'dandan-initial'
const MANIFEST_REL = 'assets/character/dandan/manifest.json'
const PACKS_REL = 'assets/character-packs.json'
const PACKS_DIR_REL = 'data/characters/packs'
const STATE_REL = 'data/state/character.json'
const UPLOADS_DIR_REL = 'data/characters/uploads'
const UPLOAD_INDEX_REL = 'data/characters/index.json'
const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const UPLOAD_AGE_GROUPS = new Set(['child', 'teen', 'adult'])
// 浏览器能正常解码、且不会在页面里执行脚本的常见位图格式。
const UPLOAD_IMAGE_EXTS = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'avif'])

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
  if (/\.gif$/i.test(file)) return 'image/gif'
  if (/\.bmp$/i.test(file)) return 'image/bmp'
  if (/\.avif$/i.test(file)) return 'image/avif'
  return 'application/octet-stream'
}

/** 只认图片魔数：扩展名和浏览器 MIME 都不可信，SVG 这种可执行文本直接拒掉。 */
function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (buf.subarray(0, 2).toString('ascii') === 'BM') return 'bmp'
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    // AVIF 的 major brand 可能是 avif/avis，也可能放在兼容 brand 列表里。
    const brands = buf.subarray(8, Math.min(buf.length, 64)).toString('ascii')
    if (brands.includes('avif') || brands.includes('avis')) return 'avif'
  }
  return ''
}

function decodeBase64(raw, maxBytes, label) {
  const text = String(raw || '')
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '')
  if (!text) throw Object.assign(new Error(`${label}没有图片数据`), { code: 'UPLOAD_INVALID' })
  if (!/^[a-z0-9+/]+={0,2}$/i.test(text) || text.length % 4 === 1) {
    throw Object.assign(new Error(`${label}不是合法的 base64`), { code: 'UPLOAD_INVALID' })
  }
  const buf = Buffer.from(text, 'base64')
  if (!buf.length) throw Object.assign(new Error(`${label}没有图片数据`), { code: 'UPLOAD_INVALID' })
  if (buf.length > maxBytes) {
    throw Object.assign(
      new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`),
      { code: 'UPLOAD_TOO_LARGE' },
    )
  }
  return buf
}

function cleanText(value, max = 80) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanTags(value, limit = 10) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，、]/)
  const tags = []
  for (const item of list) {
    const tag = cleanText(item, 24)
    if (tag && !tags.includes(tag)) tags.push(tag)
    if (tags.length >= limit) break
  }
  return tags
}

function clampDimension(value) {
  const n = Math.round(Number(value) || 0)
  return Number.isFinite(n) && n > 0 ? Math.min(20000, n) : 0
}

function fallbackTitle(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i, '')
  return cleanText(base, 60) || '我上传的形象'
}

function imageFileName(ext) {
  return `image.${ext === 'jpg' ? 'jpg' : ext}`
}

function thumbFileName(ext) {
  return `thumb.${ext === 'jpg' ? 'jpg' : ext}`
}

export function createCharacterLibrary({ config, logger = console } = {}) {
  const manifestPath = fromRoot(MANIFEST_REL)
  const packsFile = fromRoot(PACKS_REL)
  const packsRoot = fromRoot(config?.characters?.packsDir || PACKS_DIR_REL)
  const stateFile = fromRoot(config?.characters?.statePath || STATE_REL)
  const uploadsRoot = fromRoot(config?.characters?.uploadsDir || UPLOADS_DIR_REL)
  const uploadIndexFile = fromRoot(config?.characters?.indexPath || UPLOAD_INDEX_REL)
  const maxUploadBytes = Number(config?.characters?.maxUploadBytes) || DEFAULT_MAX_UPLOAD_BYTES

  let manifest = readJsonSafe(manifestPath, null, (err) => logger.warn?.(`形象 manifest 读取失败：${err.message}`))
  let registry = readJsonSafe(packsFile, { schemaVersion: 1, packs: [] }, (err) => logger.warn?.(`形象资源包清单读取失败：${err.message}`))
  if (!manifest || !Array.isArray(manifest.images)) manifest = null
  if (!registry || !Array.isArray(registry.packs)) registry = { schemaVersion: 1, packs: [] }

  let uploads = readUploadIndex()

  function requireManifest() {
    if (!manifest) throw new Error('形象库 manifest 缺失或损坏')
    return manifest
  }

  function readUploadIndex() {
    const data = readJsonSafe(uploadIndexFile, { schemaVersion: 1, items: [] }, (err) => {
      logger.warn?.(`本机形象索引读取失败，按空库启动：${err.message}`)
    })
    if (!data || !Array.isArray(data.items)) return []
    return data.items.map(normalizeUploadRecord).filter(Boolean)
  }

  function normalizeUploadRecord(record) {
    if (!record || typeof record !== 'object') return null
    const id = safeId(record.id)
    if (!id || !id.startsWith('upload-')) return null
    const imageName = String(record.imageName || '')
    const thumbName = String(record.thumbName || imageName)
    if (!/^image\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i.test(imageName)) return null
    if (thumbName !== imageName && !/^thumb\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i.test(thumbName)) return null
    const ageGroup = UPLOAD_AGE_GROUPS.has(record.ageGroup) ? record.ageGroup : 'teen'
    const knownOutfit = (manifest?.outfits || []).find((item) => item.id === safeId(record.outfitId))
    const outfitId = knownOutfit?.id || safeId(record.outfitId) || 'custom'
    const outfitLabel = cleanText(record.outfitLabel, 24) || knownOutfit?.label || (outfitId === 'custom' ? '本机上传' : outfitId)
    return {
      id,
      characterId: cleanText(record.characterId, 40) || 'dandan',
      title: cleanText(record.title, 60) || '我上传的形象',
      ageGroup,
      outfitId,
      outfitLabel,
      variant: cleanText(record.variant, 30) || '本机上传',
      tags: cleanTags(record.tags),
      viewType: 'turnaround-sheet',
      threeView: true,
      width: clampDimension(record.width),
      height: clampDimension(record.height),
      format: imageName.replace(/^image\./, ''),
      origin: 'upload',
      sourceType: 'local-upload',
      license: 'local-only',
      bytes: Math.max(0, Number(record.bytes) || 0),
      imageName,
      thumbName,
      uploadedAt: cleanText(record.uploadedAt, 40) || new Date().toISOString(),
      sortOrder: Number(record.sortOrder) || 0,
    }
  }

  function saveUploadIndex() {
    writeJsonAtomic(uploadIndexFile, {
      schemaVersion: 1,
      items: uploads,
    })
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

  function uploadById(id) {
    const key = safeId(id)
    return uploads.find((item) => item.id === key) || null
  }

  function uploadDir(id) {
    return path.join(uploadsRoot, safeId(id))
  }

  /**
   * 造型分类既可以是内置分类，也可以是用户自己起的一个分类名。
   * 自定义分类用名称的短哈希做稳定 id，后续同名上传会归到一起。
   */
  function resolveOutfit(outfitId, outfitLabel) {
    const requestedId = safeId(outfitId)
    const label = cleanText(outfitLabel, 24)
    const builtIn = (manifest?.outfits || []).find((outfit) => outfit.id === requestedId || (label && outfit.label === label))
    if (builtIn) return { id: builtIn.id, label: builtIn.label }
    if (!label || label === '本机上传') return { id: 'custom', label: '本机上传' }
    const key = 'custom-' + createHash('sha1').update(label).digest('hex').slice(0, 8)
    return { id: key, label }
  }

  function uploadImagePath(record) {
    const dir = uploadDir(record.id)
    const file = path.resolve(dir, record.imageName)
    return isPathInside(dir, file) ? file : null
  }

  function uploadThumbPath(record) {
    const dir = uploadDir(record.id)
    const file = path.resolve(dir, record.thumbName)
    return isPathInside(dir, file) ? file : null
  }

  function uploadView(record) {
    if (!record) return null
    const image = uploadImagePath(record)
    const thumb = uploadThumbPath(record)
    let ready = false
    let thumbReady = false
    try {
      const stat = image ? fs.statSync(image) : null
      ready = Boolean(stat && stat.isFile())
    } catch {
      ready = false
    }
    try {
      const stat = thumb ? fs.statSync(thumb) : null
      thumbReady = Boolean(stat && stat.isFile())
    } catch {
      thumbReady = false
    }
    return {
      id: record.id,
      characterId: record.characterId,
      title: record.title,
      ageGroup: record.ageGroup,
      outfitId: record.outfitId,
      outfitLabel: record.outfitLabel,
      variant: record.variant,
      tags: record.tags,
      viewType: record.viewType,
      threeView: record.threeView,
      width: record.width,
      height: record.height,
      format: record.format,
      origin: 'upload',
      sourceType: 'local-upload',
      license: record.license,
      isOrigin: false,
      isPrimary: false,
      sortOrder: record.sortOrder || 1000,
      // file 只用于页面展示；真实读写永远走 uploadImagePath，避免前端拼路径。
      file: `uploads/${record.id}/${record.imageName}`,
      fileName: record.imageName,
      thumbFile: record.thumbName,
      bytes: record.bytes,
      uploadedAt: record.uploadedAt,
      originalReady: ready,
      // 缩略图丢失时退回原图，至少页面还能看，不出现破图。
      thumbUrl: thumbReady
        ? `/characters/thumb?id=${encodeURIComponent(record.id)}`
        : (ready ? `/characters/file?id=${encodeURIComponent(record.id)}` : null),
      fileUrl: ready ? `/characters/file?id=${encodeURIComponent(record.id)}` : null,
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
    const m = requireManifest()
    const fallback = m.primaryImageId || (m.images[0] && m.images[0].id) || null
    const state = readJsonSafe(stateFile, null)
    const id = safeId(state?.primaryImageId)
    if (m.images.some((image) => image.id === id)) return id
    if (uploadById(id)) return id
    return fallback
  }

  function imageById(id) {
    const key = safeId(id)
    const builtIn = requireManifest().images.find((image) => image.id === key)
    if (builtIn) return builtIn
    return uploadView(uploadById(key))
  }

  function thumbnailPath(id) {
    const key = safeId(id)
    const upload = uploadById(key)
    if (upload) {
      const thumb = uploadThumbPath(upload)
      if (thumb && fs.existsSync(thumb)) return thumb
      const image = uploadImagePath(upload)
      return image && fs.existsSync(image) ? image : null
    }
    const image = requireManifest().images.find((item) => item.id === key)
    if (!image) return null
    const base = path.dirname(manifestPath)
    const file = path.resolve(base, image.thumbFile)
    return isPathInside(base, file) ? file : null
  }

  function fullImagePath(id, packId = DEFAULT_PACK_ID) {
    const key = safeId(id)
    const upload = uploadById(key)
    if (upload) {
      const file = uploadImagePath(upload)
      if (!file || !fs.existsSync(file)) return null
      return file
    }
    const image = requireManifest().images.find((item) => item.id === key)
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
    const counts = { total: 0, child: 0, teen: 0, adult: 0 }
    const items = m.images.map((image) => {
      const ready = Boolean(pack?.originalReady) && originalReady(image, packId)
      counts.total += 1
      if (counts[image.ageGroup] != null) counts[image.ageGroup] += 1
      return {
        ...image,
        isPrimary: image.id === primary,
        thumbUrl: `/characters/thumb?id=${encodeURIComponent(image.id)}`,
        fileUrl: ready ? `/characters/file?id=${encodeURIComponent(image.id)}` : null,
        originalReady: ready,
      }
    })
    for (const record of uploads) {
      const view = uploadView(record)
      if (!view) continue
      counts.total += 1
      if (counts[view.ageGroup] != null) counts[view.ageGroup] += 1
      items.push({ ...view, isPrimary: view.id === primary })
    }
    const outfits = (m.outfits || []).slice()
    const outfitSeen = new Set(outfits.map((outfit) => outfit.id))
    for (const record of uploads) {
      if (!record.outfitId || outfitSeen.has(record.outfitId)) continue
      outfits.push({
        id: record.outfitId,
        label: record.outfitLabel || '本机上传',
        ageGroups: ['child', 'teen', 'adult'],
        order: 99 + outfits.length,
      })
      outfitSeen.add(record.outfitId)
    }
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
      outfits,
      pack,
      primaryImageId: primary,
      counts,
      stats: {
        total: counts.total,
        release: m.images.length,
        uploads: uploads.length,
        byAge: {
          child: counts.child,
          teen: counts.teen,
          adult: counts.adult,
        },
      },
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

  /**
   * 网页上传：base64 JSON 进来，图片落到 data/characters/uploads/<id>/。
   * 只在本机保存，不写 Git、不上传云端。
   */
  async function upload({
    dataBase64,
    thumbBase64,
    name = '',
    title = '',
    ageGroup = 'teen',
    outfitId = 'custom',
    outfitLabel = '',
    tags = [],
    width = 0,
    height = 0,
  } = {}) {
    const imageBuf = decodeBase64(dataBase64, maxUploadBytes, '图片')
    const ext = sniffImageExt(imageBuf)
    if (!UPLOAD_IMAGE_EXTS.has(ext)) {
      throw Object.assign(new Error('不支持这种图片格式，请换 PNG、JPEG、WebP、GIF、BMP 或 AVIF'), { code: 'UPLOAD_INVALID' })
    }
    const thumbBuf = thumbBase64 ? decodeBase64(thumbBase64, 2 * 1024 * 1024, '缩略图') : null
    const thumbExt = thumbBuf ? sniffImageExt(thumbBuf) : ''
    if (thumbBuf && !UPLOAD_IMAGE_EXTS.has(thumbExt)) {
      throw Object.assign(new Error('缩略图格式不支持'), { code: 'UPLOAD_INVALID' })
    }

    const cleanAge = UPLOAD_AGE_GROUPS.has(ageGroup) ? ageGroup : 'teen'
    const outfit = resolveOutfit(outfitId, outfitLabel)
    const cleanTitle = cleanText(title, 60) || fallbackTitle(name)
    const imageName = imageFileName(ext)
    const thumbName = thumbBuf ? thumbFileName(thumbExt) : imageName
    const id = `upload-${randomUUID()}`
    const dir = uploadDir(id)
    if (!isPathInside(uploadsRoot, dir)) {
      throw Object.assign(new Error('上传目录不合法'), { code: 'UPLOAD_INVALID' })
    }

    fs.mkdirSync(dir, { recursive: true })
    try {
      fs.writeFileSync(path.join(dir, imageName), imageBuf)
      if (thumbBuf) fs.writeFileSync(path.join(dir, thumbName), thumbBuf)
      const record = normalizeUploadRecord({
        id,
        characterId: manifest?.characterId || 'dandan',
        title: cleanTitle,
        ageGroup: cleanAge,
        outfitId: outfit.id,
        outfitLabel: outfit.label,
        variant: '本机上传',
        tags: cleanTags(tags).length ? cleanTags(tags) : ['本机上传'],
        width,
        height,
        imageName,
        thumbName,
        bytes: imageBuf.length,
        uploadedAt: new Date().toISOString(),
        sortOrder: 1000 + uploads.length,
      })
      if (!record) throw new Error('上传记录不合法')
      writeJsonAtomic(path.join(dir, 'meta.json'), { schemaVersion: 1, ...record })
      uploads.push(record)
      try {
        saveUploadIndex()
      } catch (err) {
        uploads = uploads.filter((item) => item.id !== record.id)
        throw err
      }
      return {
        item: uploadView(record),
        state: state(),
      }
    } catch (err) {
      try {
        await removeDirectory(dir, { logger })
      } catch { /* 清理失败不覆盖原始错误 */ }
      throw err
    }
  }

  async function removeUpload(id) {
    const record = uploadById(id)
    if (!record) {
      if (requireManifest().images.some((image) => image.id === safeId(id))) {
        throw Object.assign(new Error('内置形象是只读的，不能删除'), { code: 'BUILTIN_READONLY' })
      }
      throw Object.assign(new Error('没有这张本机形象'), { code: 'UPLOAD_NOT_FOUND' })
    }
    const dir = uploadDir(record.id)
    if (!isPathInside(uploadsRoot, dir)) throw new Error('上传目录不合法')
    await removeDirectory(dir, { logger })
    uploads = uploads.filter((item) => item.id !== record.id)
    saveUploadIndex()
    const primary = readPrimary()
    if (primary !== record.id) {
      // readPrimary 已经自动回落到 manifest 的主形象；把状态文件也校正，页面刷新不悬空。
      writeJsonAtomic(stateFile, {
        schemaVersion: 1,
        primaryImageId: primary,
        updatedAt: new Date().toISOString(),
      })
    }
    return state()
  }

  return {
    state,
    listPacks,
    packState,
    setPrimary,
    removePack,
    installPack,
    upload,
    removeUpload,
    rawUploads: () => uploads.slice(),
    thumbnailPath,
    fullImagePath,
    mimeOf,
    imageById,
    packById,
  }
}

export { DEFAULT_PACK_ID }
