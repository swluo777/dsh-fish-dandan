// ============================================================
// 豆包桌面版生图适配器（零 API Key 路线）
//
// 原理：不碰豆包的私有协议，用「UI 自动化 + 本地数据库取图」：
//   1. UI 自动化（doubao-ui.ps1）：新对话 → 输入框 → 贴提示词/参考图 → 回车
//   2. 取图：豆包把生成图 URL 写进自己的 IndexedDB，读出最新一条 rc_gen_image 下载原图
//
// 边界：
//   - 只有用户打开「允许我操作豆包做图」开关才会跑；
//   - 单飞：同一时刻只允许一个生成任务；
//   - 会占用豆包窗口和剪贴板，失败截图存 data/images/ui-fail-*.png
// ============================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fromRoot } from '../utils/paths.js'
import { resolvePowerShell } from '../utils/powershell.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PS1 = path.join(HERE, 'doubao-ui.ps1')
const PWSH = resolvePowerShell()

const REF_ROOTS = [fromRoot('data/images'), fromRoot('data/stickers')].map((p) => path.resolve(p))
const REF_EXT = /\.(png|jpe?g|webp)$/i

/** 参考图白名单：只认 data/images、data/stickers 里的图，拒绝绝对路径乱传与 `..` 穿越。 */
export function resolveRefImage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let abs
  try {
    abs = path.resolve(fromRoot(raw))
  } catch {
    return ''
  }
  if (!REF_EXT.test(abs)) return ''
  if (!REF_ROOTS.some((root) => abs.startsWith(root + path.sep))) return ''
  try {
    if (!fs.statSync(abs).isFile()) return ''
  } catch {
    return ''
  }
  return abs
}
const DOUBAO_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Doubao', 'User Data')
const IDB_DIRS = [
  path.join(DOUBAO_USER_DATA, 'Default', 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb'),
  path.join(DOUBAO_USER_DATA, 'Default', 'IndexedDB', 'chrome_doubao-launcher_0.indexeddb.leveldb'),
]

/** 跑一次 PowerShell 助手，返回最后一行 JSON。 */
function runHelper(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: `起不来 PowerShell：${e.message}` }) })
    child.on('close', () => {
      clearTimeout(timer)
      const lines = out.split('\n').map((x) => x.trim()).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i])
          if (parsed && typeof parsed === 'object') return resolve(parsed)
        } catch { /* 继续找 */ }
      }
      resolve({ ok: false, reason: `助手没有返回 JSON（stderr: ${err.slice(0, 300)}）` })
    })
  })
}

/** 从豆包 IndexedDB 里读出所有生成图 URL（最近的排后面）。 */
function readGenUrls() {
  const urls = []
  for (const dir of IDB_DIRS) {
    let files = []
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.log') || f.endsWith('.ldb'))
        .map((f) => path.join(dir, f))
    } catch { continue }
    for (const file of files) {
      let text = ''
      try { text = fs.readFileSync(file, 'latin1') } catch { continue }
      const re = /https?:\/\/[A-Za-z0-9.\-]+byteimg\.com\/[A-Za-z0-9._~/\-]{10,400}(?:\?[A-Za-z0-9._~%=&\-]+)?/g
      for (const m of text.match(re) || []) {
        if (m.includes('rc_gen_image') && !urls.includes(m)) urls.push(m)
      }
    }
  }
  return urls
}

/** 同一张图有多个变体（缩略图 / 原图 PNG / 原图 HEIC），优先拿 PNG 原图。 */
function pickBestUrl(urls) {
  if (!urls.length) return ''
  const rawPng = urls.filter((u) => /image_raw\.png(\?|$)/.test(u))
  if (rawPng.length) return rawPng[rawPng.length - 1]
  const anyPng = urls.filter((u) => !/\.heic(\?|$)/.test(u) && /\.png(\?|$)/.test(u))
  if (anyPng.length) return anyPng[anyPng.length - 1]
  return urls[urls.length - 1]
}

/** 豆包给的原图有时是 HEIC，换成 image_raw 模板再要一次（字节图床支持模板转码）。 */
function rawVariant(url) {
  const i = url.indexOf('~tplv-')
  if (i < 0) return ''
  const q = url.match(/\?.*$/)?.[0] || ''
  return `${url.slice(0, i)}~tplv-a9rns2rl98-image_raw.png${q}`
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: {
      Referer: 'https://www.doubao.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147 Safari/537.36',
    },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  return { res, buf: Buffer.from(await res.arrayBuffer()) }
}

function imageKind(buf) {
  if (buf.length < 64) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  const brand = buf.slice(4, 12).toString('latin1')
  if (brand.startsWith('ftyp')) return 'heic'
  return ''
}

