// ============================================================
// 本机存储维护
//
// 只处理两类东西：
//   1. 共享浏览器档案里的可再生缓存；
//   2. 旧版遗留的 browser-profile-listen。
//
// 登录态（Cookies / Login Data / Preferences / Sessions / Network）
// 不在清理清单里，任何情况下都不能整目录删 browser-profile。
// ============================================================

import fs from 'node:fs/promises'
import path from 'node:path'
import { fromRoot } from '../utils/paths.js'

const SHARED_PROFILE = 'browser-profile'
const LEGACY_PROFILE = 'browser-profile-listen'

// 只列可以再生的缓存。不要往这里加 Cookies / Login Data / Network / Sessions。
const CACHE_ITEMS = [
  { rel: 'Default/Cache', label: '页面缓存' },
  { rel: 'Default/Code Cache', label: '脚本缓存' },
  { rel: 'Default/GPUCache', label: '显卡缓存' },
  { rel: 'Default/DawnCache', label: '图形缓存' },
  { rel: 'Default/DawnGraphiteCache', label: '图形缓存' },
  { rel: 'Default/DawnWebGPUCache', label: '图形缓存' },
  { rel: 'Default/ShaderCache', label: '着色器缓存' },
  { rel: 'component_crx_cache', label: '浏览器组件缓存' },
  { rel: 'ProvenanceData', label: '组件数据' },
]

const MB = 1024 * 1024

function mb(bytes) {
  return Math.round((Number(bytes) || 0) / MB * 10) / 10
}

async function treeUsage(dir) {
  let bytes = 0
  let files = 0
  let exists = false
  try {
    const st = await fs.lstat(dir)
    exists = true
    if (!st.isDirectory()) return { exists, bytes: st.size, files: 1, isDir: false }
  } catch {
    return { exists: false, bytes: 0, files: 0, isDir: false }
  }
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // 不跟随符号链接，避免把目录外的东西算进来
      if (entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(full)
          bytes += st.size
          files += 1
        } catch {
          // 被占用/没权限的文件忽略，不阻断整页统计
        }
      }
    }
  }
  return { exists, bytes, files, isDir: true }
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw Object.assign(new Error('至少选一项要清理的内容'), { code: 'TARGETS_INVALID' })
  }
  const allowed = new Set(['cache', 'legacy'])
  const picked = [...new Set(targets.map((item) => String(item)))].filter((item) => allowed.has(item))
  if (!picked.length) throw Object.assign(new Error('清理项不在允许范围内'), { code: 'TARGETS_INVALID' })
  return picked
}

function removeError(err) {
  const locked = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
  return {
    ok: false,
    code: locked.has(err?.code) ? 'BROWSER_RUNNING' : (err?.code || 'CLEAN_FAILED'),
    message: locked.has(err?.code)
      ? '有文件正在被浏览器占用，先关闭 DSH 浏览器再试'
      : (err?.message || '清理失败'),
  }
}

