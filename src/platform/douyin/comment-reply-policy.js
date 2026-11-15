// ============================================================
// 回评论的「该不该回」与限频账本
// ------------------------------------------------------------
// 关注/点赞不是评论，不能回；评论通知也要先过未读、非删除、非可疑内容。
// 用户明确要求不能每条都回，所以这里有一道硬闸：
//   两次回复之间至少间隔 cooldownMs；
//   一小时内最多 maxPerHour 条；
//   一天内最多 maxPerDay 条。
// 账本落盘，重启后仍然生效；否则重开插件会把历史通知再回一遍。
// ============================================================

import fs from 'node:fs'
import { ensureDirFor } from '../../utils/paths.js'
import { detectInjection } from '../../utils/safety.js'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const KEEP_SEEN_MS = 30 * DAY_MS
const KEEP_SENT_MS = DAY_MS

function normalize(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function keyPart(s) {
  // 去重键不保留空格：通知行会把昵称、徽标、正文拼在一起，空格位置不稳定。
  return normalize(s).replace(/\s+/g, '')
}

/** 同一条通知的稳定键：作者 + 正文 + 类型 + 视频缩略图。 */
export function commentNotificationKey(item = {}) {
  return [
    keyPart(item.name || item.author),
    keyPart(item.text),
    keyPart(item.type),
    keyPart(item.videoThumb).split('?')[0],
  ].join('|').slice(0, 500)
}

/** 删除的通知、关注/点赞、没有蓝标的条目都不回。 */
export function replyableNotification(item = {}, { requireUnread = true } = {}) {
  if (!item || item.commentBadge !== true) return { ok: false, reason: '不是评论通知（没有蓝色评论标）' }
  // 正常扫描必须未读；只有「上一轮已经确认过未读、这次点进去失败后重试」时放开。
  if (requireUnread && item.unread !== true) return { ok: false, reason: '不是未读新评论' }
  const text = normalize(item.text)
  if (!text) return { ok: false, reason: '通知里没有读到评论正文' }
  if (/(此评论已删除|评论已删除|该评论已删除)/.test(text)) return { ok: false, reason: '评论已删除' }
  if (/(此用户已注销|账号已注销)/.test(text)) return { ok: false, reason: '账号已注销' }
  const risk = detectInjection(text)
  if (risk && risk.risky) return { ok: false, reason: `评论内容可疑：${(risk.reasons || []).join('、')}` }
  return { ok: true, reason: '' }
}

/**
 * 从一轮通知里挑第一条能回的评论。
 * 顺序：未读蓝标 -> 没回过 -> 没在失败冷却里；一条都不符合就明确说为什么。
 * requireUnread=false 只用于「已确认未读但上一次点击失败」的内存重试。
 */
export function pickReplyCandidate(rows = [], { hasSeen = () => false, recentlyFailed = () => false, requireUnread = true } = {}) {
  let skipped = ''
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.commentBadge !== true) continue
    const usable = replyableNotification(row, { requireUnread })
    if (!usable.ok) { skipped = usable.reason; continue }
    const key = commentNotificationKey(row)
    if (hasSeen(key)) { skipped = '这条已经回过'; continue }
    if (recentlyFailed(key)) { skipped = '这条刚失败过，稍后再试'; continue }
    return { ok: true, item: row, key, reason: '' }
  }
  return { ok: false, item: null, key: '', reason: skipped || '没有可回的新评论' }
}

/**
 * 回评论账本。
 * @param {object} opts
 * @param {string} opts.path 落盘路径
 * @param {() => number} [opts.now]
 * @param {number} [opts.cooldownMs]
 * @param {number} [opts.maxPerHour]
 * @param {number} [opts.maxPerDay]
 */
export function createCommentReplyLedger({
  path,
  now = Date.now,
  cooldownMs = 90_000,
  maxPerHour = 6,
  maxPerDay = 20,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  let state = { seen: {}, sent: [] }
  let loaded = false
  let writeFailed = false

  function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (raw && typeof raw === 'object') {
        state.seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {}
        state.sent = Array.isArray(raw.sent) ? raw.sent.filter(Number.isFinite) : []
      }
    } catch {
      state = { seen: {}, sent: [] }
    }
  }

  function prune(t) {
    for (const [k, at] of Object.entries(state.seen)) {
      if (!Number.isFinite(Number(at)) || t - Number(at) > KEEP_SEEN_MS) delete state.seen[k]
    }
    state.sent = state.sent.filter((at) => Number.isFinite(at) && t - at <= KEEP_SENT_MS)
  }

  function save() {
    try {
      ensureDirFor(path)
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      writeFailed = false
      return true
    } catch {
      writeFailed = true
      return false
    }
  }

  function hasSeen(key, t = now()) {
    load()
    const at = Number(state.seen[key])
    return Boolean(at && t - at <= KEEP_SEEN_MS)
  }

  function check(t = now()) {
    load()
    prune(t)
    const last = state.sent.length ? Math.max(...state.sent) : 0
    if (last && t - last < cooldownMs) {
      return { ok: false, waitMs: cooldownMs - (t - last), reason: `两次回评论至少隔 ${Math.round(cooldownMs / 1000)} 秒` }
    }
    const lastHour = state.sent.filter((at) => t - at < HOUR_MS)
    if (lastHour.length >= maxPerHour) {
      return { ok: false, waitMs: HOUR_MS - (t - Math.min(...lastHour)), reason: `一小时内最多回 ${maxPerHour} 条` }
    }
    const lastDay = state.sent.filter((at) => t - at < DAY_MS)
    if (lastDay.length >= maxPerDay) {
      return { ok: false, waitMs: DAY_MS - (t - Math.min(...lastDay)), reason: `一天内最多回 ${maxPerDay} 条` }
    }
    return { ok: true, waitMs: 0, reason: '' }
  }

  function record(key, t = now()) {
    load()
    if (key) state.seen[key] = t
    state.sent.push(t)
    prune(t)
    // 防止账本无限增长；保留最近的 3000 条
    const seenKeys = Object.keys(state.seen)
    if (seenKeys.length > 3000) {
      seenKeys.sort((a, b) => Number(state.seen[a]) - Number(state.seen[b]))
      for (const k of seenKeys.slice(0, seenKeys.length - 3000)) delete state.seen[k]
    }
    const persisted = save()
    return { ok: true, persisted, writeFailed }
  }

  function snapshot() {
    load()
    const t = now()
    prune(t)
    return {
      path,
      sent: [...state.sent],
      seen: { ...state.seen },
      cooldownMs,
      maxPerHour,
      maxPerDay,
      writeFailed,
    }
  }

  return { hasSeen, check, record, snapshot, load }
}
