// ============================================================
// 文本工具：截断、数值钳制、中英混合分词（CJK bigram）
// 检索不依赖外部分词库，保证零依赖可运行
// ============================================================

/** 截断到 max 字符，超出补省略号。 */
export function truncate(text, max = 400) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

/** 数值钳制到 [min, max]；非法值返回 fallback。 */
export function clampNumber(value, min, max, fallback = min) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 去掉控制字符与首尾空白，保留换行。 */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

/**
 * 中英混合分词：拉丁词按词切，CJK 按二元组切。
 * 纯标准库实现，召回质量足够支撑本地记忆检索。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(m[0])
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens]
}

/** 本地日期键，用于每日预算与复盘归属。 */
export function localDateKey(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

