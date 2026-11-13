// 心情判断：收集一轮对话 → 调模型 → 写回 decision（假 ctx / 假 llm）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachMoodJudge } from '../src/decision/mood-judge.js'

function fakeCtx(handlers) {
  return {
    on(name, fn) { handlers[name] = fn; return () => {} },
  }
}

async function wait(ms = 60) { return new Promise((r) => setTimeout(r, ms)) }

const fakeLlm = {
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: '{"moodDelta":6,"energyDelta":-3,"reason":"被夸了","confidence":0.8}' }
    })()
  },
}

test('心情判断：收一轮对话后触发一次，参数正确', async () => {
  const handlers = {}
  const calls = []
  const decision = { applyMood: (r) => { calls.push(r); return { ok: true, delta: { mood: r.moodDelta, energy: r.energyDelta }, reason: r.reason } } }
  attachMoodJudge(fakeCtx(handlers), { logger: { info() {}, warn() {} }, decision, llm: fakeLlm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } })

  const session = { id: 's1' }
  // 结构按本机会话日志核实：user/message 的 data 就是消息本身
  handlers['session/event'](session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '你真可爱' }] } })
  // assistant/message 的 data 是 { turn, step, message, usage }
  handlers['session/event'](session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '才没有呢' }] } } })
  handlers['agent/turn-stopping']({ agent: { id: 's1' }, turn: 1 })
  await wait()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].moodDelta, 6)
  assert.equal(calls[0].energyDelta, -3)
  assert.equal(calls[0].reason, '被夸了')
})

test('心情判断：5 分钟内不重复判断', async () => {
  const handlers = {}
  let count = 0
  const decision = { applyMood: () => { count += 1; return { ok: true, delta: { mood: 1, energy: 0 }, reason: 'x' } } }
  attachMoodJudge(fakeCtx(handlers), { logger: { info() {}, warn() {} }, decision, llm: fakeLlm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } })

  const session = { id: 's2' }
  handlers['session/event'](session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '在吗' }] } })
  handlers['agent/turn-stopping']({ agent: { id: 's2' } })
  await wait()
  handlers['agent/turn-stopping']({ agent: { id: 's2' } })
  await wait()
  assert.equal(count, 1)
})

test('心情判断：没有模型服务时静默跳过，不崩', async () => {
  const handlers = {}
  attachMoodJudge(fakeCtx(handlers), { logger: { info() {}, warn() {} }, decision: { applyMood: () => ({ ok: true }) }, llm: null, defaultModel: null })
  const session = { id: 's3' }
  handlers['session/event'](session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '喂' }] } })
  assert.doesNotThrow(() => handlers['agent/turn-stopping']({ agent: { id: 's3' } }))
  await wait()
})
