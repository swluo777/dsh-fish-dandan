// ============================================================
// 状态机与自主决策（03）
// 用内部状态决定「做什么」，用有界调度决定「何时做」
// 对外动作一律进待确认队列，不自动执行
// ============================================================

import path from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { fromRoot } from '../utils/paths.js'
import { truncate } from '../utils/text.js'
import { createScheduler } from './scheduler.js'
import {
  createAffectState,
  normalizeAffect,
  advanceAffect,
  presentAffect,
  deriveThresholds,
  EVENT_APPRAISALS,
} from './affect.js'
import {
  ACTIONS,
  nextState,
  normalizeState,
  planFor,
  STATE_LABELS,
  STATES,
  tickState,
  VAR_LABELS,
} from './state.js'

export { STATE_LABELS, STATES, VAR_LABELS, ACTIONS }
export { personalityToPad, deriveThresholds, EMOTIONS, EVENT_APPRAISALS, TRAIT_LABELS } from './affect.js'

/** 读当前人格五维；人格模块暂不可用时退化为中性基线。 */
function safeTraits(getTraits) {
  try { return getTraits() || {} } catch { return {} }
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : fromRoot(value)
}

function normalizeActionInput(input) {
  if (typeof input !== 'string') return null
  const key = input.trim().toLowerCase()
  if (STATES.includes(key)) return key
  for (const [state, label] of Object.entries(STATE_LABELS)) {
    if (input.trim() === label) return state
  }
  for (const [state, action] of Object.entries(ACTIONS)) {
    if (key === action.kind) return state
  }
  return null
}

/** 同类行为是否已经过了最小间隔；`gapMs <= 0` 表示不限制。 */
export function actionGapOk(lastAt, now, gapMs) {
  if (!gapMs || gapMs <= 0) return true
  return !lastAt || now - lastAt >= gapMs
}

/**
 * 创建决策服务。
 * @param {{ config: object, logger: object, random?: () => number }} deps
 */
