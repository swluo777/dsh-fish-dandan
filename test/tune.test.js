// 自然语言微调解析器测试：词表、方向、幅度、保底锚、钳制、unknown
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTune, applyTune } from '../src/persona/tune.js'

const TRAITS = { openness: 7, extraversion: 6, agreeableness: 8, stability: 6, conscientiousness: 4 }
const PERSONA = {
  identity: { age: '成年', appearance: '蓝色长发，鲸鳍耳' },
  personality: { tags: ['傲娇', '贪吃'] },
  scenes: ['你一上线，她先刺你一句。'],
  boundaries: ['不删数据', '不伤人'],
}

test('用户的原句：话稍微少一点点，但还是话痨 -> 外向 −1 且有保底锚', () => {
  const r = parseTune('话稍微少一点点，但还是话痨', TRAITS)
  const c = r.changes.find((x) => x.key === 'extraversion')
  assert.ok(c, '应有外向变更')
  assert.equal(c.from, 6)
  assert.equal(c.to, 5)
  assert.equal(c.delta, -1)
  assert.ok(c.anchor, '「还是话痨」应触发保底锚')
  assert.ok(r.wantsLessChatter, '外向调低应触发调度联动提案')
  assert.equal(r.changes.length, 1, '只动了外向')
})

test('保底锚真的钳得住：「别那么多话，但还是话痨」不会调到安静', () => {
  const r = parseTune('别那么多话，但还是话痨', TRAITS)
  const c = r.changes.find((x) => x.key === 'extraversion')
  assert.equal(c.to, 5, '幅度再大也保底在 5')
})

test('抱怨句式：太话痨了 -> 收回 3 格', () => {
  const r = parseTune('太话痨了', TRAITS)
  const c = r.changes.find((x) => x.key === 'extraversion')
  assert.equal(c.to, 3)
  assert.ok(c.reason.includes('太'))
})

test('「我觉得他说话太多了」也能听懂，并给出调度联动信号', () => {
  const r = parseTune('我觉得他说话太多了', TRAITS)
  const c = r.changes.find((x) => x.key === 'extraversion')
  assert.ok(c && c.to < c.from)
  assert.ok(r.wantsLessChatter)
})

test('低极性词方向自动反转：安静一点 = 外向 −1；嘴硬少一点 = 宜人 +1', () => {
  const a = parseTune('安静一点', TRAITS).changes.find((x) => x.key === 'extraversion')
  assert.equal(a.delta, -1)
  const b = parseTune('嘴硬少一点', TRAITS).changes.find((x) => x.key === 'agreeableness')
  assert.equal(b.from, 8)
  assert.equal(b.to, 9, '少嘴硬 = 更好相处')
})

test('正向诉求：再话痨一点 / 更稳重些 / 皮实一点', () => {
  assert.equal(parseTune('再话痨一点', TRAITS).changes[0].delta, 1)
  assert.equal(parseTune('更稳重些', TRAITS).changes.find((x) => x.key === 'stability').delta, 1)
  assert.equal(parseTune('皮实一点', TRAITS).changes.find((x) => x.key === 'stability').key, 'stability')
})

test('各维度词表都能命中', () => {
  assert.equal(parseTune('好奇心再强一点', TRAITS).changes[0].key, 'openness')
  assert.equal(parseTune('认真一点', TRAITS).changes[0].key, 'conscientiousness')
  assert.equal(parseTune('别那么嘴硬', TRAITS).changes[0].key, 'agreeableness')
})

test('已经到顶/到底时调不动，给出人话提示而不是空变更', () => {
  const top = parseTune('再话痨一点', { ...TRAITS, extraversion: 10 })
  assert.equal(top.changes.length, 0)
  assert.ok(top.unknown[0].includes('10/10'))
  const bottom = parseTune('再安静一点', { ...TRAITS, extraversion: 1 })
  assert.equal(bottom.changes.length, 0)
})

test('完全听不懂：changes 为空、unknown 说人话', () => {
  const r = parseTune('给我来杯咖啡', TRAITS)
  assert.equal(r.changes.length, 0)
  assert.ok(r.unknown.length >= 1)
  assert.equal(r.wantsLessChatter, false)
})

