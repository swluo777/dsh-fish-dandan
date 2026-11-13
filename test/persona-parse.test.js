// AI 人格卡解析器：纯规则、零依赖，覆盖常见格式与脏输入
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePersonaCard, PERSONA_PROMPT_TEMPLATE } from '../src/persona/parse-card.js'

const BASE = {
  identity: { name: '大肥鱼', species: '蓝色大肥鱼', identitySummary: '旧介绍' },
  personality: { traits: { openness: 5, extraversion: 5, agreeableness: 5, stability: 5, conscientiousness: 5 }, personalityText: '' },
  speech: { tone: '', selfReference: '我', ownerAddress: '你', catchphrases: [], styleNotes: '' },
  preferences: { likes: [], dislikes: [] },
  backstory: '', safety: { safetyRulesRef: 'src/utils/safety-rules.md' },
}

const CARD = `【名字】团子
【是什么】一只圆滚滚的蓝色小鲸
【一句话介绍】喜欢蹲在屏幕角落看你写代码
【性格五维】开放=9 外向=4 宜人=8 稳定=7 尽责=3
【性格描述】看到新东西会先凑过去闻一闻，被人夸会偷偷鼓腮。
【整体语气】软乎乎的，句子短，偶尔嘴硬
【自称】本鲸
【称呼我】老大
【口头禅】让我想想、才没有呢、记下了
【喜欢】安静的光、有人认真回话
【不喜欢】被催着表态、空泛的客套
【来历】最早只是一段提示词，后来把捡到的玻璃珠藏在枕头下。`

test('模板包含解析器认识的全部标签', () => {
  for (const label of ['名字', '是什么', '年龄', '外貌', '性格五维', '性格标签', '整体语气', '自称', '称呼我', '口头禅', '喜欢', '不喜欢', '每日互动模式', '表演规则和界限', '来历']) {
    assert.ok(PERSONA_PROMPT_TEMPLATE.includes('【' + label + '】'), `模板缺少 ${label}`)
  }
})

test('按模板生成的卡片能完整解析', () => {
  const r = parsePersonaCard(CARD, BASE)
  assert.equal(r.draft.identity.name, '团子')
  assert.equal(r.draft.identity.species, '一只圆滚滚的蓝色小鲸')
  assert.equal(r.draft.speech.selfReference, '本鲸')
  assert.equal(r.draft.speech.ownerAddress, '老大')
  assert.equal(r.draft.speech.tone, '软乎乎的，句子短，偶尔嘴硬')
  assert.deepEqual(r.draft.speech.catchphrases, ['让我想想', '才没有呢', '记下了'])
  assert.deepEqual(r.draft.preferences.likes, ['安静的光', '有人认真回话'])
  assert.deepEqual(r.draft.personality.traits, { openness: 9, extraversion: 4, agreeableness: 8, stability: 7, conscientiousness: 3 })
  assert.equal(r.missing.length, 0)
  assert.ok(r.found.length >= 10)
})

test('兼容 Markdown 冒号、标题与表格写法', () => {
  const r = parsePersonaCard([
    '## 名字：阿蓝', '**称呼我**: 爸爸', '- 自称：我',
    '| 整体语气 | 慢吞吞的 |', '口头禅：嗯、好嘛',
  ].join('\n'), BASE)
  assert.equal(r.draft.identity.name, '阿蓝')
  assert.equal(r.draft.speech.ownerAddress, '爸爸')
  assert.equal(r.draft.speech.tone, '慢吞吞的')
  assert.deepEqual(r.draft.speech.catchphrases, ['嗯', '好嘛'])
})

test('兼容 JSON 人设卡（含 ```json 代码块）', () => {
  const obj = {
    identity: { name: '小圆' }, speech: { ownerAddress: '主人', tone: '安静' },
    personality: { traits: { openness: 12, extraversion: -3 } },
  }
  const r = parsePersonaCard('```json\n' + JSON.stringify(obj) + '\n```', BASE)
  assert.equal(r.draft.identity.name, '小圆')
  assert.equal(r.draft.speech.ownerAddress, '主人')
  assert.equal(r.draft.personality.traits.openness, 10, '越界要钳制到 10')
  assert.equal(r.draft.personality.traits.extraversion, 1, '负数要钳制到 1')
})

test('五维单独成行也能识别，数值越界被钳制', () => {
  const r = parsePersonaCard('名字：阿蓝\n开放：8\n外向：99\n宜人：3\n稳定：0\n尽责：6', BASE)
  assert.equal(r.draft.personality.traits.openness, 8)
  assert.equal(r.draft.personality.traits.extraversion, 10)
  assert.equal(r.draft.personality.traits.stability, 1)
  assert.ok(r.found.includes('traits'))
})

