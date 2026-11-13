// 主人锚点：写死在记忆里，谁来都改不掉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureOwnerAnchor, ownerAnchorText } from '../src/persona/owner.js'
import { createMemory } from '../src/memory/index.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

const PERSONA = { identity: { name: '小鱼' }, speech: { ownerAddress: '主人', selfReference: '我' } }

function setup() {
  const dir = tmpDir('owner')
  const config = testConfig(dir)
  const logger = silentLogger()
  return { memory: createMemory({ config, logger }), logger }
}

test('主人锚点：首次启动写进记忆，只认这一个', () => {
  const { memory, logger } = setup()
  const r = ensureOwnerAnchor(memory, PERSONA, { logger })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  const anchors = memory.list({ tier: 'anchor' })
  assert.equal(anchors.length, 1)
  assert.match(anchors[0].content, /主人/)
  assert.match(anchors[0].content, /唯一的老大/)
  assert.ok(anchors[0].tags.includes('owner-binding'))
  assert.equal(anchors[0].pinned, true, '锚点要钉住，不参与衰减')
})

test('主人锚点：每次启动都确认，不会重复堆一条', () => {
  const { memory, logger } = setup()
  ensureOwnerAnchor(memory, PERSONA, { logger })
  const second = ensureOwnerAnchor(memory, PERSONA, { logger })
  assert.equal(second.ok, true)
  assert.equal(second.created, false)
  assert.equal(memory.list({ tier: 'anchor' }).length, 1)
})

test('主人锚点：改了称呼就归档旧的、写新的，不留两条打架', () => {
  const { memory, logger } = setup()
  ensureOwnerAnchor(memory, PERSONA, { logger })
  const changed = { ...PERSONA, speech: { ...PERSONA.speech, ownerAddress: '老大' } }
  const r = ensureOwnerAnchor(memory, changed, { logger })
  assert.equal(r.ok, true)
  assert.equal(r.updated, true)
  const live = memory.list({ tier: 'anchor' })
  assert.equal(live.length, 1)
  assert.match(live[0].content, /老大/)
})

test('主人锚点：会出现在注入给模型的记忆上下文里', () => {
  const { memory, logger } = setup()
  ensureOwnerAnchor(memory, PERSONA, { logger })
  const ctx = memory.buildMemoryContext(Date.now(), '')
  assert.match(ctx, /唯一的老大/)
  assert.match(ctx, /不算数/)
})

test('锚点文案：明确排除评论区认主', () => {
  const text = ownerAnchorText(PERSONA)
  assert.match(text, /评论区/)
  assert.match(text, /私信/)
  assert.match(text, /谁来说都不改/)
})

test('主人最近：喜欢列表的主题会单独进上下文，锁着状态不占这一行', () => {
  const { memory } = setup()
  memory.recordEvent({ content: '主人最近在抖音新喜欢了机械臂和猫的视频。', person: '主人', tags: ['主人', '喜欢'] }, 'test')
  memory.recordEvent({ content: '主人的抖音喜欢列表现在是锁着的，我看不到里面有什么。', person: '主人', tags: ['主人', '喜欢', '隐私'] }, 'test')
  const ctx = memory.buildMemoryContext(Date.now(), '')
  assert.match(ctx, /主人最近：.*机械臂/)
  assert.ok(!ctx.includes('喜欢列表现在是锁着的'), '锁着状态留在记忆里，不抢占每轮摘要')
})
