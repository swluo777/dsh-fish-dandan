// ============================================================
// ALMA 三层情感模型（A Layered Model of Affect, Gebhard 2005）
//
// 不是自创模型，依据以下公开方案实现：
//   - 分层：Personality(长期) / Mood(中期) / Emotion(短期)  —— ALMA、VirtualHuman
//   - 性格：Big Five(OCEAN) -> PAD 基线，Mehrabian 线性转换  —— Gebhard / MDPI 2026
//   - 情绪：OCC 评价（合意性/可赞性/可能性/归因）+ 离散情绪表 + 指数衰减
//           —— GAMYGDALA、Census、quaternion Generative NPCs
//   - 心情：情绪 PAD 签名汇入 + 每轮向人格基线回归 15%
//           —— Pavel6625/PaulusAI《My AI agent's mood is three numbers》
//   - 性格真实缩放状态阈值（clamped linear interpolation，不只是文案）
//           —— wiebe-xyz/github-tamagotchi
//   - 心情八分体命名 —— VirtualHuman / Gebhard
//
// 纯函数 + 显式状态，无副作用，便于单测。
// ============================================================

import { clampNumber } from '../utils/text.js'

export const TRAIT_KEYS = ['openness', 'extraversion', 'agreeableness', 'stability', 'conscientiousness']
export const TRAIT_LABELS = {
  openness: '开放',
  extraversion: '外向',
  agreeableness: '宜人',
  stability: '稳定',
  conscientiousness: '尽责',
}

/** 离散情绪表：valence/arousal 取 Russell 环状坐标，pad 为心情空间的贡献签名。 */
export const EMOTIONS = {
  joy:        { label: '开心', valence: 0.8,  arousal: 0.55,  pad: [0.80, 0.45, 0.30],  decayMin: 22, color: '#f5a623' },
  content:    { label: '安心', valence: 0.5,  arousal: -0.45, pad: [0.60, -0.35, 0.20], decayMin: 45, color: '#4fc3a1' },
  curiosity:  { label: '好奇', valence: 0.35, arousal: 0.6,   pad: [0.30, 0.65, 0.15],  decayMin: 30, color: '#5b8cff' },
  surprise:   { label: '惊讶', valence: 0.0,  arousal: 0.9,   pad: [0.00, 0.90, -0.20], decayMin: 8,  color: '#a97bff' },
  boredom:    { label: '无聊', valence: -0.4, arousal: -0.7,  pad: [-0.45, -0.70, -0.20], decayMin: 35, color: '#8b97ad' },
  anxiety:    { label: '焦虑', valence: -0.6, arousal: 0.7,   pad: [-0.60, 0.70, -0.50], decayMin: 25, color: '#e07b93' },
  sadness:    { label: '低落', valence: -0.7, arousal: -0.45, pad: [-0.70, -0.45, -0.35], decayMin: 40, color: '#6f8bd6' },
  irritation: { label: '烦躁', valence: -0.5, arousal: 0.5,   pad: [-0.55, 0.50, 0.40],  decayMin: 20, color: '#e8794a' },
}

/** OCC 评价模板：把项目里真实发生的事件映射成合意性/可赞性/可能性/归因。 */
export const EVENT_APPRAISALS = {
  state_sleep:      { desirability: 0.25, praiseworthiness: 0.1, likelihood: 1, agency: 'self',  emotion: 'content' },
  state_rest:       { desirability: 0.2,  praiseworthiness: 0.1, likelihood: 1, agency: 'self',  emotion: 'content' },
  state_explore:    { desirability: 0.5,  praiseworthiness: 0.2, likelihood: 0.8, agency: 'self', emotion: 'curiosity' },
  state_social:     { desirability: 0.65, praiseworthiness: 0.4, likelihood: 0.8, agency: 'self', emotion: 'joy' },
  state_create:     { desirability: 0.6,  praiseworthiness: 0.5, likelihood: 0.8, agency: 'self', emotion: 'joy' },
  decision:         { desirability: 0.35, praiseworthiness: 0.2, likelihood: 1,   agency: 'self',  emotion: 'curiosity' },
  memory_anchor:    { desirability: 0.6,  praiseworthiness: 0.5, likelihood: 1,   agency: 'other', emotion: 'joy' },
  approval:         { desirability: 0.55, praiseworthiness: 0.45, likelihood: 1,  agency: 'other', emotion: 'content' },
  platform_message: { desirability: 0.3,  praiseworthiness: 0.1, likelihood: 0.7, agency: 'other', emotion: 'surprise' },
  // 自己在平台跟人说了句话：不是大事，但会真的让心情好一点
  platform_interact: { desirability: 0.45, praiseworthiness: 0.3, likelihood: 0.9, agency: 'self', emotion: 'joy' },
  low_energy:       { desirability: -0.5, praiseworthiness: 0,    likelihood: 1,   agency: 'self',  emotion: 'sadness' },
  high_boredom:     { desirability: -0.4, praiseworthiness: 0,    likelihood: 1,   agency: 'self',  emotion: 'boredom' },
  high_social_need: { desirability: -0.45, praiseworthiness: 0,   likelihood: 1,   agency: 'self',  emotion: 'anxiety' },
  long_idle:        { desirability: -0.3, praiseworthiness: 0,    likelihood: 1,   agency: 'none',  emotion: 'boredom' },
  error:            { desirability: -0.6, praiseworthiness: -0.3, likelihood: 1,   agency: 'self',  emotion: 'irritation' },
}

