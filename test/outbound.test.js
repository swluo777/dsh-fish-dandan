import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOutboundLog } from '../src/platform/douyin/outbound.js'

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-outbound-')), 'outbound.json')
}

test('出站账本：记下刚发的私信，监听能认出自己的回音', () => {
  const pathName = tempPath()
  const log = createOutboundLog({ path: pathName, now: () => 1000 })
  assert.equal(log.record('主人', '今天想你了'), true)
  assert.equal(log.isEcho('主人', '今天想你了'), true)
  assert.equal(log.isEcho('别人', '今天想你了'), false)
})

test('出站账本：短句只认完全相等，不吞对方的「好」', () => {
  const pathName = tempPath()
  const log = createOutboundLog({ path: pathName, now: () => 1000 })
  log.record('主人', '好')
  assert.equal(log.isEcho('主人', '好'), true)
  assert.equal(log.isEcho('主人', '好呀'), false)
})

test('出站账本：超过十分钟自动过期，不拦住新的真消息', () => {
  const pathName = tempPath()
  let clock = 1000
  const log = createOutboundLog({ path: pathName, now: () => clock })
  log.record('主人', '刚才那句是我说的')
  assert.equal(log.isEcho('主人', '刚才那句是我说的'), true)
  clock += 11 * 60_000
  assert.equal(log.isEcho('主人', '刚才那句是我说的'), false)
})

test('出站账本：坏文件/没有文件时不抛异常', () => {
  const log = createOutboundLog({ path: tempPath(), now: () => 1000 })
  assert.equal(log.isEcho('主人', '随便一句'), false)
  assert.equal(log.record('', '空的'), false)
})
