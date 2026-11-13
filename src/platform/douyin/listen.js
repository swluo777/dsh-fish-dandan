// ============================================================
// 私信监听（照 dsh-bili-whale 的做法）：
//   - 只轮询「收件箱列表」，回复前再由监听标签页读一次上下文
//   - 几秒一轮起步，失败退避到 30 秒；有新消息立刻回到最短间隔
//   - 监听独占待回队列；值班只主动发，不读这个队列
//   - 队列与已读游标存 data/state/douyin-inbox.json，重启不丢
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'
import { fromRoot } from '../../utils/paths.js'
import { readInbox } from './inbox.js'
import { resolveDmAccess } from './memory-access.js'

const DEFAULT_STATE = { seen: [], queue: [], lastPollAt: 0, backoff: 0, queueMigratedAt: 0, mediaPulse: {} }
// 列表里的媒体只有「分享[视频]/[表情]」这种文字预览，同一个人连发两个不同视频时
// itemKey 完全一样。靠「未读」把它放进来一次，再用这个冷却时间防止同一轮反复入队。
const MEDIA_UNREAD_REPEAT_MS = 10 * 60_000

// 抖音在「你还没关注/对方还没回复」时会插一条平台提示。它不是对方发来的话，
// 不能当成私信正文；否则监听会主动给一堆陌生人回「主人」话术。
const PLATFORM_NOTICE_RE = /对方回复或关注你之前|只能发送一条文字消息|请礼貌发言|自觉遵守《抖音自律公约》/
const PLATFORM_ACCOUNT_RE = /^(抖音小助手|抖音通知|系统消息|消息助手|官方小助手)$/

export function isPlatformNotice(item = {}) {
  const name = String(item.name || '').trim()
  const last = String(item.last || '').trim()
  if (!last) return true
  if (PLATFORM_ACCOUNT_RE.test(name)) return true
  return PLATFORM_NOTICE_RE.test(last)
}

function statePath() {
  return fromRoot('data/state/douyin-inbox.json')
}

export function loadInboxState() {
  const p = statePath()
  const raw = readJsonSafe(p, null, () => {})
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE }
  const queue = Array.isArray(raw.queue) ? raw.queue.slice(-100) : []
  return {
    seen: Array.isArray(raw.seen) ? raw.seen.slice(-500) : [],
    // 旧队列里可能还有 pending/approved 的历史条目；启动时的 migrateLegacyQueue
    // 会把旧 approved 收起来，只处理升级后新到的私信，避免把几天前的消息再发一遍。
    queue,
    lastPollAt: Number(raw.lastPollAt) || 0,
    backoff: Math.max(0, Number(raw.backoff) || 0),
    queueMigratedAt: Number(raw.queueMigratedAt) || 0,
    mediaPulse: raw.mediaPulse && typeof raw.mediaPulse === 'object' && !Array.isArray(raw.mediaPulse) ? raw.mediaPulse : {},
  }
}

export function saveInboxState(state) {
  try {
    const p = statePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    writeJsonAtomic(p, state)
  } catch { /* 读写失败不影响主流程 */ }
}

function itemKey(item) {
  // 只用「谁 + 最后一条内容」当键：列表里的时间是相对时间（刚刚→55分钟前），
  // 带上时间会导致同一条消息每轮都被当成新的，队列里堆一堆重复的。
  // 纯媒体预览的文字可能一样，带上预览图地址区分不同的表情包/视频封面。
  const name = String(item.name || '').trim()
  const last = String(item.last || '').trim()
  const media = String(item.mediaKey || '').trim()
  return media ? `${name}|${last}|${media}` : `${name}|${last}`
}

/**
 * 轮询一次收件箱。
 * 现在所有新私信都自动回，不再有排队/审批；记忆权限只由 memoryAllow 决定。
 * @param {{ page, state, ownerName, memoryAllow, now }} input
 * @returns {{ ok, fresh: array, queued: array, reason?: string }}
 */
