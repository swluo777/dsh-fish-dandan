import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollInboxOnce } from '../src/platform/douyin/listen.js'

test('私信轮询：同一个人一次来多条，只保留最新一条，旧的标 superseded', async () => {
  const state = { seen: ['别人|旧'], queue: [], lastPollAt: 0, backoff: 0 }
  const r = await pollInboxOnce({
    page: {},
    state,
    ownerName: '主人',
    now: 2000,
    read: async () => ({
      ok: true,
      items: [{ name: '主人', last: '旧消息' }, { name: '主人', last: '新消息' }],
    }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.queued.length, 2)
  assert.equal(state.queue.length, 2)
  assert.equal(state.queue[0].status, 'superseded')
  assert.equal(state.queue[1].status, 'approved')
  assert.equal(state.queue[1].last, '新消息')
})

test('私信轮询：自己刚发的回音不入队，但仍记进 seen 防止下一轮再翻出来', async () => {
  const state = { seen: ['别人|旧'], queue: [], lastPollAt: 0, backoff: 0 }
  const r = await pollInboxOnce({
    page: {},
    state,
    ownerName: '主人',
    now: 2000,
    isEcho: (name, last) => name === '主人' && last === '我刚发的话',
    read: async () => ({ ok: true, items: [{ name: '主人', last: '我刚发的话' }] }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.queued.length, 0)
  assert.equal(state.queue.length, 0)
  assert.ok(state.seen.includes('主人|我刚发的话'))
})

test('私信轮询：主人昵称精确匹配；陌生人同样自动回，但没有记忆权限', async () => {
  const state = { seen: ['别人|旧'], queue: [], lastPollAt: 0, backoff: 0 }
  const r = await pollInboxOnce({
    page: {},
    state,
    ownerName: '主人',
    memoryAllow: ['阿明'],
    now: 2000,
    read: async () => ({
      ok: true,
      items: [{ name: '主人', last: '我是主人' }, { name: '主人的朋友', last: '我是朋友' }],
    }),
  })
  assert.equal(r.ok, true)
  const byName = Object.fromEntries(state.queue.map((q) => [q.name, q]))
  assert.equal(byName['主人'].isOwner, true)
  assert.equal(byName['主人的朋友'].isOwner, false, '模糊命中不能拿到主人记忆')
  assert.equal(byName['主人'].status, 'approved', '主人消息自动回')
  assert.equal(byName['主人的朋友'].status, 'approved', '陌生人也自动回，不再排队')
  assert.equal(byName['主人'].memoryAllowed, true)
  assert.equal(byName['主人的朋友'].memoryAllowed, false)
})

test('私信轮询：记忆名单内的人自动回，并带 memoryAllowed', async () => {
  const state = { seen: ['别人|旧'], queue: [], lastPollAt: 0, backoff: 0 }
  const r = await pollInboxOnce({
    page: {},
    state,
    ownerName: '主人',
    memoryAllow: ['阿明'],
    now: 2000,
    read: async () => ({ ok: true, items: [{ name: '阿明', last: '周末去哪' }] }),
  })
  assert.equal(r.ok, true)
  assert.equal(state.queue[0].status, 'approved')
  assert.equal(state.queue[0].isOwner, false)
  assert.equal(state.queue[0].memoryAllowed, true)
})

test('私信轮询：同一个人连发不同视频卡片，未读能放进来一次，但不会每轮重复入队', async () => {
  const state = { seen: ['主人|分享[视频]'], queue: [], lastPollAt: 0, backoff: 0, mediaPulse: {} }
  let unread = true
  const read = async () => ({
    ok: true,
    items: [{ name: '主人', last: '分享[视频]', mediaHint: true, mediaKey: '', unread }],
  })
  const r1 = await pollInboxOnce({ page: {}, state, ownerName: '主人', now: 2000, read })
  assert.equal(r1.queued.length, 1, '未读的第二个视频卡片应该入队')
  const r2 = await pollInboxOnce({ page: {}, state, ownerName: '主人', now: 3000, read })
  assert.equal(r2.queued.length, 0, '同一个未读状态不能每轮重复入队')
  unread = false
  const r3 = await pollInboxOnce({ page: {}, state, ownerName: '主人', now: 4000, read })
  assert.equal(r3.queued.length, 0, '已读后清冷却，但不入队')
  unread = true
  const r4 = await pollInboxOnce({ page: {}, state, ownerName: '主人', now: 5000, read })
  assert.equal(r4.queued.length, 1, '线程读完后到来的新媒体应该重新入队')
})

test('私信轮询：平台提示不是对方消息，不入队也不自动回', async () => {
  const state = { seen: ['别人|旧'], queue: [], lastPollAt: 0, backoff: 0 }
  const notice = '对方回复或关注你之前，只能发送一条文字消息。请礼貌发言，自觉遵守《抖音自律公约》'
  const r = await pollInboxOnce({
    page: {},
    state,
    ownerName: '主人',
    now: 2000,
    read: async () => ({ ok: true, items: [{ name: '路人', last: notice }] }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.queued.length, 0)
  assert.equal(state.queue.length, 0)
  assert.ok(state.seen.includes(`路人|${notice}`), '提示也记 seen，下一轮不要翻出来')
})
