import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createDecision, actionGapOk } from '../src/decision/index.js'
import { createScheduler } from '../src/decision/scheduler.js'
import { createInitialState, nextState, planFor, tickState } from '../src/decision/state.js'
import { isQuietAt } from '../src/config.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

test('行为计划：创作入口接本地画图执行器，按策略决定审批', () => {
  const create = planFor('create', { policy: 'ask' })
  assert.equal(create.scope, 'local')
  assert.equal(create.executor, 'local-draw')
  assert.equal(create.requiresApproval, true)
  assert.equal(create.policy, 'ask')
  assert.equal(planFor('create', { policy: 'auto' }).requiresApproval, false)
  assert.equal(planFor('create', { policy: 'off' }).policy, 'off')
  const explore = planFor('explore', { policy: 'auto' })
  assert.equal(explore.scope, 'platform')
  assert.equal(explore.executor, 'douyin-round')
  assert.equal(explore.requiresApproval, false)
  assert.match(explore.text, /抖音/)
  assert.doesNotMatch(explore.text, /B站/)
  const social = planFor('social', { policy: 'off' })
  assert.equal(social.requiresApproval, false)
  assert.match(social.text, /主人/)
})

test('策略：updatePolicy 落盘，重启后仍保留', () => {
  const dir = tmpDir('decision-policy')
  const config = testConfig(dir)
  const first = createDecision({ config, logger: silentLogger() })
  first.updatePolicy({ explore: 'auto', create: 'off' })
  assert.deepEqual(first.getInternalState().policy, { explore: 'auto', social: 'ask', create: 'off' })
  const second = createDecision({ config, logger: silentLogger() })
  assert.deepEqual(second.getInternalState().policy, { explore: 'auto', social: 'ask', create: 'off' })
})

test('待确认：重启后从磁盘恢复，取走后再次重启不再出现', () => {
  const dir = tmpDir('decision-pending')
  const config = testConfig(dir)
  fs.mkdirSync(path.dirname(config.decision.pendingPath), { recursive: true })
  fs.writeFileSync(config.decision.pendingPath, JSON.stringify({
    items: [{
      id: 'p1', at: Date.now(), state: 'explore', label: '自主探索', reason: '测试',
      plan: { kind: 'explore', text: '去抖音逛一圈', executor: 'douyin-round', preview: { detail: '刷一轮' } },
    }],
  }))
  const first = createDecision({ config, logger: silentLogger() })
  assert.equal(first.getInternalState().pending.length, 1, '重启后要恢复待确认')
  const item = first.takePending('p1')
  assert.equal(item.id, 'p1')
  const second = createDecision({ config, logger: silentLogger() })
  assert.equal(second.getInternalState().pending.length, 0, '取走后不能又冒出来')
})

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

test('调度：每类动作独立计算日上限与间隔，重启后仍保留用量', () => {
  const dir = tmpDir('sched-actions')
  const config = testConfig(dir, {
    decision: { actionLimits: { explore: { dailyBudget: 2, gapMs: 60 * 60_000 } } },
  })
  const now = new Date('2026-11-14T10:00:00+08:00').getTime()
  const scheduler = createScheduler({
    config,
    now,
    random: () => 0.5,
    persisted: { used: 0, nextWakeAt: 1, lastActivity: now - 60 * 60_000 },
  })
  assert.equal(scheduler.canAction('explore', now), true)
  scheduler.recordAction('explore', now)
  assert.equal(scheduler.canAction('explore', now + 1000), false, '间隔没到不能重复')
  assert.equal(scheduler.canAction('explore', now + 60 * 60_000), true, '间隔到了且未满 2 次')

  scheduler.recordAction('explore', now + 60 * 60_000)
  assert.equal(scheduler.canAction('explore', now + 2 * 60 * 60_000), false, '到日上限')
  const snapshot = scheduler.snapshot(now + 60 * 60_000)
  assert.equal(snapshot.actionLimits.explore.usedToday, 2)
  assert.equal(snapshot.actionLimits.explore.dailyBudget, 2)

  const reloaded = createScheduler({
    config,
    now: now + 2 * 60 * 60_000,
    random: () => 0.5,
    persisted: scheduler.persistable(),
  })
  assert.equal(reloaded.snapshot(now + 2 * 60 * 60_000).actionLimits.explore.usedToday, 2, '重启后仍保留当天用量')
  assert.equal(reloaded.canAction('explore', now + 2 * 60 * 60_000), false)
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
