// ============================================================
// 它做过什么：只记录，不拦截。
//
// 之前的版本是「草稿 + 等主人点头」。现在它自己判断、自己动手，
// 这里改成一本流水账：什么时候、在谁那儿、说了什么、当时什么心情、
// 为什么想这么做。看得见，但不需要谁批准。
//
// 文件在 data/state/douyin-journal.json（本机，不入库）。
// ============================================================

import { randomUUID } from 'node:crypto'
import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'
import { fromRoot } from '../../utils/paths.js'

const MAX_ITEMS = 300
const KEEP_DAYS = 14

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function createJournal({ config, logger = console } = {}) {
  const cfg = (config && config.platforms && config.platforms.douyin) || {}
  const configured = cfg.journalPath || cfg.pendingPath
  const filePath = configured ? fromRoot(configured) : null
  let state = null

  function load() {
    if (state) return state
    const raw = filePath ? readJsonSafe(filePath, null, (err) => logger.warn?.(`互动记录读取失败：${err.message}`)) : null
    // 兼容旧草稿文件：有 items 就接着读，字段对不上的一律丢掉
    const items = raw && Array.isArray(raw.items)
      ? raw.items.filter((x) => x && x.id && x.type && Number.isFinite(x.at || x.createdAt))
      : []
    state = { items: items.map(normalize) }
    return state
  }

  function persist() {
    if (!filePath) return
    try { writeJsonAtomic(filePath, state) } catch (err) { logger.warn?.(`互动记录写入失败：${err.message}`) }
  }

  function normalize(x) {
    return {
      id: String(x.id),
      at: Number(x.at || x.createdAt) || Date.now(),
      type: String(x.type || '').slice(0, 20),
      text: String(x.text || '').slice(0, 300),
      target: x.target || null,
      videoId: String(x.videoId || ''),
      videoUrl: String(x.videoUrl || ''),
      videoCaption: String(x.videoCaption || '').slice(0, 120),
      reason: String(x.reason || '').slice(0, 200),
      mood: String(x.mood || '').slice(0, 20),
      ok: x.ok !== false,
      note: String(x.note || '').slice(0, 200),
    }
  }

  /** 记一笔。去重只针对 5 分钟内同一条视频、同类型、同文本的重复，避免连点两次记两条。 */
  function record(entry = {}) {
    const s = load()
    const at = Date.now()
    const item = normalize({ id: randomUUID(), at, ...entry })
    if (!item.type) return null
    const dup = s.items.find((x) => x.type === item.type && x.videoId === item.videoId && x.text === item.text &&
      (x.target && x.target.name) === (item.target && item.target.name) && at - x.at < 5 * 60_000)
    if (dup) return dup
    s.items.unshift(item)
    s.items = s.items
      .filter((x) => at - x.at < KEEP_DAYS * 86_400_000)
      .slice(0, MAX_ITEMS)
    persist()
    return item
  }

  function list({ limit = 50 } = {}) {
    return load().items.slice(0, Math.max(1, limit)).map((x) => ({ ...x }))
  }

  function counts() {
    const s = load()
    const today = dayKey(Date.now())
    const byType = {}
    let todayCount = 0
    for (const x of s.items) {
      if (dayKey(x.at) !== today) continue
      byType[x.type] = (byType[x.type] || 0) + 1
      // 「没搭理」不算主动做过的事，单独在 byType 里看
      if (x.type !== 'ignore') todayCount += 1
    }
    return { total: s.items.length, today: todayCount, byType }
  }

  /** 最近说过的句子：生成新话时避开，不然一眼假。 */
  function recentTexts(limit = 40) {
    return load().items.filter((x) => x.text).slice(0, Math.max(1, limit)).map((x) => x.text)
  }

  return { record, list, counts, recentTexts, filePath }
}
