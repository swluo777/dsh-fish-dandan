// ============================================================
// 状态机：五个内部变量 + 五个状态
// 纯函数：给定当前状态和经过时间，算出新状态与建议行为
// 可注入随机源，保证单测可复现
// ============================================================

import { clampNumber } from '../utils/text.js'

export const STATES = ['sleep', 'rest', 'explore', 'social', 'create']

export const STATE_LABELS = {
  sleep: '睡眠',
  rest: '休息',
  explore: '自主探索',
  social: '社交互动',
  create: '专注创作',
}

export const VAR_LABELS = {
  energy: '精力',
  mood: '心情',
  boredom: '无聊值',
  socialNeed: '社交需求',
  creativeUrge: '创作欲',
}

/** 状态对应的行为计划；external 表示会碰到外部世界，必须人工确认。 */
export const ACTIONS = {
  sleep: { kind: 'sleep', text: '安静睡觉，谁也不打扰', external: false, tools: [] },
  rest: { kind: 'rest', text: '发呆、整理记忆，顺手做点小事', external: false, tools: ['memory'] },
  explore: { kind: 'explore', text: '去抖音/B站逛一圈，把看到的有意思的东西记下来', external: true, tools: ['browse', 'memory'] },
  social: { kind: 'social', text: '找主人或熟人聊两句，看看对方在忙什么', external: true, tools: ['message', 'memory'] },
  create: { kind: 'create', text: '画画或剪一段视频，把脑子里的东西做出来', external: true, tools: ['art', 'video', 'memory'] },
}

const INITIAL_VARS = { energy: 82, mood: 62, boredom: 22, socialNeed: 30, creativeUrge: 45 }

/**
 * 进入各状态的阈值（低于退出线才离开，形成迟滞，避免抖动）。
 * 阈值可由 ALMA 性格层注入（deriveThresholds），不传时保持原有数值，
 * 保证既有行为与测试不变。
 */
export const DEFAULT_THRESHOLDS = {
  sleep: 15,
  create: 70,
  social: 70,
  explore: 65,
  createEnergy: 45,
  socialEnergy: 35,
  exploreEnergy: 30,
}

const ENTER = {
  sleep: (v, t) => v.energy <= t.sleep,
  create: (v, t) => v.creativeUrge >= t.create && v.energy >= t.createEnergy,
  social: (v, t) => v.socialNeed >= t.social && v.energy >= t.socialEnergy,
  explore: (v, t) => v.boredom >= t.explore && v.energy >= t.exploreEnergy,
}

const EXIT = {
  sleep: (v) => v.energy >= 70,
  create: (v) => v.creativeUrge < 40,
  social: (v) => v.socialNeed < 40,
  explore: (v) => v.boredom < 40,
}

export function createInitialState(now = Date.now()) {
  return {
    vars: { ...INITIAL_VARS },
    state: 'rest',
    since: now,
    lastTick: now,
    lastAction: null,
    // 首屏会把这句当成它的台词，所以写人话，不写调试语
    reason: '刚被装进来，还谁都不认识，先歇着',
    updatedAt: now,
  }
}

/** 把任意输入规范化成可用的状态对象（文件损坏也不崩）。 */
export function normalizeState(raw, now = Date.now()) {
  const base = createInitialState(now)
  if (!raw || typeof raw !== 'object') return base
  const vars = {}
  for (const key of Object.keys(INITIAL_VARS)) {
    vars[key] = Math.round(clampNumber(raw.vars?.[key], 0, 100, INITIAL_VARS[key]))
  }
  return {
    vars,
    state: STATES.includes(raw.state) ? raw.state : 'rest',
    since: Number.isFinite(raw.since) ? raw.since : now,
    lastTick: Number.isFinite(raw.lastTick) ? raw.lastTick : now,
    lastAction: typeof raw.lastAction === 'string' ? raw.lastAction : null,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  }
}

function clampVars(vars) {
  // 内部保留两位小数：以前每 tick 直接 Math.round，会把 0.03/分 这种慢增量抹成 0，
  // 导致精力永远回不满、状态机基本不切换（2026-11-11 审计发现）。展示时再取整。
  for (const key of Object.keys(vars)) vars[key] = Math.round(clampNumber(vars[key], 0, 100, INITIAL_VARS[key]) * 100) / 100
  return vars
}