async function downloadImage(url, outDir, logger) {
  let { res, buf } = await fetchImage(url)
  let kind = imageKind(buf)
  if (kind !== 'png' && kind !== 'jpeg') {
    const alt = rawVariant(url)
    if (alt && alt !== url) {
      try {
        const again = await fetchImage(alt)
        const kind2 = imageKind(again.buf)
        if (kind2 === 'png' || kind2 === 'jpeg') { buf = again.buf; res = again.res; kind = kind2 }
      } catch { /* 还是不行就走下面报错 */ }
    }
  }
  if (kind !== 'png' && kind !== 'jpeg') {
    const head = buf.slice(0, 16).toString('hex')
    throw new Error(`下载到的不是常用图片（HTTP ${res.status}，type=${res.headers.get('content-type') || '?'}，head=${head}）`)
  }
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12)
  const day = new Date().toISOString().slice(0, 10)
  const dir = path.join(outDir, day)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-${hash}.${kind === 'png' ? 'png' : 'jpg'}`)
  fs.writeFileSync(file, buf)
  logger.info?.(`豆包做图：已落盘 ${file}（${Math.round(buf.length / 1024)} KB）`)
  return file
}

export function createDoubaoPainter({ config, logger = console, settings = null } = {}) {
  const imagesDir = fromRoot(config?.image?.doubao?.outDir || 'data/images')
  const failDir = fromRoot('data/images')
  const settingsPath = fromRoot(config?.platforms?.settingsPath || 'data/state/platform-settings.json')
  let running = false

  /** 开关存 platform-settings，运行时改立刻生效：每次现读文件，不吃缓存。 */
  const isEnabled = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (raw && raw.image && raw.image.doubao && typeof raw.image.doubao.enabled === 'boolean') {
        return raw.image.doubao.enabled
      }
    } catch { /* 文件不存在/坏了就用默认 */ }
    return config?.image?.doubao?.enabled === true
  }

  async function detect() {
    return await runHelper(['-Action', 'detect'], { timeoutMs: 20000 })
  }

  async function status() {
    const enabled = isEnabled()
    const d = await detect().catch(() => ({ ok: false, detected: false, installed: false, reason: '检测失败' }))
    const installed = d.installed === undefined ? Boolean(d.detected) : Boolean(d.installed)
    const windowOpen = Boolean(d.detected)
    return {
      ok: true,
      enabled,
      installed,
      windowOpen,
      exePath: d.exePath || '',
      windowTitle: d.title || '',
      canPaint: enabled && installed && !running,
      running,
      reason: !installed
        ? (d.reason || '没找到豆包桌面版')
        : (!windowOpen ? '豆包没在运行（画的时候会自动打开）' : (!enabled ? '开关没打开' : '')),
    }
  }

  /**
   * 让豆包画一张。
   * @param {{ prompt: string, refPath?: string }} input
   */
  async function paint({ prompt, refPath = '' } = {}) {
    const text = String(prompt || '').trim()
    if (!text) return { ok: false, reason: '没有提示词' }
    if (!isEnabled()) return { ok: false, reason: '「允许我操作豆包做图」没打开' }
    if (running) return { ok: false, reason: '正在画上一张，等它画完' }
    running = true
    const startedAt = Date.now()
    try {
      let det = await detect()
      // 装了但没开：自己把豆包拉起来，而不是报「没装」
      if (!det.detected && det.installed) {
        logger.info?.('豆包没在运行，正在自动打开…')
        const launched = await runHelper(['-Action', 'launch'], { timeoutMs: 45000 }).catch((err) => ({ ok: false, reason: err.message }))
        if (launched && launched.detected) det = launched
      }
      if (!det.detected) return { ok: false, reason: det.reason || '没找到豆包桌面版' }

      // 记录已有 URL，之后只认新出现的
      const before = new Set(readGenUrls())

      const opened = await runHelper(['-Action', 'open-create'], { timeoutMs: 30000 })
      if (!opened.ok) return { ok: false, reason: opened.reason || '新对话没打开' }

      const b64 = Buffer.from(text, 'utf8').toString('base64')
      const args = ['-Action', 'paint', '-Text', b64]
      // 参考图只收 data/images 里的：这个参数最终会把本机文件贴进豆包（外部服务），
      // 不收敛就等于给模型一条外发本机任意图片的通道。
      const ref = resolveRefImage(refPath)
      if (String(refPath || '').trim() && !ref) {
        return { ok: false, reason: '参考图不在允许的目录里（只收 data/images 下的 png/jpg/webp）' }
      }
      if (ref) args.push('-RefPath', ref)
      const sent = await runHelper(args, { timeoutMs: 40000 })
      if (!sent.ok) return { ok: false, reason: sent.reason || '没能把提示词送进豆包' }

      // 轮询等新图 URL 出现（最多 3 分钟）
      let url = ''
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const fresh = readGenUrls().filter((u) => !before.has(u))
        if (fresh.length) { url = pickBestUrl(fresh); break }
      }
      if (!url) {
        try {
          const shot = await runHelper(['-Action', 'screenshot', '-Out', path.join(failDir, `ui-fail-${Date.now()}.png`)], { timeoutMs: 30000 })
          logger.warn?.(`豆包做图超时，截图：${shot.file || '（失败）'}`)
        } catch { /* 忽略 */ }
        return { ok: false, reason: '等了 3 分钟没等到新图（可能被审核/网络慢），截图留在 data/images/' }
      }

      const file = await downloadImage(url, imagesDir, logger)
      return {
        ok: true,
        file,
        url,
        ms: Date.now() - startedAt,
        mode: refPath ? 'image-to-image' : 'text-to-image',
      }
    } catch (err) {
      logger.error?.(`豆包做图失败：${err.message}`)
      return { ok: false, reason: err.message }
    } finally {
      running = false
    }
  }

  /** 最近画过的图（按文件 mtime 倒序）。 */
  function list(limit = 12) {
    const out = []
    try {
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name)
          if (ent.isDirectory()) walk(p)
          else if (/\.(png|jpe?g)$/i.test(ent.name) && !/^ui-fail-/.test(ent.name)) {
            out.push({ file: p, at: fs.statSync(p).mtimeMs })
          }
        }
      }
      walk(imagesDir)
    } catch { /* 目录还没建 */ }
    return out.sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit))
  }

  return { detect, status, paint, list, imagesDir }
}
