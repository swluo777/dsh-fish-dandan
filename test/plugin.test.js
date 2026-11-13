import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

// 避免测试把 info 日志写进真实 data/plugin.log
process.env.LOG_LEVEL = 'error'

function fakeContext() {
  const calls = { sections: [], contexts: [], routes: [], events: [], effects: [], tools: [] }
  const child = {
    systemPrompt: {
      section: (spec) => { calls.sections.push(spec); return () => {} },
      context: (spec) => { calls.contexts.push(spec); return () => {} },
    },
    tools: {
      register: (spec) => { calls.tools.push(spec); return () => {} },
    },
    webServer: {
      register: (route) => { calls.routes.push(route); return () => {} },
    },
  }
  const disposers = []
  const ctx = {
    on: (event) => { calls.events.push(event) },
    inject: (deps, callback) => callback(child),
    effect: (fn, label) => {
      calls.effects.push(label)
      const dispose = fn()
      const off = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(off)
      return off
    },
  }
  return { ctx, calls, disposers }
}

function config(dir) {
  return {
    persona: { corePath: path.join(dir, 'persona', 'core.json'), auditPath: path.join(dir, 'persona', 'audit.jsonl') },
    memory: { dbPath: path.join(dir, 'memory', 'memory.db'), jsonlPath: path.join(dir, 'memory', 'memory.jsonl') },
    decision: { statePath: path.join(dir, 'state', 'decision.json'), schedulerPath: path.join(dir, 'state', 'scheduler.json') },
  }
}

test('插件装配：注册人格段、记忆上下文、决策循环与 GUI 路由', async () => {
  const { apply } = await import('../src/index.js')
  const { mkdtempSync } = await import('node:fs')
  const os = await import('node:os')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-dandan-plugin-'))
  const { ctx, calls, disposers } = fakeContext()

  apply(ctx, config(dir))

  assert.equal(calls.sections.length, 1)
  assert.equal(calls.sections[0].name, 'fish-dandan:persona')
  assert.equal(typeof calls.sections[0].text, 'function')
  assert.match(calls.sections[0].text({}), /大肥鱼/)
  assert.ok(calls.tools.some((tool) => tool.name === 'fish_memory_search'), '主对话要能主动查长期记忆')

  assert.equal(calls.contexts.length, 4, '记忆上下文 + 语料 + 首次见面 + 心气上下文')
  assert.equal(calls.contexts[0].name, 'fish-dandan:memory')
  assert.equal(typeof calls.contexts[0].text, 'function')
  assert.equal(calls.contexts[1].name, 'fish-dandan:voice-corpus', '现成的说法每轮轮换')
  assert.equal(typeof calls.contexts[1].text, 'function')
  assert.equal(calls.contexts[2].name, 'fish-dandan:first-meet', '首次见面只出现一次')
  assert.equal(typeof calls.contexts[2].text, 'function')
  assert.equal(calls.contexts[3].name, 'fish-dandan:inner-state', '心情/精力每轮注入')
  assert.equal(typeof calls.contexts[3].text, 'function')

  assert.ok(calls.events.includes('agent/pre-step'))
  assert.ok(calls.routes.length >= 10)
  assert.ok(calls.effects.includes('fish-dandan:decision-loop'))
  assert.ok(calls.effects.includes('fish-dandan:teardown'))

  // 卸载：调用所有清理函数不应抛错
  for (const dispose of disposers) {
    assert.equal(typeof dispose, 'function')
    dispose()
  }
})

test('插件装配：pre-step 必须透传 next 的结果', async () => {
  const { apply } = await import('../src/index.js')
  const { mkdtempSync } = await import('node:fs')
  const os = await import('node:os')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-dandan-pre-step-'))

  let preStep
  const child = { systemPrompt: { section: () => () => {}, context: () => () => {} }, webServer: { register: () => () => {} } }
  const ctx = {
    on: (event, fn) => { if (event === 'agent/pre-step') preStep = fn },
    inject: (deps, callback) => callback(child),
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  apply(ctx, config(dir))
  assert.equal(typeof preStep, 'function')

  const marker = { enter: true }
  const result = await preStep({}, async () => marker)
  assert.equal(result, marker)
})

test('GUI 路由：非本机来源被拒绝', async () => {
  const { apply } = await import('../src/index.js')
  const { mkdtempSync } = await import('node:fs')
  const os = await import('node:os')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-dandan-guard-'))

  const routes = []
  const child = { systemPrompt: { section: () => () => {}, context: () => () => {} }, webServer: { register: (route) => { routes.push(route); return () => {} } } }
  const ctx = { on: () => {}, inject: (deps, callback) => callback(child), effect: (fn) => (typeof fn() === 'function' ? fn() : () => {}) }

  apply(ctx, config(dir))
  const overview = routes.find((route) => route.path === '/fish-dandan/api/overview')
  assert.ok(overview)

  const res = { statusCode: 0, headers: {}, body: '', headersSent: false, writeHead(s, h) { this.statusCode = s; this.headers = h; this.headersSent = true }, end(b = '') { this.body += b } }
  await overview.handler({ method: 'GET', headers: {}, socket: { remoteAddress: '10.0.0.9' }, url: '/fish-dandan/api/overview' }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN')
})