/** PAD 八分体：符号组合 -> 中文心情名（VirtualHuman / Gebhard）。 */
const OCTANTS = [
  { signs: [1, 1, 1],   label: '兴高采烈', tone: 'warm' },
  { signs: [1, 1, -1],  label: '依赖撒娇', tone: 'warm' },
  { signs: [1, -1, 1],  label: '放松惬意', tone: 'calm' },
  { signs: [1, -1, -1], label: '温顺乖巧', tone: 'calm' },
  { signs: [-1, 1, 1],  label: '任性闹腾', tone: 'hot' },
  { signs: [-1, 1, -1], label: '焦虑不安', tone: 'hot' },
  { signs: [-1, -1, 1], label: '嘴硬别扭', tone: 'cold' },
  { signs: [-1, -1, -1], label: '蔫蔫的',  tone: 'cold' },
]

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round = (v, digits = 3) => Number(v.toFixed(digits))
const unit = (v) => clamp((Number(v) - 5.5) / 4.5, -1, 1)

/**
 * Big Five -> PAD 人格基线。
 * 采用 ALMA / Mehrabian 被广泛引用的线性转换（Gebhard 2005；MDPI Electronics 2026, 15(8):1691）。
 * trait 为 1..10，先归一到 [-1,1]；stability 视为反向神经质。
 */
export function personalityToPad(traits = {}) {
  const o = unit(traits.openness ?? 5.5)
  const e = unit(traits.extraversion ?? 5.5)
  const a = unit(traits.agreeableness ?? 5.5)
  const s = unit(traits.stability ?? 5.5)
  const c = unit(traits.conscientiousness ?? 5.5)
  const n = -s
  return {
    p: round(clamp(0.21 * e + 0.59 * a + 0.19 * n, -1, 1)),
    a: round(clamp(0.15 * o + 0.30 * a + 0.57 * n, -1, 1)),
    d: round(clamp(0.25 * o + 0.17 * c + 0.60 * e - 0.32 * a, -1, 1)),
  }
}

/** clamped linear interpolation：性格把状态阈值在 [min,max] 间真实挪动（github-tamagotchi 做法）。 */
function scaleThreshold(base, traitValue, { lo, hi, direction = 1 }) {
  const t = clamp((Number(traitValue) - 1) / 9, 0, 1)
  return Math.round(clamp(base + direction * (hi - lo) * (t - 0.5), lo, hi))
}

/**
 * 性格 -> 状态机阈值 / 情绪反应性 / 衰减率。
 * 这些值会真的喂给 nextState，不是展示用的假数据。
 */
export function deriveThresholds(traits = {}) {
  const openness = Number(traits.openness ?? 5.5)
  const extraversion = Number(traits.extraversion ?? 5.5)
  const stability = Number(traits.stability ?? 5.5)
  const conscientiousness = Number(traits.conscientiousness ?? 5.5)
  return {
    // 越开放越容易觉得无聊，越外向越容易想找人，越尽责越能撑到低精力
    explore: scaleThreshold(65, openness, { lo: 48, hi: 82, direction: -1 }),
    social: scaleThreshold(70, extraversion, { lo: 52, hi: 86, direction: -1 }),
    create: scaleThreshold(70, openness, { lo: 56, hi: 84, direction: -1 }),
    sleep: scaleThreshold(15, conscientiousness, { lo: 8, hi: 24, direction: 1 }),
    // 神经质（稳定度低）放大负性情绪、减慢衰减
    negativeGain: round(0.7 + 0.6 * (1 - clamp((stability - 1) / 9, 0, 1)), 3),
    decayFactor: round(0.75 + 0.5 * clamp((stability - 1) / 9, 0, 1), 3),
    reactivity: 0.7,
  }
}