export async function pollInboxOnce({ page, state, ownerName = '', memoryAllow = [], isEcho = () => false, now = Date.now(), read = readInbox }) {
  const inbox = await read(page).catch((err) => ({ ok: false, reason: err.message }))
  if (!inbox || !inbox.ok) {
    state.backoff = Math.min(10 * 60_000, Math.max(60_000, (state.backoff || 0) * 2 || 60_000))
    state.lastPollAt = now
    return { ok: false, reason: inbox ? inbox.reason : '读取失败', fresh: [], queued: [] }
  }
  const seen = new Set(state.seen || [])
  const mediaPulse = state.mediaPulse && typeof state.mediaPulse === 'object' && !Array.isArray(state.mediaPulse)
    ? state.mediaPulse
    : (state.mediaPulse = {})
  const fresh = []
  for (const item of inbox.items) {
    const key = itemKey(item)
    const name = String(item.name || '').trim()
    const mediaUnread = item.mediaHint === true && item.unread === true
    // 线程打开后 unread 会变回 false；清掉冷却，下一次的新媒体才能重新进来
    if (item.unread === false && name) delete mediaPulse[name]
    const seenAlready = seen.has(key)
    const lastPulse = Number(mediaPulse[name]) || 0
    const canRepeat = mediaUnread && (lastPulse === 0 || now - lastPulse >= MEDIA_UNREAD_REPEAT_MS)
    if (seenAlready && !canRepeat) continue
    if (!seenAlready) seen.add(key)
    // 平台提示/空预览不是对方发来的消息，只记 seen，不入队、不回复
    if (isPlatformNotice(item)) continue
    // 自己刚发出去的话会变成会话列表的「最后一条」；当成新消息会自己回自己
    if (isEcho(item.name, item.last)) continue
    if (mediaUnread && name) mediaPulse[name] = now
    fresh.push({ ...item, key, at: now })
  }
  // 第一次轮询只建立游标，不把历史消息当成新消息
  const firstRun = (state.seen || []).length === 0
  state.seen = [...seen].slice(-500)
  state.lastPollAt = now
  if (firstRun) {
    return { ok: true, fresh: [], queued: [], firstRun: true }
  }
  // 所有新消息都自动回：主人和 memoryAllow 名单内的人可以召回长期记忆，
  // 其他陌生人只带当前对话上下文，不碰记忆。
  const queued = []
  for (const item of fresh) {
    if (!item.last) continue
    const access = resolveDmAccess(item.name, { ownerName, memoryAllow })
    // 同一个人只保留最新一条待回：旧消息先标成被取代，避免“先回老的、新的等下一轮”
    for (const q of state.queue || []) {
      if (q && q.name === item.name && (q.status === 'approved' || q.status === 'pending')) q.status = 'superseded'
    }
    const id = `dm-${now}-${Math.random().toString(36).slice(2, 8)}`
    state.queue.push({
      id, name: item.name, last: item.last.slice(0, 200), time: item.time || '',
      at: now, status: 'approved', isOwner: access.isOwner,
      memoryAllowed: access.memoryAllowed, auto: true,
    })
    queued.push(id)
  }
  state.queue = state.queue.slice(-100)
  // 成功就清零退避：监听要几秒一轮，不能因为「这轮没新消息」就自己慢下来
  state.backoff = 0
  return { ok: true, fresh: fresh.map((x) => ({ name: x.name, last: x.last })), queued }
}

/** 把队列里某条标记为已批准 / 已忽略。 */
export function markQueued(state, id, status) {
  const hit = (state.queue || []).find((q) => q.id === id)
  if (!hit) return false
  hit.status = status
  hit.decidedAt = Date.now()
  return true
}

/** 等下一次轮询用多久（毫秒）。监听要「实时」：几秒一轮，失败也别退太久。 */
export function nextPollDelay(state, intervalSec = 3) {
  const base = Math.max(3, Number(intervalSec) || 3) * 1000
  return Math.min(30_000, Math.max(base, state.backoff || base))
}