test('spam 词单独出现也给出方向提示', () => {
  const r = parseTune('它老是刷屏', TRAITS)
  assert.equal(r.changes.length, 0)
  assert.ok(r.unknown[0].includes('少说话'))
  assert.equal(r.wantsLessChatter, true)
})

test('applyTune 产出新五维且不修改入参', () => {
  const r = parseTune('话稍微少一点点，但还是话痨', TRAITS)
  const next = applyTune(TRAITS, r.changes)
  assert.equal(next.extraversion, 5)
  assert.equal(TRAITS.extraversion, 6, '原对象不变')
  for (const key of Object.keys(TRAITS)) {
    assert.ok(next[key] >= 1 && next[key] <= 10)
  }
})

test('一句话改年龄：改成/是/冒号都能读，产出文本变更', () => {
  const a = parseTune('年龄改成 28', TRAITS, PERSONA).changes[0]
  assert.equal(a.kind, 'text')
  assert.equal(a.path, 'identity.age')
  assert.equal(a.from, '成年')
  assert.equal(a.to, '28')
  const b = parseTune('把她的年龄改成28岁', TRAITS, PERSONA).changes[0]
  assert.equal(b.to, '28岁', '前面带「把她的」也认得')
  const c = parseTune('年龄：成年', TRAITS, PERSONA)
  assert.equal(c.changes.length, 0, '和原来一样时不产生空变更')
  assert.ok(c.unknown[0].includes('没有变化'))
})

test('一句话改外貌：整段替换与追加分开', () => {
  const rep = parseTune('外貌改成蓝色短发', TRAITS, PERSONA).changes[0]
  assert.equal(rep.kind, 'text')
  assert.equal(rep.path, 'identity.appearance')
  assert.equal(rep.to, '蓝色短发')
  const add = parseTune('外貌加上白色花', TRAITS, PERSONA).changes[0]
  assert.ok(add.to.includes('白色花'))
  assert.ok(add.to.includes('蓝色长发'), '追加不覆盖原外貌')
})

test('一句话改列表：标签 / 日常反应 / 边界都能加、删、换', () => {
  const tag = parseTune('性格标签加上科技宅', TRAITS, PERSONA).changes[0]
  assert.equal(tag.kind, 'list-add')
  assert.deepEqual(tag.items, ['科技宅'])
  assert.ok(tag.to.includes('科技宅') && tag.to.includes('傲娇'))

  const scene = parseTune('加一条日常反应：你夸她的时候，她结巴', TRAITS, PERSONA).changes[0]
  assert.equal(scene.kind, 'list-add')
  assert.deepEqual(scene.items, ['你夸她的时候，她结巴'], '句内逗号不拆条')

  const del = parseTune('删掉边界：不伤人', TRAITS, PERSONA).changes[0]
  assert.equal(del.kind, 'list-remove')
  assert.deepEqual(del.items, ['不伤人'])
  assert.ok(!del.to.includes('不伤人'))
  const del2 = parseTune('标签删掉贪吃', TRAITS, PERSONA).changes[0]
  assert.equal(del2.kind, 'list-remove')
  assert.deepEqual(del2.items, ['贪吃'], '字段在前、动词在中间也要认得')

  const rep = parseTune('标签：傲娇、科技宅', TRAITS, PERSONA).changes[0]
  assert.equal(rep.kind, 'list-replace')
  assert.deepEqual(rep.to, ['傲娇', '科技宅'])
})

test('字段变更不动五维；applyTune 只处理 trait', () => {
  const r = parseTune('年龄改成 28', TRAITS, PERSONA)
  assert.equal(r.changes.length, 1)
  assert.equal(r.changes[0].kind, 'text')
  const next = applyTune(TRAITS, r.changes)
  assert.deepEqual(next, TRAITS)
})

test('没提到字段时不乱猜；提到但没说怎么改才给提示', () => {
  const r = parseTune('把尾巴改成红色', TRAITS, PERSONA)
  assert.equal(r.changes.length, 0)
  assert.ok(r.unknown[0].includes('直接') || r.unknown[0].includes('表单'))
  const half = parseTune('外貌', TRAITS, PERSONA)
  assert.equal(half.changes.length, 0)
  assert.ok(half.unknown[0].includes('外貌'))
})
