// 回评论标签页被关掉后，设置里的开关必须一起关；与私信监听同一套兜底。
import test from 'node:test'
import assert from 'node:assert/strict'
import { markCommentsDisabled } from '../src/platform/douyin/comment-listener.js'

function logger() {
  const logs = []
  return { logs, warn: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)) }
}

test('回评论标签页没了：把 douyin.comments.enabled 写回 false', () => {
  const calls = []
  const log = logger()
  const settings = {
    get: () => ({ douyin: { comments: { enabled: true } } }),
    patch: (p) => calls.push(p),
  }
  const ok = markCommentsDisabled(settings, log)
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ douyin: { comments: { enabled: false } } }])
  assert.ok(log.logs[0].includes('回评论标签页被手动关闭'))
})

test('回评论写盘失败：返回 false，不抛异常', () => {
  const log = logger()
  const settings = {
    get: () => ({ douyin: { comments: { enabled: true } } }),
    patch: () => { throw new Error('磁盘满了') },
  }
  const ok = markCommentsDisabled(settings, log)
  assert.equal(ok, false)
  assert.ok(log.logs[0].includes('磁盘满了'))
})

test('没有设置存储：回评论不假装已写回', () => {
  const log = logger()
  const ok = markCommentsDisabled(null, log)
  assert.equal(ok, false)
  assert.ok(log.logs[0].includes('开关状态没能写回'))
})
