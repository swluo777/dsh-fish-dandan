// ============================================================
// 形象资源包下载器
//
// 与表情包下载的区别：
// 1. 不把整张图读进内存，worker 内流式写盘；
// 2. 4 个 worker_threads 真正并行，主线程只收进度；
// 3. 每个文件单独校验 SHA-256，失败只重试该文件；
// 4. 全部通过后原子替换正式目录，页面永远看不到半套图。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { detectProxy } from '../stickers/net.js'
import { removeDirectory, renamePath } from '../utils/fs-retry.js'
import { writeJsonAtomic } from '../utils/json.js'

const CONCURRENCY = 4
const MAX_RETRIES = 2
const URL_HOSTS = new Set(['github.com'])

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function packTotalBytes(pack) {
  return pack.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0)
}

function safeFileName(name) {
  const value = String(name || '')
  if (!value || value !== path.basename(value) || value.includes('..') || /[\\/]/.test(value)) {
    throw new Error(`文件名不合法：${value}`)
  }
  return value
}

function validatePack(pack, { allowedHosts = URL_HOSTS, allowHttp = false } = {}) {
  if (!pack || typeof pack !== 'object') throw new Error('资源包不存在')
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(pack.id || ''))) throw new Error('资源包 id 不合法')
  if (!Array.isArray(pack.files) || !pack.files.length) throw new Error('资源包没有文件清单')
  let base
  try {
    base = new URL(pack.baseUrl)
  } catch {
    throw new Error('资源包 baseUrl 不合法')
  }
  if ((base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) || !allowedHosts.has(base.hostname)) {
    throw new Error('资源包只允许从 GitHub 下载')
  }
  for (const file of pack.files) {
    safeFileName(file.path)
    if (!Number.isFinite(Number(file.bytes)) || Number(file.bytes) <= 0) throw new Error(`文件大小不合法：${file.path}`)
    if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) throw new Error(`SHA-256 不合法：${file.path}`)
  }
}

/** 一个常驻 worker；下载完成后还能接下一个文件。 */
function createWorkerSlot(proxy) {
  const worker = new Worker(new URL('./download-worker.js', import.meta.url), {
    workerData: { proxy },
  })
  let seq = 0
  const pending = new Map()

  function rejectAll(err) {
    for (const { reject } of pending.values()) {
      try { reject(err) } catch { /* 调用方已处理 */ }
    }
    pending.clear()
  }

  worker.on('message', (msg) => {
    const entry = pending.get(msg?.id)
    if (!entry) return
    if (msg.type === 'progress') {
      entry.onProgress?.(Number(msg.bytes) || 0)
      return
    }
    pending.delete(msg.id)
    if (msg.type === 'done') entry.resolve(msg)
    else entry.reject(new Error(msg.message || '下载失败'))
  })
  worker.on('error', (err) => rejectAll(err))
  worker.on('exit', (code) => {
    if (pending.size) rejectAll(new Error(`下载 worker 退出（code ${code}）`))
  })

  return {
    run(task, dest, onProgress) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress })
        worker.postMessage({
          type: 'download',
          id,
          url: `${String(task.baseUrl || '').replace(/\/+$/, '')}/${encodeURIComponent(task.path)}`,
          dest,
          bytes: Number(task.bytes) || 0,
          sha256: task.sha256,
        })
      })
    },
    terminate() {
      return worker.terminate()
    },
  }
}

async function replaceDirectory(staging, target, logger) {
  const backup = `${target}.bak-${Date.now()}`
  const hadTarget = fs.existsSync(target)
  let backupReady = false
  if (hadTarget) {
    try {
      await renamePath(target, backup, { logger })
      backupReady = true
    } catch (err) {
      // 旧目录改名被占用时，退一步先清掉旧目录，再把已校验的新目录放进去。
      logger?.warn?.(`旧资源目录改名失败（${err.code || err.message}），改为先清理再替换`)
      await removeDirectory(target, { logger })
    }
  }
  try {
    await renamePath(staging, target, { logger })
  } catch (err) {
    if (backupReady && fs.existsSync(backup)) {
      try { await renamePath(backup, target, { logger }) } catch { /* 保留备份，交给人工处理 */ }
    }
    throw err
  }
  if (backupReady) {
    try { await removeDirectory(backup, { logger }) } catch (err) {
      logger?.warn?.(`旧资源目录备份清理失败（${err.code || err.message}），暂时保留 ${backup}`)
    }
  }
}

function cleanupOldStaging(root) {
  try {
    if (!fs.existsSync(root)) return
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name)
      try {
        if (fs.statSync(dir).isDirectory() && fs.statSync(dir).mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      } catch { /* 单个旧目录清理失败不阻断新任务 */ }
    }
  } catch { /* 临时目录不存在时忽略 */ }
}

/**
 * @param {{pack: object, targetDir: string, onProgress?: Function, logger?: object, concurrency?: number, proxy?: string, allowTestUrls?: boolean}} opts
 */
