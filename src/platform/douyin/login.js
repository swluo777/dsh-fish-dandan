// ============================================================
// 抖音扫码登录流程：headed 浏览器打开抖音 → 用户扫码 → 轮询会话 Cookie →
// 捕获并加密落盘。全程不打印、不回显 Cookie 内容；失败只报阶段，不泄细节。
// ============================================================

import { createBrowserHub } from './browser-hub.js'

const LOGIN_URL = 'https://www.douyin.com/'
const SESSION_COOKIE = 'sessionid' // 抖音网页版登录态主标识；出现即视为登录成功
const POLL_MS = 2000

export function createLoginFlow({ config, logger, sessionStore, onSuccess, now = () => Date.now(), hub } = {}) {
  // 共享浏览器：登录只是其中的一个标签页；成功/取消只关这个标签，不关整个浏览器。
  const browserHub = hub || createBrowserHub({ config, logger })
  let state = { phase: 'idle', detail: '', startedAt: null, finishedAt: null }
  let running = null // { browser, page }

  function setPhase(phase, detail = '') {
    state = { ...state, phase, detail, startedAt: state.startedAt, finishedAt: phase === 'idle' ? null : state.finishedAt }
    logger.debug?.(`抖音登录流程：${phase} ${detail}`)
  }

  /**
   * 启动登录。立即返回当前快照（phase=waiting）；真实流程在后台跑，
   * 前端轮询 snapshot() 直到 success / timeout / error / cancelled。
   */
  function start() {
    if (state.phase === 'waiting') return snapshot()
    state = { phase: 'waiting', detail: '正在打开浏览器，请在弹出的窗口里登录抖音（扫码或短信验证都可以）', startedAt: now(), finishedAt: null }
    running = null
    run().catch((err) => {
      logger.warn?.(`抖音登录启动失败：${err.message}`)
      setPhase('error', err.message)
      cleanup()
    })
    return snapshot()
  }

  async function run() {
    const cfg = config.platforms.douyin
    setPhase('waiting', '正在启动共享浏览器…')
    logger.info?.('抖音登录：开始启动共享浏览器')
    // 共享浏览器只开一个进程、一份档案；登录窗口只是其中一个标签页。
    const browser = await browserHub.ensure()
    running = { browser }
    setPhase('waiting', `浏览器已就绪（${browser.version || '共享实例'}），正在打开登录页…`)
    logger.info?.(`抖音登录：共享浏览器已就绪（端口 ${browser.port || browserHub.snapshot().port}）`)
    const page = await browserHub.openTab('login', LOGIN_URL, { bringToFront: true })
    running.page = page
    setPhase('waiting', '登录页已打开，请扫码或完成登录；成功后会自动保存登录态，只关这个登录标签页')
    logger.info?.('抖音登录：等待扫码')

    const deadline = now() + (cfg.loginTimeoutMs || 5 * 60_000)
    while (now() < deadline) {
      if (state.phase !== 'waiting') return // 被取消
      let cookies = []
      try {
        const res = await page.cmd('Network.getCookies', { urls: ['https://www.douyin.com'] })
        cookies = res.cookies || []
      } catch (err) {
        // 页面导航中可能暂时取不到，下一轮再试
        logger.debug?.(`取 Cookie 暂时失败，下一轮重试：${err.message}`)
      }
      const hit = cookies.find((c) => c.name === SESSION_COOKIE || c.name.startsWith('sessionid'))
      if (hit) {
        const douyinCookies = cookies.filter((c) => (c.domain || '').includes('douyin'))
        sessionStore.save(douyinCookies, { account: 'douyin-web', capturedAt: now() })
        setPhase('success', `已捕获登录态并加密保存（${douyinCookies.length} 条 Cookie）。登录标签页这就关掉，共享浏览器和它的 Cookie 罐留给活动和监听用。`)
        logger.info?.(`抖音登录：成功，保存 ${douyinCookies.length} 条 Cookie（关闭登录标签页）`)
        // 登录成功后才启动监听与自唤醒；状态查询本身不碰这些服务。
        try {
          await onSuccess?.({ cookies: douyinCookies })
        } catch (err) {
          logger.warn?.(`抖音登录成功回调失败：${err.message}`)
        }
        // 登录只是共享浏览器里的一个标签页：只关它，不关浏览器。
        // 活动和监听如果已经在跑，它们的标签页继续留着。
        cleanup()
        state = { ...state, finishedAt: now() }
        return
      }
      await sleep(POLL_MS)
    }
    setPhase('timeout', '超时未检测到登录。登录标签页已关闭，可以重新发起。')
    cleanup()
  }

  /** 取消等待：只关登录标签页、回 idle。 */
  function cancel() {
    if (state.phase !== 'waiting') return snapshot()
    setPhase('idle', '已取消')
    cleanup()
    return snapshot()
  }

  function cleanup() {
    const page = running?.page
    running = null
    Promise.resolve()
      .then(() => (page ? browserHub.closeTab(page) : browserHub.closeTab('login')))
      .then(() => browserHub.closeIfIdle())
      .catch(() => { /* 浏览器可能已经被用户关了 */ })
    state = { ...state, finishedAt: now() }
    if (state.phase === 'waiting') setPhase('idle', '已中断')
  }

  function snapshot() {
    const exists = sessionStore.exists()
    return { ...state, exists, keySource: sessionStore.keySource(), browser: browserHub.snapshot() }
  }

  function dispose() {
    cleanup()
  }

  return { start, cancel, snapshot, dispose }
}

/**
 * 惰性保活 + 失效探测：带 Cookie 轻量访问抖音主页。
 * 只判断「还认不认这份登录态」，不解析内容、不触发任何写操作。
 * @returns {Promise<{ alive: boolean, reason: string }>}
 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export async function probeAlive(cookieHeader, { fetchImpl = fetch, logger = console, timeoutMs = 8000 } = {}) {
  if (!cookieHeader) return { alive: false, reason: 'no-session' }
  try {
    const res = await fetchImpl('https://www.douyin.com/', {
      headers: {
        cookie: cookieHeader,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
      },
      redirect: 'manual',
      // 超时兜底：验活不该拖住刷流
      ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
    // 未登录时抖音会把主页重定向到登录流程；登录态有效返回 200 主页
    const alive = res.status === 200
    return { alive, reason: alive ? 'ok' : `http-${res.status}` }
  } catch (err) {
    logger.warn?.(`抖音保活探测失败（不影响本地数据）：${err.message}`)
    return { alive: false, reason: 'network-error' }
  }
}
