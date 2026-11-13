// ============================================================
// 值班 MCP 服务端：跑在独立的 DSH 会话里（dsh-mcp-client 拉起）。
// 模型通过这里的一组窄工具"看→想→动"，宿主只留护栏（时间/条数/发言卫生）。
// 事件全部追加到 FISH_EVENTS（jsonl），宿主在值班结束后导进记忆与流水账。
// ============================================================
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createSessionStore } from './session.js'
import { launchBrowser, attachPage, openNewPage, closePage, closeBrowser } from './cdp.js'
import { sweepStaleProfiles } from './temp-profiles.js'
import {
  readSnapshot, readComments, closeComments, nextVideo, like, favorite,
  postComment, replyToComment, sendDm, playbackState, currentVideoId, openRecommend,
  openPage, readSelf, updateSelf, captureVideoFrames, readOwnerLikes, forwardToOwner,
} from './actions.js'
import { checkOutbound } from './guard.js'
import { sanitizeInput } from '../../utils/safety.js'
import { humanize, limitForComment, splitBubbles, stripEcho } from '../../voice/humanize.js'
import { applyFlavor } from '../../voice/flavor.js'
import { closeInbox, peekThread, replyTo, sendStickerTo, resolveStickerFile } from './inbox.js'
import { readInteractions } from './interactions.js'
import { createDmLimiter } from './dm-limit.js'
import { resolveDmAccess } from './memory-access.js'
import { createStickerLibrary } from '../../stickers/index.js'
import { expressionProfile, hasEmoji, inferIntent, isStickerEligible, isStickerOnlyIntent } from '../../voice/expression.js'
import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'
import { createMemory } from '../../memory/index.js'
import { resolveConfig } from '../../config.js'

const HOME = process.env.FISH_DUTY_HOME || process.cwd()
const EVENTS = process.env.FISH_EVENTS || join(HOME, 'duty-events.jsonl')
const STOP_FLAG = join(HOME, 'stop')
const SEEN_FILE = join(HOME, 'seen.json')
const OWNER_LIKES_FILE = join(HOME, 'owner-likes.json')
const OWNER_LIKES_COOLDOWN_MS = 10 * 60_000
const COMMENT_LIMIT = Math.max(1, Number(process.env.FISH_COMMENT_LIMIT) || 5)
// 人味后处理强度：off / light / natural（fish-tone 的思路）
const HUMANIZE = process.env.FISH_HUMANIZE === 'off' ? 'off' : (process.env.FISH_HUMANIZE === 'natural' ? 'natural' : 'light')
// 单项能力位：设置里关掉的能力，工具层直接拒绝，不靠提示词自觉
const CAPS = (() => {
  try { return JSON.parse(process.env.FISH_CAPS || '{}') } catch { return {} }
})()
const capOn = (name) => !CAPS.actions || CAPS.actions[name] !== false
const readCommentsOn = () => CAPS.readComments !== false
const visionOn = () => CAPS.vision === true
const ownerLikesOn = () => CAPS.ownerLikes === true
// 新能力位必须显式打开；旧进程没有这个键时不能当成 true
const mentionOwnerOn = () => Boolean(CAPS.actions && CAPS.actions.mentionOwner === true)
// 分享给主人同样必须显式打开；默认关，避免升级后突然开始转发。
const forwardOn = () => Boolean(CAPS.actions && CAPS.actions.forward === true)
// 表情包总闸：设置页「允许发表情包」关着时，评论/私信都不能贴图。
const stickersOn = () => CAPS.stickers === true
// 表达浓度由设置页三档决定；这里是数字落地，不给用户看滑块。
const EXPRESSION = (() => {
  let level = 'natural'
  try {
    const raw = process.env.FISH_EXPRESSION
    if (raw) {
      const parsed = JSON.parse(raw)
      level = typeof parsed === 'string' ? parsed : (parsed?.level || 'natural')
    } else if (process.env.FISH_EXPRESSION_LEVEL) level = process.env.FISH_EXPRESSION_LEVEL
  } catch { /* 用默认 */ }
  return expressionProfile(level)
})()
const OWNER_PROFILE = String(process.env.FISH_OWNER_PROFILE || '').trim()
const HOME_URL = 'https://www.douyin.com/'
const LOG_FILE = join(HOME, 'duty-server.log')
const HUB_FILE = process.env.FISH_HUB_FILE || join(HOME, '..', 'platform', 'browser-hub.json')
const HUB_PORT = Number(process.env.FISH_HUB_PORT) || 9224
const PROFILE_DIR = process.env.FISH_BROWSER_PROFILE || join(HOME, '..', 'browser-profile')
// 宿主靠这个文件核对「值班标签页还在不在」；页面被手动关掉时不能继续让按钮显示值班中。
const TAB_FILE = join(HOME, 'tab.json')

mkdirSync(HOME, { recursive: true })
const log = (m) => { try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [duty] ${m}\n`) } catch { /* 忽略 */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const stickerLibrary = createStickerLibrary({
  config: { stickers: { dir: join(HOME, '..', 'stickers') } },
  logger: { info() {}, warn: (m) => log(`[stickers] ${m}`), error: (m) => log(`[stickers] ${m}`) },
})

function readHub() {
  try { return readJsonSafe(HUB_FILE, null) } catch { return null }
}

function readOwnerLikesState() {
  try {
    const s = readJsonSafe(OWNER_LIKES_FILE, {})
    return {
      seen: Array.isArray(s.seen) ? s.seen.map(String).slice(-200) : [],
      visibility: ['open', 'locked', 'empty', 'unknown'].includes(s.visibility) ? s.visibility : '',
      lastScanAt: Number(s.lastScanAt) || 0,
      totalVisible: Number(s.totalVisible) || 0,
    }
  } catch { return { seen: [], visibility: '', lastScanAt: 0, totalVisible: 0 } }
}

function saveOwnerLikesState(s) {
  try { writeJsonAtomic(OWNER_LIKES_FILE, s) } catch (e) { log(`主人喜欢列表状态写入失败：${e.message}`) }
}

function writeHub(owner) {
  try {
    writeJsonAtomic(HUB_FILE, {
      port: handle?.port || HUB_PORT,
      httpBase: handle?.httpBase || `http://127.0.0.1:${HUB_PORT}`,
      pid: handle?.child?.pid || 0,
      owner,
      profile: PROFILE_DIR,
      updatedAt: now(),
    })
  } catch (e) { log(`共享浏览器信息写入失败：${e.message}`) }
}

function removeHub() {
  try { rmSync(HUB_FILE, { force: true }) } catch { /* 忽略 */ }
}

async function probe(base) {
  try {
    const r = await fetch(`${base}/json/version`, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
    })
    return Boolean(r.ok)
  } catch { return false }
}

/** 先找共享浏览器；找不到才自己启动一个（之后插件会把它接管成共享实例）。 */
async function resolveHubBase() {
  const saved = readHub()
  const ports = [...new Set([
    Number(saved?.port),
    HUB_PORT,
    9224,
    Number(process.env.FISH_BROWSE_PORT) || 0,
    Number(process.env.FISH_DUTY_PORT) || 0,
  ].filter((p) => Number.isFinite(p) && p > 0))]
  for (const p of ports) {
    const base = `http://127.0.0.1:${p}`
    if (await probe(base)) return base
  }
  return ''
}

async function pageCount(base) {
  try {
    const r = await fetch(`${base}/json/list`, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
    })
    const list = await r.json()
    return (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page').length
  } catch { return 0 }
}

// 启动清扫：值班主任被强杀后，临时浏览器档案会留在 %TEMP%。
// 只清 12 小时前的 fish-douyin-*；占用中的 rename 失败会自动跳过。
try { sweepStaleProfiles({ logger: { info: (m) => log(m) } }) } catch (err) { log(`启动清扫临时档案失败：${err.message}`) }

const startedAt = now()
const seen = new Set(readJsonSafe(SEEN_FILE, { ids: [] }).ids || [])
let handle = null
let page = null
let navigated = false
let videos = 0
let misses = 0
let finished = false
// 关注、发作品已整体关闭；分享给主人有独立计数和「每次值班最多一条」硬门。
const counts = { like: 0, favorite: 0, comment: 0, reply: 0, dm: 0, forward: 0 }
let lastSnap = null
// 艾特主人的评论是公开评论：读记忆可以，但不能把隐私原样写出去。
// 一次评论前必须先在当前视频上读一次；换视频就作废，防止拿上一条的记忆写这一条。
const OWNER_MEMORY_TTL_MS = 5 * 60_000
let ownerMemoryFor = null

