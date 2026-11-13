import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlatforms, normalizeEnvelope } from '../src/platform/index.js'
import { createSendGate } from '../src/platform/router.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

function mockAdapter(overrides = {}) {
  const sent = []
  return {
    platform: 'mock',
    name: '模拟平台',
    connected: false,
    capabilities: () => ['text', 'private'],
    connect() { this.connected = true },
    disconnect() { this.connected = false },
    normalize(event) {
      return {
        conversation: { kind: event.kind || 'private', externalId: event.convId || 'c1' },
        sender: { platformUserId: event.userId, displayName: event.name || '某人' },
        content: event.text,
        nativeMessageId: event.id || '',
        raw: event,
      }
    },
    send(conv, message) {
      sent.push({ conv, message })
      return { nativeId: 'n1' }
    },
    sent,
    ...overrides,
  }
}

function setup(overrides = {}) {
  const dir = tmpDir('platform')
  const config = testConfig(dir, {
    platforms: {
      enabled: true,
      requireApproval: false,
      sendDelayMs: { min: 0, max: 0 },
      maxSendsPerMinute: 5,
      identityPath: `${dir}/identity/identities.json`,
      ...overrides,
    },
  })
  const logger = silentLogger()
  const recorded = []
  const memory = { recordEvent: (...args) => recorded.push(args) }
  const platforms = createPlatforms({ config, logger, memory, random: () => 0.5, sleep: async () => {} })
  return { platforms, config, logger, recorded, memory }
}

test('归一化：缺省字段被补齐，未知会话类型降级为 unknown', () => {
  const message = normalizeEnvelope('mock', { sender: { platformUserId: 1 }, content: ' hi ' })
  assert.equal(message.platform, 'mock')
  assert.equal(message.conversation.kind, 'unknown')
  assert.equal(message.sender.platformUserId, '1')
  assert.equal(message.content, 'hi')
  assert.deepEqual(message.segments, [])
  assert.equal(message.raw, null)
})

test('适配器：缺少必需方法时拒绝注册', () => {
  const { platforms } = setup()
  assert.throws(() => platforms.defineAdapter({ platform: 'bad' }), /缺少 connect/)
  assert.equal(platforms.listCapabilities().length, 0)
})

test('平台目录：三卡并列恒在，注册适配器后 planned 转 ready', () => {
  const { platforms } = setup()
  const rows = platforms.status()
  assert.deepEqual(rows.map((r) => r.id), ['douyin', 'bilibili', 'qq'], '做抖音不能挡住 B站和 QQ')
  assert.equal(rows[0].status, 'planned', '未注册时抖音是规划中')
  assert.equal(rows[2].status, 'extensible', 'QQ 是扩展口')
  assert.ok(rows[0].detail.length > 10, '每张卡要有说明')

  platforms.defineAdapter({ ...mockAdapter(), platform: 'douyin', name: '抖音适配器', detail: '已连接' })
  const after = platforms.status()
  assert.equal(after.length, 3, '注册后仍是三张卡')
  assert.equal(after[0].status, 'ready', 'douyin 转 ready')
  assert.ok(after[0].capabilities.length >= 1)
  assert.equal(after[0].detail, '已连接')
})

test('平台目录：目录外的自定义注册（如 QQ 扩展对接）追加在尾部', () => {
  const { platforms } = setup()
  platforms.defineAdapter({ ...mockAdapter(), platform: 'qq-bridge', name: 'QQ 桥接' })
  const rows = platforms.status()
  assert.equal(rows.length, 4)
  assert.equal(rows[3].id, 'qq-bridge')
  assert.equal(rows[3].phase, '自定义扩展')
})

test('入站：归一化 → 身份 → 记忆，平台私有内容保留在 raw', async () => {
  const { platforms, recorded } = setup()
  const adapter = mockAdapter()
  platforms.defineAdapter(adapter)

  const event = { userId: 'u1', name: '小鱼', text: '在吗', id: 'm1', privateOnly: true }
  const message = await platforms.routeIncoming('mock', event)

  assert.equal(message.content, '在吗')
  assert.equal(message.conversation.kind, 'private')
  assert.equal(message.raw.privateOnly, true)
  assert.match(message.sender.unifiedPersonId, /^p_/)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0][0].person, message.sender.unifiedPersonId)
  assert.match(recorded[0][0].content, /在吗/)
})

