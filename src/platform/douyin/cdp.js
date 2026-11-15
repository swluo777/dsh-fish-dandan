// ============================================================
// CDP 驾驶本机浏览器的最小封装（零第三方依赖）。
// 探针（docs/dev-tools/browser-probe.mjs）已验证：Node 内置 WebSocket 即可完成
// 启动 → 调试端口 → 页面 target → 导航 → 截屏 全流程。这里把探针逻辑产品化。
// 真实使用用 headed 模式（用户要看到二维码）。
// ============================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// 临时档案登记表：只在「没传 profileDir」的一次性浏览器里使用。
// 正常关闭/进程退出时尽量删掉；强杀留下的由 temp-profiles.js 在下次启动时清。
const TEMP_DIRS = new Set()
let exitHookInstalled = false

function trackTempDir(dir) {
  if (!dir) return
  TEMP_DIRS.add(dir)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const d of TEMP_DIRS) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 退出阶段尽力而为 */ }
    }
    TEMP_DIRS.clear()
  })
}

/** 删临时档案；句柄还没释放就退避重试，最终失败留给下次启动清扫。 */
function dropTempDir(dir, attempts = 2) {
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    TEMP_DIRS.delete(dir)
  } catch {
    if (attempts <= 0) return
    const timer = setTimeout(() => dropTempDir(dir, attempts - 1), 500)
    timer.unref?.()
  }
}

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/** 找本机浏览器；override 显式指定时只用它。 */
export function findBrowser(override = '') {
  const list = override ? [override] : BROWSER_CANDIDATES
  return list.find((p) => { try { return fs.existsSync(p) } catch { return false } }) || null
}

/**
 * 启动浏览器并等调试端口就绪。
 * profileDir 传了就复用固定档案（登录态/缓存都留着，下次打开还是老样子）；不传就临时目录。
 * @returns {Promise<{ httpBase: string, child: object, profileDir: string, version: string, persistent: boolean }>}
 */
