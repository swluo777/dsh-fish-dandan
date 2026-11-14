import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStickerQuery,
  expressionProfile,
  hasEmoji,
  inferIntent,
  isInformationQuestion,
  isSeriousContext,
  isStickerEligible,
  isStickerOnlyIntent,
  isStickerReplyEligible,
  normalizeExpressionLevel,
  panelEmojiForText,
  pickStickerCandidate,
} from '../src/voice/expression.js'

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
  assert.equal(isStickerEligible('今天这个转场挺有意思的，我看了两遍才看懂'), true, '普通闲聊放宽到 80 字')
  assert.equal(isStickerEligible('啊'.repeat(81)), false)
})

test('意图识别和 emoji 探测', () => {
  assert.equal(inferIntent('在吗'), 'greeting')
  assert.equal(inferIntent('谢谢啦'), 'thanks')
  assert.equal(inferIntent('晚安'), 'sleepy')
  assert.equal(inferIntent('委屈'), 'sad', '委屈不能被 comfort 抢走')
  assert.equal(hasEmoji('好耶😂'), true)
  assert.equal(hasEmoji('好耶'), false)
})

test('信息型问句和短社交问句分开：在吗？可以发表情，怎么弄？不可以', () => {
  assert.equal(isInformationQuestion('在吗？'), false)
  assert.equal(isInformationQuestion('真的吗？'), false)
  assert.equal(isInformationQuestion('这个怎么弄？'), true)
  assert.equal(isInformationQuestion('帮我查一下多少钱'), true)
  assert.equal(isStickerEligible('在吗？'), true)
  assert.equal(isStickerEligible('这个怎么弄？'), false)
  assert.equal(isStickerOnlyIntent('在吗？'), true)
})

test('短社交回复才允许被一张图替换，内容型回复不允许', () => {
  assert.equal(isStickerReplyEligible({ incoming: '谢谢', reply: '不客气' }), true)
  assert.equal(isStickerReplyEligible({ incoming: '在吗？', reply: '在的' }), true)
  assert.equal(isStickerReplyEligible({ incoming: '哈哈', reply: '笑死' }), true)
  assert.equal(isStickerReplyEligible({ incoming: '在吗？', reply: '在的，怎么啦？' }), false)
  assert.equal(isStickerReplyEligible({ incoming: '帮我查一下', reply: '好的' }), false)
  assert.equal(isStickerReplyEligible({ incoming: '谢谢', reply: '明天几点见面' }), false)
  assert.equal(isStickerReplyEligible({ incoming: '', reply: '好可爱', incomingKind: 'emoji' }), true)
})

test('表情包候选门槛：高分、分差、tagOnly、confidence', () => {
  const close = pickStickerCandidate([
    { id: 'a', score: 0.55, caption: '笑死', tagOnly: false, confidence: 0.8, matched: [] },
    { id: 'b', score: 0.54, caption: '笑哭', tagOnly: false, confidence: 0.8, matched: [] },
  ], { intent: 'laugh' })
  assert.equal(close, null, 'top1/top2 太接近且没有 intent 命中，视为歧义')

  const intentHit = pickStickerCandidate([
    { id: 'a', score: 0.55, caption: '笑死', tagOnly: false, confidence: 0.8, matched: ['laugh'] },
    { id: 'b', score: 0.54, caption: '笑哭', tagOnly: false, confidence: 0.8, matched: [] },
  ], { intent: 'laugh' })
  assert.equal(intentHit.id, 'a', 'intent 命中可以压过分差')

  const tagOnly = pickStickerCandidate([
    { id: 't', score: 0.36, caption: '', tagOnly: true, confidence: 0.8, matched: [] },
  ], { allowTagOnly: true })
  assert.equal(tagOnly.id, 't')
  assert.equal(pickStickerCandidate([
    { id: 't', score: 0.36, caption: '', tagOnly: true, confidence: 0.8, matched: [] },
  ], { allowTagOnly: false }), null)

  assert.equal(pickStickerCandidate([
    { id: 'low', score: 0.41, caption: '有点相关', tagOnly: false, confidence: 0.3, matched: [] },
  ]), null, 'confidence 低要再高 0.04')
})

test('面板表情按回复情绪选；中性句不硬配', () => {
  assert.equal(panelEmojiForText('笑死'), '笑哭')
  assert.equal(panelEmojiForText('谢谢啦'), '抱拳')
  assert.equal(panelEmojiForText('好的收到'), '点赞')
  assert.equal(panelEmojiForText('再见'), '挥手')
  assert.equal(panelEmojiForText('抱抱你'), '爱心')
  assert.equal(panelEmojiForText('委屈'), '委屈')
  assert.equal(panelEmojiForText('今天天气不错'), '')
})

test('检索词以我们要回的这句话为主，上下文只补在后面', () => {
  assert.equal(
    buildStickerQuery({ replyText: '不客气', incomingText: '谢谢', extra: '视频文案', max: 40 }),
    '不客气 谢谢 视频文案',
  )
})