test('身份：同一平台账号重复出现只建一个档，跨平台可合并', async () => {
  const { platforms } = setup()
  platforms.defineAdapter(mockAdapter())
  const a = await platforms.routeIncoming('mock', { userId: 'u1', text: '第一句' })
  const b = await platforms.routeIncoming('mock', { userId: 'u1', text: '第二句' })
  assert.equal(a.sender.unifiedPersonId, b.sender.unifiedPersonId)

  const other = platforms.resolveIdentity('another', 'x9')
  assert.notEqual(other.id, a.sender.unifiedPersonId)
  const merged = platforms.mergeIdentity(other.id, a.sender.unifiedPersonId)
  assert.equal(merged.id, a.sender.unifiedPersonId)
  assert.equal(merged.accounts.length, 2)
  assert.equal(platforms.listIdentities().length, 1)
})

test('出站：总开关关闭时拒绝，不调用适配器', async () => {
  const { platforms } = setup({ enabled: false })
  const adapter = mockAdapter()
  platforms.defineAdapter(adapter)
  const result = await platforms.routeOutgoing({ platform: 'mock', kind: 'private', externalId: 'c1' }, '你好')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DISABLED')
  assert.equal(adapter.sent.length, 0)
})

test('出站：需要确认但未批准时不发送', async () => {
  const { platforms } = setup({ requireApproval: true })
  const adapter = mockAdapter()
  platforms.defineAdapter(adapter)
  const conv = { platform: 'mock', kind: 'private', externalId: 'c1' }
  const refused = await platforms.routeOutgoing(conv, '你好')
  assert.equal(refused.code, 'NEEDS_APPROVAL')
  assert.equal(adapter.sent.length, 0)

  const approved = await platforms.routeOutgoing(conv, '你好', { approved: true })
  assert.equal(approved.ok, true)
  assert.equal(adapter.sent.length, 1)
})

test('出站：每分钟上限生效', async () => {
  const { platforms } = setup({ maxSendsPerMinute: 1 })
  platforms.defineAdapter(mockAdapter())
  const conv = { platform: 'mock', kind: 'private', externalId: 'c1' }
  assert.equal((await platforms.routeOutgoing(conv, '第一条')).ok, true)
  const second = await platforms.routeOutgoing(conv, '第二条')
  assert.equal(second.code, 'RATE_LIMITED')
})

test('出站闸门：并发按平台串行，延迟完才占额度，超额的不白等', async () => {
  const dir = tmpDir('gate-serial')
  const config = testConfig(dir, {
    platforms: {
      enabled: true,
      requireApproval: false,
      maxSendsPerMinute: 3,
      sendDelayMs: { min: 100, max: 100 },
    },
  })
  let clock = 0
  const sleeps = []
  const gate = createSendGate({
    config,
    logger: silentLogger(),
    sleep: async (ms) => { sleeps.push(clock); clock += ms },
    now: () => clock,
    random: () => 0,
  })
  // 6 条同时进来，只有前 3 条真正等延迟并发送，后 3 条直接限流
  const results = await Promise.all(Array.from({ length: 6 }, () => gate.check('mock')))
  assert.equal(results.filter((r) => r.ok).length, 3)
  assert.equal(results.filter((r) => r.code === 'RATE_LIMITED').length, 3)
  assert.deepEqual(sleeps, [0, 100, 200], '只有获准的发送才进入延迟，且一次只有一个在等')
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false, false], '顺序稳定，不因并发乱序')
})

test('出站：没有注册适配器时给出明确错误', async () => {
  const { platforms } = setup()
  await assert.rejects(
    () => platforms.routeOutgoing({ platform: 'ghost', kind: 'private', externalId: 'c1' }, '你好'),
    /没有注册平台适配器/,
  )
})

test('生命周期：attach 连接、卸载断开并释放适配器资源', () => {
  const { platforms } = setup()
  const adapter = mockAdapter()
  let disposed = 0
  adapter.dispose = () => { disposed += 1 }
  platforms.defineAdapter(adapter)
  let disposer = null
  const ctx = { effect: (fn) => { disposer = fn(); return disposer } }
  platforms.attach(ctx)
  assert.equal(adapter.connected, true)
  assert.equal(typeof disposer, 'function')
  disposer()
  assert.equal(adapter.connected, false)
  assert.equal(disposed, 1, '卸载时要释放刷流定时器与围观窗口')
})

test('行为计划：缺少会话时诚实拒绝，不假装执行', async () => {
  const { platforms } = setup()
  const result = await platforms.execute({ kind: 'explore', text: '去逛一圈' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /06\/07/)
})
