// ============================================================
// 主动私信频控：把「私信」从刷流动作里拆出来的硬闸。
//
// 目的：值班刷到很多人时，不能变成「刷一个人发一条」。
// 规则：两次主动私信之间至少冷却一段时间；一小时内最多 N 条。
// 落盘是为了跨值班轮次也生效，不是只靠进程内计数。
// ============================================================

import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'

const KEEP_MS = 24 * 60 * 60_000
const MAX_ROWS = 50

export function createDmLimiter({
  path,
  cooldownMs = 10 * 60_000,
  maxPerHour = 2,
  now = () => Date.now(),
} = {}) {
  if (!path) throw new Error('dm limiter 需要 path')

  function read() {
    try {
      const raw = readJsonSafe(path, { items: [] })
      const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : [])
      const cutoff = now() - KEEP_MS
      return items
        .filter((r) => r && typeof r === 'object' && Number(r.at) >= cutoff)
        .map((r) => ({ name: String(r.name || '').trim(), at: Number(r.at) }))
        .filter((r) => r.name && Number.isFinite(r.at))
        .slice(-MAX_ROWS)
    } catch {
      return []
    }
  }

  function check(target) {
    const rows = read()
    const current = now()
    const last = rows.length ? rows[rows.length - 1] : null
    if (last && current - last.at < cooldownMs) {
      return {
        ok: false,
        reason: `刚发过私信，先做点别的；两次私信最少隔 ${Math.round(cooldownMs / 60_000)} 分钟`,
      }
    }
    const lastHour = rows.filter((r) => current - r.at < 60 * 60_000)
    if (lastHour.length >= Math.max(1, maxPerHour)) {
      return {
        ok: false,
        reason: `这一小时私信额度用完了（最多 ${Math.max(1, maxPerHour)} 条）；先看视频/评论，别把私信当刷流`,
      }
    }
    return { ok: true, target: String(target || '').trim() }
  }

  function record(target) {
    const rows = read()
    rows.push({ name: String(target || '').trim(), at: now() })
    try { writeJsonAtomic(path, { items: rows.slice(-MAX_ROWS) }) } catch { /* 忽略 */ }
  }

  return { check, record, read }
}
