// ============================================================
// 回评论：一台共享浏览器里的独立常驻标签页
// ------------------------------------------------------------
// 这个标签页只做「回评论」，不刷视频、不点赞、不关注、不主动私信：
//   开关开 -> 打开这个标签页
//   开关关 -> 关掉这个标签页
//   用户手动关掉标签页 -> 把 douyin.comments.enabled 写回 false
// 打开后每 5 秒先让鼠标离开通知、看顶部铃铛的未读红点：
//   有红点才悬停打开浮层；平时不常开浮层，否则平台不会推新通知。
//   只挑头像带蓝色评论标、且带未读红点的新评论；
//   点评论文字进视频详情（modal_id），点这条评论下的「回复」；
//   注入草稿器写一句，发出去，再关详情回推荐页。
// 不另起浏览器、不使用第二个登录档案，避免重新扫码/重新登录。
// ============================================================

import { createBrowserHub } from './browser-hub.js'
import { PAUSE_VIDEOS_JS } from './tab-quiet.js'
import { currentVideoId, readSnapshot, replyToComment } from './actions.js'
import { createSessionStore } from './session.js'
import {
  closeNotificationPanel,
  closeNotificationVideo,
  currentModalVideoId,
  ensureRecommendPage,
  openNotificationVideo,
  readBell,
  readNotificationComments,
} from './comment-inbox.js'
import {
  commentNotificationKey,
  createCommentReplyLedger,
  pickReplyCandidate,
  replyableNotification,
} from './comment-reply-policy.js'
import { fromRoot } from '../../utils/paths.js'

/** 回评论标签页的固定地址；后续读通知的链路也从这一页开始。 */
const COMMENT_TAB_URL = 'https://www.douyin.com/'
const COMMENT_POLL_MS = 5000
const COMMENT_RETRY_MS = 15000
// 没回复成功时停在视频详情里，留时间给人看；用户手动关掉详情会立刻恢复轮询。
const DETAIL_HOLD_MS = 10 * 60 * 1000
// 回评论是公开动作，宁可慢一点，也不要一条接一条。
// 默认：两次至少隔 90 秒、每小时最多 6 条、每天最多 20 条；可用环境变量收紧。
const REPLY_COOLDOWN_MS = Math.max(30_000, Number(process.env.FISH_COMMENT_REPLY_COOLDOWN_SEC) * 1000 || 90_000)
const REPLY_MAX_PER_HOUR = Math.max(1, Number(process.env.FISH_COMMENT_REPLY_MAX_PER_HOUR) || 6)
const REPLY_MAX_PER_DAY = Math.max(1, Number(process.env.FISH_COMMENT_REPLY_MAX_PER_DAY) || 20)
const REPLY_LEDGER_PATH = process.env.FISH_COMMENT_REPLY_LEDGER || fromRoot('data', 'state', 'comment-reply-ledger.json')

/** 这个标签页只做监听，不应该在后台自动播放视频。脚本与私信监听共用。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 当前页面立刻暂停，返回命中的 video 数量；失败只记日志，不影响监听。 */
async function pauseVideos(page) {
  try {
    const r = await page.cmd('Runtime.evaluate', { expression: PAUSE_VIDEOS_JS, returnByValue: true })
    return Number(r?.result?.value) || 0
  } catch {
    return 0
  }
}

/**
 * 把加密会话里的 Cookie 注入共享浏览器。
 * 只补 sessionid 缺失的情况，不覆盖浏览器档案里更新的登录态。
 * 只操作 Cookie，不读、不回显 Cookie 值。
 */
async function injectSessionCookies(page, store, logger) {
  if (!store || typeof store.load !== 'function') return false
  const session = store.load()
  if (!session || !Array.isArray(session.cookies) || !session.cookies.length) return false
  try {
    await page.cmd('Network.enable')
    const current = await page.cmd('Network.getCookies', { urls: ['https://www.douyin.com'] })
    const hasSession = (current?.cookies || []).some((c) => c && (c.name === 'sessionid' || String(c.name).startsWith('sessionid')))
    if (hasSession) return false
    const cookies = session.cookies
      .filter((c) => c && c.name)
      .map((c) => {
        const next = {
          name: String(c.name),
          value: String(c.value ?? ''),
          domain: String(c.domain || '.douyin.com'),
          path: String(c.path || '/'),
        }
        if (c.secure !== false) next.secure = true
        if (c.httpOnly === true) next.httpOnly = true
        const expires = Number(c.expires)
        if (Number.isFinite(expires) && expires > 0) next.expires = expires
        if (c.sameSite) next.sameSite = c.sameSite
        return next
      })
    if (!cookies.length) return false
    await page.cmd('Network.setCookies', { cookies })
    logger.info?.(`回评论：已把加密登录态注入共享浏览器（${cookies.length} 条 Cookie）`)
    return true
  } catch (err) {
    logger.warn?.(`回评论：注入登录态失败：${err.message}`)
    return false
  }
}