/** 事件评价：按 OCC 的 desirability/praiseworthiness/likelihood 算情绪强度，人格调制负性放大。 */
export function appraise(eventKind, { thresholds, extra = 0 } = {}) {
  const tpl = EVENT_APPRAISALS[eventKind]
  if (!tpl) return null
  const emotion = EMOTIONS[tpl.emotion]
  const valence = emotion.valence
  const gain = valence < 0 ? (thresholds?.negativeGain ?? 1) : 1
  const intensity = clamp(
    (0.35 + 0.45 * Math.abs(tpl.desirability) + 0.20 * Math.abs(tpl.praiseworthiness)) *
      (thresholds?.reactivity ?? 0.7) * gain * (0.5 + 0.5 * tpl.likelihood) + extra,
    0, 1,
  )
  return {
    id: tpl.emotion,
    label: emotion.label,
    valence,
    arousal: emotion.arousal,
    color: emotion.color,
    intensity: round(intensity),
    pad: emotion.pad,
    decayMin: emotion.decayMin / (thresholds?.decayFactor ?? 1),
    agency: tpl.agency,
    at: null,
  }
}

export function createAffectState(traits = {}, now = Date.now()) {
  const baseline = personalityToPad(traits)
  return {
    baseline,
    mood: { ...baseline },
    active: [],
    emotion: null,
    cause: '',
    history: [],
    updatedAt: now,
  }
}

/** 反序列化时容错：字段缺失/类型错误一律回退，不让插件起不来。 */
export function normalizeAffect(raw, traits = {}, now = Date.now()) {
  const base = createAffectState(traits, now)
  if (!raw || typeof raw !== 'object') return base
  const baseline = personalityToPad(traits)
  const num = (v, fallback) => (Number.isFinite(v) ? clamp(v, -1, 1) : fallback)
  return {
    baseline,
    mood: {
      p: num(raw.mood?.p, baseline.p),
      a: num(raw.mood?.a, baseline.a),
      d: num(raw.mood?.d, baseline.d),
    },
    active: Array.isArray(raw.active)
      ? raw.active.slice(0, 12).filter((e) => e && EMOTIONS[e.id]).map((e) => ({
          ...e,
          intensity: clamp(Number(e.intensity) || 0, 0, 1),
          at: Number.isFinite(e.at) ? e.at : now,
          pad: EMOTIONS[e.id].pad,
          color: EMOTIONS[e.id].color,
        }))
      : [],
    emotion: raw.emotion && EMOTIONS[raw.emotion.id] ? raw.emotion : null,
    cause: typeof raw.cause === 'string' ? raw.cause : '',
    history: Array.isArray(raw.history)
      ? raw.history.slice(-48).filter((h) => h && Number.isFinite(h.at))
      : [],
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  }
}

function moodOctant(mood) {
  const signs = [mood.p, mood.a, mood.d].map((v) => (v >= 0 ? 1 : -1))
  return OCTANTS.find((o) => o.signs.every((s, i) => s === signs[i])) ?? OCTANTS[2]
}

/**
 * 推进三层状态。
 * @param {object} affect   normalizeAffect 的结果
 * @param {object} input    { traits, vars, state, events: string[], now }
 * @returns 新的 affect（不修改入参）
 */