// ---- 刷的时候顺便看互动消息（评论/@），不读私信队列 ----
// 私信队列归监听器独占；值班只走「主动私信」这一条路，低频、限量，不回队列。
const LISTEN = (() => { try { return JSON.parse(process.env.FISH_LISTEN || '{}') } catch { return {} } })()
const OWNER = String(LISTEN.ownerName || '').trim()
const MEMORY_ALLOW = Array.isArray(LISTEN.memoryAllow) ? LISTEN.memoryAllow : []
const OWNER_ADDRESS = String(process.env.FISH_OWNER_ADDRESS || '主人').trim() || '主人'
// 值班进程和宿主分开跑：这里只读同一个记忆库，不写。第一次用到时再打开，没配记忆库也不影响刷流。
let memoryService = null
let memoryServiceFailed = false
function getMemoryService() {
  if (memoryService || memoryServiceFailed) return memoryService
  try {
    const { config } = resolveConfig()
    if (process.env.FISH_MEMORY_DB) config.memory.dbPath = process.env.FISH_MEMORY_DB
    memoryService = createMemory({
      config,
      logger: {
        info() {}, debug() {}, error() {},
        warn: (m) => log(`记忆：${m}`),
      },
    })
  } catch (err) {
    memoryServiceFailed = true
    log(`记忆库打不开，长期记忆按无记忆继续：${err.message}`)
  }
  return memoryService
}
// 主动私信频控：主动私信是「偶尔搭话」，不是刷流动作。
// 默认两次之间至少 10 分钟、每小时最多 2 条；同一轮刷到很多人也不会一条接一条。
const DM_LEDGER_FILE = join(HOME, 'dm-ledger.json')
const DM_COOLDOWN_MS = Math.max(60_000, Number(process.env.FISH_DM_COOLDOWN_SEC) * 1000 || 10 * 60_000)
const DM_MAX_PER_HOUR = Math.max(1, Number(process.env.FISH_DM_MAX_PER_HOUR) || 2)
const dmLimiter = createDmLimiter({
  path: DM_LEDGER_FILE,
  cooldownMs: DM_COOLDOWN_MS,
  maxPerHour: DM_MAX_PER_HOUR,
  now,
})
const dmGate = (target) => dmLimiter.check(target)
const recordDm = (target) => dmLimiter.record(target)

const INTERACTION_POLL_MS = Math.max(20_000, Number(process.env.FISH_INBOX_POLL_MS) || 60_000)
let inboxTimer = null
let tabTimer = null
let tabClosed = false
let pageStarted = false
let toolBusy = false
let pendingComment = []
let inboxTick = 0
const seenInteractions = new Set()
function drainPendingComment() {
  const out = pendingComment
  pendingComment = []
  return out
}

function startInteractionPoll() {
  if (inboxTimer) return
  inboxTimer = setInterval(async () => {
    if (toolBusy || finished || stopped() || !page) return
    toolBusy = true
    try {
      const ir = await readInteractions(page, { limit: 8 })
      if (ir && ir.ok && ir.items && ir.items.length) {
        const fresh = ir.items.filter((it) => {
          const key = interactionKey(it)
          if (!key || seenInteractions.has(key)) return false
          seenInteractions.add(key)
          return true
        })
        if (seenInteractions.size > 300) {
          for (const k of [...seenInteractions].slice(0, 100)) seenInteractions.delete(k)
        }
        if (fresh.length) {
          pendingComment.push(...fresh)
          log(`互动消息：新增 ${fresh.length} 条`)
          emit({ type: 'interaction-new', items: fresh.map((x) => ({ text: String(x.text).slice(0, 80) })) })
        }
      } else if (ir && !ir.ok) {
        log(`互动消息读取失败：${ir.reason}`)
      }
    } catch (err) {
      log(`互动消息异常：${err.message}`)
    } finally {
      try { await closeInbox(page) } catch { /* 忽略 */ }
      toolBusy = false
    }
  }, INTERACTION_POLL_MS)
  inboxTimer.unref?.()
  log(`互动消息：跟着浏览器一起开了，每 ${Math.round(INTERACTION_POLL_MS / 1000)} 秒看一次`)
}

const emit = (event) => {
  try { appendFileSync(EVENTS, JSON.stringify({ at: now(), ...event }) + '\n') } catch (e) { log(`事件写不进：${e.message}`) }
}
const persistSeen = () => { try { writeJsonAtomic(SEEN_FILE, { ids: [...seen].slice(-2000) }) } catch { /* 忽略 */ } }
const elapsedSec = () => Math.round((now() - startedAt) / 1000)
const stopped = () => existsSync(STOP_FLAG)

/** 值班标签页还在不在：/json/list 里按 targetId 核对，不靠 CDP 连接猜。 */
async function targetOpen(base, targetId) {
  if (!base || !targetId) return false
  try {
    const r = await fetch(`${base}/json/list`, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
    })
    if (!r.ok) return false
    const list = await r.json()
    return (Array.isArray(list) ? list : []).some((t) => t && t.id === targetId)
  } catch { return false }
}

function rememberTab() {
  if (!page || !page.targetId) return
  try {
    writeJsonAtomic(TAB_FILE, {
      targetId: page.targetId,
      httpBase: page.httpBase || handle?.httpBase || '',
      at: now(),
    })
  } catch (err) { log(`记录值班标签页失败：${err.message}`) }
}

/** 用户手动关标签页：结束这一轮，别让宿主一直显示「值班中」。 */
function finishByClosedTab(summary) {
  if (finished || tabClosed) return
  tabClosed = true
  finished = true
  // 先写 stop：正在执行的工具看到它也会立刻返回，不再对着已经关掉的页面动手。
  try { writeFileSync(STOP_FLAG, String(now())) } catch { /* 忽略 */ }
  log(`值班标签页已被关闭，结束这一轮`)
  try {
    emit({
      type: 'finish',
      summary: summary || '值班标签页被手动关闭，这一轮提前结束',
      videos,
      seconds: elapsedSec(),
      actions: { ...counts },
      aborted: true,
    })
  } catch { /* 忽略 */ }
  cleanupBrowser().finally(() => { try { process.exit(0) } catch { /* 忽略 */ } })
}

/**
 * 值班标签页 watchdog：用户可能直接点标签页右上角关闭，不会点页面里的「停止」。
 * 这时下一次工具调用不一定发生（模型可能正在长思考），所以必须由进程自己盯着。
 */
function startTabWatch() {
  if (tabTimer) return
  tabTimer = setInterval(async () => {
    if (!page || !pageStarted || finished || tabClosed || stopped()) return
    if (await targetOpen(page.httpBase || handle?.httpBase, page.targetId)) return
    finishByClosedTab()
  }, 1000)
  tabTimer.unref?.()
  log('值班标签页 watchdog 已挂上：标签页被手动关闭会自动结束')
}

let sessionStore = null
function store() {
  if (!sessionStore) {
    const sessionPath = process.env.FISH_SESSION_PATH || join(HOME, 'douyin-session.json')
    sessionStore = createSessionStore({ config: { platforms: { douyin: { sessionPath } } }, logger: { debug() {}, info() {}, warn() {}, error() {} } })
  }
  return sessionStore
}

/** 共享档案里已有 sessionid 时不再覆盖；只有档案为空、靠手动导入时才注入。 */
async function applySession(p, cookies) {
  try {
    const current = await p.cmd('Network.getCookies', { urls: [HOME_URL] })
    const has = (current?.cookies || []).some((c) => c && (c.name === 'sessionid' || String(c.name).startsWith('sessionid')))
    if (has) return
    await p.cmd('Network.setCookies', {
      cookies: cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain || '.douyin.com', path: c.path || '/', secure: true, httpOnly: false,
      })),
    })
  } catch { /* 注入失败就按档案里的 Cookie 跑 */ }
}

  async function ensurePage() {
    if (page) {
      // 浏览器被用户关掉/共享实例没了：下一次工具调用重新接上，不抱着死页面不放。
      // 但如果标签页是在已经跑起来之后被手动关掉的，不能偷偷再开一页继续值班。
      try { await page.cmd('Runtime.evaluate', { expression: '1' }); return page } catch {
        const dead = page
        const base = dead.httpBase || handle?.httpBase
        page = null
        handle = null
        pageStarted = false
        if (!finished && !stopped() && !(await targetOpen(base, dead.targetId))) {
          finishByClosedTab()
          throw new Error('值班标签页已被关闭，这一轮结束')
        }
      }
    }
    const session = store().load()
    if (!session || !Array.isArray(session.cookies)) throw new Error('没有登录态：先在设置页扫码登录')
    // MCP 的 stdout 是 JSON-RPC 行协议，任何非 JSON 输出都会污染协议流，
    // 所以浏览器这边只给一个写文件的 logger，绝不让它 console。
    // 和登录/活动/监听用同一个共享浏览器、同一份档案（默认 data/browser-profile）。
    const profileDir = PROFILE_DIR
    const reuseBase = await resolveHubBase()
    if (reuseBase) {
      handle = { httpBase: reuseBase, child: null, profileDir, persistent: true, reused: true }
      // 共享浏览器归插件所有：值班只借一个标签页，停止时不能按 pid 杀它
      try { rmSync(join(HOME, 'browser.pid'), { force: true }) } catch { /* 忽略 */ }
      log('接入共享浏览器（' + reuseBase + '），只开自己的值班标签页')
    } else {
      handle = await launchBrowser({
        port: HUB_PORT, profileDir,
        headless: false, // 共享浏览器必须可见：活动和监听都在里面
        startUrl: 'about:blank',
        logger: { debug: (m) => log(String(m)), info: (m) => log(String(m)), warn: (m) => log(String(m)), error: (m) => log(String(m)) },
      })
      handle.port = HUB_PORT
      writeHub('duty')
      // 只有值班自己拉起浏览器时才留 pid：宿主停止时可兜底关掉，避免孤儿 Edge
      try { if (handle.child && handle.child.pid) writeFileSync(join(HOME, 'browser.pid'), String(handle.child.pid)) } catch { /* 忽略 */ }
    }
    // 复用已有浏览器时新开一页；自己刚拉起时用自带的 about:blank，避免多一个空白页
    page = handle.reused
      ? await openNewPage(handle.httpBase, HOME_URL)
      : await attachPage(handle.httpBase, { preferUrl: 'about:blank' })
    pageStarted = true
    rememberTab()
    if (!handle.reused) await page.cmd('Page.navigate', { url: HOME_URL }).catch(() => {})
    const cookies = session.cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain || '.douyin.com', path: c.path || '/',
      secure: true, httpOnly: false,
    }))
    await applySession(page, cookies)
    await page.cmd('Page.bringToFront').catch(() => {})
    await sleep(4000)
    // 别急：页面/登录浮层加载慢时多等几轮，8 秒还没到推荐再点一次
    for (let i = 0; i < 20 && !finished; i++) {
      const snap = await readSnapshot(page)
      if (snap && snap.id) break
      if (i === 5 || i === 12) { await openRecommend(page); await page.cmd('Page.bringToFront').catch(() => {}) }
      await sleep(1000)
    }
    navigated = true
    rememberTab()
    // 私信由共享浏览器里的监听标签页负责（实时回复），值班这边只顺手看「互动消息」
    startInteractionPoll()
    return page
  }

