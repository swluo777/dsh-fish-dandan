import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecision, actionGapOk } from '../src/decision/index.js'
import { createScheduler } from '../src/decision/scheduler.js'
import { createInitialState, nextState, tickState } from '../src/decision/state.js'
import { isQuietAt } from '../src/config.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

test('状态推进：清醒且活动时精力下降、无聊上升', () => {
  const base = { ...createInitialState(1_000_000), state: 'explore' }
  const next = tickState(base, 1_000_000 + 60 * 60_000, { random: () => 0.99 })
  assert.ok(next.vars.energy < base.vars.energy)
  assert.ok(next.vars.boredom < base.vars.boredom) // 探索会消耗无聊值
})

test('状态推进：休息时精力缓慢恢复', () => {
  const base = { ...createInitialState(0), state: 'rest', vars: { energy: 40, mood: 50, boredom: 40, socialNeed: 40, creativeUrge: 30 } }
  const next = tickState(base, 60 * 60_000, { random: () => 0.99 })
  assert.ok(next.vars.energy > 40)
})

test('状态推进：睡眠恢复精力', () => {
  const base = { ...createInitialState(0), state: 'sleep', vars: { energy: 20, mood: 50, boredom: 40, socialNeed: 40, creativeUrge: 30 } }
  const next = tickState(base, 60 * 60_000, { random: () => 0.99 })
  assert.ok(next.vars.energy > 20)
})

test('状态机：精力过低会去睡觉，睡醒回到休息', () => {
  const state = { ...createInitialState(0), vars: { energy: 10, mood: 50, boredom: 50, socialNeed: 50, creativeUrge: 50 } }
  assert.equal(nextState(state, 3_600_000).state, 'sleep')
  const sleeping = { ...state, state: 'sleep', vars: { ...state.vars, energy: 75 } }
  assert.equal(nextState(sleeping, 7_200_000).state, 'rest')
})

test('状态机：迟滞生效，退出条件未满足不切走', () => {
  const state = {
    ...createInitialState(0),
    state: 'explore',
    since: 0,
    vars: { energy: 60, mood: 60, boredom: 50, socialNeed: 20, creativeUrge: 20 },
  }
  const picked = nextState(state, 3_600_000, { minDwellMs: 0 })
  assert.equal(picked.state, 'explore')
})

test('状态机：最短停留时间内不切走', () => {
  const state = {
    ...createInitialState(0),
    state: 'social',
    since: 0,
    vars: { energy: 60, mood: 60, boredom: 10, socialNeed: 5, creativeUrge: 10 },
  }
  const picked = nextState(state, 60_000, { minDwellMs: 15 * 60_000 })
  assert.equal(picked.state, 'social')
})

test('状态机：创作欲高时进入创作', () => {
  const state = {
    ...createInitialState(0),
    state: 'rest',
    since: 0,
    vars: { energy: 70, mood: 60, boredom: 10, socialNeed: 10, creativeUrge: 80 },
  }
  assert.equal(nextState(state, 3_600_000, { minDwellMs: 0 }).state, 'create')
})

test('决策服务：nudge 可覆盖当前状态并按期失效', () => {
  const dir = tmpDir('decision')
  const decision = createDecision({ config: testConfig(dir), logger: silentLogger() })
  decision.nudge('create', { ttlMs: 60_000, reason: '测试' })
  const state = decision.getInternalState()
  assert.equal(state.override.state, 'create')
  assert.equal(decision.decideNext({ now: Date.now() }).state, 'create')

  decision.clearNudge()
  assert.equal(decision.getInternalState().override, null)
})

test('调度：静默时段会把唤醒推到静默结束之后', () => {
  const dir = tmpDir('sched')
  const config = testConfig(dir)
  const night = new Date()
  night.setHours(23, 30, 0, 0)
  assert.equal(isQuietAt(night.getTime(), config.decision.quietHours), true)

  const scheduler = createScheduler({ config, now: night.getTime(), random: () => 0.5 })
  const next = scheduler.computeNextWake(night.getTime())
  const nextDate = new Date(next)
  assert.equal(isQuietAt(next, config.decision.quietHours), false)
  assert.ok(nextDate.getTime() > night.getTime())
  assert.equal(scheduler.canWake(night.getTime()), false)
})

test('调度：每日预算用尽后不再唤醒', () => {
  const dir = tmpDir('sched-budget')
  const config = testConfig(dir, { decision: { dailyBudget: 1 } })
  const now = Date.now()
  const scheduler = createScheduler({
    config,
    now,
    random: () => 0.5,
    persisted: { used: 1, nextWakeAt: 0, lastActivity: 0, dateKey: new Date(now).toISOString().slice(0, 10) },
  })
  assert.equal(scheduler.canWake(now), false)
})

test('调度：最小空闲未到不唤醒，记录唤醒后计数增加', () => {
  const dir = tmpDir('sched-idle')
  const config = testConfig(dir, { decision: { minIdleMs: 60 * 60_000, wakeBaseMs: 60_000, dailyBudget: 8 } })
  const now = Date.now()
  const scheduler = createScheduler({ config, now, random: () => 0.5, persisted: { used: 0, nextWakeAt: 1, lastActivity: now } })
  assert.equal(scheduler.canWake(now + 1000), false)
  scheduler.recordActivity(now - 2 * 60 * 60_000)
  scheduler.recordWake(now)
  assert.equal(scheduler.snapshot(now).usedToday, 1)
})

test('调度：参数更新做范围钳制并报错', () => {
  const dir = tmpDir('sched-update')
  const config = testConfig(dir)
  const scheduler = createScheduler({ config, now: Date.now(), random: () => 0.5 })
  const result = scheduler.update({ quietHours: { start: '25:00', end: '07:00' }, dailyBudget: 999 })
  assert.equal(result.ok, false)
  assert.equal(result.issues.length, 1)
  assert.equal(config.decision.dailyBudget, 96)
})

test('决策挂载：effect 返回清理函数，卸载不抛错', () => {
  const dir = tmpDir('decision-attach')
  const config = testConfig(dir, { decision: { enabled: true, tickIntervalMs: 5000 } })
  const decision = createDecision({ config, logger: silentLogger() })
  let disposer
  const ctx = { effect: (fn) => { disposer = fn(); return disposer } }
  const off = decision.attach(ctx, {})
  assert.equal(typeof off, 'function')
  off()
  assert.equal(typeof disposer, 'function')
})

test('防重复：同类行为在最小间隔内被跳过', () => {
  const now = 1_000_000
  assert.equal(actionGapOk(0, now, 60_000), true)
  assert.equal(actionGapOk(now - 10_000, now, 60_000), false)
  assert.equal(actionGapOk(now - 60_000, now, 60_000), true)
  assert.equal(actionGapOk(now - 1_000, now, 0), true)
})

test('配置默认值：睡眠复盘与防重复间隔已启用', () => {
  const config = testConfig(tmpDir('decision-defaults'))
  assert.equal(config.decision.reviewOnSleep, true)
  assert.equal(config.decision.minActionGapMs, 20 * 60_000)
})
