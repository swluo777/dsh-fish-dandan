// 人味管线：拆条、限长、去回音、去连接词。这几条是「像不像人」的底线，必须有测试锁住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanize, limitForComment, splitBubbles, stripEcho } from '../src/voice/humanize.js'
import { applyFlavor, maybeEmoji, maybeMeme, maybeTypo, vibeOf } from '../src/voice/flavor.js'

test('拆条：一句话里有几件事就分成几条，每条不超过 18 字', () => {
  const out = splitBubbles('诶你就甩个问号过来呀。本鱼是真打不开那个分享卡片，一直是图集卡片，你复制个链接丢过来嘛')
  assert.ok(out.length >= 3, `应该拆成多条，实际 ${out.length}`)
  for (const p of out) assert.ok(p.length <= 24, `单条太长：${p}`)
  assert.match(out[0], /问号/)
})

test('拆条：没有标点的长句也要切开，不能整段甩出去', () => {
  const out = splitBubbles('卡片的字太小了本鱼看着费劲你把它复制出来发我本鱼帮你瞧瞧写的啥')
  assert.ok(out.length >= 2, '长句必须被切开')
  for (const p of out) assert.ok(p.length <= 24)
})

test('拆条：很短的一句话不该被拆', () => {
  assert.deepEqual(splitBubbles('嗯'), ['嗯'])
  assert.deepEqual(splitBubbles('好呀'), ['好呀'])
})

test('删句首连接词：因为/所以/但是/其实 不该出现在句首', () => {
  const r = humanize('因为卡片打不开，所以我把链接发你', { strength: 'light', rng: () => 0.99 })
  assert.ok(!/^因为/.test(r.text), r.text)
  assert.ok(!/，所以/.test(r.text), r.text)
})

test('删客服尾巴：如有需要随时告诉我 这种收尾要被砍掉', () => {
  const r = humanize('图集打不开，你发个链接吧。如果还有问题随时告诉我', { strength: 'light', rng: () => 0.99 })
  assert.ok(!r.text.includes('随时告诉我'), r.text)
})

test('评论限长：超过 30 字在标点处截断，不留半句', () => {
  const long = '这条视频拍得真好看，尤其是最后那一幕，光影和节奏都特别舒服，想再看两遍'
  const out = limitForComment(long, 30)
  assert.ok(out.length <= 30, `长度 ${out.length}`)
  assert.ok(!/[，,]$/.test(out), '不能以逗号结尾')
})

test('去回音：复述对方的话要删掉，但只是开头几个字一样的不算', () => {
  assert.equal(stripEcho('我想问一下这个视频在哪里拍的？', '我想问一下这个视频在哪里拍的'), '')
  assert.equal(stripEcho('我想问一下这个视频在哪里拍的？好看', '我想问一下这个视频在哪里拍的'), '好看')
  // 碰巧开头一样但不是复述，不能删
  assert.equal(stripEcho('我想问一下这个视频在哪里拍的？我也不知道', '我想问一下这个视频在哪里拍的东西'), '我想问一下这个视频在哪里拍的？我也不知道')
})

test('嘴瓢：最多错一个字，而且只换同音字', () => {
  const text = '这条视频真好看，我在看一遍'
  const r = maybeTypo(text, { rng: () => 0.01, chance: 1 })
  assert.equal(r.changed, true)
  const diff = [...text].filter((ch, i) => ch !== r.text[i]).length
  assert.equal(diff, 1, `只该变一个字：${text} -> ${r.text}`)
  assert.equal(r.text.length, text.length)
})

test('嘴瓢：链接、@、话题标签、短句都不许碰', () => {
  for (const t of ['看 https://x.com/a', '谢谢 @某人', '#话题 好看', '嗯', '好呀']) {
    assert.equal(maybeTypo(t, { rng: () => 0, chance: 1 }).changed, false, t)
  }
})

test('玩梗：按情绪挑，一条最多一个，不认识的情绪不加', () => {
  assert.equal(maybeMeme('今天有点烦什么都不想干', { rng: () => 0, chance: 1, vibe: '' }).changed, false)
  const r = maybeMeme('今天有点烦什么都不想干', { rng: () => 0, chance: 1, vibe: 'down' })
  assert.equal(r.changed, true)
  assert.ok(r.meme)
})

test('情绪识别：能从文本里看出大概语气', () => {
  assert.equal(vibeOf('好烦啊不想动'), 'down')
  assert.equal(vibeOf('哈哈哈哈这个太好笑了'), 'amuse')
  assert.equal(vibeOf('今天天气不错'), '')
})

test('整体：嘴瓢和梗的概率很低，默认不改', () => {
  const text = '这条视频的节奏真不错'
  const r = applyFlavor(text, { rng: () => 0.99 })
  assert.equal(r.text, text)
  assert.equal(r.typo, false)
})

test('表情：能加、只加一个、已有的不重复加、链接不加', () => {
  const r = maybeEmoji('这个真好看', { rng: () => 0, chance: 1 })
  assert.equal(r.changed, true)
  assert.ok(r.emoji)
  // 短句也能带表情
  assert.equal(maybeEmoji('好耶', { rng: () => 0, chance: 1 }).changed, true)
  // 已经有表情就不再加
  assert.equal(maybeEmoji('好耶😂', { rng: () => 0, chance: 1 }).changed, false)
  // 链接不加
  assert.equal(maybeEmoji('看 https://a.com 这个', { rng: () => 0, chance: 1 }).changed, false)
})

