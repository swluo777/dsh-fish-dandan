// ============================================================
// 表情包库（跨平台共享，不属于任何单一平台）
//
// 设计原则（对齐社区实现，见 docs/architecture/10-表情包与多平台发送设计.md）：
// 1. 库本身不内置任何素材：初始为空，由用户上传或从外部源导入；
// 2. 图片一律落 data/stickers/（.gitignore），仓库里只有代码和空目录；
// 3. 元数据记来源与许可，方便以后分享/清理时知道哪些能带走；
// 4. 导入器统一走 ingest()：魔数嗅探 → 哈希去重 → 写盘 → 记索引；
// 5. 发送只认 StickerRef，具体转 base64 / 先上传由平台适配器决定。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const CAPTION_CONCURRENCY = 2

/** 只认图片魔数：不接收 SVG（可带脚本）、不信任扩展名。 */
export function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  const head6 = buf.subarray(0, 6).toString('ascii')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return ''
}

function cleanId(value, fallback = 'local') {
  const t = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)
  return t || fallback
}

function textList(value, limit = 12) {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x || '').trim()).filter(Boolean).map((x) => x.slice(0, 24)).slice(0, limit)
}

function clamp01(value, fallback = 0.5) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
}

/** 中文没有空格，检索时补上单个字/双字片段；只用于打分，不要求全库都有 caption。 */
function queryTerms(q) {
  const s = String(q || '').trim().toLowerCase()
  if (!s) return []
  const words = s.split(/[\s,，。！？!?、；;：:]+/).filter(Boolean)
  const terms = new Set(words)
  for (const w of words) {
    if (/^[\u4e00-\u9fff]+$/.test(w)) {
      if (w.length >= 2) {
        for (let i = 0; i < w.length - 1; i += 1) terms.add(w.slice(i, i + 2))
      }
      if (w.length === 2) terms.add(w[0])
    }
  }
  return [...terms].filter((x) => x.length >= 1).slice(0, 20)
}