/**
 * 把回评论开关写回关闭。
 * 用户手动叉掉标签页时调用；写盘失败只记日志，不把异常抛给轮询。
 */
export function markCommentsDisabled(platformSettings, logger = console) {
  try {
    if (!platformSettings || typeof platformSettings.patch !== 'function') {
      logger.warn?.('回评论标签页已关闭，但没有设置存储，开关状态没能写回')
      return false
    }
    platformSettings.patch({ douyin: { comments: { enabled: false } } })
    logger.warn?.('回评论标签页被手动关闭，开关已同步关闭')
    return true
  } catch (err) {
    logger.warn?.(`回评论标签页已关闭，但开关状态写回失败：${err.message}`)
    return false
  }
}

/**
 * 回评论监听器。
 *
 * 和 createInboxWatcher 共用同一个 browserHub；只是 kind 不同，
 * 因此不会把私信监听的标签页顶掉，也不会打开第二个浏览器。
 */
export function createCommentWatcher({ config, logger = console, platformSettings, hub, sessionStore = null, now = Date.now, ledger = null, replyCooldownMs = REPLY_COOLDOWN_MS, maxPerHour = REPLY_MAX_PER_HOUR, maxPerDay = REPLY_MAX_PER_DAY } = {}) {
  const browserHub = hub || createBrowserHub({ config, logger })
  // 回评论和私信监共用同一份加密登录态：浏览器档案里没有 sessionid 时，
  // 先把加密会话里的 Cookie 注进去，否则新标签页会显示未登录。
  const store = sessionStore
    || (config?.platforms?.douyin?.sessionPath ? createSessionStore({ config, logger }) : null)
  const replyLedger = ledger || createCommentReplyLedger({
    path: REPLY_LEDGER_PATH,
    now,
    cooldownMs: replyCooldownMs,
    maxPerHour,
    maxPerDay,
  })
  let page = null
  let timer = null
  let ticking = false
  let dead = false
  let generation = 0
  let restartPending = false
  let lastTickAt = 0
  let lastError = ''
  let failures = 0
  let lastReply = null
  let draftHandler = null
  // 上一次没发出去时停在详情页，避免用户正看着就被自动刷新回推荐。
  let heldDetail = null

  function settings() {
    const s = platformSettings?.get?.() || {}
    return {
      enabled: s?.douyin?.comments?.enabled === true,
    }
  }

  async function ensurePage(gen) {
    if (page) return page
    // 先开空白页，注入登录态后再导航到抖音；否则页面会先以未登录状态加载。
    const opened = await browserHub.openTab('comments', 'about:blank', { bringToFront: true })
    // 开页和用户点「关」可能撞在一起；已经换代或已经停用的页不能留下。
    if (gen !== generation || dead || !settings().enabled) {
      try { await browserHub.closeTab(opened) } catch { /* 浏览器可能已经退出 */ }
      return null
    }
    page = opened
    // 用户手动叉掉标签页时立刻写回开关，不等下一轮 5 秒轮询。
    if (typeof opened.onClose === 'function') {
      opened.onClose(() => {
        if (page !== opened || dead) return
        void markOff('标签页已被手动关闭')
      })
    }
    // 私信监听标签页有这一步，回评论标签页也必须补上：共享档案里没有 Cookie 时，
    // 用加密会话里的登录态把 sessionid 注进去，页面才不会显示未登录。
    await injectSessionCookies(opened, store, logger)
    // 地址是首页时可能正在自动播放；先静音暂停，避免监听页抢注意力。
    await opened.cmd('Page.addScriptToEvaluateOnNewDocument', { source: PAUSE_VIDEOS_JS }).catch(() => {})
    await opened.cmd('Page.navigate', { url: COMMENT_TAB_URL }).catch(() => {})
    await sleep(1600)
    if (page !== opened || dead) return null
    const paused = await pauseVideos(opened)
    if (paused) logger.info?.(`回评论监听：已暂停页面里的 ${paused} 个视频`)
    logger.info?.('回评论监听：共享浏览器标签页已打开')
    return opened
  }

  async function markOff(reason) {
    dead = true
    generation += 1
    heldDetail = null
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const old = page
    page = null
    if (old) {
      try { await browserHub.closeTab(old) } catch (err) { logger.warn?.(`回评论标签页关闭失败：${err.message}`) }
    }
    const ok = markCommentsDisabled(platformSettings, logger)
    if (!ok) logger.warn?.(`回评论监听已停止（${reason}），但开关状态没写回`)
    else logger.info?.(`回评论监听已停止：${reason}`)
  }

  function schedule(delay = COMMENT_POLL_MS) {
    if (!settings().enabled || dead) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, delay)
  }

  // 同一条通知生成/定位失败时先压一会儿，别每 5 秒重试同一条。
  const failedAt = new Map()
  const FAILED_RETRY_MS = 10 * 60_000
  function recentlyFailed(key) {
    const at = Number(failedAt.get(key)) || 0
    if (!at) return false
    if (now() - at > FAILED_RETRY_MS) { failedAt.delete(key); return false }
    return true
  }
  function noteFailed(key) {
    failedAt.set(key, now())
    if (failedAt.size > 100) {
      const oldest = [...failedAt.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) failedAt.delete(oldest[0])
    }
  }

  // 上一轮已经确认是未读，但点评论文字没进视频：记在内存里，
  // 下一轮即使红点已经被平台清掉，也再试一次这条，而不是直接当已读。
  const PENDING_TTL_MS = 10 * 60_000
  const PENDING_MAX_ATTEMPTS = 2
  let pending = null

  function rememberPending(key, item) {
    const previous = pending && pending.key === key ? pending : null
    const attempts = (previous ? previous.attempts : 0) + 1
    if (attempts >= PENDING_MAX_ATTEMPTS) {
      noteFailed(key)
      pending = null
      return
    }
    pending = { key, item, attempts, at: now() }
  }

  /** 优先接上一轮 pending 的同一条；找不到就回落到正常“未读蓝标”筛选。 */
  function pickFromRows(rows) {
    if (pending) {
      if (now() - pending.at > PENDING_TTL_MS) {
        pending = null
      } else {
        const row = (rows || []).find((r) => commentNotificationKey(r) === pending.key)
        if (row) {
          const usable = replyableNotification(row, { requireUnread: false })
          if (usable.ok && !replyLedger.hasSeen(pending.key) && !recentlyFailed(pending.key)) {
            return { ok: true, item: row, key: pending.key, pending: true, reason: '' }
          }
        }
        // 上一轮那条已经不在浮层里/已删除/已回过，别一直挂着一条死引用。
        pending = null
      }
    }
    return pickReplyCandidate(rows || [], {
      hasSeen: (k) => replyLedger.hasSeen(k),
      recentlyFailed,
    })
  }

  /** 已进入视频详情：读文案/评论上下文 -> 生成一句 -> 点这条评论的回复 -> 发送 -> 关详情。 */
  async function replyToItem(p, picked) {
    const item = picked.item
    const key = picked.key
    const opened = await openNotificationVideo(p, item)
    if (!opened.ok) {
      // 已经确认是未读评论，别因为一次点击失败就当它已读；下一轮再试一次。
      rememberPending(key, item)
      // 点击失败必须把鼠标移开：浮层常开会让平台收不到后续新通知。
      await closeNotificationPanel(p)
      return { ok: false, reason: opened.reason }
    }
    pending = null
    let sentOk = false
    let detailVideoId = ''
    try {
      // 详情页可能先只挂评论面板，文案晚一点；读不到完整 snapshot 也继续，回复仍然只针对这条评论。
      let snap = null
      for (let i = 0; i < 4; i++) {
        snap = await readSnapshot(p)
        if (snap && (snap.id || snap.caption)) break
        await sleep(400)
      }
      const videoId = opened.videoId || (await currentVideoId(p)) || (await currentModalVideoId(p))
      detailVideoId = videoId || ''
      const drafted = await draftHandler(item, {
        video: {
          id: videoId,
          caption: snap?.caption || '',
          author: snap?.author || '',
        },
        comments: snap?.comments || [],
      })
      if (!drafted || !drafted.ok || (!drafted.text && !drafted.image)) {
        noteFailed(key)
        logger.warn?.(`回评论：给「${item.name || '对方'}」的草稿没生成（${drafted?.reason || '空'}）`)
        return { ok: false, reason: drafted?.reason || '草稿为空' }
      }
      const sent = await replyToComment(p, { author: item.name, text: item.text }, drafted.text, {
        expectVideoId: videoId || '',
        image: drafted.image || '',
        emoji: drafted.emoji || '',
        logger,
      })
      if (!sent || !sent.ok) {
        noteFailed(key)
        logger.warn?.(`回评论：回复「${item.name || '对方'}」没发出去（${sent?.reason || '未知'}）`)
        return { ok: false, reason: sent?.reason || '回复没有发出去' }
      }
      sentOk = true
      const rec = replyLedger.record(key, now())
      const shown = drafted.text || (drafted.image ? `[表情包${drafted.stickerCaption ? `：${drafted.stickerCaption}` : ''}]` : '')
      lastReply = {
        at: now(),
        author: String(item.name || '').slice(0, 40),
        text: String(shown || '').slice(0, 60),
        videoId: videoId || '',
      }
      logger.info?.(`回评论：回了「${item.name || '对方'}」：${shown}${drafted.emoji ? ` +${drafted.emoji}` : ''}${rec.persisted ? '' : '（限频账本没写盘，重启后可能重复）'}`)
      return { ok: true, replied: true, author: item.name, text: drafted.text }
    } finally {
      if (sentOk) {
        // 正常回完才关详情回推荐，下一轮才能重新读通知。
        heldDetail = null
        const closed = await closeNotificationVideo(p)
        if (!closed.ok) logger.warn?.(`回评论：视频详情没关掉（${closed.reason}）`)
      } else {
        // 没发出去就不自动刷新：用户可能正看着这条详情，突然跳回推荐会像是“凭空失败”。
        heldDetail = { at: now(), videoId: detailVideoId }
        logger.warn?.('回评论：这条没发出去，停在视频详情里，先不自动刷新')
      }
      await pauseVideos(p)
    }
  }

  /**
   * 看一轮通知，最多处理一条新评论：
   * 正常状态鼠标必须离开通知、浮层收起，平台才会推新的红点；
   * 看到红点后才悬停打开浮层，挑未读 + 蓝色评论标 + 没回过 + 没失败过，
   * 点文字进视频 -> 生成一句 -> 回复 -> 关详情回推荐。
   */
  async function processOne(p) {
    if (typeof draftHandler !== 'function') {
      return { ok: false, skipped: true, reason: '自动回复草稿器还没接上' }
    }
    // 上一轮如果没回复成功，会停在视频详情里等人看；这里不要立刻把它关掉。
    const modalId = await currentModalVideoId(p)
    if (modalId) {
      if (heldDetail && now() - heldDetail.at < DETAIL_HOLD_MS
        && (!heldDetail.videoId || heldDetail.videoId === modalId)) {
        return { ok: true, skipped: true, reason: '上一条没回复，停在视频详情里等你查看' }
      }
      heldDetail = null
      const closed = await closeNotificationVideo(p)
      if (!closed.ok) return { ok: false, reason: `上一轮视频详情没关掉：${closed.reason}` }
      return { ok: true, skipped: true, reason: '已把上一轮的视频详情关掉' }
    }
    if (heldDetail) heldDetail = null
    // 页面被点到 about:blank 或别的地址时，直接拉回推荐首页；不要从错误页面读通知。
    const home = await ensureRecommendPage(p)
    if (!home.ok) return { ok: false, reason: home.reason }
    if (home.navigated) return { ok: true, skipped: true, reason: '已把页面拉回推荐首页' }
    const gate = replyLedger.check(now())
    if (!gate.ok) {
      // 冷却期间也要把鼠标挪开，浮层不能常开；否则新通知进不来。
      await closeNotificationPanel(p)
      logger.debug?.(`回评论：本轮不回（${gate.reason}）`)
      return { ok: true, skipped: true, reason: gate.reason }
    }

    // 先看有没有上一轮遗留下来的、已经打开的浮层（比如插件重启时）。
    // 有就读，不再把鼠标移来移去；没有就进入正常轮询。
    let found = await readNotificationComments(p, { openIfNeeded: false })
    if (found.ok) {
      const pickedOpen = pickFromRows(found.rows)
      if (pickedOpen.ok) return replyToItem(p, pickedOpen)
    }

    // 关键：平时必须让鼠标离开通知，浮层收起后平台才会把新通知的红点推出来。
    // 常开浮层会导致新评论根本不出现，用户实测已经确认。
    await closeNotificationPanel(p)
    await sleep(1200)
    const bell = await readBell(p)
    if ((!bell || !bell.unread) && !pending) {
      return { ok: true, skipped: true, reason: '通知上没有未读红点' }
    }

    // 只有看到红点（或还有上一轮 pending）才悬停打开浮层。
    found = await readNotificationComments(p)
    if (!found.ok) return { ok: false, reason: found.reason }
    const picked = pickFromRows(found.rows)
    if (!picked.ok) {
      // 浮层里没有可回的新评论，立刻收起，别让它挡住下一波通知。
      await closeNotificationPanel(p)
      return { ok: true, skipped: true, reason: picked.reason }
    }
    return replyToItem(p, picked)
  }

  async function tick() {
    timer = null
    if (ticking) return
    if (!settings().enabled) return
    ticking = true
    const gen = generation
    let keep = true
    try {
      const p = await ensurePage(gen)
      if (gen !== generation) {
        keep = false
        return
      }
      if (!p) throw new Error('标签页没有打开')
      if (!(await browserHub.isTabOpen(p))) {
        await markOff('标签页已不存在')
        keep = false
        return
      }
      lastTickAt = now()
      lastError = ''
      failures = 0
      // 页面刷新/推荐流换条都可能让视频重新播；每轮补一次暂停，回评论页保持安静
      await pauseVideos(p)
      const result = await processOne(p)
      if (!result.ok && !result.skipped) {
        lastError = result.reason || '回评论流程没有完成'
        logger.warn?.(`回评论：${lastError}`)
      }
    } catch (err) {
      failures += 1
      lastError = String(err?.message || err)
      logger.warn?.(`回评论监听轮询失败：${lastError}`)
      // 标签页可能被用户关掉，但 isTabOpen 检查本身也可能因浏览器退出失败；
      // 能在浏览器里核对就核对，核对不到就保持开关，下一轮重试。
      try {
        if (page && !(await browserHub.isTabOpen(page))) {
          await markOff('标签页已不存在')
          keep = false
        }
      } catch { /* 浏览器暂时不可用时继续重试 */ }
    } finally {
      ticking = false
      if (restartPending) {
        restartPending = false
        if (settings().enabled) {
          dead = false
          schedule(1000)
        }
        return
      }
      if (keep && settings().enabled && !dead) schedule(failures ? COMMENT_RETRY_MS : COMMENT_POLL_MS)
    }
  }

  function start() {
    if (!settings().enabled) return
    if (timer) {
      dead = false
      return
    }
    if (ticking) {
      // 关闭后立刻重开：旧 tick 还在跑，等它收尾后重新起一轮。
      if (dead) {
        dead = false
        restartPending = true
        generation += 1
      }
      return
    }
    generation += 1
    dead = false
    timer = setTimeout(tick, 1000)
  }

  function stop() {
    dead = true
    generation += 1
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const old = page
    page = null
    if (old) {
      Promise.resolve(browserHub.closeTab(old)).catch((err) => logger.warn?.(`回评论标签页关闭失败：${err.message}`))
    }
  }

  /** 开关变化时调用；开=起标签页，关=关标签页，不连坐共享浏览器。 */
  async function apply(reason = 'settings') {
    if (!settings().enabled) {
      stop()
      return { ok: true, running: false, reason }
    }
    dead = false
    start()
    return { ok: true, running: true, reason }
  }

  function snapshot() {
    let hubSnapshot = {}
    try { hubSnapshot = browserHub.snapshot?.() || {} } catch { /* 浏览器没起来时仍然返回开关状态 */ }
    return {
      enabled: settings().enabled,
      running: Boolean(timer || ticking),
      tabOpen: Boolean(page),
      mode: 'shared-browser-tab',
      reason: 'comment-listener',
      port: hubSnapshot.port || null,
      profile: hubSnapshot.profile || null,
      lastTickAt: lastTickAt || null,
      lastError: lastError || '',
      failures,
      lastReply,
      note: '先看红点再悬停、不常开浮层；已在视频内回复并返回推荐页；自动回复草稿器由宿主注入',
    }
  }

  async function peek() {
    return page
  }

  /** 宿主注入草稿器：收到一条新评论通知时由它写一句回复。 */
  function setDraftHandler(fn) {
    draftHandler = typeof fn === 'function' ? fn : null
  }

  return { ensurePage, tick, apply, start, stop, snapshot, peek, setDraftHandler }
}