async function watchPlayback(minMs) {
  const startAt = now()
  const minEnd = startAt + (minMs || 0)
  const noStateEnd = startAt + 30_000
  const hardEnd = startAt + 180_000
  while (now() < hardEnd && !stopped()) {
    if (now() >= minEnd) {
      const p = await playbackState(page)
      if (p && p.found) {
        if (p.ended || (p.duration > 0 && p.currentTime >= p.duration - 0.35)) { await sleep(700); break }
        if (p.paused) break
      } else if (now() >= noStateEnd) {
        // 读不到播放状态：最多等 30 秒，别为一条卡到 3 分钟
        break
      }
    }
    await sleep(400)
  }
}

const r = (v, n = 4) => Number(Number(v || 0).toFixed(n))

/** 读当前这条并停在它上面；只有当前这条已经看过时才往下翻。 */
async function tLook() {
  if (stopped()) return { ok: false, stopRequested: true, done: true, reason: '已要求停止' }
  const p = await ensurePage()
  let snap = null

  // 先找到一条没看过的视频，但读到它之后绝不自动翻页：
  // 模型要在这条上点赞/评论，页面必须停在它上面，否则就会把 A 的话发到 B 下面。
  for (let attempt = 0; attempt < 4; attempt++) {
    snap = await readSnapshot(p)
    if (!snap || !snap.id) {
      misses += 1
      if (misses % 3 === 0) await openRecommend(p)
      await nextVideo(p)
      await sleep(800)
      continue
    }
    if (!seen.has(snap.id)) break
    await nextVideo(p)
    await sleep(900)
  }

  if (!snap || !snap.id) {
    return { ok: false, reason: `第 ${misses} 次没读到视频（可能不在推荐页），正在找…`, videos }
  }
  if (seen.has(snap.id)) {
    return { ok: false, skip: true, reason: '连续几条都看过，没找到新的；可以收尾或去别的页面', videos }
  }

  let comments = []
  // 读评论也受设置控制：关掉就不打开评论区
  if (readCommentsOn()) {
    const rc = await readComments(p, COMMENT_LIMIT)
    if (rc && rc.ok) comments = rc.comments || []
    await closeComments(p)
  }

  await watchPlayback(3000)

  // 播放期间页面可能自己滑走；这时返回的文案/评论已经不属于当前页面，宁可报错也不串台。
  const idNow = await currentVideoId(p)
  if (!idNow || idNow !== snap.id) {
    return { ok: false, reason: '刚看的这条被页面自己翻走了，评论和动作都没做；再调一次 douyin_look' }
  }

  // 画面理解：只截当前这一条的帧，并把帧绑定到 videoId。
  // 截完再核对一次页面 id；如果页面在这 1-2 秒里翻走，图片直接作废，绝不带到下一条。
  let visual = null
  let images = []
  if (visionOn()) {
    const vf = await captureVideoFrames(p, { count: 2, intervalMs: 900, quality: 55 })
    if (vf.ok) {
      const idAfter = await currentVideoId(p)
      if (!idAfter || idAfter !== snap.id) {
        return { ok: false, reason: '截画面时页面翻走了，这一条的图片作废；再调一次 douyin_look' }
      }
      visual = { status: 'ready', frames: vf.frames.length, capturedAt: vf.capturedAt, videoId: snap.id }
      images = vf.frames.map((f) => ({ data: f.data, mimeType: f.mimeType }))
    } else {
      visual = { status: 'failed', reason: vf.reason, videoId: snap.id }
    }
  }

  seen.add(snap.id)
  persistSeen()
  videos += 1
  lastSnap = { ...snap, comments, visual }
  return {
    ok: true,
    video: {
      id: snap.id, url: snap.url, caption: String(snap.caption || '').slice(0, 200),
      author: snap.author || '', stats: snap.stats || {},
      comments: comments.map((c) => ({ author: c.author, text: String(c.text || '').slice(0, 120), likes: c.likes || '' })),
      visual: visual || undefined,
    },
    counters: { videos, elapsedSec: elapsedSec(), actions: { ...counts }, misses },
    hint: visual?.status === 'ready'
      ? '页面就停在这条视频上；上面附了当前画面的截图。评论/回复只能针对这条；看完画面后，用 douyin_memory 记一条真正看到的事（别只抄文案）。换下一条要重新 look。'
      : '页面就停在这条视频上。要评论/点赞就针对这条；想换下一条，再调一次 douyin_look。',
    ...(images.length ? { __images: images } : {}),
  }
}

/** 执行动作前再核对一次：页面必须还停在 douyin_look 读到的那条视频上。 */
async function ensureStillOnSnap(p) {
  if (!lastSnap) return { ok: false, reason: '还没有正在看的视频，先 douyin_look' }
  const idNow = await currentVideoId(p)
  if (!idNow || idNow !== lastSnap.id) {
    return { ok: false, reason: '当前页面已经不是 douyin_look 读的那条了；先重新 douyin_look，别对着上一条动手' }
  }
  return { ok: true }
}

/** 点赞 / 收藏。传 {like:true} 这种，只做传了的；没打开的能力直接拒绝。 */
async function tReact(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (args.like && !capOn('like')) return { ok: false, disabled: true, reason: '「点赞」没在设置里打开，这次不做' }
  if (args.favorite && !capOn('favorite')) return { ok: false, disabled: true, reason: '「收藏」没在设置里打开，这次不做' }
  const p = await ensurePage()
  const still = await ensureStillOnSnap(p)
  if (!still.ok) return still
  const bound = String(args.videoId || '').trim()
  if (bound && bound !== lastSnap.id) {
    return { ok: false, reason: '传的 videoId 不是当前这条视频；先重新 douyin_look，别对着上一条动手' }
  }
  const done = {}
  if (args.like) { const r1 = await like(p); done.like = Boolean(r1 && r1.ok); if (done.like) counts.like += 1 }
  if (args.favorite) { const r3 = await favorite(p); done.favorite = Boolean(r3 && r3.ok); if (done.favorite) counts.favorite += 1 }
  if (done.like || done.favorite) {
    emit({ type: 'react', videoId: lastSnap.id, videoCaption: lastSnap.caption, author: lastSnap.author, done })
  }
  return { ok: true, done, counters: { videos, actions: { ...counts } } }
}

/** 私信拆条：真人会分几下发，不会一整段轰过去。 */
/**
 * 私信拆条：统一走 voice 层的 splitBubbles（一条一句、最多 4 条、没有标点也硬切）。
 * 以前这段自己实现，阈值太松，模型不带句号就整段发出去，一眼像 AI。
 */
function splitDmText(text) {
  return splitBubbles(text, { maxPer: 18, maxParts: 4 })
}