export function createStickerLibrary({ config, logger = console }) {
  const root = fromRoot(config.stickers?.dir || 'data/stickers')
  const packsDir = path.join(root, 'packs')
  const indexFile = path.join(root, 'index.json')
  const packsFile = path.join(root, 'packs.json')
  const maxBytes = Number(config.stickers?.maxBytes) || DEFAULT_MAX_BYTES

  let index = readJsonSafe(indexFile, [], (err) => logger.warn?.(`表情包索引读取失败，按空库启动：${err.message}`))
  if (!Array.isArray(index)) index = []
  let packs = readJsonSafe(packsFile, {}, (err) => logger.warn?.(`表情包包索引读取失败：${err.message}`))
  if (!packs || typeof packs !== 'object' || Array.isArray(packs)) packs = {}

  function saveIndex() {
    fs.mkdirSync(root, { recursive: true })
    writeJsonAtomic(indexFile, index)
  }

  function savePacks() {
    fs.mkdirSync(root, { recursive: true })
    writeJsonAtomic(packsFile, packs)
  }

  // ---- 图义补全队列：后台跑，不阻塞上传/网页；并发只开 2 路 ----
  let captioner = null
  let captionActive = 0
  let captionAbort = null
  let captionStopping = false
  const captionQueue = []
  const captionQueued = new Set()

  function isCaptionAbort(err) {
    const name = String(err && err.name || '')
    const code = String(err && err.code || '')
    return name === 'AbortError' || code === 'ABORTED' || code === 'ABORT_ERR'
  }

  /** 还没有图义的图。只有用户点「标语义」才会把它排进队列。 */
  function captionMissing(record) {
    return Boolean(record && record.id && !record.caption)
  }

  function pumpCaption() {
    while (captioner && captionActive < CAPTION_CONCURRENCY && captionQueue.length) {
      const record = captionQueue.shift()
      if (!record || !record.id || record.caption) {
        if (record) captionQueued.delete(record.id)
        continue
      }
      captionActive += 1
      Promise.resolve()
        .then(async () => {
          const file = filePath(record.id)
          if (!file) throw new Error('表情包文件不存在')
          const signal = captionAbort ? captionAbort.signal : null
          const meta = await captioner({ ...record, file }, { signal })
          const current = get(record.id)
          if (!current) return
          if (meta && meta.caption) {
            current.caption = String(meta.caption).slice(0, 80)
            current.emotion = textList(meta.emotion, 3)
            current.intents = textList(meta.intents, 8)
            current.avoid = textList(meta.avoid, 8)
            current.confidence = clamp01(meta.confidence, 0.6)
            current.enrichedAt = Date.now()
            current.enrichError = ''
            saveIndex()
            logger.info?.(`表情包图义已补：${current.id}「${current.caption}」`)
          }
        })
        .catch((err) => {
          if (isCaptionAbort(err)) {
            logger.debug?.(`表情包图义已停止：${record.id}`)
            return
          }
          const current = get(record.id)
          if (current) {
            current.enrichAttemptAt = Date.now()
            current.enrichError = String(err && err.message || '图义补全失败').slice(0, 160)
            saveIndex()
          }
          logger.warn?.(`表情包图义补全失败：${record.id} ${err && err.message || err}`)
        })
        .finally(() => {
          captionActive = Math.max(0, captionActive - 1)
          captionQueued.delete(record.id)
          if (captionActive === 0) captionStopping = false
          pumpCaption()
        })
    }
  }

  function queueCaption(record) {
    if (!captioner || !captionMissing(record) || captionQueued.has(record.id)) return false
    captionQueued.add(record.id)
    captionQueue.push(record)
    pumpCaption()
    return true
  }

  /** 接上图义模型；不自动排队，等用户点「标语义」再开始。 */
  function setCaptioner(fn) {
    captioner = typeof fn === 'function' ? fn : null
    return {
      ready: Boolean(captioner),
      pending: captioner ? index.filter(captionMissing).length : 0,
    }
  }

  /** 手动触发补全；limit=0 表示全库；失败图也会一起重试。 */
  function enrichMissing({ limit = 0 } = {}) {
    if (!captioner) {
      return { ready: false, queued: 0, pending: index.filter(captionMissing).length, total: index.length }
    }
    if (!captionAbort || captionAbort.signal.aborted) captionAbort = new AbortController()
    captionStopping = false
    let queued = 0
    for (const record of index) {
      if (limit > 0 && queued >= limit) break
      if (queueCaption(record)) queued += 1
    }
    return {
      ready: true,
      queued,
      pending: captionQueue.length + captionActive,
      total: index.length,
      captioned: index.filter((s) => s.caption).length,
    }
  }

  /** 中途停止：未开始的直接取消，正在跑的两路立即中断，已标好的保留。 */
  function stopCaptioning() {
    let stopped = 0
    while (captionQueue.length) {
      const record = captionQueue.pop()
      if (record && record.id) captionQueued.delete(record.id)
      stopped += 1
    }
    if (captionAbort && !captionAbort.signal.aborted) captionAbort.abort()
    captionStopping = captionActive > 0
    return {
      stopped,
      active: captionActive,
      pending: index.filter(captionMissing).length,
      total: index.length,
      captioned: index.filter((s) => s.caption).length,
    }
  }

  function ensurePack(packId, meta = {}) {
    if (!packs[packId]) {
      packs[packId] = {
        id: packId,
        name: String(meta.packName || packId).slice(0, 40),
        source: String(meta.sourceType || 'upload'),
        license: String(meta.license || '').slice(0, 120),
        createdAt: Date.now(),
        count: 0,
      }
      savePacks()
    }
    return packs[packId]
  }

  function absPath(record) {
    return path.join(root, record.path)
  }

  /** 登记/更新一个包的元信息（远程整包安装后调用）。 */
  function registerPack(meta = {}) {
    const id = cleanId(meta.id)
    const prev = packs[id] || {}
    packs[id] = {
      ...prev,
      id,
      name: String(meta.name || prev.name || id).slice(0, 80),
      version: String(meta.version || prev.version || '').slice(0, 40),
      description: String(meta.description || prev.description || '').slice(0, 300),
      author: String(meta.author || prev.author || '').slice(0, 80),
      homepage: String(meta.homepage || prev.homepage || '').slice(0, 300),
      license: String(meta.license || prev.license || '').slice(0, 120),
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 20) : (prev.tags || []),
      source: String(meta.source || prev.source || 'upload').slice(0, 200),
      ref: String(meta.ref || prev.ref || '').slice(0, 80),
      subpath: String(meta.subpath || prev.subpath || '').slice(0, 200),
      installedAt: Date.now(),
      count: index.filter((s) => s.packId === id).length,
    }
    savePacks()
    return packs[id]
  }

  /** 写入一张表情。buffer 必须已经是图片字节。 */
  async function ingest(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片是空的')
    if (buffer.length > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
    const ext = sniffImageExt(buffer)
    if (!ext) throw new Error('只收 PNG / JPEG / GIF / WebP（SVG 一律不收，防脚本注入）')
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const id = sha256.slice(0, 16)
    const existing = index.find((s) => s.id === id)
    if (existing) {
      // 同一张图再传一次也只入库，不自动标语义。
      return { ok: true, duplicate: true, id, item: existing }
    }

    const packId = cleanId(meta.packId)
    ensurePack(packId, meta)
    const rel = path.join('packs', packId, `${sha256}.${ext}`)
    const file = path.join(root, rel)
    // 异步写盘：一次装一百多张时不堵事件循环（同步写会让整个网页卡住）
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, buffer)

    const record = {
      id,
      packId,
      sha256,
      ext,
      bytes: buffer.length,
      path: rel.replace(/\\/g, '/'),
      animated: ext === 'gif',
      source: {
        type: String(meta.sourceType || 'upload').slice(0, 20),
        url: String(meta.sourceUrl || '').slice(0, 500),
        license: String(meta.license || '').slice(0, 120),
        retrievedAt: Date.now(),
      },
      tags: textList(meta.tags),
      emotion: textList(meta.emotion),
      caption: String(meta.caption || '').slice(0, 80),
      // 语义卡：这张图能回答什么、不能出现在什么场景、标注有多确定。
      // 旧库没有这些字段时不强行编造，检索会标成 tag-only。
      intents: textList(meta.intents, 8),
      avoid: textList(meta.avoid, 8),
      confidence: clamp01(meta.confidence, meta.caption ? 0.8 : 0.2),
      enrichedAt: meta.enrichedAt ? Number(meta.enrichedAt) || Date.now() : null,
      usageCount: 0,
      lastUsedAt: null,
      platforms: [],
      createdAt: Date.now(),
    }
    index.push(record)
    saveIndex()
    packs[packId].count = index.filter((s) => s.packId === packId).length
    savePacks()
    // 入库只落盘和写索引；是否标语义由用户在表情包页点按钮决定。
    logger.info?.(`表情包入库：${id}（${ext}，${Math.round(buffer.length / 1024)}KB，来源 ${record.source.type}）`)
    return { ok: true, duplicate: false, id, item: record }
  }

  /** 从 http(s) 链接下载一张表情。 */
  async function importUrl(url, meta = {}, { fetchImpl = fetch } = {}) {
    let parsed
    try {
      parsed = new URL(String(url || '').trim())
    } catch {
      throw new Error('链接不合法')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http / https 链接')
    let res
    try {
      res = await fetchImpl(parsed, {
        headers: { 'user-agent': UA, accept: 'image/*' },
        redirect: 'follow',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      })
    } catch (err) {
      throw new Error(`下载失败：${err.message}`)
    }
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const len = Number(res.headers?.get?.('content-length') || 0)
    if (len && len > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
    const buf = Buffer.from(await res.arrayBuffer())
    return ingest(buf, { ...meta, sourceType: meta.sourceType || 'url', sourceUrl: String(parsed) })
  }

  /** 上传：前端传 base64（纯 JSON，不引 multipart 依赖）。 */
  async function upload({ dataBase64, name = '', ...meta } = {}) {
    const raw = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '')
    if (!raw) throw new Error('没有图片数据')
    const buf = Buffer.from(raw, 'base64')
    // name 只用来给新包起名，不再当作 caption：文件名不是图义，交给后台看图补。
    return ingest(buf, { ...meta, caption: meta.caption || '', packName: meta.packName || name || '我上传的' })
  }

  function list({ q = '', limit = 50, offset = 0 } = {}) {
    const kw = String(q || '').trim().toLowerCase()
    const matched = kw
      ? index.filter((s) => {
        const hay = [s.caption, ...(s.tags || []), ...(s.emotion || []), ...(s.intents || []), ...(s.avoid || [])].join(' ').toLowerCase()
        return hay.includes(kw)
      })
      : index.slice()
    matched.sort((a, b) => b.createdAt - a.createdAt)
    return {
      total: matched.length,
      items: matched.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit)),
    }
  }

  /**
   * 按「图本身的意思 + 当前对话」检索，不再全库随机。
   * q 是对方刚说的话/视频文案；intent 是 expression.inferIntent 的结果。
   * 没有 caption 的旧图只按分类做低分兜底，返回里带 tagOnly 让调用方决定敢不敢用。
   */
  function search({ q = '', intent = '', limit = 8, includeTagOnly = true } = {}) {
    const terms = queryTerms(q)
    const wantedIntent = String(intent || '').trim().toLowerCase()
    const scored = []
    for (const record of index) {
      const caption = String(record.caption || '').toLowerCase()
      const tagText = [...(record.tags || []), ...(record.intents || []), ...(record.emotion || [])].join(' ').toLowerCase()
      const avoidText = (record.avoid || []).join(' ').toLowerCase()
      const tagOnly = !caption
      if (tagOnly && !includeTagOnly) continue
      // 明确写了「不要用在这些场景」的，直接跳过，不靠模型自觉
      if (wantedIntent && avoidText.includes(wantedIntent)) continue
      let score = 0
      const matched = []
      if (caption && q) {
        const whole = String(q).trim().toLowerCase()
        if (whole && caption.includes(whole)) { score += 0.55; matched.push('caption') }
        for (const term of terms) {
          if (caption.includes(term)) { score += term.length <= 1 ? 0.12 : 0.06; if (!matched.includes(term)) matched.push(term) }
        }
      }
      if (wantedIntent) {
        const own = [...(record.intents || []), ...(record.tags || [])].map((x) => String(x).toLowerCase())
        if (own.includes(wantedIntent)) { score += 0.32; matched.push(wantedIntent) }
        else if (tagText.includes(wantedIntent)) { score += 0.16; matched.push(wantedIntent) }
      }
      // 没有语义卡的旧图：只按分类给一点分；连同 confidence 一起封顶 0.38，
      // 不能靠高 confidence 把 tagOnly 图抬到 caption 图的 0.40 门槛。
      score += (record.confidence ?? 0.2) * 0.08
      if (tagOnly) score = Math.min(score, 0.38)
      if (record.lastUsedAt && Date.now() - record.lastUsedAt < 6 * 60 * 60 * 1000) score -= 0.04
      if (score <= 0) continue
      scored.push({
        ...record,
        score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100,
        tagOnly,
        matched,
      })
    }
    scored.sort((a, b) => b.score - a.score || (b.confidence || 0) - (a.confidence || 0))
    return scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
  }

  /** 网页上给单张图补「含义卡」；只改这一张，不动图片本身。 */
  function updateMeta(id, patch = {}) {
    const record = get(id)
    if (!record) return { ok: false, reason: '这张表情不在库里' }
    if ('caption' in patch) record.caption = String(patch.caption || '').slice(0, 80)
    if ('tags' in patch) record.tags = textList(patch.tags)
    if ('emotion' in patch) record.emotion = textList(patch.emotion)
    if ('intents' in patch) record.intents = textList(patch.intents, 8)
    if ('avoid' in patch) record.avoid = textList(patch.avoid, 8)
    if ('confidence' in patch) record.confidence = clamp01(patch.confidence, record.confidence ?? 0.2)
    record.enrichedAt = Date.now()
    saveIndex()
    // 清空 caption 只清标注；要不要重新标由用户点「标语义」决定。
    if (!record.caption) record.enrichAttemptAt = null
    return { ok: true, item: record }
  }

  function get(id) {
    return index.find((s) => s.id === String(id || '')) || null
  }

  function filePath(id) {
    const record = get(id)
    if (!record) return null
    const file = absPath(record)
    try {
      if (!fs.statSync(file).isFile()) return null
    } catch {
      return null
    }
    return file
  }

  function mimeOf(id) {
    const record = get(id)
    return record ? EXT_MIME[record.ext] || 'application/octet-stream' : ''
  }

  /** 标记用过一次：给以后「最近/常用」排序，也让分享统计有据可查。 */
  function markUsed(id, platform = '') {
    const record = get(id)
    if (!record) return null
    record.usageCount = (record.usageCount || 0) + 1
    record.lastUsedAt = Date.now()
    if (platform && !(record.platforms || []).includes(platform)) {
      record.platforms = [...(record.platforms || []), platform].slice(0, 8)
    }
    saveIndex()
    return record
  }

  function remove(id) {
    const idx = index.findIndex((s) => s.id === String(id || ''))
    if (idx < 0) return { ok: false, reason: '这张表情不在库里' }
    const [record] = index.splice(idx, 1)
    try {
      fs.rmSync(absPath(record), { force: true })
    } catch (err) {
      logger.warn?.(`表情包文件删除失败：${err.message}`)
    }
    saveIndex()
    if (packs[record.packId]) {
      packs[record.packId].count = index.filter((s) => s.packId === record.packId).length
      savePacks()
    }
    return { ok: true, id: record.id }
  }

  function stats() {
    const totalBytes = index.reduce((sum, s) => sum + (s.bytes || 0), 0)
    return {
      total: index.length,
      packs: Object.keys(packs).length,
      packsList: Object.values(packs),
      bytes: totalBytes,
      animated: index.filter((s) => s.animated).length,
      captioned: index.filter((s) => s.caption).length,
      captionPending: index.filter(captionMissing).length,
      captionActive,
      captionQueued: captionQueue.length,
      captionStopping,
      captionFailed: index.filter((s) => !s.caption && s.enrichAttemptAt && !captionQueued.has(s.id)).length,
      captionReady: Boolean(captioner),
      dir: path.relative(fromRoot('.'), root).replace(/\\/g, '/'),
    }
  }

  /** 给平台适配器用的发送引用：只给字节与 mime，由适配器决定怎么发。 */
  function toRef(id) {
    const record = get(id)
    if (!record) return null
    const file = filePath(id)
    if (!file) return null
    return {
      id: record.id,
      mime: EXT_MIME[record.ext] || 'application/octet-stream',
      bytes: Buffer.from(fs.readFileSync(file)),
      path: file,
      animated: record.animated,
      caption: record.caption,
    }
  }

  return {
    ingest, importUrl, upload, list, search, updateMeta, get, filePath, mimeOf, markUsed, remove, stats, toRef, registerPack,
    setCaptioner, enrichMissing, stopCaptioning,
    dir: root,
  }
}
