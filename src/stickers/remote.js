// ============================================================
// 远程表情包：从 AstrBot 生态的社区索引/仓库整包下载
//
// 格式依据 anka-afk/astrbot-meme-pack-index 的《AstrBot 表情包规范》（v0.3）：
//   包根 = manifest.json + memes/<分类>/<图片>
//   社区索引 = community-index.json，packs[] 里带 source{type:'github',repo,ref,subpath}
// 下载方式：GitHub API 拿文件树 → 从 github.com/<repo>/raw/<ref>/<path> 逐张取。
// （zipball 在本机网络下会超时；tree+raw 实测稳定。）
// 只做「读」：不执行包内任何东西，图片逐个过魔数与去重。
// ============================================================

const INDEX_REPO = 'anka-afk/astrbot-meme-pack-index'
const INDEX_PATH = 'community-index.json'
const DEFAULT_INDEX = `https://api.github.com/repos/${INDEX_REPO}/contents/${INDEX_PATH}`
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const MAX_IMAGES_DEFAULT = 200
const CONCURRENCY = 4

import fs from 'node:fs'
import { fromRoot } from '../utils/paths.js'
import { httpGet } from './net.js'

async function fetchJson(url, fetchImpl = null, { timeoutMs = 20000 } = {}) {
  const res = await httpGet(url, {
    timeoutMs, fetchImpl,
    headers: { accept: 'application/vnd.github+json, application/json' },
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`请求失败：HTTP ${res.status}`)
  try {
    return JSON.parse(res.body.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('返回不是合法 JSON')
  }
}

/**
 * 仓库里的推荐清单：图片不进 git，但「去哪儿下」这份清单要进 git。
 * 社区索引拉不到时（国内经常拉不到 GitHub API）用它兜底，新用户也不至于对着空库。
 */
export function readRecommended() {
  try {
    const raw = JSON.parse(fs.readFileSync(fromRoot('assets/stickers/recommended.json'), 'utf8'))
    const packs = Array.isArray(raw.packs) ? raw.packs : []
    return {
      schemaVersion: String(raw.schema_version || ''),
      maintainer: String(raw.maintainer || ''),
      repository: String(raw.repository || ''),
      generatedAt: String(raw.generated_at || ''),
      packs: packs.filter((p) => p && p.id && p.name && p.source && p.source.type === 'github'),
      source: 'recommended',
    }
  } catch {
    return { schemaVersion: '', maintainer: '', repository: '', generatedAt: '', packs: [], source: 'recommended' }
  }
}

/**
 * 拉社区索引。GitHub API 返回文件对象（content 为 base64），也接受直接是 JSON 的地址。
 * 拉不到就退回仓库里的推荐清单，并在返回值里标明 offline 与原因。
 */
export async function fetchCommunityIndex({ url = DEFAULT_INDEX, fetchImpl = fetch } = {}) {
  try {
    return await fetchCommunityIndexOnline({ url, fetchImpl })
  } catch (err) {
    const rec = readRecommended()
    if (!rec.packs.length) throw err
    return { ...rec, offline: true, reason: err.message }
  }
}

async function fetchCommunityIndexOnline({ url = DEFAULT_INDEX, fetchImpl = fetch } = {}) {
  const data = await fetchJson(url, fetchImpl)
  let index = data
  if (data && typeof data.content === 'string' && data.encoding === 'base64') {
    try {
      index = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
    } catch {
      throw new Error('索引文件不是合法 JSON')
    }
  }
  if (!index || !Array.isArray(index.packs)) throw new Error('索引格式不对：缺少 packs 数组')
  return {
    schemaVersion: index.schema_version || '',
    maintainer: index.maintainer || '',
    repository: index.repository || '',
    generatedAt: index.generated_at || '',
    packs: index.packs
      .filter((p) => p && p.id && p.name && p.source && p.source.type === 'github')
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        version: String(p.version || ''),
        description: String(p.description || ''),
        license: String(p.license || ''),
        maintainer: String(p.maintainer || ''),
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 20) : [],
        preview: Array.isArray(p.previews) && p.previews[0] ? String(p.previews[0]) : '',
        verified: Boolean(p.verified),
        source: {
          repo: String(p.source.repo || ''),
          ref: String(p.source.ref || 'main'),
          subpath: String(p.source.subpath || '.'),
        },
      })),
  }
}