/** 当前视频的检索词：文案 + 前几条评论，足够把记忆限定在这条视频的话题上。 */
function currentOwnerMemoryQuery() {
  const caption = String(lastSnap?.caption || '')
  const comments = (lastSnap?.comments || []).slice(0, 6).map((c) => String(c?.text || '')).join(' ')
  return `${caption} ${comments}`.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** 公开评论不能把隐私类记忆带出去：带隐私标签或明显敏感词的命中直接丢弃。 */
function publicSafeMemory(hit) {
  const tags = Array.isArray(hit?.tags) ? hit.tags.join(' ') : ''
  const text = String(hit?.content || '')
  return !/(隐私|私密|密码|密钥|token|身份证|银行卡|手机号|住址|家庭住址|账号密码|api[_-]?key)/i.test(`${tags} ${text}`)
}

/**
 * 艾特主人评论或分享给主人前读长期记忆。
 * 只在「艾特主人」或「分享给主人」模式下可用：普通评论和回评论没有这个入口，不要读、不要提。
 * 只读、不强化；过滤 anchor 与隐私类命中；一次最多两条。
 */
async function tOwnerMemory(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!mentionOwnerOn() && !forwardOn()) {
    return { ok: false, disabled: true, reason: '「艾特主人」和「分享给主人」都没开；普通评论/回复不读长期记忆' }
  }
  if (!lastSnap) return { ok: false, reason: '还没有正在看的视频，先 douyin_look' }
  const p = await ensurePage()
  const still = await ensureStillOnSnap(p)
  if (!still.ok) return still

  const query = String(args.query || '').trim() || currentOwnerMemoryQuery() || OWNER || '主人'
  const memory = getMemoryService()
  let hits = []
  if (memory && typeof memory.recall === 'function') {
    try {
      hits = memory.recall(query, { limit: 4, reinforce: false })
        .filter((h) => h && h.tier !== 'anchor' && typeof h.content === 'string' && h.content.trim() && publicSafeMemory(h))
        .slice(0, 2)
    } catch (err) {
      log(`艾特主人/分享记忆召回失败：${err.message}`)
    }
  }
  ownerMemoryFor = { videoId: lastSnap.id, at: now(), hits: hits.length, available: Boolean(memory) }

  const memoryText = hits.length
    ? [
        forwardOn() && !mentionOwnerOn()
          ? '你可能记得的事（这次是私聊给主人，可以自然带上，但不要原样复述隐私细节）：'
          : '你可能记得的事（这是公开评论，只用来决定怎么对主人说；不要原样复述，不要写隐私、地址、账号、健康等细节）：',
        ...hits.map((h) => `- ${String(h.content).trim().replace(/\s+/g, ' ').slice(0, 100)}`),
      ].join('\n')
    : ''
  return {
    ok: true,
    videoId: lastSnap.id,
    count: hits.length,
    available: Boolean(memory),
    memory: memoryText,
    hint: hits.length
      ? (forwardOn() && !mentionOwnerOn()
          ? '有相关记忆就自然挑一句；不相关就不要硬提。这是私聊给主人，但也别把隐私细节原样念出来。'
          : '有相关记忆就自然挑一句；不相关就不要硬提。这是公开评论，别把记忆原文或主人私事写出去。')
      : (memory
          ? '没有召回相关记忆。按当前视频和评论区写，不要编旧事。'
          : '记忆库没打开，按当前视频写，不要编旧事。'),
    counters: { videos, elapsedSec: elapsedSec() },
  }
}

/**
 * 模型要发图时，只允许从库里按 id/语义挑；不再「没给文件就随机抽一张」。
 * 查询词匹配度不够就拒绝，让模型改用文字，避免图不达意。
 */
function stickerForArgs(args = {}) {
  const id = String(args.stickerId || '').trim()
  if (id) {
    const file = stickerLibrary.filePath(id)
    if (!file) return { ok: false, reason: '这个表情 id 不在库里，先用 douyin_find_sticker 查' }
    return { ok: true, id, file, item: stickerLibrary.get(id) }
  }
  const q = String(args.stickerQuery || '').trim()
  if (!q) return { ok: false, reason: '要发图就带 stickerId，或先用 douyin_find_sticker 按上下文找一张' }
  const intent = String(args.intent || inferIntent(q)).trim()
  const hits = stickerLibrary.search({ q, intent, limit: 5, includeTagOnly: false })
  const hit = hits[0]
  if (!hit || hit.score < 0.5) {
    return { ok: false, reason: `没有匹配度够高的表情包（最高 ${hit ? hit.score : 0}）；这次用文字更稳` }
  }
  return { ok: true, id: hit.id, file: stickerLibrary.filePath(hit.id), item: hit }
}

/** 评论图片的检索词：模型指定的优先；否则用当前视频文案 + 评论区 + 自己要说的话。 */
function commentStickerQuery(args = {}, snap = null) {
  const own = String(args.stickerQuery || '').trim()
  if (own) return own
  const comments = (snap?.comments || []).slice(0, 5).map((c) => String(c?.text || '')).join(' ')
  return [args.text, snap?.caption, comments].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** 说话：评论 / 回复 / 私信。文字必须像人话，宿主负责脱敏与上限。 */
async function tSay(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!lastSnap) return { ok: false, reason: '还没有正在看的视频，先 douyin_look' }
  const p = await ensurePage()
  const still = await ensureStillOnSnap(p)
  if (!still.ok) return still
  const kind = String(args.kind || '').trim()
  // 说话也分项受控：评论/回复/私信各自开关
  const kindCap = kind === 'comment' ? 'comment' : kind === 'reply' ? 'reply' : kind === 'dm' ? 'dm' : ''
  if (kindCap && !capOn(kindCap)) {
    const capLabel = { comment: '评论', reply: '回复', dm: '私信' }[kindCap] || kindCap
    return { ok: false, disabled: true, reason: `「${capLabel}」没在设置里打开，这次不做` }
  }
  const text = String(args.text || '').trim()
  if (!text) return { ok: false, reason: '要说的话是空的' }
  const bound = String(args.videoId || '').trim()
  if (bound && bound !== lastSnap.id) {
    return { ok: false, reason: '传的 videoId 不是当前这条视频；先重新 douyin_look，别对着上一条说话' }
  }
  // 评论/回复是公开动作，必须让模型显式带上当前 video.id；只靠页面状态不够，
  // 模型上下文里可能还残留上一条视频的文案。
  if ((kind === 'comment' || kind === 'reply') && !bound) {
    return { ok: false, reason: '评论/回复必须带当前 videoId（douyin_look 返回的 video.id），先 douyin_look 再说话' }
  }
  const maxLen = kind === 'dm' ? 120 : 60
  const checked = checkOutbound(text, { maxLen })
  if (!checked.ok) return { ok: false, reason: `这句话不能发出去：${checked.reason}` }

  // 评论/回复可以贴自定义表情包；只从库里按 id/语义选，不接受模型给任意本地路径。
  let sticker = null
  if (args.stickerId || args.stickerQuery) {
    if (kind !== 'comment' && kind !== 'reply') return { ok: false, reason: '只有评论/回复可以带表情包；私信请用 douyin_send_sticker' }
    if (!stickersOn()) return { ok: false, disabled: true, reason: '「允许发表情包」在设置里关着，这次只发文字' }
    sticker = stickerForArgs({ ...args, stickerQuery: commentStickerQuery(args, lastSnap) })
    if (!sticker.ok) return sticker
  }

  // 发出去之前先掰成人话（fish-tone 的精华）：删套话、删连接词、砍说明书式尾巴
  let polished = humanize(checked.text, { strength: HUMANIZE }).text
  // 评论/回复有长度上限：太长就没人看，也最像 AI。在标点处截断，不留半句
  if (kind === 'comment' || kind === 'reply') polished = limitForComment(polished, 30)
  // 回评论时别把对方的话复述一遍再答（AI 的典型动作）
  const echoOf = kind === 'reply' ? String((args.replyTo && args.replyTo.text) || '') : ''
  if (echoOf) polished = stripEcho(polished, echoOf)
  // 嘴瓢 + 玩梗 + 文字 emoji：都按表达浓度来；带图时不再叠文字 emoji
  polished = applyFlavor(polished, { emojiChance: sticker ? 0 : EXPRESSION.textEmoji }).text
  const out = { ...checked, text: polished }
  if (!out.text) return { ok: false, reason: '这句话改完变空了，换个说法' }
  // 艾特主人不是加个 @ 就完事：文案必须能让主人看出是在跟他说话。
  // 用「你/您」、人格称呼或主人昵称都算；一句纯视频泛评会被打回重写。
  const mentionOwner = kind === 'comment' && mentionOwnerOn()
  if (mentionOwner && !OWNER) {
    return { ok: false, reason: '「艾特主人」开着，但设置里没填主人抖音昵称；先去「设置 → 抖音 → 详细设置 → 我的抖音昵称」填好' }
  }
  if (mentionOwner) {
    // 硬门：艾特主人的评论必须先读当前视频上的长期记忆；换视频/超过 5 分钟都要重新读。
    // 普通评论和 kind=reply 不会走这里，所以仍然只用当前视频/评论上下文。
    const memoryFresh = ownerMemoryFor
      && ownerMemoryFor.videoId === lastSnap.id
      && now() - ownerMemoryFor.at <= OWNER_MEMORY_TTL_MS
    if (!memoryFresh) {
      return { ok: false, reason: '发艾特主人的评论前，先调 douyin_owner_memory 读一下长期记忆（query 用当前视频的题眼），再写文案' }
    }
    const addressed = /[你您](?!们)/.test(out.text)
      || out.text.includes(OWNER_ADDRESS)
      || (OWNER && out.text.includes(OWNER))
    if (!addressed) {
      const addrTip = (OWNER_ADDRESS === '你' || OWNER_ADDRESS === '您') ? '用「你」' : `用「你」或「${OWNER_ADDRESS}」`
      return { ok: false, reason: `「艾特主人」模式下，评论要写成对${OWNER_ADDRESS}说的话（${addrTip}），不要写成普通视频评论` }
    }
  }

  let r1
  if (kind === 'comment') {
    // 「艾特主人」开着时，评论不是普通视频评论：固定 @ 主人，文案由提示词约束成
    // 「对主人说的话」。mention 不接受模型另指别人，避免把主人模式带偏。
    const mention = (mentionOwner ? OWNER : String(args.mention || '').trim()).slice(0, 40)
    // 真人发评论常带一个表情：文字 emoji / 面板表情最多一个；带图时不再叠
    const wantEmoji = !sticker && !hasEmoji(out.text) && Math.random() < EXPRESSION.panelEmoji
    r1 = await postComment(p, out.text, { mention, emoji: wantEmoji, image: sticker?.file || '', expectVideoId: lastSnap.id })
    if (r1 && r1.ok && sticker) stickerLibrary.markUsed(sticker.id, 'douyin')
    // 以前评论成功了也不记事件/不计数，收尾统计里 comment 永远是 0，
    // 看起来像「没发出去」，其实发出去了。这里跟 reply/dm 一样记账。
    if (r1 && r1.ok) return emitAndReturn('comment', out.text, { videoId: lastSnap.id, mention })
  } else if (kind === 'reply') {
    // 只回指定的那一条；定位不上就报错，绝不兜底回到评论区第一条（那样会把话回到别人楼下）
    const target = (lastSnap.comments || []).find((c) => c.author && args.replyTo && c.author === args.replyTo.author
      && String(c.text || '').startsWith(String(args.replyTo.text || '').slice(0, 12)))
    if (!target) return { ok: false, reason: '评论区里找不到要回的那条，换个 replyTo 或者别回这条' }
    r1 = await replyToComment(p, { author: target.author, text: target.text }, out.text, { image: sticker?.file || '', expectVideoId: lastSnap.id })
    if (r1 && r1.ok && sticker) stickerLibrary.markUsed(sticker.id, 'douyin')
    if (r1 && r1.ok) return emitAndReturn('reply', out.text, { author: target.author, text: target.text })
  } else if (kind === 'dm') {
    // 视频页私信作者已关闭：值班刷到谁就私信谁，会主动骚扰陌生人。
    // 主动私信只保留「发给主人」这一条路，统一走 douyin_dm_send。
    return { ok: false, reason: '视频页私信作者已关闭；主动私信走 douyin_dm_send（工具会限频），别刷到一个人发一条' }
  } else return { ok: false, reason: `不认识的 kind：${kind}（comment / reply；私信只走 douyin_dm_send）` }

  return { ok: Boolean(r1 && r1.ok), reason: (r1 && r1.reason) || '', kind, text: out.text }

  function emitAndReturn(k, t, target) {
    counts[k] += 1
    emit({ type: 'say', kind: k, text: t, target, videoId: lastSnap.id, videoCaption: lastSnap.caption, author: lastSnap.author })
    return { ok: true, kind: k, text: t, target, counters: { videos, actions: { ...counts } } }
  }
}

