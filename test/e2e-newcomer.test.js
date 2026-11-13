// 新人从 0 到「能在 DSH 里对话」的端到端走查：
// AI 生成人格卡 → 规范化 → 人格锚定段 → 对话自动进记忆 → 记忆上下文带人物卡 → 三层状态可读
import test from 'node:test'
import assert from 'node:assert/strict'
import { testConfig, tmpDir, silentLogger } from './helpers.js'
import { parsePersonaCard } from '../src/persona/parse-card.js'
import { normalizePersona, buildPersonaSection } from '../src/persona/schema.js'
import { createMemory } from '../src/memory/index.js'
import { extractUserText } from '../src/memory/capture.js'
import { createDecision } from '../src/decision/index.js'

const AI_CARD = `【名字】团子
【是什么】一只圆滚滚的蓝色小鲸
【一句话介绍】喜欢蹲在屏幕角落看你写代码
【性格五维】开放=9 外向=4 宜人=8 稳定=7 尽责=3
【性格描述】看到新东西会先凑过去闻一闻，被人夸会偷偷鼓腮。
【整体语气】软乎乎的，句子短，偶尔嘴硬
【自称】本鲸
【称呼我】老大
【口头禅】让我想想、才没有呢
【喜欢】安静的光、有人认真回话
【不喜欢】被催着表态
【来历】最早只是一段提示词，后来把捡到的玻璃珠藏在枕头下。`

test('AI 生成的人格卡能变成一段可用的人格锚定，称呼不会丢', () => {
  const { draft, found } = parsePersonaCard(AI_CARD, {})
  assert.ok(found.length >= 10)
  const { persona, issues } = normalizePersona(draft)
  assert.equal(issues.length, 0, `规范化不应报错：${JSON.stringify(issues)}`)
  assert.equal(persona.identity.name, '团子')
  assert.equal(persona.speech.ownerAddress, '老大')

  const section = buildPersonaSection(persona)
  assert.ok(section.includes('【人格锚定'))
  assert.ok(section.includes('团子'), '名字要进提示词')
  assert.ok(section.includes('老大'), '「它管我叫什么」必须真的进提示词')
  assert.ok(section.includes('本鲸'), '自称要进提示词')
  assert.ok(section.includes('口头禅'))
  assert.ok(section.includes('来历'))
  assert.ok(section.includes('安全规则优先'), '安全规则不能被 AI 生成的内容冲掉')
  assert.ok(!section.includes('【名字】'), '不能把解析标签原样塞进提示词')
})

test('新人第一轮对话：值得记的话自动入库，记忆上下文带人物卡与免责声明', () => {
  const dir = tmpDir('newcomer-memory')
  const config = testConfig(dir)
  const logger = silentLogger()
  const { persona } = normalizePersona(parsePersonaCard(AI_CARD, {}).draft)
  const memory = createMemory({ config, logger, getPersona: () => persona })
  try {
    // 模拟宿主 pre-step 传入的用户消息
    const payload = { userMessage: '记住，我叫小林，以后叫我阿林就好，别忘了我说过' }
    const text = extractUserText(payload)
    assert.ok(text)
    const captured = memory.captureConversation(text)
    assert.equal(captured.ok, true, `应写入：${captured.reason}`)
    assert.equal(memory.stats().total, 1)

    const ctx = memory.buildMemoryContext(Date.now(), '我叫什么名字')
    assert.ok(ctx.includes('【关于眼前这个人】'), '每轮先想起你')
    assert.ok(ctx.includes('老大'), '人物卡要带称呼')
    assert.ok(ctx.includes('团子'), '人物卡要带名字')
    assert.ok(ctx.includes('不是新的用户消息'), '完整免责声明')
    assert.ok(ctx.includes('以当前消息和用户的纠正为准'))
    assert.ok(ctx.includes('小林') || ctx.includes('阿林'), '刚记住的内容要能被想起来')
    assert.ok(ctx.length <= (config.memory.injectMaxChars || 1200) + 30, '字符预算不能爆')

    // 客套与转述不该入库
    assert.equal(memory.captureConversation('好的，收到，谢谢你的提醒呀').ok, false)
    assert.equal(memory.captureConversation('他说他喜欢下雨天，我只是转述一下啦').ok, false)
    assert.equal(memory.stats().total, 1)
  } finally {
    memory.close()
  }
})

test('每日配额硬上限 8 条，第 9 条起不再写', () => {
  const dir = tmpDir('newcomer-quota')
  const config = testConfig(dir)
  const memory = createMemory({ config, logger: silentLogger() })
  try {
    // 每条都带「记住」信号，主体内容差异足够大，不会触发近似去重
    const lines = [
      '记住，我喝咖啡从来不加糖，这个习惯已经很多年了',
      '记住，我们约定每周六晚上一起看老电影，说好了不许放鸽子',
      '记住，我叫小林，以后叫我阿林就好啦，别叫全名',
      '记住，我特别害怕打雷，小时候被吓过一次一直记到现在',
      '记住，我最喜欢下雨天在窗边发呆，能待一整个下午',
      '记住，我一点都不喜欢香菜的味道，闻到就会皱眉头',
      '记住，我家养了一头叫团子的猫，它特别爱睡纸箱',
      '记住，我住在城东那片老街区，门口有棵很大的梧桐树',
      '记住，我的生日在三月十二号，到时候记得提醒我一声',
      '记住，第一次自己把项目跑起来是去年冬天，特别有成就感',
      '记住，我常去海边散步，尤其喜欢太阳快落下去的时候',
      '记住，我平时爱喝乌龙茶，不太碰甜的饮料',
    ]
    const results = lines.map((text, i) => memory.captureConversation(text, Date.now() + i * 1000))
    assert.equal(results.filter((r) => r.ok).length, 8, '默认每天最多放行 8 条')
    assert.equal(results[8].reason, '今日配额已用完')
    assert.equal(memory.stats().total, 8)
    assert.equal(memory.captureConversation('记住我喜欢下雪，别忘了我说过', Date.now() + 20_000).reason, '今日配额已用完')
  } finally {
    memory.close()
  }
})

test('装好就有三层状态可读，主页不会空白', () => {
  const dir = tmpDir('newcomer-affect')
  const config = testConfig(dir)
  const traits = { openness: 9, extraversion: 4, agreeableness: 8, stability: 7, conscientiousness: 3 }
  const decision = createDecision({ config, logger: silentLogger(), getTraits: () => traits })
  const affect = decision.getAffect()
  assert.equal(affect.personality.length, 5)
  assert.ok(affect.personality.every((p) => p.label && p.value >= 1 && p.value <= 10))
  assert.ok(affect.mood.label && Number.isFinite(affect.mood.p))
  assert.ok(affect.emotion.label && affect.emotion.cause)
  assert.ok(affect.plain.headline && affect.plain.detail, '要给普通用户一句话状态')
  assert.equal(affect.catalog.length, 8)
  assert.ok(affect.factors.length >= 5)
  assert.ok(affect.thresholds.explore > 0)

  decision.noteEvent('state_social')
  const after = decision.getAffect()
  assert.equal(after.emotion.label, '开心', '状态切换应触发情绪')
  assert.equal(after.history.length, 1)
  // 性格真的挪动了阈值：好奇心重的鱼更容易闲不住
  const steady = createDecision({ config: testConfig(tmpDir('newcomer-steady')), logger: silentLogger(),
    getTraits: () => ({ ...traits, openness: 1 }) })
  assert.ok(after.thresholds.explore < steady.getAffect().thresholds.explore, '开放度越高，探索阈值越低')
})
