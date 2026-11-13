import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDmEpisodeMemory,
  DM_EPISODE_GAP_MS,
  DM_WRITE_COOLDOWN_MS,
} from '../src/platform/douyin/dm-memory.js'

function makeMemory() {
  const writes = []
  return {
    writes,
    recordEvent(event, source) {
      writes.push({ event, source })
      return { ok: true, id: `m${writes.length}` }
    },
  }
}

test('私信记忆：10 分钟内的连续聊天合成一段，静默后才写一条', async () => {
  let clock = 1000
  const memory = makeMemory()
  const dmMemory = createDmEpisodeMemory({
    memory,
    now: () => clock,
    autoFlush: false,
    summarize: (ep) => `今天和主人聊了：${ep.incoming.join('；')}`,
  })

  dmMemory.note({ name: '思维_', isOwner: true, incoming: '今天项目过了', outgoing: '太好了', at: clock })
  clock += 5 * 60_000
  dmMemory.note({ name: '思维_', isOwner: true, incoming: '晚上去吃火锅', outgoing: '好耶', at: clock })
  assert.equal(dmMemory.pending().length, 1, '五分钟后还是同一段')

  clock += 9 * 60_000
  await dmMemory.flushDue(clock)
  assert.equal(memory.writes.length, 0, '最后一条才过 9 分钟，不能收尾')

  clock += 60_001
  await dmMemory.flushDue(clock)
  assert.equal(memory.writes.length, 1, '静默超过 10 分钟，整段只写一条')
  assert.match(memory.writes[0].event.content, /今天项目过了/)
  assert.match(memory.writes[0].event.content, /晚上去吃火锅/)
  assert.equal(memory.writes[0].event.person, '主人')
  assert.ok(memory.writes[0].event.tags.includes('主人'))
})

test('私信记忆：刚过静默阈值又聊起来，15 分钟冷却会把它压到下一段再合写', async () => {
  let clock = 1000
  const memory = makeMemory()
  const dmMemory = createDmEpisodeMemory({
    memory,
    now: () => clock,
    autoFlush: false,
    summarize: (ep) => `和主人聊了：${ep.incoming.join('；')}`,
  })

  dmMemory.note({ name: '思维_', isOwner: true, incoming: '第一段', outgoing: '收到', at: clock })
  clock = 1000 + DM_EPISODE_GAP_MS + 1
  await dmMemory.flushDue(clock)
  assert.equal(memory.writes.length, 1)

  // 刚写完 1 分钟又开一段：不能立刻再堆一条，要等冷却结束。
  clock += 60_000
  dmMemory.note({ name: '思维_', isOwner: true, incoming: '第二段', outgoing: '嗯', at: clock })
  clock = 1000 + DM_EPISODE_GAP_MS + 1 + DM_WRITE_COOLDOWN_MS - 1
  await dmMemory.flushDue(clock)
  assert.equal(memory.writes.length, 1, '冷却没到，不能连写')

  clock += 1
  await dmMemory.flushDue(clock)
  assert.equal(memory.writes.length, 2)
  assert.match(memory.writes[1].event.content, /第二段/)
})

test('私信记忆：陌生人只写轻量印象，昵称会被遮成「一个网友」', async () => {
  let clock = 1000
  const memory = makeMemory()
  const dmMemory = createDmEpisodeMemory({
    memory,
    now: () => clock,
    autoFlush: false,
    summarize: () => '路人今天说想去看海，心情不错',
  })

  dmMemory.note({ name: '路人', isOwner: false, memoryAllowed: false, incoming: '我想去看海', outgoing: '那就去呀', at: clock })
  clock += DM_EPISODE_GAP_MS + 1
  await dmMemory.flushDue(clock)

  assert.equal(memory.writes.length, 1)
  assert.equal(memory.writes[0].event.person, '网友')
  assert.ok(memory.writes[0].event.tags.includes('网友'))
  assert.ok(!memory.writes[0].event.tags.includes('路人'))
  assert.match(memory.writes[0].event.content, /一个网友/)
  assert.ok(!memory.writes[0].event.content.includes('路人'))
})

test('私信记忆：纯寒暄没有可记内容，不占记忆库', async () => {
  let clock = 1000
  const memory = makeMemory()
  const dmMemory = createDmEpisodeMemory({
    memory,
    now: () => clock,
    autoFlush: false,
  })

  dmMemory.note({ name: '路人', isOwner: false, incoming: '在吗', outgoing: '在', at: clock })
  clock += DM_EPISODE_GAP_MS + 1
  await dmMemory.flushDue(clock)
  assert.equal(memory.writes.length, 0, '没有摘要内容就不写')
})