export async function launchBrowser({ browserPath = '', port = 9224, headless = false, offscreen = false, startUrl = 'about:blank', logger = console, profileDir = '' } = {}) {
  const exe = findBrowser(browserPath)
  if (!exe) throw new Error('本机没有找到 Chrome/Edge，可在 platforms.douyin.browserPath 手动指定')
  const persistent = Boolean(profileDir)
  const dir = persistent ? profileDir : fs.mkdtempSync(path.join(os.tmpdir(), 'fish-douyin-'))
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  if (!persistent) trackTempDir(dir)
  const flags = [
    // 不要加 --disable-blink-features=AutomationControlled：
    // Edge 会因此弹「不受支持的命令行标记」警告条，反而更显眼；
    // navigator.webdriver 靠下面的脚本抹掉就够了。
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    // 关掉「是否保存登录信息」气泡：它会盖在页面上，挡住消息面板等操作
    '--disable-save-password-bubble', '--disable-features=PasswordManager,AutofillServerCommunication',
  ]
  if (headless) flags.unshift('--headless=new')
  else if (offscreen) {
    // 屏幕外窗口：兼容旧调用；当前抖音活动固定可见，不再走这个分支
    flags.push('--window-position=-32000,-32000', '--window-size=1280,900')
  } else {
    // 可见模式：强制把窗口放回屏幕里。
    // 之前用屏幕外坐标开过这个档案，Edge 会把窗口位置记进档案，之后从这个档案开的窗口全跑到屏幕外。
    flags.push('--window-position=120,80', '--window-size=1280,900')
  }
  const child = spawn(exe, [...flags, `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, startUrl], { stdio: 'ignore', windowsHide: false, detached: true })
  // 浏览器自己退出（崩溃/被关）也要回收临时档案；给它 1 秒释放文件句柄
  if (!persistent) {
    child.once('exit', () => {
      const timer = setTimeout(() => dropTempDir(dir), 1000)
      timer.unref?.()
    })
  }
  const httpBase = `http://127.0.0.1:${port}`
  let version = ''
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${httpBase}/json/version`)
      if (r.ok) {
        version = (await r.json()).Browser || ''
        break
      }
    } catch { /* not up yet */ }
    await sleep(250)
  }
  if (!version) {
    try { child.kill() } catch { /* already gone */ }
    dropTempDir(dir)
    throw new Error(`浏览器调试端口未就绪（${httpBase}），可能被占用或浏览器启动失败`)
  }
  logger.debug?.(`CDP 浏览器已启动：${version}（端口 ${port}${persistent ? '，固定档案' : ''}）`)
  return { httpBase, child, profileDir: dir, version, persistent }
}

/**
 * 复用或启动：端口上已经有浏览器就直接连它，不新开。
 * 「开一次就一直留着，别频繁开关」——所有需要浏览器的操作都走这里。
 */
export async function ensureBrowser({ browserPath = '', port = 9224, headless = false, offscreen = false, startUrl = 'about:blank', logger = console, profileDir = '' } = {}) {
  const httpBase = `http://127.0.0.1:${port}`
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${httpBase}/json/version`, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
      })
      if (r.ok) {
        const v = await r.json()
        logger.debug?.(`CDP 复用已开的浏览器：${v.Browser || ''}（端口 ${port}）`)
        return { httpBase, child: null, profileDir: profileDir || '', version: v.Browser || '', persistent: Boolean(profileDir), reused: true }
      }
    } catch { /* 端口上没活着的浏览器 */ }
    await sleep(300)
  }
  const handle = await launchBrowser({ browserPath, port, headless, offscreen, startUrl, logger, profileDir })
  return { ...handle, reused: false }
}

/** 从一条 WebSocket 调试地址建页面对象；attachPage 和 openNewPage 共用。 */
async function pageFromWs(wsUrl, meta = {}) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  const listeners = new Map()
  // 事件订阅（例如 Page.fileChooserOpened），返回值用于退订
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, new Set())
    listeners.get(method).add(handler)
    return () => { listeners.get(method)?.delete(handler) }
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
      return
    }
    if (msg.method) {
      const arr = listeners.get(msg.method)
      if (arr) for (const fn of arr) { try { fn(msg.params) } catch { /* 订阅方自己处理 */ } }
    }
  }
  // 页面/浏览器被关掉时，把还在等结果的调用全部拒绝——否则「停止本轮」会一直挂着
  const rejectAll = (reason) => {
    for (const p of pending.values()) p.reject(new Error(reason))
    pending.clear()
  }
  // 用户手动关标签页时 WebSocket 会关闭；插件自己调用 close() 不算。
  // 监听器用这个事件把开关立即写回，不用等下一轮 3~5 秒轮询。
  const closeListeners = new Set()
  let selfClosing = false
  let closeNotified = false
  const onClose = (handler) => {
    closeListeners.add(handler)
    return () => { closeListeners.delete(handler) }
  }
  const notifyClosed = () => {
    if (selfClosing || closeNotified) return
    closeNotified = true
    for (const fn of closeListeners) { try { fn() } catch { /* 订阅方自己处理 */ } }
  }
  ws.onclose = () => { rejectAll('页面已关闭'); notifyClosed() }
  ws.onerror = () => rejectAll('页面连接异常')
  const cmd = (method, params = {}, { timeoutMs = 20000 } = {}) => {
    const n = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(n)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      pending.set(n, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  }
  await cmd('Page.enable')
  // 抹掉自动化痕迹：navigator.webdriver、chrome 对象、语言列表
  try {
    await cmd('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        "try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}",
        'window.chrome = window.chrome || { runtime: {} };',
        "try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] }); } catch {}",
      ].join('\n'),
    })
    await cmd('Runtime.evaluate', { expression: "try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}" })
  } catch { /* 老版本浏览器不支持就跳过 */ }
  return {
    cmd,
    on,
    onClose,
    // 插件主动关页前先标记，避免把「自己关的」误报成用户手动关标签页
    prepareClose() { selfClosing = true },
    // 关标签页要用 targetId；只断 WebSocket 不会真的把标签页关掉
    targetId: meta.targetId || '',
    httpBase: meta.httpBase || '',
    close() { selfClosing = true; rejectAll('页面已关闭'); try { ws.close() } catch { /* already closed */ } },
  }
}

/** 连到一个 page target，返回 { cmd, close }。preferUrl 用来避开浏览器自带的新标签页。 */
export async function attachPage(httpBase, { preferUrl = '' } = {}) {
  const list = await (await fetch(`${httpBase}/json/list`)).json()
  const pages = list.filter((t) => t.type === 'page')
  const page = (preferUrl && (pages.find((t) => t.url === preferUrl) || pages.find((t) => String(t.url || '').includes(preferUrl)))) || pages[0]
  if (!page) throw new Error('浏览器里没有可用页面')
  return await pageFromWs(page.webSocketDebuggerUrl, { targetId: page.id, httpBase })
}

/**
 * 在同一个浏览器里新开一个标签页，返回连到它的页面对象。
 * 监听器用它：有自己的标签页，就不会把别人正在用的页面导航走。
 */
export async function openNewPage(httpBase, url = 'about:blank') {
  const r = await fetch(`${httpBase}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!r.ok) throw new Error(`新开标签页失败（HTTP ${r.status}）`)
  const target = await r.json()
  if (!target || !target.webSocketDebuggerUrl) throw new Error('新开标签页没拿到调试地址')
  return await pageFromWs(target.webSocketDebuggerUrl, { targetId: target.id, httpBase })
}

/**
 * 只关一个标签页，不动浏览器进程。
 * 共享浏览器里每个服务只能关自己那一页；关整个浏览器会把别人的活一起掐掉。
 */
export async function closePage(page) {
  if (!page) return
  const { httpBase, targetId } = page
  // 先标记是插件主动关页：后面的 WebSocket 关闭事件不要再触发「用户关标签页」。
  page.prepareClose?.()
  if (httpBase && targetId) {
    try { await fetch(`${httpBase}/json/close/${encodeURIComponent(targetId)}`) } catch { /* 浏览器可能已经关了 */ }
  }
  page.close()
}

export function closeBrowser(handle) {
  if (!handle) return
  try { if (handle.child) handle.child.kill() } catch { /* already gone */ }
  // 固定档案不删：登录态、缓存都留着，下次还能接着用
  if (!handle.persistent) dropTempDir(handle.profileDir)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
