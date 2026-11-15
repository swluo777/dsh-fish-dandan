import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKGROUNDS,
  MOODS,
  buildPlan,
  deriveMood,
  keywordObjects,
  localCopy,
  makeRng,
  planText,
  signatureOf,
  stickerGesture,
  validatePlan,
} from '../src/creative/draw/plan.js'

const CHARACTER = { id: 'child-initial-maid', ageGroup: 'child', outfitId: 'initial-maid', displayName: '蛋蛋' }
const PERSONA = { identity: { name: '蛋蛋' }, speech: { selfReference: '我' } }
const STICKER = { id: 's1', emotion: ['困'], caption: '困到睁不开眼', intents: ['comfort'] }

function make(seed, extra = {}) {
  return buildPlan({
    now: 1_700_000_000_000,
    seed,
    vars: { energy: 70, mood: 60, boredom: 20, socialNeed: 30, creativeUrge: 55 },
    affect: { mood: { p: 0.2, a: 0.1, d: 0 } },
    character: CHARACTER,
    persona: PERSONA,
    sticker: STICKER,
    history: [],
    ...extra,
  })
}

test('背景：10 种方向，纸类正好一半', () => {
  const ids = Object.keys(BACKGROUNDS)
  assert.equal(ids.length, 10)
  assert.equal(ids.filter((id) => BACKGROUNDS[id].paper).length, 5)
})

test('规划器：同 seed 同输入完全可复现', () => {
  const a = make(12345)
  const b = make(12345)
  assert.deepEqual(a, b)
  assert.equal(a.seed, 12345)
  assert.equal(validatePlan(a).length, 0)
})

test('规划器：八种心情都能规划，且心情写进 plan', () => {
  for (const key of Object.keys(MOODS)) {
    const plan = make(8800 + Object.keys(MOODS).indexOf(key), { moodKey: key })
    assert.equal(plan.mood.key, key)
    assert.equal(plan.mood.label, MOODS[key].label)
    assert.equal(validatePlan(plan).length, 0)
  }
})

test('规划器：连续 12 张不出现同背景+构图+姿态+主物件', () => {
  const quartets = []
  const backgrounds = []
  for (let i = 0; i < 12; i += 1) {
    const plan = make(2000 + i * 7919, { history: quartets.map((q) => ({ ...q })) })
    quartets.push(plan)
    backgrounds.push(plan.background)
  }
  const keys = quartets.map((p) => [p.background, p.composition, p.pose, p.objects[0] || ''].join('|'))
  assert.equal(new Set(keys).size, 12)
  assert.ok(new Set(backgrounds).size >= 6, `背景只出现 ${new Set(backgrounds).size} 种`)
})

test('文案：提到糖就必须画糖，不是只换字', () => {
  const plan = make(424242, { copyLines: ['想把这块糖留到晚上。'] })
  assert.ok(plan.objects.includes('candy'), `物件：${plan.objects.join(',')}`)
  assert.ok(plan.copy.keywords.includes('糖'))
})

test('文案：关键词能映射到多个物件候选', () => {
  assert.ok(keywordObjects('窗外下雨，抱着尾巴').includes('rain'))
  assert.ok(keywordObjects('窗外下雨，抱着尾巴').includes('window'))
  assert.ok(keywordObjects('窗外下雨，抱着尾巴').includes('tailpillow'))
})

test('表情包：只取语义定姿态，不贴原图', () => {
  assert.equal(stickerGesture({ emotion: ['困'] }, 'sleepy'), 'sleep')
  assert.equal(stickerGesture({ intents: ['greeting'] }, 'calm'), 'wave')
  assert.equal(stickerGesture({ emotion: ['难过'] }, 'sad'), 'curl')
  assert.equal(stickerGesture(null, 'calm'), null)
})

test('落款：配置优先，其次角色名，最后人格名', () => {
  assert.equal(signatureOf(CHARACTER, PERSONA, '小鱼'), '小鱼')
  assert.equal(signatureOf(CHARACTER, PERSONA), '蛋蛋')
  assert.equal(signatureOf({}, PERSONA, ''), '蛋蛋')
})

test('校验：独白过长、物件过多、缺落款都会被拦下', () => {
  const plan = make(777)
  const bad = { ...plan, copy: { ...plan.copy, lines: ['今天这一句话我写得特别特别长，长到根本不像随手写在纸上的内心独白，也不像我会说出来的话。'] } }
  assert.ok(validatePlan(bad).some((x) => x.includes('独白太长')))
  const many = { ...plan, objects: ['cup', 'book', 'pen', 'flower', 'moon', 'stars'] }
  assert.ok(validatePlan(many).some((x) => x.includes('物件太多')))
  const noSign = { ...plan, signature: '' }
  assert.ok(validatePlan(noSign).some((x) => x.includes('落款')))
})

test('独白兜底：只写短句，总长不超过 30 字', () => {
  for (const key of Object.keys(MOODS)) {
    const lines = localCopy({ moodKey: key, persona: PERSONA, sticker: STICKER, rng: makeRng(99) })
    assert.ok(lines.length >= 1)
    assert.ok(lines.join('').length <= 30, `${key}: ${lines.join('')}`)
  }
})

test('心情推导：创作欲与精力高时进入兴奋', () => {
  assert.equal(deriveMood({ energy: 90, mood: 70, creativeUrge: 80 }, { mood: { p: 0.5, a: 0.5, d: 0.2 } }), 'excited')
  assert.equal(deriveMood({ energy: 20, mood: 60, creativeUrge: 40 }, {}), 'sleepy')
})

test('计划文案：能说清这次画了什么', () => {
  const plan = make(31337)
  assert.match(planText(plan), /^画一张.+的手稿/)
})