export function createStorageMaintenance({ root = fromRoot('data'), logger = console } = {}) {
  const dataRoot = path.resolve(root)
  const sharedDir = path.join(dataRoot, SHARED_PROFILE)
  const legacyDir = path.join(dataRoot, LEGACY_PROFILE)

  function safeInside(target) {
    const resolved = path.resolve(target)
    if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep)) {
      throw Object.assign(new Error('清理路径越界'), { code: 'PATH_FORBIDDEN' })
    }
    return resolved
  }

  async function cacheItems() {
    const items = []
    for (const item of CACHE_ITEMS) {
      const dir = safeInside(path.join(sharedDir, item.rel))
      const usage = await treeUsage(dir)
      if (!usage.exists || usage.files === 0) continue
      items.push({
        rel: item.rel,
        label: item.label,
        bytes: usage.bytes,
        files: usage.files,
      })
    }
    return items
  }

  async function summary() {
    // 顶层占用：按目录分开看，避免把 2GB 都归到“代码”上
    const top = []
    try {
      const entries = await fs.readdir(dataRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue
        const usage = await treeUsage(path.join(dataRoot, entry.name))
        if (!usage.exists) continue
        top.push({ name: entry.name, bytes: usage.bytes, files: usage.files })
      }
    } catch (err) {
      logger.warn?.(`存储扫描失败：${err.message}`)
    }

    const byName = new Map(top.map((item) => [item.name, item]))
    const shared = byName.get(SHARED_PROFILE) || { bytes: 0, files: 0 }
    const legacy = byName.get(LEGACY_PROFILE) || { bytes: 0, files: 0 }
    const stickers = byName.get('stickers') || { bytes: 0, files: 0 }
    const characters = byName.get('characters') || { bytes: 0, files: 0 }
    const templates = byName.get('templates') || { bytes: 0, files: 0 }
    const browserBytes = (shared.bytes || 0) + (legacy.bytes || 0)
    const topKnown = new Set([SHARED_PROFILE, LEGACY_PROFILE, 'stickers', 'characters', 'templates'])
    const otherBytes = top
      .filter((item) => !topKnown.has(item.name))
      .reduce((sum, item) => sum + (item.bytes || 0), 0)
    const totalBytes = top.reduce((sum, item) => sum + (item.bytes || 0), 0)

    const cache = await cacheItems()
    const cacheBytes = cache.reduce((sum, item) => sum + item.bytes, 0)
    const legacyUsage = await treeUsage(legacyDir)

    const categories = [
      { id: 'browser', label: '浏览器档案', bytes: browserBytes, files: shared.files + legacy.files, note: '共享档案 + 旧监听档案' },
      { id: 'stickers', label: '表情包', bytes: stickers.bytes, files: stickers.files, note: '两个表情包，不动' },
      { id: 'characters', label: '形象原图', bytes: characters.bytes, files: characters.files, note: '13 张原图 + 安装记录，按需保留' },
      { id: 'templates', label: '模板底图', bytes: templates.bytes, files: templates.files, note: '文字卡片模板' },
      { id: 'other', label: '其他本机数据', bytes: otherBytes, files: top.filter((item) => !topKnown.has(item.name)).reduce((sum, item) => sum + item.files, 0), note: '记忆、状态、日志等，不动' },
    ]

    return {
      totalBytes,
      totalMB: mb(totalBytes),
      categories,
      profiles: [
        { id: 'shared', label: '共享浏览器档案', bytes: shared.bytes, files: shared.files, exists: Boolean(shared.files || shared.bytes) },
        { id: 'legacy', label: '旧监听档案', bytes: legacyUsage.bytes, files: legacyUsage.files, exists: legacyUsage.exists },
      ],
      cleanup: {
        cache: {
          id: 'cache',
          label: '清理可再生缓存',
          bytes: cacheBytes,
          files: cache.reduce((sum, item) => sum + item.files, 0),
          available: cacheBytes > 0,
          items: cache,
        },
        legacy: {
          id: 'legacy',
          label: '清理旧监听档案',
          bytes: legacyUsage.bytes,
          files: legacyUsage.files,
          available: legacyUsage.exists,
          path: `data/${LEGACY_PROFILE}`,
        },
      },
      safeNote: '只清可再生缓存和旧监听档案；不会删除登录态、人格、记忆、形象原图和表情包。',
      updatedAt: Date.now(),
    }
  }

  async function clean({ targets } = {}) {
    const picked = normalizeTargets(targets)
    const results = []
    let freedBytes = 0

    for (const target of picked) {
      if (target === 'cache') {
        for (const item of CACHE_ITEMS) {
          const dir = safeInside(path.join(sharedDir, item.rel))
          const usage = await treeUsage(dir)
          if (!usage.exists) continue
          try {
            await fs.rm(dir, { recursive: true, force: true })
            freedBytes += usage.bytes
            results.push({ target, path: item.rel, bytes: usage.bytes, files: usage.files, ok: true })
          } catch (err) {
            const failure = removeError(err)
            results.push({ target, path: item.rel, bytes: 0, files: 0, ...failure })
            logger.warn?.(`存储清理失败 ${item.rel}：${failure.message}`)
          }
        }
      }

      if (target === 'legacy') {
        const usage = await treeUsage(legacyDir)
        if (!usage.exists) {
          results.push({ target, path: `data/${LEGACY_PROFILE}`, bytes: 0, files: 0, ok: true, skipped: true })
          continue
        }
        try {
          await fs.rm(legacyDir, { recursive: true, force: true })
          freedBytes += usage.bytes
          results.push({ target, path: `data/${LEGACY_PROFILE}`, bytes: usage.bytes, files: usage.files, ok: true })
        } catch (err) {
          const failure = removeError(err)
          results.push({ target, path: `data/${LEGACY_PROFILE}`, bytes: 0, files: 0, ...failure })
          logger.warn?.(`旧监听档案清理失败：${failure.message}`)
        }
      }
    }

    const errors = results.filter((item) => !item.ok)
    const after = await summary()
    if (freedBytes > 0) logger.info?.(`存储清理完成：释放 ${mb(freedBytes)}MB`)
    return {
      freedBytes,
      freedMB: mb(freedBytes),
      targets: picked,
      results,
      errors,
      after,
    }
  }

  return { summary, clean }
}