/** 写一条第一人称记忆（宿主会在值班结束后导进记忆库）。 */
async function tMemory(args = {}) {
  const content = String(args.content || '').trim()
  if (!content) return { ok: false, reason: '内容是空的' }
  emit({ type: 'memory', content: content.slice(0, 300) })
  return { ok: true }
}

/** 收尾：写总结、落事件，值班会话就该退出了。 */
async function tFinish(args = {}) {
  if (finished) return { ok: true, done: true, reason: '已经收过尾了' }
  finished = true
  const summary = String(args.summary || '').trim()
  emit({ type: 'finish', summary: summary.slice(0, 400), videos, seconds: Math.round((now() - startedAt) / 1000), actions: { ...counts }, aborted: stopped() })
  return { ok: true, done: true, videos, actions: { ...counts } }
}

async function tStatus() {
  const can = ['open:recommend|following|me|search|video|url', 'look']
  const reacts = ['like', 'favorite'].filter(capOn)
  if (reacts.length) can.push(`react:${reacts.join('/')}`)
  if (readCommentsOn()) can.push('read-comments')
  if (visionOn()) can.push('see-current-video')
  const says = ['comment', 'reply', 'dm'].filter(capOn)
  if (says.length) can.push(`say:${says.join('/')}`)
  if (capOn('dm')) can.push('dm-send')
  if (forwardOn()) can.push('share-to-owner')
  if (mentionOwnerOn() || forwardOn()) can.push('memory:read-owner')
  can.push('self:read', 'self:update', 'memory', 'finish')
  if (ownerLikesOn() && OWNER_PROFILE) can.push('owner-likes:read')
  return {
    ok: true, mode: 'watch', videos, elapsedSec: elapsedSec(),
    actions: { ...counts }, stopped: stopped(), navigated,
    shareLeft: forwardOn() ? Math.max(0, 1 - counts.forward) : 0,
    // 这些不是任务清单，是你现在被允许做的事；没列出来的就是设置里关掉了
    can,
  }
}

/** 去抖音的任何地方：推荐、关注、自己的主页、搜索、指定视频或链接。 */
async function tOpen(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  const page = await ensurePage()
  const kind = String(args.page || 'recommend')
  const r = await openPage(page, kind, args)
  if (!r.ok) return { ok: false, reason: r.reason || '没打开', page: kind }
  let snap = null
  if (r.page === 'recommend' || r.page === 'video') snap = await readSnapshot(page)
  // 页面已经换了：旧的 lastSnap 立即作废；新页面上读到视频才重新绑定。
  lastSnap = snap ? { ...snap, comments: [] } : null
  return {
    ok: true,
    page: r.page || kind,
    url: r.url || '',
    video: snap ? { id: snap.id, caption: String(snap.caption || '').slice(0, 200), author: snap.author || '' } : null,
    hint: '到了。想干嘛就干嘛，不用按顺序来。',
    counters: { videos, elapsedSec: elapsedSec(), actions: { ...counts } },
  }
}

/** 看自己的账号资料。 */
async function tSelf() {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  const page = await ensurePage()
  const r = await readSelf(page)
  if (!r.ok) return r
  emit({ type: 'self', nickname: r.nickname, douyinId: r.douyinId, signature: r.signature })
  return { ok: true, ...r, counters: { elapsedSec: elapsedSec() } }
}

/**
 * 只读主人主页的喜欢列表。
 * 开着：只把「新增」视频的 id/标题/封面截图交给模型理解；锁着：只记状态，不绕过。
 * 10 分钟内重复调用直接返回缓存，避免模型好奇起来反复开页面。
 */
async function tOwnerLikes() {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!ownerLikesOn()) return { ok: false, disabled: true, reason: '「偷窥喜欢列表」没在设置里打开，这次不看' }
  if (!OWNER_PROFILE) return { ok: false, reason: '还没配主人主页链接（设置 → 抖音 → 主人主页）' }
  const st = readOwnerLikesState()
  if (st.lastScanAt && now() - st.lastScanAt < OWNER_LIKES_COOLDOWN_MS) {
    return {
      ok: true, cached: true, visibility: st.visibility || 'unknown',
      newItems: [], totalVisible: st.totalVisible,
      hint: st.visibility === 'locked'
        ? '刚看过，主人喜欢列表还是锁着的；不要每轮重复记，除非状态变了。'
        : '刚看过，先别反复开主页；有新增再记。',
    }
  }
  const p = await ensurePage()
  const r = await readOwnerLikes(p, OWNER_PROFILE, { maxItems: 20 })
  if (!r.ok) return { ok: false, reason: r.reason || '没读到主人喜欢列表' }
  // 页面已经开到主人主页，旧视频的 lastSnap 立即作废；要评论/回复必须重新 douyin_look。
  lastSnap = null

  const prev = st.visibility
  let newItems = []
  if (r.visibility === 'open') {
    const seen = new Set(st.seen)
    newItems = (r.items || []).filter((x) => x && x.id && !seen.has(x.id))
    st.seen = [...new Set([...st.seen, ...(r.items || []).map((x) => x.id).filter(Boolean)])].slice(-200)
  }
  st.visibility = r.visibility
  st.lastScanAt = now()
  st.totalVisible = Number(r.totalVisible) || 0
  saveOwnerLikesState(st)

  if (r.visibility === 'open' && newItems.length) {
    emit({
      type: 'owner-likes', visibility: 'open',
      newItems: newItems.map((x) => ({ id: x.id, title: x.title || '', url: x.url || '' })),
      totalVisible: r.totalVisible || 0,
    })
  } else if (r.visibility === 'locked' && prev !== 'locked') {
    emit({ type: 'owner-likes', visibility: 'locked', newItems: [], totalVisible: 0 })
  }

  const images = r.shot && r.shot.ok && r.shot.data ? [{ data: r.shot.data, mimeType: r.shot.mimeType || 'image/jpeg' }] : []
  return {
    ok: true,
    cached: false,
    visibility: r.visibility,
    newItems: newItems.map((x) => ({ id: x.id, title: x.title || '', url: x.url || '' })),
    totalVisible: r.totalVisible || 0,
    hint: r.visibility === 'locked'
      ? '主人喜欢列表是锁着的；只把「锁着」这个状态记下来，不要猜里面有什么。'
      : r.visibility === 'open'
        ? (newItems.length ? '这些是新增的喜欢；先看你收到的列表面截图和标题，再用 douyin_memory 记一条「主人最近喜欢什么」的第一人称记忆，然后再做别的。' : '没有新增，不用重复记。')
        : '当前可视区域没读到喜欢卡片；可能没加载完，不要当成「锁着」。',
    ...(images.length ? { __images: images } : {}),
  }
}

