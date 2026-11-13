import test from 'node:test'
import assert from 'node:assert/strict'
import { expressionProfile, hasEmoji, inferIntent, isSeriousContext, isStickerEligible, isStickerOnlyIntent, normalizeExpressionLevel } from '../src/voice/expression.js'

test('表达浓度：三档，非法值回自然档', () => {
  assert.equal(normalizeExpressionLevel('unknown'), 'natural')
  assert.equal(expressionProfile('restrained').textEmoji, 0.14)
  assert.equal(expressionProfile('natural').sticker, 0.5)
  assert.equal(expressionProfile('playful').panelEmoji, 0.26)
})

test('表情包只回短社交，严肃/求信息不拿图顶答案', () => {
  assert.equal(isStickerOnlyIntent('在吗'), true)
  assert.equal(isStickerOnlyIntent('收到'), true)
  assert.equal(isStickerOnlyIntent('我最近有点难过'), false)
  assert.equal(isSeriousContext('我被骗了，银行卡也冻结了'), true)
  assert.equal(isStickerEligible('帮我查一下这个多少钱'), false)
  assert.equal(isStickerEligible('哈哈哈哈'), true)
})

test('意图识别和 emoji 探测', () => {
  assert.equal(inferIntent('在吗'), 'greeting')
  assert.equal(inferIntent('谢谢啦'), 'thanks')
  assert.equal(inferIntent('晚安'), 'sleepy')
  assert.equal(hasEmoji('好耶😂'), true)
  assert.equal(hasEmoji('好耶'), false)
})
