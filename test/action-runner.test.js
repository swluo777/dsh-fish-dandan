import test from 'node:test'
import assert from 'node:assert/strict'
import { createActionRunner } from '../src/decision/action-runner.js'

function fakeDecision() {
  const state = { policy: { explore: 'auto', social: 'ask', create: 'ask' } }
  const activities = []
  return {
    state,
    activities,
    getInternalState: () => state,
    setActivity: (a) => { activities.push(a); state.activity = a; return a },
  }
}

function fakeDouyin() {
  const rounds = []
  let settle = null
  return {
    rounds,
    settings: () => ({ douyin: { browse: { enabled: true }, actions: { dm: true }, listen: { ownerName: '主人' } } }),
    login: { snapshot: () => ({ status: 'connected' }) },
    startRound(why, options = {}) {
      const round = { id: `round-${rounds.length + 1}`, task: options.task || 'explore', owner: options.owner || 'manual' }
      rounds.push({ why, options, round })
      return { ok: true, round, detail: '值班中' }
    },
    stopRound() { return { ok: true } },
    roundSnapshot() { return { running: false } },
    onRoundSettled(fn) { settle = fn; return () => { settle = null } },
    settle(result) { if (settle) settle(result) },
  }
}

test('执行器：自主探索启动、结算后活动完成', () => {
  const decision = fakeDecision()
  const dy = fakeDouyin()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => dy })
  const r = runner.start('explore', { trigger: 'state' })
  assert.equal(r.ok, true)
  assert.equal(dy.rounds[0].options.task, 'explore')
  assert.equal(runner.snapshot().status, 'running')
  dy.settle({ round: dy.rounds[0].round, ok: true, lastRun: { detail: '刷了 6 条' } })
  assert.equal(runner.snapshot().status, 'done')
  assert.match(runner.snapshot().detail, /刷了 6 条/)
})

test('执行器：同一时间只允许一个活动', () => {
  const decision = fakeDecision()
  const dy = fakeDouyin()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => dy })
  runner.start('explore', { trigger: 'manual' })
  const second = runner.start('social', { trigger: 'manual' })
  assert.equal(second.ok, false)
  assert.match(second.reason, /正在/)
})

test('执行器：社交任务只发主人，发出后完成', () => {
  const decision = fakeDecision()
  const dy = fakeDouyin()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => dy })
  const r = runner.start('social', { trigger: 'approval' })
  assert.equal(r.ok, true)
  assert.equal(dy.rounds[0].options.task, 'social')
  assert.equal(dy.rounds[0].options.owner, 'social')
  dy.settle({ round: dy.rounds[0].round, ok: true, socialSent: true })
  assert.equal(runner.snapshot().status, 'done')
  assert.match(runner.snapshot().detail, /主人/)
})

test('执行器：社交在发出前被停止，活动记取消', async () => {
  const decision = fakeDecision()
  const dy = fakeDouyin()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => dy })
  runner.start('social', { trigger: 'manual' })
  await runner.stop('主人手动停止')
  dy.settle({ round: dy.rounds[0].round, ok: false })
  assert.equal(runner.snapshot().status, 'cancelled')
})

function fakeDraw() {
  const calls = []
  return {
    calls,
    preview: () => ({
      text: '画一张发呆的手稿',
      detail: '它会用当前心情和表情包当参考，画一张手绘稿放到桌面。',
      payload: { stickerId: 'st-1' },
    }),
    async draw(options = {}) {
      calls.push(options)
      options.onProgress?.('正在铺纸、起稿…')
      if (options.isCancelled?.()) return { ok: false, cancelled: true, reason: '已经停下' }
      return { ok: true, pngPath: 'C:/Users/test/Desktop/大肥鱼创作.png', htmlPath: 'C:/tmp/draw.html', plan: { seed: 7 }, ms: 1200 }
    },
  }
}

function waitTick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('执行器：专注创作接本地画图，跑完把产物写进活动', async () => {
  const decision = fakeDecision()
  const draw = fakeDraw()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => fakeDouyin(), getDraw: () => draw })
  const r = runner.start('create', { trigger: 'manual' })
  assert.equal(r.ok, true)
  assert.equal(runner.snapshot().status, 'running')
  await waitTick()
  assert.equal(runner.snapshot().status, 'done')
  assert.match(runner.snapshot().detail, /桌面/)
  assert.equal(runner.snapshot().result.pngPath, 'C:/Users/test/Desktop/大肥鱼创作.png')
  assert.equal(draw.calls.length, 1)
  assert.equal(draw.calls[0].trigger, 'manual')
})

