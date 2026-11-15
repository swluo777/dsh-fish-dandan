// ============================================================
// 本机存储维护
//
// 处理三类东西：
//   1. 共享浏览器档案里的可再生缓存；
//   2. 旧版遗留的 browser-profile-listen；
//   3. 自由创作 / 画画的旧稿与旧版创作残留。
//
// 创意工作室的作品由插件自己管理，这里只读展示，绝不删除。
// 登录态（Cookies / Login Data / Preferences / Sessions / Network）
// 不在清理清单里，任何情况下都不能整目录删 browser-profile。
// ============================================================

import fs from 'node:fs/promises'
import path from 'node:path'
import { fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'

const SHARED_PROFILE = 'browser-profile'
const LEGACY_PROFILE = 'browser-profile-listen'
const CREATIVE_DIR = 'creative'
const CREATIVE_INPUTS = 'creative/inputs'
const CREATIVE_LEGACY_DIRS = ['creative/exports', 'creative/jobs', 'creative/runtime']
const FREE_DRAFT_KEEP = 15

// 只列可以再生的缓存。不要往这里加 Cookies / Login Data / Network / Sessions。
const CACHE_ITEMS = [
  { rel: 'Default/Cache', label: '页面缓存' },
  { rel: 'Default/Code Cache', label: '脚本缓存' },
  { rel: 'Default/GPUCache', label: '显卡缓存' },
  { rel: 'Default/DawnCache', label: '图形缓存' },
  { rel: 'Default/DawnGraphiteCache', label: '图形缓存' },
  { rel: 'Default/DawnWebGPUCache', label: '图形缓存' },
  { rel: 'ShaderCache', label: '着色器缓存' },
  { rel: 'GrShaderCache', label: '着色器缓存' },
  { rel: 'component_crx_cache', label: '浏览器组件缓存' },
  { rel: 'ProvenanceData', label: '组件数据' },
]

const MB = 1024 * 1024

function mb(bytes) {
  return Math.round((Number(bytes) || 0) / MB * 10) / 10
}

function text(value) {
  return String(value ?? '').trim()
}

function baseName(value) {
  return text(value).split(/[\\/]/).pop() || ''
}

function isCreativeHtml(name) {
  return /^creative-.*\.html$/i.test(String(name || ''))
}

function sumUsage(usages) {
  return usages.reduce((acc, usage) => {
    acc.bytes += Number(usage?.bytes) || 0
    acc.files += Number(usage?.files) || 0
    acc.exists = acc.exists || Boolean(usage?.exists)
    return acc
  }, { exists: false, bytes: 0, files: 0 })
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

async function directFileUsage(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { exists: false, bytes: 0, files: 0 }
  }
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue
    try {
      const st = await fs.stat(path.join(dir, entry.name))
      bytes += st.size
      files += 1
    } catch {
      // 被占用/没权限的文件忽略
    }
  }
  return { exists: true, bytes, files }
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw Object.assign(new Error('至少选一项要清理的内容'), { code: 'TARGETS_INVALID' })
  }
  const allowed = new Set(['cache', 'legacy', 'free-drafts'])
  const picked = [...new Set(targets.map((item) => String(item)))].filter((item) => allowed.has(item))
  if (!picked.length) throw Object.assign(new Error('清理项不在允许范围内'), { code: 'TARGETS_INVALID' })
  return picked
}

function removeError(err, { browser = false } = {}) {
  const locked = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
  return {
    ok: false,
    code: locked.has(err?.code) ? 'FILE_BUSY' : (err?.code || 'CLEAN_FAILED'),
    message: locked.has(err?.code)
      ? (browser ? '有文件正在被浏览器占用，先关闭 DSH 浏览器再试' : '有文件正在被占用，稍后再试')
      : (err?.message || '清理失败'),
  }
}

function isInside(child, parent) {
  const a = path.resolve(child)
  const b = path.resolve(parent)
  return a === b || a.startsWith(b + path.sep)
}

