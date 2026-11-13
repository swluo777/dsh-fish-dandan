// ============================================================
// 私信监听器：共享浏览器里的一个常驻标签页，跟开关同生共死
//
// 用户定的规矩：
//   1. 监听私信和登录/刷流/值班用同一个浏览器、同一份档案；
//   2. 开关打开就常驻，关掉就退出；浏览器被关掉，监听也随之停；
//   3. 这样才可能实时回复。以前靠值班顺手读，等于没有。
//
// 标签页用可见窗口：无头特征太明显，抖音更容易拦；监听和活动互不导航。
// ============================================================

import { createBrowserHub } from './browser-hub.js'
import { fromRoot } from '../../utils/paths.js'
import { createSessionStore } from './session.js'
import { loadInboxState, markQueued, nextPollDelay, pollInboxOnce, saveInboxState } from './listen.js'
import { closeInbox, evalJs, peekThread, replyTo, resolveStickerFile, sendStickerTo } from './inbox.js'
import { normalizePersonName, normalizeMemoryAllow } from './memory-access.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 监听标签页只负责私信，不该顺便播视频：把页面里的 video 全部暂停并静音，
 * 再用 play 事件 + 定时扫描兜住推荐流后来挂上来的新 video。
 * 这段同时用于「新文档注入」和「当前页面立即执行」。
 */
const PAUSE_VIDEOS_JS = `(() => {
  const pause = (v) => {
    try {
      v.autoplay = false;
      v.muted = true;
      if (!v.paused) v.pause();
    } catch {}
  };
  const scan = () => {
    let n = 0;
    for (const v of document.querySelectorAll('video')) { pause(v); n += 1; }
    return n;
  };
  // 捕获阶段拦 play：autoplay / 用户点开 / 推荐流换条都在这里按掉
  if (!window.__fishListenPausePlay) {
    window.__fishListenPausePlay = true;
    document.addEventListener('play', (e) => {
      if (e.target && e.target.tagName === 'VIDEO') pause(e.target);
    }, true);
  }
  // 新 video 是后来插入的，play 事件不一定经过 document，定时补一刀
  if (!window.__fishListenPauseTimer) {
    window.__fishListenPauseTimer = setInterval(scan, 1500);
  }
  return scan();
})()`

/**
 * 监听标签页没了（用户手动关掉、或整个共享浏览器被关掉）：
 * 把设置里的 listen.enabled 一起写回 false。这样网页上的开关会跟着关，
 * 不会出现「开关还开着、实际没有标签页」的假状态。
 */
export function markListenDisabled(platformSettings, logger = console) {
  try {
    if (!platformSettings || typeof platformSettings.patch !== 'function') {
      logger.warn?.('私信监听：标签页已关闭，但设置存储不可用，开关状态没能写回')
      return false
    }
    platformSettings.patch({ douyin: { listen: { enabled: false } } })
    logger.warn?.('私信监听：标签页已关闭，监听停止，开关已同步关闭；重新打开开关即可恢复')
    return true
  } catch (err) {
    logger.warn?.(`私信监听：标签页已关闭，但开关没能同步写回：${err.message}`)
    return false
  }
}