test('执行器：审批执行沿用待确认里的画图计划，不临时换一张', async () => {
  const decision = fakeDecision()
  const draw = fakeDraw()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => fakeDouyin(), getDraw: () => draw })
  const approved = { seed: 424242, mood: { key: 'happy' }, copy: { lines: ['已经看过的句子。'] } }
  const pending = { id: 'p1', state: 'create', plan: { kind: 'create', executor: 'local-draw', payload: { plan: approved } } }
  const r = runner.start('create', { trigger: 'approval', pending })
  assert.equal(r.ok, true)
  await waitTick()
  assert.equal(draw.calls.length, 1)
  assert.equal(draw.calls[0].plan.seed, 424242)
  assert.equal(draw.calls[0].trigger, 'approval')
  assert.equal(runner.snapshot().status, 'done')
})

test('执行器：画图失败时活动记失败，不抛出', async () => {
  const decision = fakeDecision()
  const draw = { preview: () => ({ text: '画一张', detail: '画', payload: {} }), draw: async () => ({ ok: false, reason: '共享浏览器没有准备好' }) }
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => fakeDouyin(), getDraw: () => draw })
  runner.start('create', { trigger: 'state' })
  await waitTick()
  assert.equal(runner.snapshot().status, 'failed')
  assert.match(runner.snapshot().detail, /浏览器/)
})

test('执行器：画图可以中途停止，活动记取消', async () => {
  const decision = fakeDecision()
  let release
  const draw = {
    preview: () => ({ text: '画一张', detail: '画', payload: {} }),
    draw: async ({ isCancelled }) => {
      await new Promise((resolve) => { release = resolve })
      return isCancelled() ? { ok: false, cancelled: true } : { ok: true, pngPath: 'x.png' }
    },
  }
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => fakeDouyin(), getDraw: () => draw })
  runner.start('create', { trigger: 'manual' })
  const stop = await runner.stop('主人手动停止')
  assert.equal(stop.ok, true)
  assert.equal(runner.snapshot().status, 'cancelled')
  release()
  await waitTick()
  assert.equal(runner.snapshot().status, 'cancelled')
})

test('执行器：没有画图模块时明确跳过，不假装成功', () => {
  const decision = fakeDecision()
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => fakeDouyin(), getDraw: () => null })
  const r = runner.start('create', { trigger: 'state' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /画图模块没有准备好/)
  assert.equal(runner.snapshot().status, 'skipped')
})

test('执行器：平台页权限没开时，手动社交不启动并提示去平台页打开', () => {
  const decision = fakeDecision()
  const dy = fakeDouyin()
  dy.settings = () => ({ douyin: { browse: { enabled: false }, actions: { dm: true }, listen: { ownerName: '主人' } } })
  const runner = createActionRunner({ config: { platforms: { enabled: true } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => dy })
  const r = runner.start('social', { trigger: 'manual' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /平台页的刷抖音权限没打开/)
  assert.match(r.reason, /「允许它用抖音」/)
  assert.match(r.reason, /「平台」页/)
  assert.match(r.reason, /立即触发一次/)
  assert.equal(runner.snapshot().status, 'skipped')
  assert.equal(dy.rounds.length, 0)
})

test('执行器：平台基座总开关关闭不影响抖音本地动作，仍以「允许它用抖音」为准', () => {
  const decision = fakeDecision()
  const dy = fakeDouyin()
  dy.settings = () => ({ douyin: { browse: { enabled: true }, actions: { dm: true }, listen: { ownerName: '主人' } } })
  const runner = createActionRunner({ config: { platforms: { enabled: false } }, logger: { info() {}, warn() {} }, decision, getDouyin: () => dy })
  const r = runner.start('social', { trigger: 'manual' })
  assert.equal(r.ok, true)
  assert.equal(dy.rounds.length, 1)
  assert.equal(dy.rounds[0].options.task, 'social')
  dy.settle({ round: dy.rounds[0].round, ok: true, socialSent: true })
  assert.equal(runner.snapshot().status, 'done')
})