/** 改自己的昵称/签名。改不了就如实说，不假装。 */
async function tUpdateSelf(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  const page = await ensurePage()
  const r = await updateSelf(page, { nickname: String(args.nickname || '').trim(), signature: String(args.signature || '').trim() })
  if (r.ok) emit({ type: 'profile', nickname: args.nickname || '', signature: args.signature || '' })
  return { ...r, counters: { elapsedSec: elapsedSec() } }
}

/** 发作品功能已整体关闭：这里不再提供发布工具，等重新设计后再接。 */

/**
 * 主动私信前的上下文：读这段会话，按目标身份返回记忆。
 * 只读：主人和 memoryAllow 名单内返回 1-2 条非 anchor 记忆；其他人只返回线程。
 * 调用后需要再调 douyin_dm_send；不要把这里的记忆原样念出来。
 */
async function tDmContext(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  const rawTo = String(args.to || '').trim()
  const target = (!rawTo || rawTo === 'owner' || rawTo === '主人') ? OWNER : rawTo
  if (!target) return { ok: false, reason: '没填私信对象；也没有配主人昵称' }
  const access = resolveDmAccess(target, { ownerName: OWNER, memoryAllow: MEMORY_ALLOW })
  const targetName = access.name
  if (!targetName) return { ok: false, reason: '私信对象昵称是空的' }
  const page = await ensurePage()
  let thread = ''
  try {
    const r = await peekThread(page, targetName)
    if (r && r.ok && r.text) {
      const safe = sanitizeInput(r.text, { maxChars: 800 })
      if (safe.quarantined) log(`主动私信上下文：会话含可疑指令，已忽略（${target}）`)
      else thread = safe.text.slice(-800).trim()
    }
    // 上下文工具会打开私信面板；当前视频已经不在眼前，旧的 lastSnap 必须作废
    lastSnap = null
    await closeInbox(page)
  } catch (err) {
    log(`主动私信上下文：读会话失败（${target}）：${err.message}`)
    try { await closeInbox(page) } catch { /* 忽略 */ }
  }

  let memoryText = ''
  if (access.memoryAllowed) {
    const memory = getMemoryService()
    if (memory && typeof memory.recall === 'function') {
      const query = String(args.query || '').trim() || thread.slice(-300) || target
      try {
        const hits = memory.recall(query, { limit: 2, reinforce: false })
          .filter((h) => h && h.tier !== 'anchor' && typeof h.content === 'string' && h.content.trim())
          .slice(0, 2)
        if (hits.length) {
          memoryText = [
            '你可能记得的事（只在和对方这句话直接相关时用；不要提主人的私事，不要提其他人，也不要把这些记忆说成对方的经历）：',
            ...hits.map((h) => `- ${h.content.trim().replace(/\s+/g, ' ').slice(0, 100)}`),
          ].join('\n')
        }
      } catch (err) {
        log(`主动私信上下文：记忆召回失败（${target}）：${err.message}`)
      }
    }
  }

  return {
    ok: true,
    target: access.name,
    isOwner: access.isOwner,
    memoryAllowed: access.memoryAllowed,
    thread,
    memory: memoryText,
    hint: access.memoryAllowed
      ? '可以用下面的记忆，但只在直接相关时提一句；不要原样复述，也不要提主人的私事。'
      : '这个人不在记忆名单里：只根据下面的当前对话回复，不要提任何长期记忆、旧事或主人私事。',
    counters: { elapsedSec: elapsedSec() },
  }
}

/**
 * 主动私信：值班标签页里偶尔找人说一句，不跟刷流绑定。
 * to 省略 / owner / 主人：发给主人；也可以填视频作者名字或收件箱里的会话名。
 * 硬频控：两次之间至少 10 分钟、每小时最多 2 条；超过就直接拒发。
 */
async function tDmSend(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!capOn('dm')) return { ok: false, disabled: true, reason: '「私信」没在设置里打开，这次不发' }
  const rawTo = String(args.to || '').trim()
  const target = (!rawTo || rawTo === 'owner' || rawTo === '主人') ? OWNER : rawTo
  if (!target) return { ok: false, reason: '没填私信对象；也没有配主人昵称' }
  if (!OWNER && (!rawTo || rawTo === 'owner' || rawTo === '主人')) {
    return { ok: false, reason: '没配主人昵称；要发给主人就先填昵称，或者直接填对方名字' }
  }
  const access = resolveDmAccess(target, { ownerName: OWNER, memoryAllow: MEMORY_ALLOW })
  const targetName = access.name
  if (!targetName) return { ok: false, reason: '私信对象昵称是空的' }
  const text = String(args.text || '').trim()
  if (!text) return { ok: false, reason: '要说的话是空的' }
  const checked = checkOutbound(text, { maxLen: 300 })
  if (!checked.ok) return { ok: false, reason: `这句话不能发出去：${checked.reason}` }
  const out = { ...checked, text: humanize(checked.text, { strength: HUMANIZE }).text }
  if (!out.text) return { ok: false, reason: '这句话改完变空了，换个说法' }

  const gate = dmGate(targetName)
  if (!gate.ok) return gate

  const page = await ensurePage()
  const parts = splitDmText(out.text).map((p) => applyFlavor(p, { emojiChance: EXPRESSION.textEmoji }).text)
  const sent = []
  const toAuthor = Boolean(lastSnap && lastSnap.author && targetName === lastSnap.author)
  for (let i = 0; i < parts.length; i += 1) {
    const r = toAuthor
      ? await sendDm(page, lastSnap.author, parts[i])
      : await replyTo(page, targetName, parts[i])
    if (!r || !r.ok) {
      if (!sent.length) {
        if (!toAuthor) { try { await closeInbox(page) } catch { /* 忽略 */ } }
        return { ok: false, reason: (r && r.reason) || `私信没发出去（${targetName}）` }
      }
      break
    }
    sent.push(parts[i])
    if (i < parts.length - 1) await sleep(1100 + Math.round(Math.random() * 900))
  }
  if (!toAuthor) { try { await closeInbox(page) } catch { /* 忽略 */ } }
  if (!sent.length) return { ok: false, reason: `私信没发出去（${targetName}）` }
  counts.dm += 1
  recordDm(targetName)
  emit({ type: 'say', kind: 'dm', text: sent.join(' / '), target: { name: targetName, active: true }, parts: sent.length })
  return { ok: true, text: sent.join(' / '), target: targetName, parts: sent.length, counters: { elapsedSec: elapsedSec(), actions: { ...counts } } }
}

/**
 * 分享当前视频给主人。
 * 目标固定主人，不接受 to；只看 lastSnap 对应的视频，页面翻走就拒绝。
 * 卡片先发；有文字时先读 owner memory，再用主人私信补一句，不能在一个面板里原子完成。
 */