export function createStorageMaintenance({ root = fromRoot('data'), logger = console, getCreativeStudio = null } = {}) {
  const dataRoot = path.resolve(root)
  const sharedDir = path.join(dataRoot, SHARED_PROFILE)
  const legacyDir = path.join(dataRoot, LEGACY_PROFILE)
  const creativeDir = path.join(dataRoot, CREATIVE_DIR)
  const inputsDir = path.join(dataRoot, CREATIVE_INPUTS)
  const imagesDir = path.join(dataRoot, 'images')
  const stateDir = path.join(dataRoot, 'state')
  const creativeIndex = path.join(creativeDir, 'index.json')
  const lastCreative = path.join(stateDir, 'creative-studio-last.json')

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

  async function creativeHtmlFiles() {
    let entries
    try {
      entries = await fs.readdir(creativeDir, { withFileTypes: true })
    } catch {
      return []
    }
    const files = []
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !isCreativeHtml(entry.name)) continue
      const full = path.join(creativeDir, entry.name)
      try {
        const st = await fs.stat(full)
        if (!st.isFile()) continue
        files.push({
          name: entry.name,
          path: full,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        })
      } catch {
        // 被占用/没权限的文件忽略
      }
    }
    return files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
  }

  async function debugImageFiles() {
    const out = []
    const stack = [imagesDir]
    while (stack.length) {
      const current = stack.pop()
      let entries
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile() && /^ui-fail-.*\.(png|jpe?g)$/i.test(entry.name)) {
          try {
            const st = await fs.stat(full)
            out.push({ path: full, rel: path.relative(dataRoot, full), bytes: st.size })
          } catch {
            // 忽略读不到的文件
          }
        }
      }
    }
    return out
  }

  async function studioCurrent() {
    const last = readJsonSafe(lastCreative, null)
    const outputDir = text(last?.outputDir)
    if (!last?.ok || !outputDir) {
      return { exists: false, bytes: 0, files: 0, jobId: '', readonly: true }
    }
    const usage = await treeUsage(outputDir)
    return {
      exists: usage.exists && usage.files > 0,
      bytes: usage.bytes,
      files: usage.files,
      jobId: text(last.jobId),
      readonly: true,
    }
  }

  async function creativeSnapshot() {
    const creativeUsage = await treeUsage(creativeDir)
    const rootFiles = await directFileUsage(creativeDir)
    const studioUsage = sumUsage([
      await treeUsage(path.join(creativeDir, 'account')),
      await treeUsage(inputsDir),
    ])
    const legacyUsage = sumUsage(await Promise.all(
      CREATIVE_LEGACY_DIRS.map((rel) => treeUsage(path.join(dataRoot, rel))),
    ))
    const imagesUsage = await treeUsage(imagesDir)
    const drafts = await creativeHtmlFiles()
    const debug = await debugImageFiles()
    const creativeGapBytes = Math.max(0, creativeUsage.bytes - rootFiles.bytes - studioUsage.bytes - legacyUsage.bytes)
    const creativeGapFiles = Math.max(0, creativeUsage.files - rootFiles.files - studioUsage.files - legacyUsage.files)
    return {
      creativeUsage,
      rootFiles,
      studioUsage,
      legacyUsage,
      imagesUsage,
      drafts,
      debug,
      freeBytes: rootFiles.bytes + imagesUsage.bytes + creativeGapBytes,
      freeFiles: rootFiles.files + imagesUsage.files + creativeGapFiles,
    }
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
    const plugins = byName.get('plugins') || { bytes: 0, files: 0 }
    const browserBytes = (shared.bytes || 0) + (legacy.bytes || 0)
    const topKnown = new Set([
      SHARED_PROFILE,
      LEGACY_PROFILE,
      'stickers',
      'characters',
      'templates',
      'creative',
      'plugins',
      'images',
    ])
    const otherTop = top.filter((item) => !topKnown.has(item.name))
    const otherBytes = otherTop.reduce((sum, item) => sum + (item.bytes || 0), 0)
    const totalBytes = top.reduce((sum, item) => sum + (item.bytes || 0), 0)

    const cache = await cacheItems()
    const cacheBytes = cache.reduce((sum, item) => sum + item.bytes, 0)
    const legacyUsage = await treeUsage(legacyDir)
    const creative = await creativeSnapshot()
    const current = await studioCurrent()

    const drafts = creative.drafts
    const oldDrafts = drafts.slice(FREE_DRAFT_KEEP)
    const oldDraftBytes = oldDrafts.reduce((sum, item) => sum + item.bytes, 0)
    const inputsUsage = await treeUsage(inputsDir)
    const debugBytes = creative.debug.reduce((sum, item) => sum + item.bytes, 0)
    const freeDraftBytes = oldDraftBytes + creative.legacyUsage.bytes + inputsUsage.bytes + debugBytes
    const freeDraftFiles = oldDrafts.length + creative.legacyUsage.files + inputsUsage.files + creative.debug.length
    const freeDraftAvailable = freeDraftFiles > 0

    const studioNote = current.exists
      ? `账号头像与渲染输入；当前作品 ${mb(current.bytes)}MB 在插件目录，只读`
      : '账号头像与渲染输入；当前没有可预览作品'
    const freeNote = drafts.length
      ? `${drafts.length} 个创作稿，保留最近 ${FREE_DRAFT_KEEP} 张；豆包生图只统计，不随旧稿清`
      : '自由创作稿与豆包生图；目前还没有创作稿'
    const legacyCreativeNote = creative.legacyUsage.files
      ? '旧版宿主创作残留；可随自由创作旧稿一起清'
      : '没有旧版宿主残留'

    const categories = [
      { id: 'browser', label: '浏览器档案', bytes: browserBytes, files: shared.files + legacy.files, note: '共享档案 + 旧监听档案' },
      { id: 'stickers', label: '表情包', bytes: stickers.bytes, files: stickers.files, note: '两个表情包，不动' },
      { id: 'characters', label: '形象原图', bytes: characters.bytes, files: characters.files, note: '13 张原图 + 安装记录，按需保留' },
      { id: 'templates', label: '模板底图', bytes: templates.bytes, files: templates.files, note: '文字卡片模板' },
      { id: 'creative-studio', label: '创意工作室', bytes: creative.studioUsage.bytes, files: creative.studioUsage.files, note: studioNote },
      { id: 'creative-free', label: '自由创作 / 画画', bytes: creative.freeBytes, files: creative.freeFiles, note: freeNote },
      { id: 'creative-legacy', label: '旧版创作残留', bytes: creative.legacyUsage.bytes, files: creative.legacyUsage.files, note: legacyCreativeNote },
      { id: 'plugins', label: '插件与运行环境', bytes: plugins.bytes, files: plugins.files, note: '已安装插件、依赖与运行环境；只统计，不自动清理' },
      { id: 'other', label: '其他本机数据', bytes: otherBytes, files: otherTop.reduce((sum, item) => sum + item.files, 0), note: '记忆、状态、日志等；只统计，不自动清理' },
    ]

    return {
      totalBytes,
      totalMB: mb(totalBytes),
      categories,
      studio: {
        readonly: true,
        current,
      },
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
        freeDrafts: {
          id: 'free-drafts',
          label: '清理自由创作的旧稿',
          bytes: freeDraftBytes,
          files: freeDraftFiles,
          available: freeDraftAvailable,
          keep: FREE_DRAFT_KEEP,
          total: drafts.length,
          remove: oldDrafts.length,
          breakdown: {
            drafts: { bytes: oldDraftBytes, files: oldDrafts.length },
            legacy: { bytes: creative.legacyUsage.bytes, files: creative.legacyUsage.files },
            inputs: { bytes: inputsUsage.bytes, files: inputsUsage.files },
            debugImages: { bytes: debugBytes, files: creative.debug.length },
          },
        },
      },
      safeNote: '只清可再生缓存、旧监听档案和自由创作旧稿；不会删除登录态、人格、记忆、形象原图、表情包、当前创作作品、账号头像和豆包生图。',
      updatedAt: Date.now(),
    }
  }

  async function assertCreativeIdle() {
    if (typeof getCreativeStudio !== 'function') return
    let state
    try {
      state = getCreativeStudio()?.status?.()
    } catch {
      return
    }
    if (state?.run || state?.action?.busy || state?.runtime?.installing) {
      throw Object.assign(new Error('正在创作或安装依赖，等这次结束再清理旧稿'), { code: 'CREATIVE_BUSY' })
    }
  }

  async function protectedCreativePaths() {
    const last = readJsonSafe(lastCreative, null)
    return [text(last?.outputDir), text(last?.imagePath)]
      .filter(Boolean)
      .map((item) => path.resolve(item))
  }

  function overlapsProtected(target, protectedPaths) {
    return protectedPaths.some((item) => isInside(target, item) || isInside(item, target))
  }

  async function pruneCreativeIndex(keepNames) {
    let indexExists = false
    try {
      await fs.lstat(creativeIndex)
      indexExists = true
    } catch { /* 没有索引时允许直接清旧稿 */ }
    const index = readJsonSafe(creativeIndex, null)
    if (!index || !Array.isArray(index.items)) {
      if (indexExists) {
        throw Object.assign(new Error('data/creative/index.json 解析失败，先不删旧稿'), { code: 'INDEX_INVALID' })
      }
      return { changed: false }
    }
    const items = index.items.filter((item) => {
      const name = baseName(item?.html)
      if (!name || !isCreativeHtml(name)) return true
      return keepNames.has(name)
    })
    if (items.length === index.items.length) return { changed: false }
    writeJsonAtomic(creativeIndex, { ...index, items, updatedAt: Date.now() })
    return { changed: true, removed: index.items.length - items.length }
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
            const failure = removeError(err, { browser: true })
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
          const failure = removeError(err, { browser: true })
          results.push({ target, path: `data/${LEGACY_PROFILE}`, bytes: 0, files: 0, ...failure })
          logger.warn?.(`旧监听档案清理失败：${failure.message}`)
        }
      }

      if (target === 'free-drafts') {
        await assertCreativeIdle()
        const drafts = await creativeHtmlFiles()
        const keep = drafts.slice(0, FREE_DRAFT_KEEP)
        const old = drafts.slice(FREE_DRAFT_KEEP)
        const keepNames = new Set(keep.map((item) => item.name))
        const protectedPaths = await protectedCreativePaths()

        // 先原子改写索引，再删旧 HTML；即使删除中断，也不会留下“索引指向已删文件”的坏状态。
        if (old.length > 0) {
          try {
            const pruned = await pruneCreativeIndex(keepNames)
            if (pruned.changed) {
              results.push({
                target,
                path: 'data/creative/index.json',
                bytes: 0,
                files: 0,
                ok: true,
                skipped: true,
                note: `索引移除 ${pruned.removed} 条旧记录`,
              })
            }
          } catch (err) {
            const failure = removeError(err)
            results.push({ target, path: 'data/creative/index.json', bytes: 0, files: 0, ...failure })
            logger.warn?.(`自由创作索引清理失败：${failure.message}`)
            // 索引没改成功时不能删 HTML，否则会留下不可恢复的旧稿
            continue
          }
        }

        for (const item of old) {
          const file = safeInside(item.path)
          try {
            await fs.rm(file, { force: true })
            freedBytes += item.bytes
            results.push({ target, path: path.relative(dataRoot, file), bytes: item.bytes, files: 1, ok: true })
          } catch (err) {
            const failure = removeError(err)
            results.push({ target, path: path.relative(dataRoot, file), bytes: 0, files: 0, ...failure })
            logger.warn?.(`自由创作旧稿清理失败 ${item.name}：${failure.message}`)
          }
        }

        for (const rel of CREATIVE_LEGACY_DIRS) {
          const dir = safeInside(path.join(dataRoot, rel))
          const usage = await treeUsage(dir)
          if (!usage.exists) continue
          if (overlapsProtected(dir, protectedPaths)) {
            results.push({ target, path: `data/${rel}`, bytes: 0, files: 0, ok: true, skipped: true, note: '当前作品还在这个目录，跳过' })
            continue
          }
          try {
            await fs.rm(dir, { recursive: true, force: true })
            freedBytes += usage.bytes
            results.push({ target, path: `data/${rel}`, bytes: usage.bytes, files: usage.files, ok: true })
          } catch (err) {
            const failure = removeError(err)
            results.push({ target, path: `data/${rel}`, bytes: 0, files: 0, ...failure })
            logger.warn?.(`旧版创作残留清理失败 ${rel}：${failure.message}`)
          }
        }

        const inputs = await treeUsage(inputsDir)
        if (inputs.exists) {
          try {
            await fs.rm(inputsDir, { recursive: true, force: true })
            freedBytes += inputs.bytes
            results.push({ target, path: 'data/creative/inputs', bytes: inputs.bytes, files: inputs.files, ok: true })
          } catch (err) {
            const failure = removeError(err)
            results.push({ target, path: 'data/creative/inputs', bytes: 0, files: 0, ...failure })
            logger.warn?.(`创作输入临时参数清理失败：${failure.message}`)
          }
        }

        const debug = await debugImageFiles()
        for (const item of debug) {
          const file = safeInside(item.path)
          try {
            await fs.rm(file, { force: true })
            freedBytes += item.bytes
            results.push({ target, path: item.rel, bytes: item.bytes, files: 1, ok: true })
          } catch (err) {
            const failure = removeError(err)
            results.push({ target, path: item.rel, bytes: 0, files: 0, ...failure })
            logger.warn?.(`失败截图清理失败 ${item.rel}：${failure.message}`)
          }
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
