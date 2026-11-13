// ============================================================
// 出网小工具：优先走系统代理（Windows 注册表 / 环境变量）
//
// 背景：本机 Node 的 fetch 不走系统代理，GitHub 直连会 timeout；
// 表情包整包下载必须能出网，所以这里用 node:http 的 CONNECT 隧道
// 支持 http 代理（Clash / 系统代理常见形态），零依赖。
// ============================================================

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const UA = 'dsh-fish-dandan/0.1 (local meme library)'

function normalizeProxy(raw) {
  if (!raw) return ''
  let s = String(raw).trim()
  if (!s) return ''
  // 注册表里可能是 http=host:port;https=host:port
  const httpsPart = s.match(/https=([^;]+)/i)
  if (httpsPart) s = httpsPart[1]
  else s = s.split(';')[0]
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    if (!u.hostname) return ''
    return `http://${u.hostname}:${u.port || 80}`
  } catch {
    return ''
  }
}

/** 优先环境变量，其次 Windows 注册表；没有就返回空串（直连）。结果缓存，避免每次请求都开子进程。 */
let cachedProxy = null
export function detectProxy() {
  if (cachedProxy !== null) return cachedProxy
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
  cachedProxy = normalizeProxy(env)
  if (cachedProxy) return cachedProxy
  if (process.platform !== 'win32') return cachedProxy
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000,
    })
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)
    cachedProxy = normalizeProxy(m ? m[1] : '')
  } catch {
    cachedProxy = ''
  }
  return cachedProxy
}

/** 经 http 代理发 HTTPS GET（CONNECT 隧道），自动跟随最多 maxRedirect 次重定向。 */
function proxyGet(url, { proxy, headers = {}, timeoutMs = 30000, maxRedirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false
    const fail = (err) => { if (!finished) { finished = true; reject(err) } }
    const ok = (v) => { if (!finished) { finished = true; resolve(v) } }

    const target = new URL(url)
    const proxyUrl = new URL(proxy)
    const req = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: timeoutMs,
    })
    req.on('timeout', () => { req.destroy(new Error('代理连接超时')) })
    req.on('error', fail)
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); fail(new Error(`代理拒绝连接：HTTP ${res.statusCode}`)); return }
      const tlsSocket = tls.connect({ socket, servername: target.hostname, timeout: timeoutMs }, () => {
        const path = target.pathname + target.search
        const r = https.request({
          host: target.hostname, path, method: 'GET', socket: tlsSocket, servername: target.hostname, timeout: timeoutMs,
          headers: { 'user-agent': UA, ...headers },
        }, (resp) => {
          const status = resp.statusCode || 0
          if ([301, 302, 303, 307, 308].includes(status) && resp.headers.location && maxRedirect > 0) {
            resp.resume()
            const next = new URL(resp.headers.location, url).toString()
            proxyGet(next, { proxy, headers, timeoutMs, maxRedirect: maxRedirect - 1 }).then(ok).catch(fail)
            return
          }
          const chunks = []
          resp.on('data', (c) => chunks.push(c))
          resp.on('end', () => ok({ status, headers: resp.headers, body: Buffer.concat(chunks) }))
          resp.on('error', fail)
        })
        r.on('error', fail)
        r.on('timeout', () => { r.destroy(new Error('请求超时')) })
        r.end()
      })
      tlsSocket.on('error', fail)
    })
    req.end()
  })
}

/**
 * GET 一个 URL，返回 { status, headers, body: Buffer }。
 * - 测试注入 fetchImpl 时直接用它；
 * - 有系统代理时走 curl（Windows 10+ / macOS / Linux 都自带，比自建隧道稳）；
 * - 没代理就用内置 fetch。
 */
export async function httpGet(url, { headers = {}, timeoutMs = 30000, fetchImpl = null, proxy = null } = {}) {
  if (fetchImpl) {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': UA, ...headers },
      redirect: 'follow',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    const ab = await res.arrayBuffer()
    return { status: res.status, headers: res.headers, body: Buffer.from(ab), ok: res.ok }
  }

  const proxyUrl = proxy === null ? detectProxy() : proxy
  if (proxyUrl) {
    try {
      return await curlGet(url, { headers, timeoutMs, proxy: proxyUrl })
    } catch {
      // curl 不在或失败：退回直连，让调用方看到真实的网络错误
    }
  }
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  })
  const ab = await res.arrayBuffer()
  return { status: res.status, headers: res.headers, body: Buffer.from(ab), ok: res.ok }
}

/** 用系统 curl 走代理取字节（失败抛错）。异步执行，绝不卡住事件循环。 */
async function curlGet(url, { headers = {}, timeoutMs = 30000, proxy } = {}) {
  const args = ['-sS', '-L', '-f', '--max-time', String(Math.max(5, Math.ceil(timeoutMs / 1000)))]
  if (proxy) args.push('--proxy', proxy)
  for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`)
  args.push(url)
  const { stdout } = await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs + 5000,
  })
  return { status: 200, headers: {}, body: Buffer.from(stdout), ok: true }
}

export { UA as NET_USER_AGENT }