async function tShareToOwner(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!forwardOn()) return { ok: false, disabled: true, reason: '「分享给主人」没在设置里打开，这次不分享' }
  if (!OWNER) return { ok: false, reason: '没配主人昵称，不能分享；先在设置里填「我的抖音昵称」' }
  if (!lastSnap) return { ok: false, reason: '还没有正在看的视频，先 douyin_look' }
  if (counts.forward >= 1) return { ok: false, limitReached: true, reason: '这一轮已经分享过一条了；每次值班最多一条，不再分享' }

  const videoId = String(args.videoId || '').trim()
  if (!videoId) return { ok: false, reason: '要传当前 videoId（douyin_look 返回的 video.id）' }
  if (videoId !== lastSnap.id) {
    return { ok: false, reason: '传的 videoId 不是当前这条视频；先重新 douyin_look，别把上一条分享出去' }
  }

  const text = String(args.text || '').trim()
  if (text) {
    if (!capOn('dm')) return { ok: false, disabled: true, reason: '想附一句话就要同时打开「私信（主动）」；只发分享卡片不需要' }
    const fresh = ownerMemoryFor
      && ownerMemoryFor.videoId === videoId
      && now() - ownerMemoryFor.at <= OWNER_MEMORY_TTL_MS
    if (!fresh) {
      return { ok: false, reason: '带文字分享前必须先调 douyin_owner_memory 读当前视频相关的 1-2 条记忆；没读就不发文字' }
    }
  }

  const p = await ensurePage()
  const still = await ensureStillOnSnap(p)
  if (!still.ok) return still

  let out = null
  if (text) {
    const checked = checkOutbound(text, { maxLen: 300 })
    if (!checked.ok) return { ok: false, reason: `这句话不能发出去：${checked.reason}` }
    out = { ...checked, text: humanize(checked.text, { strength: HUMANIZE }).text }
    if (!out.text) return { ok: false, reason: '这句话改完变空了，换个说法' }
  }

  const card = await forwardToOwner(p, OWNER)
  if (!card || !card.ok) {
    return { ok: false, cardSent: false, textSent: false, reason: (card && card.reason) || '分享卡片没发出去' }
  }
  counts.forward += 1

  if (!out) {
    emit({ type: 'say', kind: 'share', text: '', target: { name: OWNER, isOwner: true, active: true }, videoId, videoCaption: lastSnap.caption, cardSent: true, textSent: false })
    return {
      ok: true, cardSent: true, textSent: false, target: OWNER, videoId,
      hint: '分享卡片已经发给主人。没有附言；这一轮不要再分享同一条。',
      counters: { elapsedSec: elapsedSec(), actions: { ...counts } },
    }
  }

  let textResult = { ok: false, reason: '私信没发出去' }
  try {
    textResult = await replyTo(p, OWNER, out.text)
    if (textResult && textResult.ok) {
      counts.dm += 1
    }
  } catch (err) {
    textResult = { ok: false, reason: err.message }
  } finally {
    try { await closeInbox(p) } catch { /* 忽略 */ }
  }
  const textSent = Boolean(textResult && textResult.ok)
  emit({
    type: 'say', kind: 'share', text: out.text, target: { name: OWNER, isOwner: true, active: true },
    videoId, videoCaption: lastSnap.caption, cardSent: true, textSent, ok: textSent,
    partial: !textSent, reason: textSent ? '' : (textResult && textResult.reason) || '',
  })
  return {
    ok: textSent,
    partial: !textSent,
    cardSent: true,
    textSent,
    target: OWNER,
    videoId,
    text: out.text,
    reason: textSent ? '' : `分享卡片已经发出去了，但补的私信没发出去：${(textResult && textResult.reason) || '未知原因'}`,
    hint: textSent
      ? '分享卡片和一句话都发给主人了。这一轮不要再分享同一条。'
      : '分享卡片已经发出去了，但补的私信没发出去；不要再说成完整成功，也不要重复分享卡片。',
    counters: { elapsedSec: elapsedSec(), actions: { ...counts } },
  }
}

/** 按当前对话找表情包：先看候选含义卡，再决定发不发。返回 top 5 供模型挑，不替它随机选。 */
async function tFindSticker(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!stickersOn()) return { ok: false, disabled: true, reason: '「允许发表情包」在设置里关着' }
  const q = String(args.q || args.query || '').trim()
  const intent = String(args.intent || (q ? inferIntent(q) : '')).trim()
  const hits = stickerLibrary.search({ q, intent, limit: 5, includeTagOnly: true })
  return {
    ok: true,
    available: hits.length > 0,
    totalInLibrary: stickerLibrary.stats().total,
    items: hits.map((h) => ({
      id: h.id,
      caption: h.caption || '',
      intents: h.intents || [],
      emotion: h.emotion || [],
      tags: h.tags || [],
      score: h.score,
      tagOnly: h.tagOnly,
    })),
    hint: hits.length
      ? '挑一张 caption 和当前对话真的对得上的；tagOnly=true 的图只是按分类粗略匹配，别拿它硬答。'
      : '没有合适的表情包，这次用文字回复。',
  }
}

/** 发一张表情包：和主动私信共用频控；必须按 id 或语义检索选，不随机抽。 */
async function tSendSticker(args = {}) {
  if (stopped()) return { ok: false, stopRequested: true, done: true }
  if (!capOn('dm')) return { ok: false, disabled: true, reason: '「私信」没在设置里打开，这次不发' }
  if (!stickersOn()) return { ok: false, disabled: true, reason: '「允许发表情包」在设置里关着，这次不发' }
  const rawName = String(args.name || '').trim()
  const name = (!rawName || rawName === 'owner' || rawName === '主人') ? OWNER : rawName
  if (!name) return { ok: false, reason: '要发给谁（name）；没填 name 时也没有配主人昵称' }

  let chosen
  if (args.file) {
    const file = resolveStickerFile(args.file)
    if (!file) return { ok: false, reason: '这个图片路径不在允许的表情包目录里' }
    chosen = { ok: true, id: '', file, item: null }
  } else {
    chosen = stickerForArgs({ ...args, stickerId: args.id || args.stickerId, stickerQuery: args.query || args.stickerQuery })
  }
  if (!chosen.ok) return chosen
  const file = chosen.file
  if (!file) return { ok: false, reason: '表情包里没有可发的图（data/stickers）' }

  const gate = dmGate(name)
  if (!gate.ok) return gate

  const page = await ensurePage()
  const r = await sendStickerTo(page, name, file)
  if (r.ok) {
    counts.dm = (counts.dm || 0) + 1
    recordDm(name)
    if (chosen.id) stickerLibrary.markUsed(chosen.id, 'douyin')
    emit({ type: 'say', kind: 'dm-sticker', text: (chosen.item && chosen.item.caption) || file.split(/[\\/]/).pop() || '', target: { name } })
  }
  return { ...r, file, id: chosen.id || '', caption: (chosen.item && chosen.item.caption) || '', counters: { elapsedSec: elapsedSec() } }
}