export function createInboxWatcher({ config, logger = console, platformSettings, onMessage = null, now = () => Date.now(), hub } = {}) {
  const cfg = (config && config.platforms && config.platforms.douyin) || {}
  const sessionPath = cfg.sessionPath ? fromRoot(cfg.sessionPath) : fromRoot('data/platform/douyin-session.json')
  const store = createSessionStore({ config: { platforms: { douyin: { sessionPath } } }, logger: { debug() {}, info() {}, warn() {}, error() {} } })
  // 私信监听不再是独立浏览器，而是共享浏览器里的一个常驻标签页。
  // Cookie 罐和登录/活动是同一份，扫码一次就都在。
  const browserHub = hub || createBrowserHub({ config, logger })

  let page = null
  let timer = null
  let running = false
  let failures = 0
  let dead = false
  let tickCount = 0
  let capturedSessionId = ''

  /**
   * 顶部「消息」图标上的未读角标：有数字算数字，没有数字只有红点算 1，没有算 0。
   * 这是最省事的判据——不用打开面板、不用比列表，红点亮了才去点。
   */
  async function unreadCount(p) {
    const n = await evalJs(p, `(() => {
      const visible = (r) => r && r.width > 0 && r.height > 0;
      const label = (n) => ((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title'))) || '').trim();
      // 先找到「消息」那个图标
      let icon = null, best = null;
      for (const n of document.querySelectorAll('[aria-label],[title],a,button,div,span')) {
        if (!label(n).includes('消息') && (n.innerText || '').trim() !== '消息') continue;
        const r = n.getBoundingClientRect();
        if (!visible(r) || r.top > 160) continue;
        // 取最靠右上、面积最小的那个（图标本体）
        if (!best || r.width * r.height < best.w * best.h) { icon = n; best = { w: r.width, h: r.height, r } }
      }
      if (!best) return 0;
      const ir = best.r;
      let count = 0;
      for (const n of document.querySelectorAll('span,div,i,sup')) {
        const r = n.getBoundingClientRect();
        if (!visible(r) || r.width > 30 || r.height > 30) continue;
        // 只要图标附近那一圈
        if (r.left < ir.left - 24 || r.left > ir.right + 24) continue;
        if (r.top < ir.top - 24 || r.top > ir.bottom + 30) continue;
        const t = (n.innerText || '').trim();
        if (/^\\d{1,3}$/.test(t)) { count = Math.max(count, Number(t)); continue; }
        if (count) continue;
        const bg = getComputedStyle(n).backgroundColor || '';
        const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (m && Number(m[1]) > 200 && Number(m[2]) < 90 && Number(m[3]) < 90) count = 1;
      }
      return count;
    })()`)
    return Number(n) || 0
  }
  let state = loadInboxState()

  function settings() {
    const s = platformSettings?.get?.() || {}
    const d = s.douyin || {}
    const ownerName = String(d.listen?.ownerName || '').trim()
    return {
      enabled: d.listen?.enabled === true,
      // 所有私信都自动回；旧 scope 字段不再参与行为
      autoReply: true,
      ownerName,
      memoryAllow: normalizeMemoryAllow(d.listen?.memoryAllow, ownerName),
      intervalSec: Math.max(3, Number(d.listen?.intervalSec) || 3),
      stickersEnabled: s.stickers?.enabled === true,
      // 监听窗口永远可见：用户要能看着它回
      showWindow: true,
    }
  }

  function isSessionCookie(c) {
    return c && (c.name === 'sessionid' || String(c.name).startsWith('sessionid'))
  }

  /**
   * 共享浏览器里用户可能直接在监听标签页扫码：Cookie 进了同一份档案，但加密会话文件还没写。
   * 这里发现 sessionid 变了就同步落盘，下次登录/活动/监听重启都认这份登录态。
   */
  async function captureSession(p) {
    try {
      const res = await p.cmd('Network.getCookies', { urls: ['https://www.douyin.com'] })
      const cookies = Array.isArray(res?.cookies) ? res.cookies : []
      const hit = cookies.find(isSessionCookie)
      if (!hit || hit.value === capturedSessionId) return
      const existing = store.exists() ? store.load() : null
      const old = existing?.cookies?.find(isSessionCookie)?.value
      capturedSessionId = hit.value
      if (old === hit.value) return
      store.save(cookies.filter((c) => String(c.domain || '').includes('douyin')), {
        account: 'douyin-web', capturedAt: now(), source: 'listen-tab',
      })
      logger.info?.('私信监听：在共享浏览器里发现新的登录态，已同步加密保存（登录/活动共用）')
    } catch (err) {
      logger.debug?.(`私信监听：同步登录态暂时失败：${err.message}`)
    }
  }

  /** 当前页面立刻暂停，返回命中的 video 数量；失败只记日志，不影响监听。 */
  async function pauseVideos(p) {
    try {
      return Number(await evalJs(p, PAUSE_VIDEOS_JS)) || 0
    } catch { return 0 }
  }

  /** 起自己那个监听标签页（共享浏览器已经开着就接上），注入登录态，停在抖音首页。 */
  async function ensurePage() {
    if (page) return page
    if (!store.exists()) return null
    const session = store.load()
    if (!session || !Array.isArray(session.cookies)) return null
    try {
      page = await browserHub.openTab('listen', 'https://www.douyin.com/', {
        bringToFront: settings().showWindow,
      })
    } catch (err) {
      logger.warn?.(`私信监听：共享浏览器标签页打不开：${err.message}`)
      page = null
      return null
    }
    await page.cmd('Network.enable').catch(() => {})
    // 共享档案里已经有登录 Cookie 时不再覆盖；只有手动导入、档案里没有时才注入 sessionStore。
    try {
      const current = await page.cmd('Network.getCookies', { urls: ['https://www.douyin.com'] })
      const hasSession = (current?.cookies || []).some(isSessionCookie)
      if (!hasSession) {
        await page.cmd('Network.setCookies', {
          cookies: session.cookies.map((c) => ({
            name: c.name, value: c.value, domain: c.domain || '.douyin.com', path: c.path || '/', secure: true, httpOnly: false,
          })),
        })
      }
    } catch { /* 注入失败就按档案里的 Cookie 跑 */ }
    // 监听标签页只监听私信：每次新文档都先把 video 暂停/静音，别让首页推荐流一打开就播
    await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: PAUSE_VIDEOS_JS }).catch(() => {})
    await page.cmd('Page.navigate', { url: 'https://www.douyin.com/' }).catch(() => {})
    await sleep(2500)
    // 等页面真的可交互再开始读：首页加载慢时立刻去点「消息」永远打不开，
    // 旧版就是这样每轮失败、越退越久，看着像「没动静」。
    let ready = false
    for (let i = 0; i < 20; i += 1) {
      ready = Boolean(await evalJs(page, `(() => {
        if (document.readyState !== 'complete') return false;
        const t = document.body ? document.body.innerText : '';
        return t.includes('消息') || t.includes('登录');
      })()`))
      if (ready) break
      if (i === 10) await page.cmd('Page.reload', {}).catch(() => {})
      await sleep(500)
    }
    if (!ready) logger.warn?.('私信监听：抖音首页还没加载完，先按现在的样子试着读')
    const paused = await pauseVideos(page)
    if (paused) logger.info?.(`私信监听：已暂停页面里的 ${paused} 个视频，监听标签页只收私信`)
    await captureSession(page)
    logger.info?.(`私信监听：共享浏览器标签页已就绪（端口 ${browserHub.snapshot().port}，档案 ${browserHub.snapshot().profile}）`)
    return page
  }

  /** 给宿主用的发送口：所有私信都允许回；记忆权限另由 dm-auto 判断。 */
  async function reply(name, text) {
    const clean = normalizePersonName(name)
    if (!clean) return { ok: false, reason: '没有会话名，发不出去' }
    const p = await ensurePage()
    if (!p) return { ok: false, reason: '监听浏览器没起来（没有登录态或启动失败）' }
    const r = await replyTo(p, name, text)
    try { await closeInbox(p) } catch { /* 忽略 */ }
    return r
  }

  /**
   * 被动回复也能发一张库里的表情包。
   * 这里只负责“发”，要不要发、发哪张由 dm-auto 按语义卡判断。
   */
  async function sendSticker(name, file) {
    const s = settings()
    if (!s.stickersEnabled) return { ok: false, disabled: true, reason: '「允许发表情包」在设置里关着' }
    const clean = normalizePersonName(name)
    if (!clean) return { ok: false, reason: '没有会话名，发不出去' }
    const safeFile = resolveStickerFile(file)
    if (!safeFile) return { ok: false, reason: '表情路径不在允许的目录里' }
    const p = await ensurePage()
    if (!p) return { ok: false, reason: '监听浏览器没起来（没有登录态或启动失败）' }
    const r = await sendStickerTo(p, clean, safeFile)
    try { await closeInbox(p) } catch { /* 忽略 */ }
    return r
  }

  /** 点进会话读上下文（回复要用）。 */
  async function peek(name) {
    const p = await ensurePage()
    if (!p) return { ok: false, reason: '监听浏览器没起来' }
    // 表情包/图片截图、分享视频打开视频页读文案/评论/抽帧，都发生在监听标签页里。
    return await peekThread(p, name, { logger, analyzeVideo: true })
  }

  /** 补答：重启前已经进队列、却还没回过的（最近一小时，一人只补一条）。 */
  async function catchUp() {
    if (typeof onMessage !== 'function') return
    const cutoff = now() - 60 * 60_000
    const latest = new Map()
    for (const q of state.queue || []) {
      if (!q || q.status !== 'approved' || q.answeredAt || q.catchUpAt) continue
      if (Number(q.at) < cutoff) { q.catchUpAt = now(); continue }
      const prev = latest.get(q.name)
      if (!prev || Number(q.at) > Number(prev.at)) latest.set(q.name, q)
    }
    if (!latest.size) return
    for (const item of latest.values()) {
      if (item.retryAt && Number(item.retryAt) > now()) continue
      try {
        const out = await onMessage(item, { reply, peek })
        if (out && out.sent) {
          item.status = 'answered'
          item.answeredAt = now()
          item.catchUpAt = now()
          // 同一个人只保留最新一条待回；更老的还在队列里就标成被取代，别再翻出来
          for (const q of state.queue || []) {
            if (q && q !== item && q.name === item.name && q.status === 'approved') q.status = 'superseded'
          }
          logger.info?.(`私信监听：补回重启前没回的那条（${item.name}）`)
        } else if (out && out.deferred) {
          // 冷却中：留着 approved，下一轮再看；不写 catchUpAt，避免把这条永久丢掉
        } else if (out && out.skipped) {
          // 旧状态/已撤销的消息，不再重试
          item.status = 'ignored'
          item.ignoredAt = now()
          item.catchUpAt = now()
        } else {
          // 模型/发送失败：留着重试，但别每 3 秒烧一次模型
          item.retryAt = now() + 5 * 60_000
        }
      } catch (err) {
        item.retryAt = now() + 5 * 60_000
        logger.warn?.(`补回私信失败：${err.message}`)
      }
    }
    saveInboxState(state)
  }

  /** 监听标签页没了：停轮询、把开关写回 false，再关残留页。 */
  async function markDead(reason) {
    const deadPage = page
    page = null
    dead = true
    // 先写开关：即使关标签页的请求卡住，网页上也不会留下一个空开的开关
    markListenDisabled(platformSettings, logger)
    if (deadPage) await browserHub.closeTab(deadPage).catch(() => { /* 已关 */ })
    logger.warn?.(`私信监听：${reason}，监听停止`)
  }

  async function tick() {
    if (running) return
    const cfgL = settings()
    if (!cfgL.enabled) { timer = null; return }
    running = true
    tickCount += 1
    try {
      // 值班/别的进程可能刚改过队列；每轮重新读盘，别拿创建时的旧快照写回去
      state = loadInboxState()
      const p = await ensurePage()
      if (!p) {
        logger.warn?.('私信监听：没有登录态或监听浏览器起不来，30 秒后再试')
        failures += 1
      } else if (typeof browserHub.isTabOpen === 'function' && !(await browserHub.isTabOpen(p))) {
        // 用户手动关掉了监听标签页（或整个共享浏览器被关）：立刻停，并把开关写回 false
        await markDead('监听标签页已关闭（或共享浏览器被关掉）')
        return
      } else {
        // 页面刷新/推荐流换条都可能让视频重新播；每轮补一次暂停，监听页保持安静
        await pauseVideos(p)
        await captureSession(p)
        // 先看顶部「消息」的红点：没有红点就不去点面板，省得白折腾。
        // 每 5 轮强制读一次，防角标认不出来时一直当没消息。
        const unread = await unreadCount(p)
        const force = tickCount % 5 === 0
        if (!unread && !force) {
          state.lastPollAt = now()
          saveInboxState(state)
          failures = 0
          return
        }
        const r = await pollInboxOnce({
          page: p, state, ownerName: cfgL.ownerName, memoryAllow: cfgL.memoryAllow,
        })
        if (r.ok && r.queued && r.queued.length) {
          saveInboxState(state)
          // 同一个人一次发多条时，只回最新那条；旧的标成被取代，不逐条回
          const latest = new Map()
          for (const q of (state.queue || [])) {
            if (!q || !r.queued.includes(q.id) || q.status !== 'approved') continue
            const prev = latest.get(q.name)
            if (!prev || Number(q.at) >= Number(prev.at)) {
              if (prev) prev.status = 'superseded'
              latest.set(q.name, q)
            } else {
              q.status = 'superseded'
            }
          }
          const items = [...latest.values()]
          logger.info?.(`私信监听：收到 ${items.length} 条（${items.map((i) => i.name).join('、')}）`)
          failures = 0
          // 实时回复：交给宿主注入的草稿器，边收边回，不依赖值班
          if (typeof onMessage === 'function') {
            for (const item of items) {
              try {
                const out = await onMessage(item, { reply, peek })
                if (out && out.sent) { item.status = 'answered'; item.answeredAt = now() }
                else if (out && out.skipped) { item.status = 'ignored'; item.ignoredAt = now() }
              } catch (err) { logger.warn?.(`私信自动回复失败：${err.message}`) }
            }
            saveInboxState(state)
          }
        } else if (r.ok) {
          saveInboxState(state)
          failures = 0
          await catchUp()
        } else {
          saveInboxState(state)
          failures += 1
          logger.warn?.(`私信监听读取失败（第 ${failures} 次）：${r.reason || '未知'}`)
          // 读失败先把浮层收掉，下一轮从干净状态重开，别在坏状态上越陷越深
          try { await closeInbox(p) } catch { /* 忽略 */ }
        }
      }
    } catch (err) {
      failures += 1
      logger.warn?.(`私信监听异常：${err.message}`)
      // 监听标签页没了/浏览器被关掉：按用户定的规矩，监听随之停止，不偷偷重开
      await markDead('监听标签页异常（可能已关闭）')
    } finally {
      running = false
      if (dead) { dead = false; timer = null; return }
      if (settings().enabled) {
        timer = setTimeout(tick, nextPollDelay(state, settings().intervalSec))
        timer.unref?.()
      }
    }
  }

  /** 开关打开 = 开监听标签页 + 立刻开始轮询；关闭 = 只关这个标签页、停轮询。 */
  function apply(reason = 'settings') {
    const cfgL = settings()
    if (!cfgL.enabled) {
      stop()
      logger.info?.('私信监听：开关关闭，轮询已停、监听标签页已关闭')
      return { ok: true, running: false, reason }
    }
    if (!store.exists()) {
      stop()
      logger.warn?.('私信监听：还没登录抖音，先扫码登录再开监听')
      return { ok: false, running: false, reason: 'no-session' }
    }
    // 开：立刻起一轮，不等定时器；之后由 tick 自己续（别再叠一个 start 的定时器）
    if (timer) { clearTimeout(timer); timer = null }
    dead = false
    tick()
    return { ok: true, running: true, reason }
  }

  /**
   * 旧版队列迁移：以前值班会把 approved 一条条回，pending 等主人审批；
   * 积压的旧消息会在第一次启动时被当成「新私信」再回一遍。新逻辑由监听独占队列，
   * 第一次启动先把这批历史 approved/pending 全部标成 superseded，只处理启动之后新到的消息。
   */
  function migrateLegacyQueue() {
    state = loadInboxState()
    if (state.queueMigratedAt) return
    let n = 0
    for (const q of state.queue || []) {
      // 旧版 pending 是「等主人点头」，approved 是「等值班回」；两种都不该在升级后补发
      if (q && (q.status === 'approved' || q.status === 'pending')) {
        q.status = 'superseded'
        q.migratedAt = now()
        n += 1
      }
    }
    state.queueMigratedAt = now()
    saveInboxState(state)
    if (n) logger.info?.(`私信监听：旧队列迁移完成，${n} 条历史 approved 标为 superseded，不再补回`)
  }

  function start() {
    if (timer) return
    if (!settings().enabled) return
    migrateLegacyQueue()
    dead = false
    timer = setTimeout(tick, 1000)
    timer.unref?.()
    logger.info?.('私信监听已挂上（共享浏览器标签页，几秒一轮）')
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null }
    const old = page
    page = null
    // 只关监听标签页，共享浏览器留给活动和值班
    if (old) Promise.resolve(browserHub.closeTab(old)).catch(() => { /* 已关 */ })
  }

  function snapshot() {
    const s = settings()
    const st = readState()
    const browser = browserHub.snapshot()
    return {
      enabled: s.enabled,
      running: Boolean(timer),
      ownerName: s.ownerName,
      memoryAllow: s.memoryAllow,
      autoReply: s.autoReply,
      intervalSec: s.intervalSec,
      showWindow: s.showWindow,
      port: browser.port,
      profile: browser.profile,
      lastPollAt: st.lastPollAt || null,
      backoff: st.backoff || 0,
      queue: [...(st.queue || [])].reverse().slice(0, 30),
      failures,
      mode: 'shared-browser-tab',
    }
  }

  function readState() { return loadInboxState() }

  function decide(id, status) {
    const st = readState()
    if (!markQueued(st, id, status)) return false
    saveInboxState(st)
    return true
  }

  async function sendToOwner(text) {
    const s = settings()
    if (!s.ownerName) return { ok: false, reason: '没配主人昵称' }
    return await reply(s.ownerName, text)
  }

  return { start, stop, apply, snapshot, readState, decide: (id, status) => decide(id, status), sendToOwner, reply, sendSticker, peek }
}
