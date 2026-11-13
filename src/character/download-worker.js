// ============================================================
// 形象资源包下载 worker
//
// 每个 worker 一次只处理一个文件：流式写临时文件、边写边算 SHA-256，
// 只把“已下载字节 / 完成 / 错误”回给主线程；主线程不做大文件读写。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { parentPort, workerData } from 'node:worker_threads'

const execFileAsync = promisify(execFile)
const UA = 'dsh-fish-dandan/0.1 (local character pack)'
const PROGRESS_MS = 100

const proxy = String(workerData?.proxy || '').trim()

function postProgress(id, bytes) {
  parentPort.postMessage({ type: 'progress', id, bytes })
}

function safeDest(dest) {
  if (!dest || typeof dest !== 'string') throw new Error('缺少目标路径')
  return path.resolve(dest)
}

function statBytes(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** 直连：Node fetch，流式落盘。 */
async function downloadWithFetch(url, dest, expectedBytes, id) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('响应没有正文')

  let seen = 0
  let lastAt = 0
  const hash = createHash('sha256')
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (now - lastAt >= PROGRESS_MS) {
        lastAt = now
        postProgress(id, seen)
      }
      cb(null, chunk)
    },
  })

  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest))
  postProgress(id, seen)

  if (expectedBytes && seen !== expectedBytes) {
    throw new Error(`大小不一致：期望 ${expectedBytes}，实际 ${seen}`)
  }
  return { bytes: seen, sha256: hash.digest('hex') }
}

/** 系统代理：用 curl 下载，定时读文件大小回传进度；仍然是异步子进程，不阻塞主线程。 */
async function downloadWithCurl(url, dest, expectedBytes, id) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const args = [
    '-L', '-f', '-sS',
    '--connect-timeout', '30',
    '--max-time', '180',
    '--proxy', proxy,
    '-o', dest,
    url,
  ]
  let timer = null
  try {
    timer = setInterval(() => {
      const size = statBytes(dest)
      if (size) postProgress(id, size)
    }, PROGRESS_MS)
    await execFileAsync(curl, args, { windowsHide: true, timeout: 190000, maxBuffer: 1024 * 1024 })
  } finally {
    if (timer) clearInterval(timer)
  }
  const bytes = statBytes(dest)
  postProgress(id, bytes)
  if (expectedBytes && bytes !== expectedBytes) {
    throw new Error(`大小不一致：期望 ${expectedBytes}，实际 ${bytes}`)
  }
  return { bytes, sha256: await hashFile(dest) }
}

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'download') return
  const { id, url, dest, bytes, sha256 } = msg
  try {
    const target = safeDest(dest)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const result = proxy
      ? await downloadWithCurl(url, target, Number(bytes) || 0, id)
      : await downloadWithFetch(url, target, Number(bytes) || 0, id)
    if (!result.sha256 || result.sha256 !== sha256) {
      throw new Error('SHA-256 校验失败')
    }
    parentPort.postMessage({ type: 'done', id, bytes: result.bytes, sha256: result.sha256 })
  } catch (err) {
    parentPort.postMessage({ type: 'error', id, message: err?.message || String(err) })
  }
})