export function advanceAffect(affect, { traits = {}, vars = {}, state = 'rest', events = [], now = Date.now() } = {}) {
  const baseline = personalityToPad(traits)
  const thresholds = deriveThresholds(traits)
  const elapsedMin = Math.max(0, Math.min((now - affect.updatedAt) / 60_000, 24 * 60))

  // 1) 短期情绪：指数衰减（ALMA：情绪绑定具体事件、快速消退）
  let active = affect.active.map((e) => ({
    ...e,
    intensity: round(e.intensity * Math.exp(-elapsedMin / Math.max(1, e.decayMin))),
  })).filter((e) => e.intensity > 0.02)

  // 2) 事件评价 -> 新情绪（OCC）
  const derived = [...events, ...implicitEvents(vars, state, elapsedMin)]
  for (const kind of derived) {
    const e = appraise(kind, { thresholds })
    if (!e) continue
    active.push({ ...e, at: now, kind })
  }
  active = active.slice(-12)

  // 3) 心情：活跃情绪的 PAD 签名加权成「目标心情」，单步最多挪动 0.22，
  //    避免多个情绪连番叠加把三轴推到 ±1 饱和（PaulusAI 的 fold-in 思路，改为有界趋近）
  const mood = { ...affect.mood }
  let weight = 0
  const pull = { p: 0, a: 0, d: 0 }
  for (const e of active) {
    const w = e.intensity
    pull.p += e.pad[0] * w
    pull.a += e.pad[1] * w
    pull.d += e.pad[2] * w
    weight += w
  }
  if (weight > 0) {
    for (const key of ['p', 'a', 'd']) {
      const target = clamp(baseline[key] + (pull[key] / weight) * 0.8, -1, 1)
      mood[key] = round(clamp(mood[key] + clamp(target - mood[key], -0.22, 0.22), -1, 1))
    }
  }
  // 无新事件时缓慢回到人格基线（PaulusAI：每轮回约 15%）
  const regress = Math.min(0.9, 0.15 * Math.max(0, elapsedMin / 5))
  for (const key of ['p', 'a', 'd']) {
    mood[key] = round(clamp(mood[key] + (baseline[key] - mood[key]) * regress * (weight > 0 ? 0.35 : 1), -1, 1))
  }

  // 4) 主导情绪 = 当前强度最高的活跃情绪
  const dominant = active.reduce((best, e) => (!best || e.intensity > best.intensity ? e : best), null)
  const octant = moodOctant(mood)

  // 5) 历史采样（给趋势图用），最多 48 点
  const sample = {
    at: now,
    p: mood.p,
    a: mood.a,
    d: mood.d,
    mood: octant.label,
    emotion: dominant?.label ?? '平静',
    intensity: dominant?.intensity ?? 0,
    energy: Math.round(clampNumber(vars.energy, 0, 100, 0)),
    valence: round(clamp(mood.p, -1, 1)),
  }
  const history = [...affect.history, sample].slice(-48)

  return {
    baseline,
    mood,
    active,
    emotion: dominant
      ? { id: dominant.id, label: dominant.label, valence: dominant.valence, arousal: dominant.arousal, color: dominant.color, intensity: dominant.intensity, at: dominant.at, kind: dominant.kind ?? '' }
      : null,
    cause: dominant?.kind ? (EVENT_APPRAISALS[dominant.kind] ? describeCause(dominant.kind) : affect.cause) : '暂时没什么情绪波动',
    octant: { label: octant.label, tone: octant.tone },
    history,
    updatedAt: now,
  }
}

/** 没有外部事件时，内部变量本身也会触发情绪（生理需求 / 昼夜 / 无聊）。 */
function implicitEvents(vars, state, elapsedMin) {
  const out = []
  if ((vars.energy ?? 100) <= 20) out.push('low_energy')
  if ((vars.boredom ?? 0) >= 70) out.push('high_boredom')
  if ((vars.socialNeed ?? 0) >= 75) out.push('high_social_need')
  if (elapsedMin >= 180 && !out.length) out.push('long_idle')
  return out
}

function describeCause(kind) {
  const map = {
    state_sleep: '刚睡下，整个人松下来了',
    state_rest: '正在休息，没什么事要操心',
    state_explore: '发现点新东西，想去看一看',
    state_social: '有人可以说说话，挺高兴',
    state_create: '手上有想做的东西，越做越起劲',
    decision: '自己拿了个主意',
    memory_anchor: '有件事被认真记住了',
    approval: '你点头同意了它提的事',
    platform_message: '外面来了条新消息',
    platform_interact: '刚在外面跟人搭了句话',
    low_energy: '精力见底，有点撑不住',
    high_boredom: '好久没有新鲜事，闷了',
    high_social_need: '太久没跟人说话，有点慌',
    long_idle: '安安静静待太久了',
    error: '刚才有件事没办利索',
  }
  return map[kind] ?? kind
}

/**
 * 情绪在环上的显示位置：不是目录点本身，而是连续计算的——
 * 方向由事件触发的情绪种类决定（种子点方向），离中心多远由强度决定（越强越靠外），
 * 再被最近的心情（底色）拉偏一点。同一个「开心」，心情差时位置就往左偏。
 * 依据：Russell 环状本是连续空间，离散标签只是典型区域（Russell 1980）；
 * 心情调制情绪表达见 ALMA / VirtualHuman。
 */
export function displayPosition(seed, intensity, mood) {
  const reach = 0.3 + 0.7 * clamp(Number(intensity) || 0, 0, 1)
  const drift = 0.3
  return {
    valence: round(clamp((seed?.valence ?? 0) * reach + (mood?.p ?? 0) * drift, -1, 1)),
    arousal: round(clamp((seed?.arousal ?? 0) * reach + (mood?.a ?? 0) * drift, -1, 1)),
  }
}