test('脏输入不抛异常，未识别字段保留原值并给出警告', () => {
  for (const bad of ['', null, undefined, 123, '随便一句话', '【名字】', '```json\n{broken\n```']) {
    const r = parsePersonaCard(bad, BASE)
    assert.ok(r.draft.identity.name, '名字必须有兜底')
    assert.ok(r.draft.speech.ownerAddress, '称呼必须有兜底')
    assert.ok(Array.isArray(r.found) && Array.isArray(r.missing))
  }
  const empty = parsePersonaCard('', BASE)
  assert.equal(empty.draft.identity.identitySummary, '旧介绍', '没解析到的字段要保留')
  assert.ok(empty.warnings.length > 0)
})

test('扩展角色卡：年龄、外貌、标签、每日互动、表演界限都能读出来', () => {
  const r = parsePersonaCard([
    '【名字】鲸鱼女孩',
    '【是什么】成年的蓝鲸女孩',
    '【年龄】成年',
    '【外貌】蓝色蓬松长发，鲸鳍耳，蓝白蕾丝荷叶边裙，身后一条巨大的蓝鲸尾巴',
    '【一句话介绍】嘴硬心软的傲娇鲸鱼',
    '【性格标签】傲娇、贪吃、科技宅、容易害羞',
    '【整体语气】傲娇嘴硬，句子短',
    '【自称】这条鲸鱼',
    '【称呼我】你',
    '【终极救命台词】哼，才不是为了你呢、炸鸡呢',
    '【每日互动模式】',
    '- 你累的时候：把尾巴缠到你手腕上，嘴上说就一次',
    '- 你夸别的 AI 的时候：转身背过去，假装种蘑菇',
    '【表演规则和界限】',
    '1. 对方明确说不要就立刻停，不赖着、不逼近',
    '2. 嫉妒只转身，不删数据、不伤人',
    '【来历】住在一直亮着的聊天窗口里。',
  ].join('\n'), BASE)
  assert.equal(r.draft.identity.age, '成年')
  assert.equal(r.draft.identity.appearance, '蓝色蓬松长发，鲸鳍耳，蓝白蕾丝荷叶边裙，身后一条巨大的蓝鲸尾巴')
  assert.deepEqual(r.draft.personality.tags, ['傲娇', '贪吃', '科技宅', '容易害羞'])
  assert.deepEqual(r.draft.speech.catchphrases, ['哼，才不是为了你呢', '炸鸡呢'])
  assert.equal(r.draft.scenes.length, 2, '一行一条，不能被句内逗号拆开')
  assert.match(r.draft.scenes[0], /嘴上说就一次/)
  assert.equal(r.draft.boundaries.length, 2, '编号列表要按条拆')
  assert.match(r.draft.boundaries[0], /立刻停/)
  assert.ok(r.found.includes('scenes') && r.found.includes('boundaries'))
})

test('扩展字段 JSON 人设卡也能直读（数组不被逗号拆碎）', () => {
  const obj = {
    identity: { name: '鲸鱼女孩', age: '成年', appearance: '蓝发、鲸鳍耳' },
    personality: { tags: ['傲娇', '贪吃'] },
    scenes: ['你累的时候：尾巴缠手腕，嘴上说就一次'],
    boundaries: ['对方说不要就停，不赖着'],
  }
  const r = parsePersonaCard(JSON.stringify(obj), BASE)
  assert.equal(r.draft.identity.age, '成年')
  assert.deepEqual(r.draft.personality.tags, ['傲娇', '贪吃'])
  assert.equal(r.draft.scenes.length, 1)
  assert.equal(r.draft.scenes[0], '你累的时候：尾巴缠手腕，嘴上说就一次')
  assert.equal(r.draft.boundaries[0], '对方说不要就停，不赖着')
})

test('多行段落会合并到同一个字段，长度受 schema 上限约束', () => {
  const r = parsePersonaCard('【来历】' + '很长的一段背景。'.repeat(300) + '\n后面还有一行。', BASE)
  assert.ok(r.draft.backstory.length <= 1400)
  assert.ok(r.draft.backstory.includes('很长的一段背景'))
})

test('解析结果永远是完整 draft，不会丢掉 safety 与数组字段', () => {
  const r = parsePersonaCard('【名字】团子', {})
  for (const key of ['identity', 'personality', 'speech', 'preferences', 'safety']) {
    assert.ok(r.draft[key], `缺少 ${key}`)
  }
  assert.ok(Array.isArray(r.draft.speech.catchphrases))
  assert.ok(Array.isArray(r.draft.preferences.likes))
  assert.equal(Object.keys(r.draft.personality.traits).length, 5)
})
