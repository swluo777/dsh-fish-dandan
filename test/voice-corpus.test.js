// 语料库：有词可用，才谈得上「不正式」。这里锁住轮换、去重和口语替换。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corpusPrompt, informalize, MEME_BANK, PATTERNS, randomMeme, sampleCorpus, SWAPS } from '../src/voice/corpus.js'

test('语料样本：按 seed 轮换，同一个 seed 结果稳定', () => {
  const a = sampleCorpus(123)
  const b = sampleCorpus(123)
  assert.deepEqual(a, b)
  assert.ok(a.memes.length > 0)
  assert.ok(a.patterns.length > 0)
  assert.ok(a.examples.length > 0)
})

test('语料样本：不同 seed 会换一批，不总是同一组', () => {
  const a = sampleCorpus(1)
  const b = sampleCorpus(999)
  assert.notDeepEqual(a.memes, b.memes)
})

test('语料样本：一批里不出现重复词', () => {
  const s = sampleCorpus(42, { memes: 8, patterns: 5, examples: 3 })
  assert.equal(new Set(s.memes).size, s.memes.length)
  assert.equal(new Set(s.patterns).size, s.patterns.length)
})

test('口语替换：因此/非常/如果 这些书面词要换成口语', () => {
  const r = informalize('因此我非常确定，如果你愿意的话')
  assert.ok(r.text.includes('所以'), r.text)
  assert.ok(r.text.includes('特别'), r.text)
  assert.ok(r.text.includes('要是'), r.text)
  assert.ok(r.changed >= 2)
})

test('口语替换：链接和 @ 不碰', () => {
  const r = informalize('看 https://a.com 这个')
  assert.equal(r.text, '看 https://a.com 这个')
  assert.equal(r.changed, 0)
})

test('梗库与句式：不是空的，且都是短句', () => {
  const total = Object.values(MEME_BANK).reduce((n, arr) => n + arr.length, 0)
  assert.ok(total >= 40, `梗太少：${total}`)
  assert.ok(PATTERNS.length >= 10)
  for (const arr of Object.values(MEME_BANK)) for (const w of arr) assert.ok(w.length <= 10, `太长：${w}`)
  assert.ok(SWAPS.length >= 15)
})

test('随机梗：认识的语气给得出，不认识的给空串', () => {
  assert.ok(randomMeme('down', 1))
  assert.equal(randomMeme('不存在', 1), '')
})

test('注入文本：有词有句式有对照，且提示「别用多」', () => {
  const p = corpusPrompt(7)
  assert.match(p, /网络用语/)
  assert.match(p, /句式/)
  assert.match(p, /正式/)
  assert.match(p, /人话/)
  assert.match(p, /用一到两个/)
})