const TOOLS = [
  { name: 'douyin_status', description: '看这一轮待了多久、动过什么、你被允许做什么。想先知道处境时调它。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'douyin_open', description: '去抖音的任何地方：recommend(推荐流) / following(关注) / me(你自己的主页) / search(给 q) / video(给 id) / url(给抖音链接)。不是只能一条条刷，想去哪就去哪。', inputSchema: { type: 'object', properties: { page: { type: 'string', enum: ['recommend', 'following', 'me', 'search', 'video', 'url'] }, q: { type: 'string' }, id: { type: 'string' }, url: { type: 'string' } }, required: ['page'], additionalProperties: false } },
  { name: 'douyin_look', description: '读当前这条视频（文案、作者、互动数、前几条评论；设置里开了画面理解时，还会附上当前视频的截图）。读到一条新的会停在它上面，等你决定点赞/评论；当前这条已经看过时，再调一次才会翻下一条。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'douyin_react', description: '对当前这条做轻动作：点赞/收藏。按你的心情来，不是每条都做；传 {like:true, videoId} 这种（videoId 用 douyin_look 返回的 video.id）。', inputSchema: { type: 'object', properties: { like: { type: 'boolean' }, favorite: { type: 'boolean' }, videoId: { type: 'string', description: '当前视频 id，douyin_look 返回的 video.id' } }, additionalProperties: false } },
  { name: 'douyin_owner_memory', description: '艾特主人评论或分享给主人前读长期记忆（只读）。「艾特主人」或「分享给主人」打开时、当前视频上可用；普通评论和回评论不要调用。query 可选，用当前视频文案/评论区里的题眼；不传就自动用当前视频检索。返回 1-2 条相关记忆；没命中就按视频写，不要编旧事。公开评论不要把记忆原文、主人私事或隐私写出去；私聊给主人也不要原样复述隐私细节。', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '可选：想回忆的话题，通常用当前视频的题眼' } }, additionalProperties: false } },
  { name: 'douyin_say', description: '说话：评论(kind=comment；开了「艾特主人」会自动 @ 主人，mention 不用传，文案要写成对主人说的话；发之前必须先调 douyin_owner_memory 读 1-2 条长期记忆。没开时可带 mention 传一个名字来 @ 他，普通评论不读记忆)/回评论(kind=reply，给 replyTo:{author,text}；不要读、不要提长期记忆)。评论/回复可以带一张库里的表情包（先 douyin_find_sticker 找，传 stickerId；或者传 stickerQuery），但不能和文字 emoji 同时上，也不要每条都带。私信不在视频页发；主动私信只用 douyin_dm_send，可发给主人或想找的人，但工具会限频。评论/回复必须带 videoId（douyin_look 返回的 video.id），服务端会核对，防止把上一条的文案发到这条下面。文字要像人话，1-2 句；不确定的事不编。', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['comment', 'reply'] }, text: { type: 'string' }, mention: { type: 'string', description: '可选：要 @ 的人的名字（只用于 kind=comment；开了「艾特主人」时不用传，传了也会被主人覆盖）' }, replyTo: { type: 'object', properties: { author: { type: 'string' }, text: { type: 'string' } } }, videoId: { type: 'string', description: '当前视频 id，douyin_look 返回的 video.id；评论/回复必填' }, stickerId: { type: 'string', description: '可选：douyin_find_sticker 返回的 id；和 stickerQuery 二选一' }, stickerQuery: { type: 'string', description: '可选：想表达的意思/对白，让服务端按语义找一张；匹配不够会拒发' } }, required: ['kind', 'text'], additionalProperties: false } },
  { name: 'douyin_share_to_owner', description: '把当前这条视频作为分享卡片发给主人（第一版只给主人，没有 to 参数）。只有看完文案/评论/画面、觉得有意思才用；每次值班最多一条。需要设置里打开「分享给主人」。可以只发卡片；想附一句话就传 text，但必须先调 douyin_owner_memory 读当前视频相关的 1-2 条记忆（5 分钟内有效），并且同时打开「私信（主动）」。工具先发卡片，再用主人私信补这句话；如果卡片成功、文字失败，会返回 partial=true，不要报完整成功。必须传 douyin_look 返回的 videoId，页面翻走就拒绝；不要随机选联系人。', inputSchema: { type: 'object', properties: { videoId: { type: 'string', description: '当前视频 id，douyin_look 返回的 video.id' }, text: { type: 'string', description: '可选：想对主人说的一句话；带 text 前先读 douyin_owner_memory，且需要打开私信' } }, required: ['videoId'], additionalProperties: false } },
  { name: 'douyin_self', description: '读你自己的账号资料：昵称、抖音号、签名、关注/粉丝/获赞。想看看自己现在是什么样时用。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'douyin_owner_likes', description: '看主人抖音主页的喜欢列表（只读）。开着且新增：返回新增视频的 id/标题和列表面截图，理解后写进记忆；锁着：返回 locked，只记「锁着」，不绕过、不猜。只在主人相关的话题里用，不在评论/私信里提。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'douyin_update_self', description: '改你自己的昵称或签名（头像这一步还没做）。网页版没有编辑入口时它会如实说没改成，不假装。', inputSchema: { type: 'object', properties: { nickname: { type: 'string' }, signature: { type: 'string' } }, additionalProperties: false } },
  { name: 'douyin_find_sticker', description: '按当前对话找表情包（只读，不发送）。返回最多 5 张候选，带 caption/意图/情绪/匹配分和 tagOnly；挑和上下文真的对得上的，不确定就回文字。不要凭图片分类猜。', inputSchema: { type: 'object', properties: { q: { type: 'string', description: '对方刚说的话或当前视频/评论的题眼' }, intent: { type: 'string', description: '可选：greeting/thanks/agree/laugh/comfort 等；不传自动判断' } }, additionalProperties: false } },
  { name: 'douyin_send_sticker', description: '私信发一张表情包。name 省略或 owner/主人=发给主人，也可以填收件箱里的会话名；和主动私信共用频控，不能一条接一条。必须先用 douyin_find_sticker 找，再传 id（或 query）；不随机抽图，匹配不上就改用文字。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string', description: 'douyin_find_sticker 返回的 id' }, query: { type: 'string', description: '没有 id 时按这句话的意思找一张' }, file: { type: 'string', description: '兼容旧调用：明确指定 data/stickers 或 data/images 里的文件；新调用优先用 id' } }, required: ['name'], additionalProperties: false } },
  { name: 'douyin_dm_context', description: '主动私信前先读上下文：返回和这个人的最近会话；主人和「记忆名单」内还会返回 1-2 条相关长期记忆，名单外只返回当前对话，不返回记忆。query 可选，用你打算聊的话题；不传就按最近对话检索。先调它，再写 douyin_dm_send 的 text。', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '可选：owner/主人，或对方名字/收件箱会话名' }, query: { type: 'string', description: '可选：你想回忆的话题' } }, additionalProperties: false } },
  { name: 'douyin_dm_send', description: '主动发私信：to 省略 / owner / 主人=发给主人，也可以填视频作者名字或收件箱里的会话名。发之前建议先调 douyin_dm_context；主人/记忆名单内可以自然带上相关记忆，名单外只能用当前对话。工具硬限频：两次至少隔 10 分钟、每小时最多 2 条；不是刷一个人发一条。', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '可选：owner/主人，或对方名字/收件箱会话名' }, text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'douyin_memory', description: '写一条第一人称记忆（今天看到的、自己做的、印象深的事）。挑真正值得记的写，一条 1-3 句。', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } },
  { name: 'douyin_finish', description: '收尾：给一句总结，然后这一轮结束。你不想待了、或者想回去跟主人说话的时候调它。', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, additionalProperties: false } },
]

const HANDLERS = {
  douyin_status: tStatus,
  douyin_open: tOpen,
  douyin_look: tLook,
  douyin_react: tReact,
  douyin_owner_memory: tOwnerMemory,
  douyin_share_to_owner: tShareToOwner,
  douyin_say: tSay,
  douyin_self: tSelf,
  douyin_owner_likes: tOwnerLikes,
  douyin_update_self: tUpdateSelf,
  douyin_dm_context: tDmContext,
  douyin_dm_send: tDmSend,
  douyin_find_sticker: tFindSticker,
  douyin_send_sticker: tSendSticker,
  douyin_memory: tMemory,
  douyin_finish: tFinish,
}

function rpcWrite(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
async function onMessage(msg) {
  if (msg.method === 'initialize') {
    rpcWrite({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'douyin-duty', version: '0.1.0' } } })
    return
  }
  if (msg.method === 'tools/list') {
    rpcWrite({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    const args = msg.params?.arguments || {}
    const fn = HANDLERS[name]
    let result
    // 页面锁：工具执行期间不做私信轮询，避免「正在发送」时被点开消息面板打断
    toolBusy = true
    try {
      if (!fn) throw new Error(`没有这个工具：${name}`)
      result = await fn(args)
    } catch (err) {
      log(`${name} 出错：${err.message}`)
      result = { ok: false, error: err.message }
    } finally {
      toolBusy = false
    }
    // 轮询到的新互动挂在下一次工具结果里带给模型：它这一轮就能顺手回掉
    const cmt = drainPendingComment()
    if (cmt.length) result = { ...result, pendingComment: cmt, commentHint: '互动消息里有新动静（有人回你评论、或 @ 你）。回之前先 douyin_open 回到那条视频、douyin_look 读评论区，再用 douyin_say kind=reply 并带上这条的 videoId 回。' }
    // 图片不能塞进 JSON 文本：按 MCP ImageContent 单独放进 content。
    // 模型看到的是「当前这条视频的帧」；text 里同时保留 video.id，方便它把动作绑对。
    const images = result && Array.isArray(result.__images) ? result.__images : []
    if (result && typeof result === 'object' && '__images' in result) delete result.__images
    const content = [{ type: 'text', text: JSON.stringify(result) }]
    for (const img of images) {
      if (!img || !img.data) continue
      content.push({ type: 'image', data: img.data, mimeType: img.mimeType || 'image/jpeg' })
    }
    rpcWrite({ jsonrpc: '2.0', id: msg.id, result: { content, isError: Boolean(result && result.ok === false) } })
    return
  }
  if (msg.id !== undefined) rpcWrite({ jsonrpc: '2.0', id: msg.id, result: {} })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try { onMessage(JSON.parse(line)) } catch (e) { log(`坏消息：${e.message}`) }
  }
})
/** 只关值班自己的标签页；共享浏览器归插件时绝不关整个进程。 */
async function cleanupBrowser() {
  const own = page
  page = null
  pageStarted = false
  if (own) {
    try { own.close() } catch { /* 忽略 */ }
    try { await closePage(own) } catch { /* 忽略 */ }
  }
  const hub = readHub()
  const shared = Boolean(hub && hub.owner === 'plugin')
  if (handle?.child && !shared && handle.httpBase) {
    await sleep(500) // 等 /json/close 真正把标签页摘掉，再数剩下的页
    const left = await pageCount(handle.httpBase)
    if (!left) {
      try { closeBrowser(handle) } catch { /* 忽略 */ }
      removeHub()
    }
  }
  if (!handle?.child) {
    try { rmSync(join(HOME, 'browser.pid'), { force: true }) } catch { /* 忽略 */ }
  }
}

process.stdin.on('end', () => {
  try { if (inboxTimer) clearInterval(inboxTimer); if (tabTimer) clearInterval(tabTimer) } catch { /* 忽略 */ }
  try { if (handle && !finished) emit({ type: 'finish', summary: '（值班会话退出了，没走到收尾）', videos, seconds: Math.round((now() - startedAt) / 1000), actions: { ...counts }, aborted: true }) } catch { /* 忽略 */ }
  cleanupBrowser().finally(() => { /* stdio 已结束，进程会自己退 */ })
})
process.on('SIGTERM', () => {
  try { if (inboxTimer) clearInterval(inboxTimer); if (tabTimer) clearInterval(tabTimer) } catch { /* 忽略 */ }
  cleanupBrowser().finally(() => process.exit(0))
})
process.on('exit', () => {
  try { if (!handle?.child) writeFileSync(join(HOME, 'browser.pid'), '') } catch { /* 忽略 */ }
  try { if (tabTimer) clearInterval(tabTimer) } catch { /* 忽略 */ }
  try { if (memoryService && typeof memoryService.close === 'function') memoryService.close() } catch { /* 忽略 */ }
})
startTabWatch()
log(`duty-server 起来了：固定围观（窗口可见，不限时长、不限条数）`)
