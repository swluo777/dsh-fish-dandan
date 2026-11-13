// 行为流水账：去重、按天统计、落盘、给发声用的最近文本
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createJournal } from '../src/platform/douyin/journal.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

function setup() {
  const dir = tmpDir('journal')
  const config = testConfig(dir, {
    platforms: { douyin: { journalPath: path.join(dir, 'state', 'douyin-journal.json') } },
  })
  return { config, logger: silentLogger() }
}

const COMMENT = {
  type: 'comment', videoId: '7401', videoUrl: 'https://www.douyin.com/video/7401',
  videoCaption: '猫咪的日常', text: '这个挺有意思的', reason: '当时雀跃，就评论了', mood: '雀跃',
}

test('流水账：记一笔、五分钟内同样的不重复记', () => {
  const { config, logger } = setup()
  const store = createJournal({ config, logger })
  const a = store.record(COMMENT)
  assert.ok(a && a.id, '应生成 id')
  const again = store.record({ ...COMMENT })
  assert.equal(again.id, a.id, '同一句话连着说两次只记一条')
  store.record({ ...COMMENT, type: 'reply', target: { author: '路人', text: '怎么做的？' }, text: '我回头查查' })
  assert.equal(store.list().length, 2)
})

test('流水账：最新的在最前面，今日计数按类型分开', () => {
  const { config, logger } = setup()
  const store = createJournal({ config, logger })
  store.record({ ...COMMENT, type: 'like', text: '' })
  store.record({ ...COMMENT, text: '第二句' })
  const list = store.list()
  assert.equal(list[0].text, '第二句', '后发生的排前面')
  const c = store.counts()
  assert.equal(c.today, 2)
  assert.equal(c.byType.like, 1)
  assert.equal(c.byType.comment, 1)
})

test('流水账：重启后还在（落盘）', () => {
  const { config, logger } = setup()
  const first = createJournal({ config, logger })
  first.record(COMMENT)
  const second = createJournal({ config, logger })
  const list = second.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].videoId, '7401')
  assert.equal(list[0].text, '这个挺有意思的')
  assert.equal(list[0].mood, '雀跃')
})

test('流水账：最近说过的句子给发声模块去重', () => {
  const { config, logger } = setup()
  const store = createJournal({ config, logger })
  store.record({ ...COMMENT, text: '这句说过了' })
  store.record({ ...COMMENT, type: 'like', text: '' })
  assert.deepEqual(store.recentTexts(), ['这句说过了'])
})

test('流水账：坏数据不会让插件起不来', () => {
  const { config, logger } = setup()
  const store = createJournal({ config, logger })
  store.record({ type: 'comment', text: '正常一条' })
  store.record({ type: '', text: '缺类型' })
  const list = store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].text, '正常一条')
})