/**
 * 推进内部变量。经过时间上限 24 小时，避免长时间关机后数值跳变。
 * @param {object} state
 * @param {number} now
 * @param {{ random?: () => number }} [options]
 */
export function tickState(state, now, { random = Math.random } = {}) {
  const elapsedMs = Math.max(0, Math.min(now - state.lastTick, 24 * 3_600_000))
  const minutes = elapsedMs / 60_000
  if (minutes <= 0) return { ...state, vars: { ...state.vars }, updatedAt: now }

  const v = { ...state.vars }
  const sleeping = state.state === 'sleep'
  const resting = state.state === 'rest'

  // 精力：睡 +0.12/分，休息 +0.03/分，其他 -0.08/分
  const energyRate = sleeping ? 0.12 : resting ? 0.03 : -0.08
  v.energy += energyRate * minutes

  // 无聊：睡觉不累积，探索/社交/创作消耗，其余缓慢累积
  const boredomRate = sleeping ? 0 : state.state === 'explore' ? -1.2 : state.state === 'social' ? -0.6 : state.state === 'create' ? -0.8 : 0.1
  v.boredom += boredomRate * minutes

  // 社交需求：社交时下降，其余上升
  v.socialNeed += (state.state === 'social' ? -1.0 : 0.06) * minutes

  // 创作欲：创作时下降，其余缓慢上升；偶发灵感
  v.creativeUrge += (state.state === 'create' ? -0.9 : 0.04) * minutes
  if (!sleeping && minutes >= 1 && random() < Math.min(0.5, minutes * 0.006)) {
    v.creativeUrge += 6
    v.mood += 2
  }

  // 心情缓慢回归 55，社交时略微上扬
  v.mood += (55 - v.mood) * 0.002 * minutes + (state.state === 'social' ? 0.05 * minutes : 0)

  clampVars(v)
  return { ...state, vars: v, lastTick: now, updatedAt: now }
}

/**
 * 决定下一个状态。带迟滞与最短停留，避免边界抖动。
 * @param {object} state
 * @param {number} now
 * @param {{ minDwellMs: number }} options
 */
export function nextState(state, now, { minDwellMs = 15 * 60_000, thresholds = null } = {}) {
  const v = state.vars
  const current = state.state
  const dwelled = now - state.since >= minDwellMs
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) }

  if (current === 'sleep') {
    if (v.energy >= 70) return { state: 'rest', reason: `精力恢复到 ${v.energy}，睡醒了` }
    return { state: 'sleep', reason: `还在睡，精力 ${v.energy}` }
  }

  if (ENTER.sleep(v, t)) return { state: 'sleep', reason: `精力只剩 ${v.energy}，撑不住了` }

  // 迟滞：当前状态的退出条件没满足就保持
  const exitMet = EXIT[current] ? EXIT[current](v) : true
  if (!exitMet) {
    return { state: current, reason: `留在${STATE_LABELS[current]}（${explainHold(current, v)}）` }
  }
  if (!dwelled && current !== 'rest') {
    return { state: current, reason: `刚进入${STATE_LABELS[current]}，再待一会儿` }
  }

  if (ENTER.create(v, t)) return { state: 'create', reason: `创作欲 ${v.creativeUrge}，手痒了` }
  if (ENTER.social(v, t)) return { state: 'social', reason: `社交需求 ${v.socialNeed}，想找人说说话` }
  if (ENTER.explore(v, t)) return { state: 'explore', reason: `无聊值 ${v.boredom}，得找点新鲜事` }
  return { state: 'rest', reason: v.boredom < 30 && v.socialNeed < 40 ? '没什么特别想做的，歇着' : '先缓一缓' }
}

function explainHold(state, v) {
  if (state === 'create') return `创作欲 ${v.creativeUrge} 还没降下来`
  if (state === 'social') return `社交需求 ${v.socialNeed} 还没满足`
  if (state === 'explore') return `无聊值 ${v.boredom} 还高`
  return '状态稳定'
}

/**
 * 依据状态给出行为计划。
 * @param {string} state
 * @param {{ autoExternal?: boolean }} [options]
 */
export function planFor(state, { autoExternal = false } = {}) {
  const action = ACTIONS[state] ?? ACTIONS.rest
  return {
    kind: action.kind,
    text: action.text,
    external: action.external,
    tools: [...action.tools],
    requiresApproval: action.external && !autoExternal,
  }
}