export function createDecision({ config, logger, random = Math.random, getTraits = () => ({}) }) {
  const statePath = resolvePath(config.decision.statePath)
  const schedulerPath = resolvePath(config.decision.schedulerPath)
  const affectPath = resolvePath(config.decision.affectPath || 'data/state/affect.json')
  const startedAt = Date.now()
  const traitsNow = () => safeTraits(getTraits)

  let state = normalizeState(
    readJsonSafe(statePath, null, (err) => logger.warn(`决策状态读取失败，使用初始值：${err.message}`)),
    startedAt,
  )
  // ALMA 三层：心情基线来自人格，情绪与历史从磁盘恢复
  let affect = normalizeAffect(
    readJsonSafe(affectPath, null, (err) => logger.warn(`情感状态读取失败，使用初始值：${err.message}`)),
    traitsNow(), startedAt,
  )
  let affectEvents = []
  const scheduler = createScheduler({
    config,
    now: startedAt,
    persisted: readJsonSafe(schedulerPath, null, (err) => logger.warn(`调度状态读取失败：${err.message}`)),
    random,
  })

  let override = null
  let lastDecision = null
  const pending = []
  const lastActionAt = new Map()

  function persist() {
    try {
      writeJsonAtomic(statePath, state)
      writeJsonAtomic(schedulerPath, scheduler.persistable())
      writeJsonAtomic(affectPath, affect)
    } catch (err) {
      logger.warn(`决策状态写入失败：${err.message}`)
    }
  }

  /** 推进状态变量、状态与三层情感；返回本次是否发生状态切换。 */
  function tick(now = Date.now()) {
    const before = state.state
    const traits = traitsNow()
    state = tickState(state, now, { random })
    // 性格衍生的阈值真实喂给状态机，不是只用于展示
    const picked = nextState(state, now, {
      minDwellMs: config.decision.minDwellMs,
      thresholds: deriveThresholds(traits),
    })
    state.reason = picked.reason
    const changed = picked.state !== before
    if (changed) {
      state = { ...state, state: picked.state, since: now }
      logger.info(`状态切换：${STATE_LABELS[before]} → ${STATE_LABELS[picked.state]}（${picked.reason}）`)
    }
    state.updatedAt = now

    const events = affectEvents
    affectEvents = []
    if (changed) events.push(`state_${picked.state}`)
    affect = advanceAffect(affect, { traits, vars: state.vars, state: state.state, events, now })

    persist()
    return { changed, from: before, to: state.state, reason: picked.reason }
  }

  /** 外部事件（人工确认、锚定、平台消息…）经 OCC 评价进入情感层。 */
  function noteEvent(kind, now = Date.now()) {
    if (!EVENT_APPRAISALS[kind]) return { ok: false, reason: '未知事件类型' }
    const traits = traitsNow()
    affect = advanceAffect(affect, { traits, vars: state.vars, state: state.state, events: [kind], now })
    persist()
    return { ok: true, kind }
  }

  /**
   * 模型判出来的「这一轮心情往哪走」（学 dsh-feiyu-mood）：
   * 同时改状态变量（影响状态机阈值）和情感层 PAD（影响显示的心情），
   * 并记一条原因。不是关键词硬猜——调用方负责给出判断依据。
   */
  function applyMood({ moodDelta = 0, energyDelta = 0, reason = '', confidence = 0 } = {}, now = Date.now()) {
    const clampNum = (v, min, max) => Math.max(min, Math.min(max, v))
    const dm = clampNum(Math.round(Number(moodDelta) || 0), -15, 15)
    const de = clampNum(Math.round(Number(energyDelta) || 0), -10, 10)
    if (!dm && !de) return { ok: false, reason: '没有变化' }
    const vars = state.vars || {}
    state.vars = {
      ...vars,
      mood: clampNum(Math.round((Number(vars.mood) || 50) + dm), 0, 100),
      energy: clampNum(Math.round((Number(vars.energy) || 50) + de), 0, 100),
    }
    state.updatedAt = now
    state.reason = String(reason || '心情有变化').slice(0, 80)
    // 情感层：PAD 里的 p（愉悦）跟着涨跌，a（唤醒）跟着精力走
    const mood = affect && affect.mood ? affect.mood : { p: 0, a: 0, d: 0 }
    affect = {
      ...affect,
      mood: {
        ...mood,
        p: clampNum(Number(mood.p || 0) + dm / 40, -1, 1),
        a: clampNum(Number(mood.a || 0) + de / 60, -1, 1),
      },
    }
    persist()
    return {
      ok: true,
      mood: state.vars.mood,
      energy: state.vars.energy,
      delta: { mood: dm, energy: de },
      confidence: Number(confidence) || 0,
      reason: state.reason,
    }
  }

  /** 主页用的三层状态视图（性格 / 心情 / 情绪 / 影响因素 / 历史）。 */
  function getAffect() {
    return presentAffect(affect, traitsNow(), state.vars)
  }

  /** 依据当前状态（或 nudge 覆盖）给出下一步计划。 */
  function decideNext(context = {}) {
    const now = context.now ?? Date.now()
    const base = {
      at: now,
      state: state.state,
      label: STATE_LABELS[state.state],
      reason: state.reason,
      source: 'state-machine',
    }
    const active = activeOverride(now)
    if (active) {
      const plan = planFor(active.state, { autoExternal: config.decision.autoExternal })
      state.lastAction = plan.text
      lastDecision = { ...base, state: active.state, label: STATE_LABELS[active.state], reason: active.reason || '人工指定', plan, source: 'nudge' }
      return lastDecision
    }
    const plan = planFor(state.state, { autoExternal: config.decision.autoExternal })
    state.lastAction = plan.text
    lastDecision = { ...base, plan }
    return lastDecision
  }

  /** 人工 nudge：临时把状态掰到指定方向，到期自动失效。 */
  function nudge(action, { ttlMs = 30 * 60_000, reason = '人工 nudge' } = {}) {
    const target = normalizeActionInput(action)
    if (!target) throw new Error(`未知状态：${action}`)
    const now = Date.now()
    override = { state: target, at: now, expiresAt: now + Math.max(60_000, ttlMs), reason }
    logger.info(`收到人工 nudge：切到${STATE_LABELS[target]}，${Math.round(ttlMs / 60_000)} 分钟后失效`)
    return { ok: true, state: target, expiresAt: override.expiresAt }
  }

  /** 读取当前有效的 nudge；过期就地清掉，别让界面一直显示「人工指定中」。 */
  function activeOverride(now = Date.now()) {
    if (override && override.expiresAt <= now) override = null
    return override
  }

  function clearNudge() {
    override = null
    return { ok: true }
  }

  /** 取出一条待确认动作（取出即移除，避免重复执行）。 */
  function takePending(id) {
    const index = pending.findIndex((item) => item.id === id)
    if (index < 0) return null
    const [item] = pending.splice(index, 1)
    return item
  }

  /** 执行抛错时把动作放回队列，别让它凭空消失（审计发现：以前会永久丢）。 */
  function restorePending(item) {
    if (!item || !item.id) return
    if (pending.some((p) => p.id === item.id)) return
    pending.unshift(item)
    while (pending.length > 20) pending.pop()
  }

  function recordActivity(now = Date.now()) {
    const previous = scheduler.snapshot(now).lastActivity
    scheduler.recordActivity(now)
    // 模型每一步都会走到这里，落盘按分钟节流，避免频繁写文件
    if (now - previous > 60_000) persist()
  }

  /**
   * 挂载调度循环。返回 disposer；插件卸载时由 ctx.effect 自动清理，无残留定时器。
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ memory?: object, onDecision?: (decision: object) => void }} [hooks]
   */
  function attach(ctx, { memory, onDecision } = {}) {
    if (!config.decision.enabled) {
      logger.info('自主决策已关闭（decision.enabled=false）')
      return () => {}
    }
    return ctx.effect(() => {
      let stopped = false
      let timer = null

      const arm = () => {
        if (stopped) return
        timer = setTimeout(loop, config.decision.tickIntervalMs)
        if (typeof timer.unref === 'function') timer.unref()
      }

      const loop = () => {
        if (stopped) return
        const now = Date.now()
        try {
          const change = tick(now)
          if (change.changed) {
            memory?.recordEvent?.(
              {
                content: `状态从「${STATE_LABELS[change.from]}」切到「${STATE_LABELS[change.to]}」：${change.reason}`,
                importance: 3,
                tags: ['decision', change.to],
                summary: change.reason,
              },
              'decision',
            )
            // 睡眠时顺手整理记忆：不阻塞对话，失败只记日志
            if (change.to === 'sleep' && config.decision.reviewOnSleep && typeof memory?.dailyReview === 'function') {
              Promise.resolve()
                .then(() => memory.dailyReview())
                .then((result) => logger.info(`睡眠复盘完成：新增 ${result.created} 条特质`))
                .catch((err) => logger.warn(`睡眠复盘失败：${err.message}`))
            }
          }

          if (scheduler.canWake(now)) {
            const decision = decideNext({ now })
            const kind = decision.plan.kind
            if (!actionGapOk(lastActionAt.get(kind), now, config.decision.minActionGapMs)) {
              logger.info(`「${kind}」距上次不到 ${Math.round(config.decision.minActionGapMs / 60000)} 分钟，跳过本次唤醒`)
              scheduler.recordActivity(now)
            } else {
              scheduler.recordWake(now)
              lastActionAt.set(kind, now)
              const line = `自主唤醒：${decision.label}｜${decision.plan.text}（${decision.reason}）`
              logger.info(line)
              if (decision.plan.requiresApproval) {
                pending.push({ ...decision, status: 'pending', id: `${now}-${pending.length}` })
                while (pending.length > 20) pending.shift()
                logger.info('该行为涉及对外操作，已进入待确认队列')
              }
              memory?.recordEvent?.(
                {
                  content: `自主决策：${decision.label}。计划：${decision.plan.text}。理由：${decision.reason}`,
                  importance: 4,
                  tags: ['decision', decision.state],
                  summary: truncate(decision.plan.text, 60),
                },
                'decision',
              )
              onDecision?.(decision)
              affectEvents.push('decision')
            }
          }
          // tick() 已落盘一次；这里再落一次是为了保存 scheduler 的唤醒计数
          persist()
        } catch (err) {
          logger.error(`决策循环异常：${err.message}`)
        }
        arm()
      }

      arm()
      logger.info(`决策循环已启动（每 ${Math.round(config.decision.tickIntervalMs / 1000)} 秒推进一次）`)

      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
        timer = null
        persist()
        logger.info('决策循环已停止，定时器已清理')
      }
    }, 'fish-dandan:decision-loop')
  }

  function getInternalState() {
    const ov = activeOverride()
    return {
      state: state.state,
      label: STATE_LABELS[state.state],
      vars: { ...state.vars },
      since: state.since,
      reason: state.reason,
      lastAction: state.lastAction,
      override: ov ? { ...ov } : null,
      pending: pending.map((p) => ({ id: p.id, at: p.at, state: p.state, label: p.label, plan: p.plan, reason: p.reason })),
      lastDecision,
      scheduler: scheduler.snapshot(),
      affect: getAffect(),
    }
  }

  function updateScheduler(patch) {
    const result = scheduler.update(patch)
    persist()
    return result
  }

  return {
    tick,
    decideNext,
    nudge,
    clearNudge,
    takePending,
    restorePending,
    attach,
    recordActivity,
    getInternalState,
    updateScheduler,
    // 现在能不能醒（含静默时段 + 每日预算）；给抖音的自唤醒之类外部循环用
    canWake: (at = Date.now()) => scheduler.canWake(at),
    getAffect,
    noteEvent,
    applyMood,
  }
}

export { normalizeState } from './state.js'
