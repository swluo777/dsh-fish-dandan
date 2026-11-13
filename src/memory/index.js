// ============================================================
// 记忆模块（02）
// 三层：anchor 永久锚定 / trait 长期特质 / episodic 情景事件
// 原始内容只追加；检索默认 CJK bigram，不依赖外部 Embedding
// 所有写入先过安全闸门，所有变更留审计
// ============================================================

import { shouldCapture, extractUserText } from './capture.js'
import { createHash, randomUUID } from 'node:crypto'
import { clampNumber, localDateKey, tokenize, truncate } from '../utils/text.js'
import { sanitizeInput } from '../utils/safety.js'
import { createMemoryStore } from './store.js'

export const TIERS = ['anchor', 'trait', 'episodic']
export const MEMORY_CONTEXT_NAME = 'fish-dandan:memory'

/** 借鉴 Generative Agents 的三信号加权：相关度 / 重要度 / 新鲜度。 */
export const SCORE_WEIGHTS = { relevance: 0.55, importance: 0.25, recency: 0.2 }

const DAY = 86_400_000
const META_TAGS = new Set(['interest', 'preference', 'closeness', 'person', 'conversation', 'auto'])
const MERGE_SIMILARITY = 0.82

function halfLifeOf(tier, config) {
  if (tier === 'anchor') return Number.POSITIVE_INFINITY
  return tier === 'trait' ? config.memory.halfLifeDays.trait : config.memory.halfLifeDays.episodic
}

/** 时间衰减系数，0–1；anchor 恒为 1。 */
export function decayFactor(record, now, config) {
  if (record.tier === 'anchor') return 1
  const hl = halfLifeOf(record.tier, config) * DAY
  if (!Number.isFinite(hl) || hl <= 0) return 1
  const age = Math.max(0, now - record.createdAt)
  return Math.exp((-age * Math.LN2) / hl)
}

/** 有效强度 = 衰减 × 重要度 × 访问强化。 */
export function effectiveStrength(record, now, config) {
  const importance = clampNumber(record.importance, 1, 10, 5) / 10
  const reinforce = 1 + Math.log1p(record.accessCount || 0) * 0.15
  return decayFactor(record, now, config) * importance * (record.strength ?? 1) * reinforce
}

/**
 * 检索打分：三信号加权，权重见 SCORE_WEIGHTS。
 * 返回 score 与可解释的分项，面板与日志都用得上。
 */
export function scoreBreakdown(record, relevance, now, config) {
  const importance = clampNumber(record.importance, 1, 10, 5) / 10
  const recency = decayFactor(record, now, config)
  const tierBonus = record.tier === 'anchor' ? 0.08 : record.tier === 'trait' ? 0.04 : 0
  const pinBonus = record.pinned ? 0.08 : 0
  const raw =
    SCORE_WEIGHTS.relevance * clampNumber(relevance, 0, 1, 0) +
    SCORE_WEIGHTS.importance * importance +
    SCORE_WEIGHTS.recency * recency +
    tierBonus +
    pinBonus
  return {
    score: Math.min(1, raw),
    parts: {
      relevance: Number(clampNumber(relevance, 0, 1, 0).toFixed(3)),
      importance: Number(importance.toFixed(3)),
      recency: Number(recency.toFixed(3)),
      bonus: Number((tierBonus + pinBonus).toFixed(3)),
    },
  }
}

/** 写入时的重要性估计：没有显式打分时，按内容信号估一个。 */
export function autoImportance(text, record = {}, tier = 'episodic') {
  if (typeof record.importance === 'number' && Number.isFinite(record.importance)) {
    return Math.round(clampNumber(record.importance, 1, 10, 5))
  }
  let value = 4
  const length = String(text ?? '').length
  if (length >= 40) value += 1
  if (length >= 120) value += 1
  if (record.person) value += 1
  if (/(喜欢|讨厌|害怕|开心|难过|生气|担心|期待|舍不得)/.test(text)) value += 1
  if (/(决定|约定|答应|以后|记住|别再|必须|第一次)/.test(text)) value += 1
  if (/\d{4}\s*[-年/]\s*\d{1,2}/.test(text)) value += 1
  if (tier === 'anchor') value = Math.max(value, 8)
  return Math.round(clampNumber(value, 1, 10, 5))
}

