// 人味后处理：去 AI 腔、不改变原意、强度可关
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanize } from '../src/voice/humanize.js'

const fixedRng = () => 0.99 // 不触发随机尾巴/犹豫，方便断言

test('人味：删掉 AI 套话和开头连接词', () => {
  const r = humanize('首先，作为一个AI，我要说的是，这个视频挺有意思。希望对你有帮助。', { rng: fixedRng })
  assert.ok(!r.text.includes('首先'))
  assert.ok(!r.text.includes('作为一个AI'))
  assert.ok(!r.text.includes('希望对你有帮助'))
  assert.ok(r.text.includes('这个视频挺有意思'), '正文不能丢')
  assert.ok(r.stats.removed > 0)
})

test('人味：破折号改成逗号，markdown 装饰清掉', () => {
  const r = humanize('这个**转场**有点——草率`吧`。', { rng: fixedRng })
  assert.ok(!r.text.includes('——'))
  assert.ok(!r.text.includes('**'))
  assert.ok(r.text.includes('转场'))
  assert.ok(r.text.includes('草率'))
})

test('人味：正常语义里的「最后」不被误删，句首套话才清', () => {
  assert.equal(humanize('最后我还是去了。', { rng: fixedRng }).text, '最后我还是去了。')
  const cleaned = humanize('最后，这个视频挺有意思。希望这能帮到你。', { rng: fixedRng })
  assert.ok(!cleaned.text.startsWith('最后'), cleaned.text)
  assert.ok(!cleaned.text.includes('希望这能帮到你'), cleaned.text)
  assert.ok(cleaned.text.includes('这个视频挺有意思'), '正文不能丢')
})

test('人味：off 强度一个字都不改', () => {
  const src = '首先，作为AI，这个挺好。'
  const r = humanize(src, { strength: 'off' })
  assert.equal(r.text, src)
  assert.equal(r.stats.strength, 'off')
})

test('人味：natural 强度会挂一点小尾巴，但不丢内容', () => {
  const r = humanize('今天有点累。', { strength: 'natural', rng: () => 0 })
  assert.ok(r.text.includes('今天有点累'))
  assert.ok(/[啦呀吧嘛哈]。$/.test(r.text), r.text)
})

test('人味：空文本/空白原样返回', () => {
  assert.equal(humanize('').text, '')
  assert.equal(humanize('   ').text, '   ')
})
