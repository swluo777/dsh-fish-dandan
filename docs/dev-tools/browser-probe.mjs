// 浏览器引擎探针（06 第一步）：验证「插件进程能否用零依赖方式驱动本机浏览器」。
// 只做三件事：找到浏览器 → 以调试端口启动 → 用 Node 内置 WebSocket 走 CDP 完成导航 + 截屏。
// 不登录任何账号、不访问任何网站（data: URL）、不写平台数据。结论写入 stdout，供 06 设计文档引用。
//
// 用法：node docs/dev-tools/browser-probe.mjs [--browser <可执行文件路径>] [--port 9223]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', '9223'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { steps: [], ok: false }

function step(name, ok, detail = '') {
  result.steps.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

// ---- 1) 找浏览器：Edge 优先（Windows 自带），其次 Chrome ----
const CANDIDATES = [
  argOf('--browser', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const browser = CANDIDATES.find((p) => { try { return fs.existsSync(p) } catch { return false } })
if (!step('找到本机浏览器', Boolean(browser), browser || `尝试过：${CANDIDATES.join(' , ')}`)) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(1)
}

// ---- 2) 以调试端口启动（headless：探针只需要验证连通性，不污染界面） ----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-probe-'))
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })
let wsUrl = null
try {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) {
        const v = await r.json()
        result.browserVersion = v.Browser
        if (!step('CDP 调试端口可达', true, v.Browser || 'unknown')) break
        break
      }
    } catch { /* not up yet */ }
    await sleep(250)
  }
  if (!result.browserVersion) throw new Error('调试端口未就绪')

  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const page = list.find((t) => t.type === 'page')
  if (!step('拿到页面 target', Boolean(page), page ? page.url : '无')) throw new Error('no page target')
  wsUrl = page.webSocketDebuggerUrl

  // ---- 3) 零依赖 CDP：Node 内置 WebSocket 导航 + 截屏 ----
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
    }
  }
  const cmd = (method, params = {}) => {
    const n = ++seq
    return new Promise((resolve, reject) => {
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  }
  await cmd('Page.enable')
  await cmd('Page.navigate', { url: 'data:text/html,<title>probe</title><h1 style="font-family:sans-serif">fish-dandan browser probe</h1>' })
  await sleep(400)
  const shot = await cmd('Page.captureScreenshot', { format: 'png' })
  const outDir = path.resolve(import.meta.dirname, '../../.workbuddy/probe')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'browser-probe.png')
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
  step('零依赖 CDP 导航 + 截屏', fs.existsSync(outFile) && fs.statSync(outFile).size > 1000, outFile)
  ws.close()
  result.ok = result.steps.every((s) => s.ok)
} catch (err) {
  step('CDP 流程', false, err.message)
} finally {
  try { child.kill() } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* temp dir */ }
}

console.log('\n=== 结论 ===')
console.log(JSON.stringify({ ok: result.ok, browser, browserVersion: result.browserVersion, port: PORT, steps: result.steps }, null, 2))
console.log(result.ok
  ? 'CDP 路线成立：插件进程可以零依赖驱动本机浏览器（拟人化引擎的地基）。\n注意：真实使用时用 headed 模式 + 真实登录标签；本探针只用 headless 验证连通性。'
  : 'CDP 路线未通过，需要评估 Playwright npm 包或 DSH 宿主能力。')
process.exit(result.ok ? 0 : 1)