/** 组装给网页用的展示结构（只读，不产生副作用）。 */
export function presentAffect(affect, traits = {}, vars = {}) {
  const thresholds = deriveThresholds(traits)
  const personality = TRAIT_KEYS.map((key) => ({
    key, label: TRAIT_LABELS[key], value: Math.round(clampNumber(traits[key], 1, 10, 5)),
  }))
  const mood = {
    p: round(affect.mood.p), a: round(affect.mood.a), d: round(affect.mood.d),
    label: affect.octant?.label ?? moodOctant(affect.mood).label,
    tone: affect.octant?.tone ?? moodOctant(affect.mood).tone,
    baseline: affect.baseline,
  }
  const emotion = affect.emotion
    ? { ...affect.emotion, cause: affect.cause, display: displayPosition(affect.emotion, affect.emotion.intensity, affect.mood) }
    : { id: 'calm', label: '平静', valence: 0, arousal: 0, color: '#8b97ad', intensity: 0, cause: affect.cause || '暂时没什么情绪波动', display: { valence: 0, arousal: 0 } }

  const factors = buildFactors(traits, vars, thresholds, affect)
  const plain = plainState(emotion, mood)
  // 情绪坐标表随接口下发，前端不再维护第二份常量
  const catalog = Object.entries(EMOTIONS).map(([id, e]) => ({
    id, label: e.label, valence: e.valence, arousal: e.arousal, color: e.color,
  }))
  return {
    personality,
    mood,
    emotion,
    plain,
    catalog,
    active: affect.active.map((e) => ({ id: e.id, label: e.label, intensity: e.intensity, color: e.color, valence: e.valence, arousal: e.arousal })),
    factors,
    thresholds,
    history: affect.history,
    updatedAt: affect.updatedAt,
  }
}

/** 影响状态的因素：主页第二层展开时展示，每一项都对应真实计算。 */
function buildFactors(traits, vars, thresholds, affect) {
  const pct = (v) => `${Math.round((v ?? 0) * 100)}%`
  return [
    { key: 'traits', label: '性格底色', value: '长期', effect: '决定它本来是什么脾气、遇到事反应多大', weight: 0.9 },
    { key: 'events', label: '刚发生的事', value: affect.active.length ? `${affect.active.length} 件` : '无', effect: '刚发生的事会立刻影响心情', weight: affect.active.length ? 0.7 : 0.1 },
    { key: 'energy', label: '精力', value: `${Math.round(vars.energy ?? 0)}/100`, effect: '太低会没精神、想睡觉', weight: clamp(1 - (vars.energy ?? 100) / 100, 0, 1) },
    { key: 'boredom', label: '有多无聊', value: `${Math.round(vars.boredom ?? 0)}/100`, effect: `≥${thresholds.explore} 就会想找点新鲜事（好奇心越重越容易闲不住）`, weight: clamp((vars.boredom ?? 0) / 100, 0, 1) },
    { key: 'socialNeed', label: '想不想找人', value: `${Math.round(vars.socialNeed ?? 0)}/100`, effect: `≥${thresholds.social} 就想找人说说话（越外向越黏人）`, weight: clamp((vars.socialNeed ?? 0) / 100, 0, 1) },
    { key: 'neuroticism', label: '容易往坏处想', value: `×${thresholds.negativeGain}`, effect: '越敏感，不开心的事越难过去', weight: clamp((thresholds.negativeGain - 0.7) / 0.6, 0, 1) },
    { key: 'time', label: '情绪会自己淡', value: pct(0.15), effect: '过一阵子会慢慢回到它本来的脾气', weight: 0.45 },
  ]
}

/** 给普通用户的一句话状态：把 PAD / 八分体翻译成日常词。 */
export function plainState(emotion, mood) {
  const feel = !emotion || emotion.id === 'calm' ? '挺平静' : emotion.label
  const p = mood?.p ?? 0
  const a = mood?.a ?? 0
  const energy = a > 0.35 ? '挺有精神' : a < -0.35 ? '有点蔫' : '不紧不慢'
  const good = p > 0.35 ? '心情不错' : p < -0.35 ? '有点低落' : '心情平平'
  const want = a > 0.35 ? '正想找点事做' : a < -0.35 ? '想安安静静待着' : '就这么待着挺好'
  return { headline: feel + '，' + energy, detail: good + '，' + want + '。', moodWord: good, energyWord: energy }
}
