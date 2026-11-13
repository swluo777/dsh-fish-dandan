// ALMA 三层情感模型的纯函数测试（无副作用、不落盘）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRAIT_KEYS,
  EMOTIONS,
  EVENT_APPRAISALS,
  personalityToPad,
  deriveThresholds,
  appraise,
  createAffectState,
  normalizeAffect,
  advanceAffect,
  presentAffect,
  displayPosition,
} from '../src/decision/affect.js'

const TRAITS = { openness: 7, extraversion: 6, agreeableness: 8, stability: 6, conscientiousness: 4 }

test('Big Five -> PAD 基线落在 [-1,1]，且随性格变化', () => {
  const a = personalityToPad(TRAITS)
  const b = personalityToPad({ ...TRAITS, extraversion: 1, stability: 1, agreeableness: 1 })
  for (const key of ['p', 'a', 'd']) {
    assert.ok(Number.isFinite(a[key]) && a[key] >= -1 && a[key] <= 1, `${key} 应被钳制`)
  }
  assert.notDeepEqual(a, b, '不同性格应得到不同基线')
  assert.deepEqual(personalityToPad({}), personalityToPad({ openness: 5.5, extraversion: 5.5, agreeableness: 5.5, stability: 5.5, conscientiousness: 5.5 }))
})

test('性格真实缩放状态阈值：越开放越易无聊，越外向越易想社交', () => {
  const low = deriveThresholds({ openness: 1, extraversion: 1, stability: 10, conscientiousness: 1 })
  const high = deriveThresholds({ openness: 10, extraversion: 10, stability: 10, conscientiousness: 10 })
  assert.ok(high.explore < low.explore, '开放度高 -> 探索阈值低')
  assert.ok(high.social < low.social, '外向度高 -> 社交阈值低')
  assert.ok(high.sleep > low.sleep, '尽责度高 -> 更能撑到低精力')
  for (const v of Object.values(high)) assert.ok(Number.isFinite(v))
})

test('稳定度低放大负性情绪并减慢衰减', () => {
  const calm = deriveThresholds({ stability: 10 })
  const sensitive = deriveThresholds({ stability: 1 })
  assert.ok(sensitive.negativeGain > calm.negativeGain)
  assert.ok(sensitive.decayFactor < calm.decayFactor)
  const joy = appraise('state_social', { thresholds: sensitive })
  const fear = appraise('error', { thresholds: sensitive })
  const fearCalm = appraise('error', { thresholds: calm })
  assert.ok(fear.intensity > fearCalm.intensity, '神经质应放大负面事件')
  assert.equal(joy.id, 'joy')
  assert.equal(fear.id, 'irritation')
  assert.ok(fear.intensity <= 1 && joy.intensity >= 0)
})

test('每种情绪都有合法的 PAD 签名与评价模板', () => {
  for (const [kind, tpl] of Object.entries(EVENT_APPRAISALS)) {
    assert.ok(EMOTIONS[tpl.emotion], `${kind} 指向不存在的情绪`)
    const e = EMOTIONS[tpl.emotion]
    assert.equal(e.pad.length, 3)
    for (const v of e.pad) assert.ok(v >= -1 && v <= 1)
    assert.ok(e.decayMin > 0)
  }
  assert.equal(appraise('不存在的事件'), null)
})

test('情绪会衰减、汇入心情并采样历史', () => {
  const t0 = 1_700_000_000_000
  let state = createAffectState(TRAITS, t0)
  state = advanceAffect(state, { traits: TRAITS, vars: { energy: 80, boredom: 10, socialNeed: 20, creativeUrge: 30, mood: 60 }, state: 'social', events: ['state_social'], now: t0 + 60_000 })
  assert.equal(state.emotion.label, '开心')
  assert.equal(state.history.length, 1)
  assert.ok(state.mood.p > state.baseline.p, '开心应把愉悦度推高')
  const firstIntensity = state.emotion.intensity

  // 过 3 小时：情绪指数衰减、心情向基线回归
  const later = advanceAffect(state, { traits: TRAITS, vars: { energy: 70, boredom: 20, socialNeed: 20, creativeUrge: 30, mood: 58 }, state: 'rest', events: [], now: t0 + 3 * 3_600_000 })
  assert.ok(later.emotion === null || later.emotion.intensity < firstIntensity, '情绪应随时间衰减')
  assert.equal(later.history.length, 2)
  assert.ok(Math.abs(later.mood.p - later.baseline.p) < Math.abs(state.mood.p - state.baseline.p) + 0.001, '心情应向基线回归')
})