export async function downloadPack({ pack, targetDir, onProgress, logger = console, concurrency = CONCURRENCY, proxy: forcedProxy, allowTestUrls = false }) {
  let hosts = URL_HOSTS
  if (allowTestUrls) {
    try { hosts = new Set([...URL_HOSTS, new URL(pack.baseUrl).hostname]) } catch { /* validatePack 会给准确错误 */ }
  }
  validatePack(pack, { allowedHosts: hosts, allowHttp: allowTestUrls })
  const files = pack.files.map((file) => ({ ...file, path: safeFileName(file.path) }))
  const totalBytes = packTotalBytes({ files })
  const totalFiles = files.length
  const stagingRoot = path.join(path.dirname(targetDir), '.staging')
  const staging = path.join(stagingRoot, `${pack.id}-${Date.now()}-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(staging, { recursive: true })
  cleanupOldStaging(stagingRoot)

  const proxy = forcedProxy !== undefined ? String(forcedProxy) : detectProxy()
  const slots = []
  const progressByFile = new Map(files.map((file) => [file.path, 0]))
  let filesDone = 0
  let failed = null
  let cursor = 0

  function bytesDone() {
    let sum = 0
    for (const value of progressByFile.values()) sum += Number(value) || 0
    return Math.min(sum, totalBytes)
  }

  function emit() {
    try {
      onProgress?.({
        status: 'running',
        filesDone,
        filesTotal: totalFiles,
        bytesDone: bytesDone(),
        bytesTotal: totalBytes,
      })
    } catch (err) {
      logger?.warn?.(`下载进度回调失败：${err.message}`)
    }
  }

  function nextTask() {
    if (failed || cursor >= files.length) return null
    const task = files[cursor]
    cursor += 1
    return { ...task, baseUrl: pack.baseUrl }
  }

  async function runTask(slot, task) {
    const dest = path.join(staging, task.path)
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      progressByFile.set(task.path, 0)
      emit()
      try {
        const result = await slot.run(task, dest, (bytes) => {
          const clamped = Math.min(Number(bytes) || 0, Number(task.bytes) || 0)
          progressByFile.set(task.path, clamped)
          emit()
        })
        const actual = Number(result.bytes) || 0
        if (actual !== Number(task.bytes)) throw new Error(`大小不一致：${task.path}`)
        if (String(result.sha256).toLowerCase() !== String(task.sha256).toLowerCase()) {
          throw new Error(`SHA-256 不一致：${task.path}`)
        }
        progressByFile.set(task.path, Number(task.bytes))
        filesDone += 1
        emit()
        return
      } catch (err) {
        try { fs.rmSync(dest, { force: true }) } catch { /* 下一轮会重写 */ }
        if (attempt >= MAX_RETRIES) throw err
        logger?.warn?.(`下载失败，重试 ${attempt + 1}/${MAX_RETRIES}：${task.path}：${err.message}`)
        await delay(1000 * (attempt + 1))
      }
    }
  }

  async function drain(slot) {
    while (!failed) {
      const task = nextTask()
      if (!task) return
      try {
        await runTask(slot, task)
      } catch (err) {
        failed = err
        // 一个文件重试后仍失败，其他 worker 不必再跑；已完成的文件留在 staging，
        // 整个 staging 会在外层 catch 里清掉。
        for (const other of slots) {
          if (other !== slot) {
            try { other.terminate() } catch { /* worker 已退出 */ }
          }
        }
        return
      }
    }
  }

  try {
    const poolSize = Math.max(1, Math.min(Number(concurrency) || CONCURRENCY, files.length))
    for (let i = 0; i < poolSize; i += 1) slots.push(createWorkerSlot(proxy))
    emit()
    await Promise.all(slots.map((slot) => drain(slot)))
    if (failed) throw failed

    const install = {
      schemaVersion: 1,
      packId: pack.id,
      version: pack.version,
      releaseTag: pack.releaseTag,
      installedAt: new Date().toISOString(),
      files: Object.fromEntries(files.map((file) => [file.path, {
        bytes: Number(file.bytes),
        sha256: file.sha256,
      }])),
    }
    writeJsonAtomic(path.join(staging, 'install.json'), install)
    await replaceDirectory(staging, targetDir, logger)
    logger?.info?.(`形象资源包已安装：${pack.id} v${pack.version}，${totalFiles} 个文件`)
    return { ...install, totalBytes, fileCount: totalFiles }
  } catch (err) {
    try {
      await removeDirectory(staging, { logger })
    } catch (cleanupErr) {
      logger?.warn?.(`下载临时目录清理失败（${cleanupErr.code || cleanupErr.message}），留在 ${staging}`)
    }
    logger?.error?.(`形象资源包安装失败：${err.message}`)
    throw err
  } finally {
    for (const slot of slots) {
      try { await slot.terminate() } catch { /* worker 已退出 */ }
    }
  }
}
