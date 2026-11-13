// 私信队列：状态标记与轮询退避（纯函数部分，不碰浏览器）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { markQueued, nextPollDelay } from '../src/platform/douyin/listen.js'

test('私信会话快照：自己消息识别包含自身/父级类名，并有左右位置兜底', () => {
  const src = fs.readFileSync(new URL('../src/platform/douyin/inbox.js', import.meta.url), 'utf8')
  assert.match(src, /el\.matches\(/)
  assert.match(src, /content\.closest\(/)
  assert.match(src, /rightSide/)
})

test('私信队列：能标记批准/忽略，未知 id 返回 false', () => {
  const state = { queue: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }] }
  assert.equal(markQueued(state, 'a', 'approved'), true)
  assert.equal(state.queue[0].status, 'approved')
  assert.ok(state.queue[0].decidedAt > 0)
  assert.equal(markQueued(state, 'zzz', 'ignored'), false)
})

test('私信轮询：几秒一轮，退避封顶 30 秒（实时优先）', () => {
  assert.equal(nextPollDelay({ backoff: 0 }, 30), 30_000)
  assert.equal(nextPollDelay({ backoff: 0 }, 5), 5_000)
  assert.equal(nextPollDelay({ backoff: 0 }, 3), 3_000)
  // 配得比下限还低按 3 秒兜底
  assert.equal(nextPollDelay({ backoff: 0 }, 1), 3_000)
  // 退避再久也不超过 30 秒
  assert.equal(nextPollDelay({ backoff: 5 * 60_000 }, 5), 30_000)
  assert.equal(nextPollDelay({ backoff: 60 * 60_000 }, 5), 30_000)
})
