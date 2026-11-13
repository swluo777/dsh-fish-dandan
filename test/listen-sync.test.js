// 监听标签页被关掉后，设置里的开关必须一起关掉；这里测写回与失败兜底。
import test from 'node:test'
import assert from 'node:assert/strict'
import { markListenDisabled } from '../src/platform/douyin/listener.js'

function logger() {
  const logs = []
  return { logs, warn: (m) => logs.push(String(m)) }
}

test('标签页没了：把 douyin.listen.enabled 写回 false', () => {
  const calls = []
  const log = logger()
  const settings = { get: () => ({ douyin: { listen: { enabled: true } } }), patch: (p) => calls.push(p) }
  const ok = markListenDisabled(settings, log)
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ douyin: { listen: { enabled: false } } }])
  assert.ok(log.logs[0].includes('开关已同步关闭'))
})

test('写盘失败：返回 false，不抛异常，日志说清原因', () => {
  const log = logger()
  const settings = { get: () => ({ douyin: { listen: { enabled: true } } }), patch: () => { throw new Error('磁盘满了') } }
  const ok = markListenDisabled(settings, log)
  assert.equal(ok, false)
  assert.ok(log.logs[0].includes('磁盘满了'))
})

test('没有设置存储：返回 false，不假装已写回', () => {
  const log = logger()
  const ok = markListenDisabled(null, log)
  assert.equal(ok, false)
  assert.ok(log.logs[0].includes('开关状态没能写回'))
})
