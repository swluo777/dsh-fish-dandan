// ============================================================
// 私信身份与记忆权限：主人始终可用；名单内的人也可用；
// 其他人只能拿当前对话上下文，不能碰长期记忆。
//
// 认人只按昵称完全一致匹配（去掉首尾空格和开头的 @），不做 includes。
// 名单不设人数上限；每个昵称最多 40 字，重复项自动去掉。
// ============================================================

export function normalizePersonName(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^@+/, '')
    .trim()
    .slice(0, 40)
}

/**
 * 清洗记忆名单：去空、去重、去首尾空格/开头 @，不截人数。
 * ownerName 传进来时，主人自己不进名单（主人始终隐式允许）。
 */
export function normalizeMemoryAllow(values, ownerName = '') {
  if (!Array.isArray(values)) return []
  const owner = normalizePersonName(ownerName)
  const seen = new Set()
  const out = []
  for (const value of values) {
    const name = normalizePersonName(value)
    if (!name) continue
    if (owner && name === owner) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 解析某个私信对象能不能用长期记忆。
 * 回复权限本身是「所有私信都自动回」，所以这里只回答身份与记忆。
 */
export function resolveDmAccess(name, { ownerName = '', memoryAllow = [] } = {}) {
  const cleanName = normalizePersonName(name)
  const owner = normalizePersonName(ownerName)
  const isOwner = Boolean(owner && cleanName === owner)
  const allowed = normalizeMemoryAllow(memoryAllow, owner)
  const memoryAllowed = isOwner || allowed.includes(cleanName)
  return { name: cleanName, isOwner, memoryAllowed }
}
