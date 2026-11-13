import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePersonName, normalizeMemoryAllow, resolveDmAccess } from '../src/platform/douyin/memory-access.js'

test('昵称清洗：去首尾空格与开头 @，最多 40 字', () => {
  assert.equal(normalizePersonName('  @阿明  '), '阿明')
  assert.equal(normalizePersonName('x'.repeat(50)).length, 40)
})

test('记忆名单：去空、去重、去主人，不设人数上限', () => {
  const many = Array.from({ length: 30 }, (_, i) => `朋友${i + 1}`)
  assert.deepEqual(
    normalizeMemoryAllow([' 主人 ', '阿明', '@阿明', '', ...many], '主人'),
    ['阿明', ...many],
  )
})

test('权限解析：主人始终可用；名单内可用；名单外只用上下文', () => {
  const opts = { ownerName: '主人', memoryAllow: ['阿明'] }
  assert.deepEqual(resolveDmAccess('主人', opts), { name: '主人', isOwner: true, memoryAllowed: true })
  assert.deepEqual(resolveDmAccess('阿明', opts), { name: '阿明', isOwner: false, memoryAllowed: true })
  assert.deepEqual(resolveDmAccess('路人', opts), { name: '路人', isOwner: false, memoryAllowed: false })
  assert.equal(resolveDmAccess('主人的朋友', opts).isOwner, false, '必须是完全一致，不能包含')
})