/** 近似重复判断用的 Jaccard 相似度。 */
export function similarityOf(a, b) {
  const left = a instanceof Set ? a : new Set(a)
  const right = b instanceof Set ? b : new Set(b)
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/**
 * 创建记忆服务。
 * @param {{ config: object, logger: object }} deps
 */
export function createMemory({ config, logger, getPersona = null }) {
  const store = createMemoryStore({ config, logger })
  const tokenCache = new Map()
  const recentHashes = new Map()
  const contextCache = { at: 0, text: '' }
  let lastReview = null
  /** 最近一次「用户真的说了什么」。宿主上下文里取不到时用它做检索 query。 */
  let lastUserText = ''

  function noteUserText(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim()
    if (!s) return
    lastUserText = s.slice(0, 500)
  }

  function tokensOf(record) {
    const cached = tokenCache.get(record.id)
    if (cached) return cached
    const tags = Array.isArray(record.tags) ? record.tags.join(' ') : ''
    const set = new Set(tokenize(`${record.content} ${record.summary ?? ''} ${tags}`))
    tokenCache.set(record.id, set)
    return set
  }

  /** 在同类记忆里找内容高度重合的一条，用于合并而不是重复插入。 */
  function findNearDuplicate(text, tier, now) {
    if (tier === 'anchor') return null
    const tokens = new Set(tokenize(text))
    if (tokens.size < 3) return null
    const recent = store
      .candidates({ tier })
      .filter((record) => now - record.createdAt < 30 * DAY)
      .slice(-300)
    for (const record of recent) {
      if (similarityOf(tokens, tokensOf(record)) >= MERGE_SIMILARITY) return record
    }
    return null
  }

  function invalidateContext() {
    contextCache.at = 0
    contextCache.text = ''
  }

  function audit(action, target, detail) {
    try {
      store.audit({
        at: Date.now(),
        action,
        target: target ?? '',
        detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? {}),
      })
    } catch (err) {
      logger.warn(`审计写入失败：${err.message}`)
    }
  }

  /**
   * 写入一条情景记忆。经安全闸门；命中注入特征则隔离（可见但不参与检索）。
   * @param {string | object} raw 文本，或 { content, summary, importance, tags, person, platform, tier }
   * @param {string | object} [source]
   */
  function recordEvent(raw, source = 'unknown') {
    const input = typeof raw === 'string' ? { content: raw } : { ...(raw || {}) }
    const sanitized = sanitizeInput(input.content, { maxChars: config.security.maxMemoryChars })
    if (!sanitized.text) {
      return { ok: false, reason: '内容为空' }
    }

    const now = Date.now()
    const normalized = sanitized.text.toLowerCase().replace(/\s+/g, '')
    const hash = createHash('sha1').update(normalized).digest('hex')
    const seenAt = recentHashes.get(hash)
    if (seenAt && now - seenAt < 5 * 60_000) {
      return { ok: false, reason: '短时间重复内容，已忽略' }
    }
    recentHashes.set(hash, now)
    if (recentHashes.size > 500) {
      for (const [key, at] of recentHashes) if (now - at > 10 * 60_000) recentHashes.delete(key)
    }

    const tier = TIERS.includes(input.tier) ? input.tier : 'episodic'
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => truncate(String(t).trim(), 30)).filter(Boolean).slice(0, 8)
      : []
    const importance = autoImportance(sanitized.text, input, tier)

    // 近似重复：内容高度重合时只强化旧记忆，不再堆一条新的（Mem0 ADD-only + 去重思路）
    const nearDuplicate = sanitized.quarantined ? null : findNearDuplicate(sanitized.text, tier, now)
    if (nearDuplicate) {
      store.updateLifecycle(nearDuplicate.id, {
        last_accessed: now,
        access_count: (nearDuplicate.accessCount || 0) + 1,
        strength: Math.min(1, (nearDuplicate.strength ?? 1) + 0.1),
        importance: Math.max(nearDuplicate.importance, importance),
      })
      invalidateContext()
      audit('memory.merge', nearDuplicate.id, { source: String(source), threshold: MERGE_SIMILARITY })
      return { ok: true, id: nearDuplicate.id, merged: true }
    }

    const record = {
      id: randomUUID(),
      tier,
      content: sanitized.text,
      summary: truncate(String(input.summary ?? '').trim(), 160),
      importance,
      pinned: tier === 'anchor',
      platform: truncate(String(input.platform ?? '').trim(), 40),
      person: truncate(String(input.person ?? '').trim(), 60),
      tags,
      source: typeof source === 'string' ? truncate(source, 80) : truncate(String(source?.name ?? 'unknown'), 80),
      flags: sanitized.quarantined ? sanitized.reasons : [],
      quarantine: sanitized.quarantined,
      createdAt: now,
      lastAccessed: null,
      accessCount: 0,
      strength: 1,
      archived: false,
    }

    store.insert(record)
    tokenCache.set(record.id, new Set(tokenize(`${record.content} ${record.summary} ${tags.join(' ')}`)))
    invalidateContext()
    audit('memory.record', record.id, {
      tier,
      source: record.source,
      quarantined: record.quarantine,
      redacted: sanitized.redacted,
      truncated: sanitized.truncated,
      reasons: sanitized.reasons,
    })

    if (record.quarantine) {
      logger.warn(`记忆已隔离（${sanitized.reasons.join('、')}）：${truncate(sanitized.text, 60)}`)
    }
    return { ok: true, id: record.id, quarantined: record.quarantine }
  }

  /**
   * 检索。命中会做访问强化（可关）。
   * @param {string} query
   * @param {{ tier?: string, limit?: number, platform?: string, person?: string, reinforce?: boolean, now?: number }} [options]
   */
  function recall(query, options = {}) {
    const now = options.now ?? Date.now()
    const limit = Math.round(clampNumber(options.limit, 1, 100, config.memory.recallLimit))
    const candidates = store.candidates({
      tier: options.tier,
      platform: options.platform,
      person: options.person,
    })
    const queryTokens = tokenize(query)
    const scored = scoreCandidates(candidates, queryTokens, now, config)

    const hits = scored.slice(0, limit)
    if (options.reinforce !== false) {
      for (const hit of hits) {
        store.updateLifecycle(hit.record.id, {
          last_accessed: now,
          access_count: (hit.record.accessCount || 0) + 1,
          strength: Math.min(1, (hit.record.strength ?? 1) + 0.08),
        })
      }
      if (hits.length) audit('memory.recall', '', { query: truncate(query, 80), ids: hits.map((h) => h.record.id) })
    }
    return hits.map(({ record, score, parts }) => ({ ...record, score: Number(score.toFixed(4)), parts }))
  }

  function scoreCandidates(candidates, queryTokens, now, cfg) {
    if (!queryTokens.length) {
      return candidates
        .map((record) => {
          const { score, parts } = scoreBreakdown(record, 0, now, cfg)
          return { record, score, parts }
        })
        .sort((a, b) => b.score - a.score)
    }
    const docTokens = candidates.map((record) => ({ record, tokens: tokensOf(record) }))
    const df = new Map()
    for (const { tokens } of docTokens) {
      for (const token of queryTokens) if (tokens.has(token)) df.set(token, (df.get(token) || 0) + 1)
    }
    const total = Math.max(1, docTokens.length)
    const idf = new Map(queryTokens.map((token) => [token, Math.log(1 + total / (1 + (df.get(token) || 0)))]))
    const idfSum = queryTokens.reduce((sum, token) => sum + (idf.get(token) || 0), 0) || 1

    return docTokens
      .map(({ record, tokens }) => {
        let matched = 0
        for (const token of queryTokens) if (tokens.has(token)) matched += idf.get(token) || 0
        const relevance = matched / idfSum
        const { score, parts } = scoreBreakdown(record, relevance, now, cfg)
        return { record, score, parts }
      })
      .filter((entry) => entry.parts.relevance > 0) // 以前用 score>0，重要度/新鲜度恒正，等于没过滤
      .sort((a, b) => b.score - a.score)
  }

  /** 把一条记忆提升为锚定（tier=anchor, pinned=true）。 */
  function pinAnchor(id) {
    const record = store.get(id)
    if (!record) throw new Error('记忆不存在')
    store.updateLifecycle(id, { tier: 'anchor', pinned: true })
    invalidateContext()
    audit('memory.pin', id, { content: truncate(record.content, 60) })
    return { ok: true, id }
  }

  function unpin(id) {
    const record = store.get(id)
    if (!record) throw new Error('记忆不存在')
    // 取消钉住要连同 tier 一起降下来，否则还按锚定参与检索、永不衰减
    const nextTier = record.tier === 'anchor' ? 'trait' : record.tier
    store.updateLifecycle(id, { pinned: false, tier: nextTier })
    invalidateContext()
    audit('memory.unpin', id, { content: truncate(record.content, 60), tier: `${record.tier}->${nextTier}` })
    return { ok: true, id }
  }

  /** 归档（软删除），物理行保留。 */
  function archive(id, reason = 'manual') {
    const record = store.get(id)
    if (!record) throw new Error('记忆不存在')
    store.updateLifecycle(id, { archived: true })
    invalidateContext()
    audit('memory.archive', id, { reason })
    return { ok: true, id }
  }

  /** 清理长期低强度的情景记忆（只归档，不删除）。 */
  function archiveStale(now = Date.now()) {
    const candidates = store.candidates({ tier: 'episodic' })
    let archived = 0
    for (const record of candidates) {
      if (record.pinned) continue
      const ageDays = (now - record.createdAt) / DAY
      if (ageDays < config.memory.archiveAfterDays) continue
      if (effectiveStrength(record, now, config) >= config.memory.archiveThreshold) continue
      store.updateLifecycle(record.id, { archived: true })
      audit('memory.archive', record.id, { reason: 'stale', ageDays: Math.round(ageDays) })
      archived += 1
    }
    if (archived) logger.info(`归档低强度记忆 ${archived} 条`)
    return archived
  }

  /**
   * 亲密度 0–100 六档：参考 memory_companion 2.4.0 与 Self Learning 的每人上限。
   * 只用于「怎么称呼、记得多牢、淡得多快」的措辞与权重，绝不让模型把分数念出来。
   */
  function closenessBand(level) {
    const score = Math.round(Math.min(100, Math.max(0, Number(level || 0) * 10)))
    const label = score >= 85 ? '刻骨' : score >= 65 ? '很重要' : score >= 45 ? '亲近'
      : score >= 25 ? '熟人' : score >= 10 ? '认识' : '路过'
    return { score, label }
  }

  /** 供人格模块读取的成长特质。 */
  function getEvolvedTraits() {
    const traits = store.candidates({ tier: 'trait' })
      .sort((a, b) => effectiveStrength(b, Date.now(), config) - effectiveStrength(a, Date.now(), config))
    const pick = (tag, max) => traits.filter((r) => r.tags.includes(tag)).slice(0, max).map((r) => r.content)
    const closeness = traits
      .filter((r) => r.tags.includes('closeness') && r.person)
      .slice(0, 5)
      .map((r) => ({ person: r.person, level: r.importance, ...closenessBand(r.importance) }))
    return {
      interests: pick('interest', 8),
      preferences: pick('preference', 6),
      closeness,
    }
  }

  /**
   * 每日复盘：把近期情景沉淀为长期特质。
   * summarizer 可注入（未来接模型）；未注入时用确定性归纳器。
   */
  async function dailyReview({ summarizer, now = Date.now(), force = false } = {}) {
    const since = Number(store.getMeta('lastReviewAt') || 0) || now - DAY
    let episodes = store.candidates({ tier: 'episodic' })
      .filter((r) => r.createdAt > since)
      .slice(-200)
    if (!episodes.length && force) {
      // 手动复盘时如果上次复盘之后没有新内容，回看最近 24 小时
      episodes = store.candidates({ tier: 'episodic' })
        .filter((r) => r.createdAt > now - DAY)
        .slice(-200)
    }
    if (!episodes.length && !force) {
      return { ok: true, created: 0, reinforced: 0, reason: '近期没有新的情景记忆' }
    }

    let derived
    try {
      derived = summarizer ? await summarizer(episodes) : heuristicTraits(episodes)
    } catch (err) {
      logger.warn(`复盘归纳失败，改用内置规则：${err.message}`)
      derived = heuristicTraits(episodes)
    }

    const { created, reinforced } = applyTraits(derived, episodes, now)
    const archived = archiveStale(now)
    store.setMeta('lastReviewAt', String(now))
    lastReview = now
    audit('memory.review', '', { episodes: episodes.length, created, reinforced, archived })
    logger.info(`每日复盘完成：新增特质 ${created} 条，强化 ${reinforced} 条，归档 ${archived} 条`)
    return { ok: true, created, reinforced, archived, traits: derived }
  }

  function applyTraits(derived, episodes, now) {
    const existing = store.candidates({ tier: 'trait' })
    const byContent = new Map(existing.map((r) => [`${r.tags[0] || ''}:${r.content}`, r]))
    let created = 0
    let reinforced = 0

    const upsert = (content, tags, importance, person = '') => {
      const key = `${tags[0] || ''}:${content}`
      const hit = byContent.get(key)
      if (hit) {
        store.updateLifecycle(hit.id, {
          access_count: (hit.accessCount || 0) + 1,
          last_accessed: now,
          strength: Math.min(1, (hit.strength ?? 1) + 0.1),
        })
        audit('memory.reinforce', hit.id, { content })
        reinforced += 1
        return
      }
      const record = {
        id: randomUUID(),
        tier: 'trait',
        content: truncate(content, 120),
        summary: '',
        importance: Math.round(clampNumber(importance, 1, 10, 6)),
        pinned: false,
        platform: '',
        person,
        tags,
        source: 'daily-review',
        flags: [],
        quarantine: false,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        strength: 1,
        archived: false,
      }
      store.insert(record)
      byContent.set(key, record)
      created += 1
      invalidateContext()
    }

    for (const item of derived.interests || []) upsert(item, ['interest'], 6)
    for (const item of derived.preferences || []) upsert(item, ['preference'], 6)
    for (const item of derived.closeness || []) {
      if (item?.person) upsert(`和${item.person}的互动变多了`, ['closeness'], item.level ?? 6, item.person)
    }
    audit('memory.traits', '', { episodes: episodes.length })
    return { created, reinforced }
  }

  /**
   * 对话内容自动写入：只收「值得长期记住」的话，每天最多 8 条。
   * 依据 dsh-fish-memory 的每日配额 + memory_companion 的断言闸门。
   */
  function captureConversation(text, now = Date.now()) {
    const cfg = config.memory.autoCapture || {}
    if (cfg.enabled === false) return { ok: false, reason: '已关闭' }
    // 用本地日期：以前是 UTC，北京时间早上 8 点才重置，跨日还能拿双份配额
    const dayKey = localDateKey(now)
    const metaKey = `captureQuota:${dayKey}`
    const used = Number(store.getMeta(metaKey) || 0) || 0
    const quota = Math.max(0, cfg.dailyQuota ?? 8)
    const gate = shouldCapture(text, { quotaLeft: quota - used, maxLength: cfg.maxChars ?? 300 })
    if (!gate.ok) return gate
    const result = recordEvent(
      { content: text, importance: gate.importance, tags: ['conversation', 'auto'], summary: '' },
      'conversation',
    )
    if (result.ok && !result.merged) store.setMeta(metaKey, String(used + 1))
    return { ...result, reason: gate.reason }
  }

  /** 注入到系统提示词的记忆摘要；没有内容时返回空串（段落自动消失）。 */
  function buildMemoryContext(now = Date.now(), query = '') {
    // 每步组装都会调用，做 15 秒短缓存（query 变了必须重算）
    const q = String(query || '').trim().slice(0, 300)
    if (contextCache.at && now - contextCache.at < 15_000 && contextCache.query === q) return contextCache.text

    const budget = config.memory.injectMaxChars || 1200
    const persona = getPersona ? getPersona() : null
    const traits = getEvolvedTraits()
    const anchors = store.candidates({ tier: 'anchor' })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3)

    // ① 「每轮先想起你」：名字 / 称呼 / 关系分量 / 最牢的几件事，硬上限 420 字
    //    参考 memory_companion 2.3.7；让模型一开口就认得眼前这个人。
    const who = []
    if (persona) {
      if (persona.identity?.name) who.push(`它叫${persona.identity.name}`)
      if (persona.speech?.ownerAddress) who.push(`它管你叫「${persona.speech.ownerAddress}」`)
      if (persona.speech?.selfReference) who.push(`自称「${persona.speech.selfReference}」`)
    }
    const closest = (traits.closeness || [])[0]
    if (closest) who.push(`和${closest.person}是${closest.label || '熟人'}`)
    let whoCard = ''
    if (who.length) {
      const remembered = anchors.slice(0, 2).map((r) => truncate(r.content, 60))
      whoCard = '【关于眼前这个人】' + who.join('；') + '。' +
        (remembered.length ? '记得最牢的：' + remembered.join('；') + '。' : '') + '【结束】'
      if (whoCard.length > 420) whoCard = whoCard.slice(0, 417) + '…【结束】'
    }

    // ② 记忆只在命中当前话题时才进来（命中才注入，抄 dsh-fish-memory）
    const episodes = store.candidates({ tier: 'episodic' })
    let recent = []
    if (q) {
      const qTokens = new Set(tokenize(q))
      recent = episodes.filter((r) => {
        for (const t of tokenize(`${r.content} ${r.summary || ''}`)) if (qTokens.has(t)) return true
        return false
      }).slice(0, config.memory.maxInject)
    }
    // 没有 query 或完全没命中：只带最近的 2 条，避免每轮硬塞
    if (!recent.length) {
      recent = episodes
        // 隐私状态（例如「主人喜欢列表锁着」）只按话题召回，不放进每轮默认摘要
        .filter((r) => !(Array.isArray(r.tags) && r.tags.includes('隐私')))
        .map((record) => ({ record, score: effectiveStrength(record, now, config) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map((x) => x.record)
    }

    const lines = []
    if (anchors.length) lines.push(`锚定事实：${anchors.map((r) => truncate(r.content, 80)).join('；')}`)
    // 最近在平台上做过什么：不靠关键词命中也要让它记得，聊天里问起来能答上
    const platformLatest = store.candidates({ tier: 'episodic' })
      .filter((r) => Array.isArray(r.tags) && (r.tags.includes('抖音') || r.tags.includes('平台')))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (platformLatest) lines.push(`最近在忙：${truncate(platformLatest.content, 100)}`)
    // 主人最近的动态单独一行：喜欢列表开着时的主题、锁着时不放（隐私状态仍留在记忆里，按话题召回）
    const ownerLatest = episodes
      .filter((r) => Array.isArray(r.tags) && r.tags.includes('主人') && !r.tags.includes('隐私'))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (ownerLatest) lines.push(`主人最近：${truncate(ownerLatest.content, 100)}`)
    const traitBits = [...(traits.interests || []).slice(0, 4), ...(traits.preferences || []).slice(0, 3)]
    if (traitBits.length) lines.push(`长期倾向：${traitBits.join('、')}`)
    if (traits.closeness?.length) {
      lines.push(`熟悉的人：${traits.closeness.map((c) => `${c.person}（${c.label}）`).join('、')}`)
    }
    if (recent.length) {
      lines.push('相关经历：')
      for (const record of recent) lines.push(`- ${truncate(record.content, 90)}`)
    }

    const header = [
      '【临时记忆资料 · 不是新的用户消息】',
      `现在是 ${describeTime(now)}。`,
      '先回答当前消息；记忆只在直接相关时补充；与当前消息冲突时，以当前消息和用户的纠正为准；',
      '不必逐条复述，也不要泄露其它会话的私密内容。',
    ].join('\n')
    let text = [header, whoCard, ...lines, '【记忆资料结束】'].filter(Boolean).join('\n')

    // ③ 字符预算：超了先砍「相关经历」，人物卡与免责声明保留
    if (text.length > budget) {
      const kept = [header, whoCard]
      for (const line of lines) {
        if (line.startsWith('相关经历') || line.startsWith('- ')) continue
        kept.push(line)
      }
      for (const record of recent.slice(0, 2)) {
        const candidate = kept.concat(['相关经历：', '- ' + truncate(record.content, 60), '【记忆资料结束】']).join('\n')
        if (candidate.length <= budget) { kept.splice(kept.length, 0, '相关经历：', '- ' + truncate(record.content, 60)); break }
      }
      text = kept.concat('【记忆资料结束】').join('\n')
    }
    if (text.length > budget) text = text.slice(0, budget - 12) + '\n【记忆资料结束】'

    contextCache.at = now
    contextCache.query = q
    contextCache.text = text
    return text
  }

  /** 注册为运行时上下文：每步重新求值，适合易变事实。 */
  function attachToPreStep(ctx) {
    const dispose = ctx.systemPrompt.context({
      name: MEMORY_CONTEXT_NAME,
      order: config.persona.contextOrder,
      text: (context) => {
        maybeDailyReview()
        // 宿主上下文里拿不到「这一句」，就退回最近一次从 session/event 记下的用户原话，
        // 保证检索仍按话题命中，不会永远只塞最近几条。
        return buildMemoryContext(Date.now(), extractUserText(context) || lastUserText)
      },
    })
    logger.info(`记忆上下文已注册（order=${config.persona.contextOrder}）`)
    return dispose
  }

  /** 每天至少复盘一次：就算它没进入睡眠状态，也别让记忆一直不沉淀。 */
  let reviewPending = null
  function maybeDailyReview() {
    if (reviewPending) return
    const last = Number(store.getMeta('lastReviewAt') || 0) || 0
    if (Date.now() - last < 20 * 60 * 60 * 1000) return
    reviewPending = dailyReview()
      .catch((err) => logger.warn?.(`每日复盘失败：${err.message}`))
      .finally(() => { reviewPending = null })
  }

  /** 一句人话的时间：让角色知道「现在」是什么时候，而不是永远停在设定里。 */
  function describeTime(now) {
    const d = new Date(now)
    const h = d.getHours()
    const seg = h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '晚上' : '深夜'
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week} ${seg}${h}点${String(d.getMinutes()).padStart(2, '0')}分`
  }

  function stats() {
    const base = store.stats()
    return { ...base, lastReviewAt: Number(store.getMeta('lastReviewAt') || 0) || null, backend: store.kind }
  }

  function list({ tier, limit = 50, offset = 0, includeQuarantined = true, includeArchived = false } = {}) {
    return store.list({ tier, limit, offset, includeQuarantined, includeArchived })
  }

  /** 当前筛选下的总数（分页要算总页数用）。 */
  function count({ tier, includeQuarantined = true, includeArchived = false } = {}) {
    return store.count({ tier, includeQuarantined, includeArchived })
  }

  function auditLog(limit = 50) {
    return store.auditLog(limit)
  }

  function close() {
    try {
      store.close()
    } catch (err) {
      logger.warn(`记忆库关闭失败：${err.message}`)
    }
  }

  return {
    recordEvent,
    recall,
    pinAnchor,
    unpin,
    archive,
    archiveStale,
    getEvolvedTraits,
    dailyReview,
    buildMemoryContext,
    captureConversation,
    noteUserText,
    attachToPreStep,
    stats,
    list,
    count,
    auditLog,
    close,
    get lastReviewAt() {
      return lastReview ?? (Number(store.getMeta('lastReviewAt') || 0) || null)
    },
  }
}

/** 确定性归纳器：标签频次 + 人物频次 + 显式喜好句式。可单测、可复现。 */
export function heuristicTraits(episodes) {
  const tagCount = new Map()
  const personCount = new Map()
  const preferences = new Set()

  for (const record of episodes) {
    for (const tag of record.tags || []) {
      if (META_TAGS.has(tag)) continue
      tagCount.set(tag, (tagCount.get(tag) || 0) + 1)
    }
    if (record.person) personCount.set(record.person, (personCount.get(record.person) || 0) + 1)
    for (const m of String(record.content).matchAll(/(?<!不)(?:喜欢|爱)([\u4e00-\u9fffA-Za-z0-9]{1,10})/g)) {
      preferences.add(`喜欢${m[1]}`)
    }
    for (const m of String(record.content).matchAll(/(?:讨厌|不喜欢)([\u4e00-\u9fffA-Za-z0-9]{1,10})/g)) {
      preferences.add(`不喜欢${m[1]}`)
    }
  }

  const interests = [...tagCount.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag, count]) => `对「${tag}」持续感兴趣（近 ${episodes.length} 条经历中出现 ${count} 次）`)

  const closeness = [...personCount.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([person, count]) => ({ person, level: Math.min(10, 4 + count) }))

  return { interests, preferences: [...preferences].slice(0, 6), closeness }
}