/** GitHub API：一次拿全仓库文件树。 */
async function fetchTree(repo, ref, fetchImpl = fetch) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`
  const data = await fetchJson(url, fetchImpl, { timeoutMs: 30000 })
  if (!data || !Array.isArray(data.tree)) throw new Error('GitHub 没返回文件树')
  if (data.truncated) throw new Error('仓库太大，文件树被截断，暂不支持整包安装')
  return data.tree.filter((e) => e && e.type === 'blob' && typeof e.path === 'string')
}

/** 从 github.com/<repo>/raw/<ref>/<path> 下载单个文件。 */
async function downloadRaw(repo, ref, path, fetchImpl = null) {
  const encoded = String(path).split('/').map((seg) => encodeURIComponent(seg)).join('/')
  const url = `https://github.com/${repo}/raw/${ref}/${encoded}`
  const res = await httpGet(url, {
    timeoutMs: 30000, fetchImpl,
    headers: { accept: 'application/octet-stream,*/*' },
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
  return res.body
}

/**
 * 安装一个整包。
 * @returns {Promise<{ ok, pack, added, duplicate, skipped, total }>}
 */
export async function installPack({
  repo, ref = 'main', subpath = '.', library,
  fetchImpl = null, logger = console, maxImages = MAX_IMAGES_DEFAULT, onProgress = null,
} = {}) {
  if (!library) throw new Error('缺少表情包库')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) throw new Error('仓库名要写成 owner/repo')
  const tree = await fetchTree(repo, ref, fetchImpl)
  const base = subpath && subpath !== '.' ? String(subpath).replace(/^\/+|\/+$/g, '') + '/' : ''

  const manifestPath = `${base}manifest.json`
  const manifestEntry = tree.find((e) => e.path === manifestPath)
  if (!manifestEntry) throw new Error('包里没有 manifest.json，不是标准表情包')
  let manifest
  try {
    // 有些仓库的 manifest 带 UTF-8 BOM，先去掉再解析
    manifest = JSON.parse((await downloadRaw(repo, ref, manifestPath, fetchImpl)).toString('utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`manifest.json 读不出来：${err.message}`)
  }
  if (!manifest || typeof manifest.id !== 'string' || !manifest.categories || typeof manifest.categories !== 'object') {
    throw new Error('manifest 缺少 id / categories')
  }
  const categories = Object.keys(manifest.categories).filter((k) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(k))
  if (!categories.length) throw new Error('manifest 没有合法分类')

  const memesPrefix = `${base}memes/`
  const images = tree
    .filter((e) => e.path.startsWith(memesPrefix) && IMAGE_EXT.test(e.path))
    .filter((e) => !Number.isFinite(e.size) || e.size > 0)
    .map((e) => {
      const rel = e.path.slice(memesPrefix.length)
      const parts = rel.split('/')
      return { path: e.path, category: parts.length >= 2 ? parts[0] : '', size: e.size }
    })
    .filter((x) => x.category && categories.includes(x.category))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Number(maxImages) || MAX_IMAGES_DEFAULT))

  if (!images.length) throw new Error('包里没有可用的分类表情（memes/<分类>/<图片>）')

  const baseUrl = `https://github.com/${repo}`
  let added = 0
  let duplicate = 0
  let skipped = 0
  let cursor = 0

  async function worker() {
    while (cursor < images.length) {
      const item = images[cursor++]
      try {
        const buf = await downloadRaw(repo, ref, item.path, fetchImpl)
        const r = await library.ingest(buf, {
          packId: manifest.id,
          packName: manifest.name,
          license: manifest.license || '',
          sourceType: 'github-pack',
          sourceUrl: `${baseUrl} (${ref}${subpath !== '.' ? '/' + subpath : ''})`,
          tags: [item.category, ...(Array.isArray(manifest.tags) ? manifest.tags : [])],
          caption: '',
        })
        if (r.duplicate) duplicate++
        else added++
      } catch (err) {
        skipped++
        logger?.warn?.(`表情包 ${manifest.id} 的 ${item.path} 下载/入库失败：${err.message}`)
      }
      try {
        onProgress?.({ done: added + duplicate + skipped, total: images.length, added, duplicate, skipped })
      } catch { /* 进度回调出错不影响安装 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker))

  const pack = library.registerPack({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version || '',
    description: manifest.description || '',
    author: manifest.author || '',
    homepage: manifest.homepage || '',
    license: manifest.license || '',
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    source: `github:${repo}`,
    ref,
    subpath,
  })
  logger?.info?.(`表情包整包安装：${manifest.name}（新增 ${added}，重复 ${duplicate}，跳过 ${skipped}）`)
  return { ok: true, pack, added, duplicate, skipped, total: images.length }
}