test('内部变量会隐式触发情绪，且心情八分体有中文标签', () => {
  const t0 = 1_700_000_000_000
  const state = advanceAffect(createAffectState(TRAITS, t0), {
    traits: TRAITS,
    vars: { energy: 10, boredom: 90, socialNeed: 88, creativeUrge: 10, mood: 20 },
    state: 'rest', events: [], now: t0 + 60_000,
  })
  assert.ok(state.octant.label.length > 0)
  assert.ok(state.active.some((e) => e.id === 'boredom' || e.id === 'anxiety' || e.id === 'sadness'))
  assert.ok(state.history[0].valence >= -1 && state.history[0].valence <= 1)
})

test('normalizeAffect 对脏数据容错，不抛异常', () => {
  for (const raw of [null, 42, { mood: { p: 99, a: 'x' } }, { active: [{ id: '不存在' }, null] }, { history: 'oops' }]) {
    const a = normalizeAffect(raw, TRAITS, 1_700_000_000_000)
    assert.ok(a.mood.p >= -1 && a.mood.p <= 1)
    assert.ok(Array.isArray(a.active) && Array.isArray(a.history))
    assert.ok(a.active.every((e) => EMOTIONS[e.id]))
  }
})

test('presentAffect 输出主页需要的完整结构', () => {
  const t0 = 1_700_000_000_000
  const state = advanceAffect(createAffectState(TRAITS, t0), {
    traits: TRAITS, vars: { energy: 80, boredom: 20, socialNeed: 30, creativeUrge: 40, mood: 60 },
    state: 'explore', events: ['state_explore'], now: t0 + 60_000,
  })
  const view = presentAffect(state, TRAITS, state.history.at(-1) ?? {})
  assert.equal(view.personality.length, TRAIT_KEYS.length)
  assert.ok(view.personality.every((p) => p.label && Number.isFinite(p.value)))
  assert.ok(view.mood.label && Number.isFinite(view.mood.p))
  assert.ok(view.emotion.label && view.emotion.cause)
  assert.ok(view.factors.length >= 5 && view.factors.every((f) => f.label && f.effect))
  assert.ok(Array.isArray(view.history) && view.thresholds.explore > 0)
})

test('情绪显示位置是连续的：强度决定离中心多远，心情把它拉偏', () => {
  const seed = EMOTIONS.joy // 目录典型位置 (0.8, 0.55)
  const full = displayPosition(seed, 1, { p: 0, a: 0, d: 0 })
  assert.equal(full.valence, seed.valence, '强度满、心情中性时停在典型位置')
  assert.equal(full.arousal, seed.arousal)

  const weak = displayPosition(seed, 0.2, { p: 0, a: 0, d: 0 })
  const dist = (v) => Math.hypot(v.valence, v.arousal)
  assert.ok(dist(weak) < dist(seed), '强度低时往中心缩')

  const blue = displayPosition(seed, 1, { p: -0.8, a: 0, d: 0 })
  assert.ok(blue.valence < seed.valence, '心情很差时，同样的开心也会往不快方向偏')
  const glad = displayPosition(seed, 1, { p: 0.6, a: 0, d: 0 })
  assert.ok(glad.valence > seed.valence, '心情很好时更靠右')
  for (const pos of [full, weak, blue, glad]) {
    assert.ok(pos.valence >= -1 && pos.valence <= 1 && pos.arousal >= -1 && pos.arousal <= 1, '始终在 [-1,1]')
  }
})

test('presentAffect 下发 display，前端据此画连续位置', () => {
  const st = createAffectState(TRAITS, 1000)
  const advanced = advanceAffect(st, { traits: TRAITS, vars: {}, state: 'create', events: ['state_create'], now: 2000 })
  const view = presentAffect(advanced, TRAITS, {})
  assert.ok(view.emotion, '应有主导情绪')
  assert.ok(view.emotion.display && Number.isFinite(view.emotion.display.valence), 'emotion 要带 display')
  assert.ok(view.emotion.display.valence > 0, 'joy 汇入后心情为正，位置应在愉快侧')
  const calmView = presentAffect(createAffectState(TRAITS, 1000), TRAITS, {})
  assert.deepEqual(calmView.emotion.display, { valence: 0, arousal: 0 }, '平静时停在中心')
})
