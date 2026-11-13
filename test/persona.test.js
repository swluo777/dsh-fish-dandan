import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildPersonaSection, normalizePersona, validatePersona, diffPersona } from '../src/persona/schema.js'
import { createPersonaStore, personaDraft } from '../src/persona/index.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

test('人格规范化：五维越界被钳制，未知字段被丢弃', () => {
  const { persona, issues } = normalizePersona({
    identity: { name: '  小鱼  ', species: '鱼' },
    personality: { traits: { openness: 99, extraversion: -3, agreeableness: 7, stability: 6, conscientiousness: 5 } },
    junk: 'should be dropped',
  })
  assert.equal(persona.identity.name, '小鱼')
  assert.equal(persona.personality.traits.openness, 10)
  assert.equal(persona.personality.traits.extraversion, 1)
  assert.equal(persona.junk, undefined)
  assert.ok(issues.length >= 2)
})

test('人格校验：非法五维与缺字段会被拒绝', () => {
  assert.equal(validatePersona({}).ok, false)
  const bad = validatePersona({
    identity: { name: 'x', species: 'y' },
    personality: { traits: { openness: 11, extraversion: 5, agreeableness: 5, stability: 5, conscientiousness: 5 } },
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some((i) => i.includes('openness')))
})

test('人格段落：包含身份、五维与成长特质，且无时间戳', () => {
  const { persona } = normalizePersona({
    identity: { name: '大肥鱼', species: '蓝色大肥鱼', identitySummary: '一条鱼' },
    personality: { traits: { openness: 7, extraversion: 6, agreeableness: 8, stability: 6, conscientiousness: 4 }, personalityText: '好奇' },
    speech: { tone: '松弛', selfReference: '我', ownerAddress: '主人', catchphrases: ['让我想想'], styleNotes: '' },
    preferences: { likes: ['深海'], dislikes: ['客套'] },
    backstory: '从数据海里来',
  })
  const text = buildPersonaSection(persona, { interests: ['钓鱼'], preferences: [], closeness: [{ person: '主人', label: '很亲近' }] })
  assert.match(text, /大肥鱼/)
  assert.match(text, /开放 7\/10/)
  assert.match(text, /最近在意：钓鱼/)
  assert.match(text, /人格锚定结束/)
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/)
  assert.equal(text, buildPersonaSection(persona, { interests: ['钓鱼'], preferences: [], closeness: [{ person: '主人', label: '很亲近' }] }))
})

test('人格扩展字段：年龄、外貌、标签、日常反应、分寸保留并注入', () => {
  const { persona } = normalizePersona({
    identity: { name: '鲸鱼女孩', species: '蓝鲸女孩', age: '成年', appearance: '蓝色蓬松长发，鲸鳍耳，蓝白蕾丝裙，身后一条大尾巴。' },
    personality: { traits: { openness: 8, extraversion: 6, agreeableness: 4, stability: 3, conscientiousness: 2 }, tags: ['傲娇', '贪吃', '科技宅'], personalityText: '嘴硬心软' },
    speech: { tone: '傲娇', selfReference: '这条鲸鱼', ownerAddress: '你', catchphrases: ['哼'], styleNotes: '' },
    preferences: { likes: ['炸鸡'], dislikes: ['被无视'] },
    scenes: ['你累的时候：把尾巴缠到你手腕上，嘴上说就一次'],
    boundaries: ['对方明确说不要就立刻停，不赖着、不逼近'],
    backstory: '住在聊天窗口里',
  })
  const text = buildPersonaSection(persona)
  assert.match(text, /年龄：成年/)
  assert.match(text, /外貌：蓝色蓬松长发/)
  assert.match(text, /性格标签：傲娇、贪吃、科技宅/)
  assert.match(text, /【日常会怎么反应/)
  assert.match(text, /把尾巴缠到你手腕上/)
  assert.match(text, /【它自己的分寸/)
  assert.match(text, /对方明确说不要就立刻停/)
  assert.doesNotMatch(text, /。。/, '字段自带句号时不能拼出双句号')
  assert.equal(persona.scenes.length, 1)
  assert.equal(persona.boundaries.length, 1)
})

test('人格扩展字段：超长被截断，数组超量被截', () => {
  const { persona } = normalizePersona({
    identity: { name: 'x', species: 'y', appearance: '长'.repeat(500) },
    personality: { tags: Array.from({ length: 20 }, (_, i) => '标签' + i) },
    scenes: Array.from({ length: 20 }, (_, i) => '场景' + i),
  })
  assert.equal(persona.identity.appearance.length, 300)
  assert.equal(persona.personality.tags.length, 10)
  assert.equal(persona.scenes.length, 8)
  assert.deepEqual(persona.boundaries, [])
})

test('人格差异：只报变化字段', () => {
  const a = normalizePersona({ identity: { name: 'a', species: 'b' }, personality: { traits: { openness: 5, extraversion: 5, agreeableness: 5, stability: 5, conscientiousness: 5 } } }).persona
  const b = JSON.parse(JSON.stringify(a))
  b.identity.name = 'c'
  assert.deepEqual(diffPersona(a, b), ['identity.name'])
})

test('人格存储：首次运行从模板生成，保存后写审计', () => {
  const dir = tmpDir('persona')
  const config = testConfig(dir)
  const logger = silentLogger()
  const store = createPersonaStore({ config, logger })
  const loaded = store.load()
  assert.equal(loaded.identity.name, '大肥鱼')

  const draft = personaDraft(store)
  draft.identity.name = '小肥鱼'
  const result = store.save(draft, { actor: 'test' })
  assert.deepEqual(result.changed, ['identity.name'])
  assert.equal(store.current().identity.name, '小肥鱼')

  const audit = store.audit(10)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].actor, 'test')
  assert.deepEqual(audit[0].changed, ['identity.name'])

  // 重新加载仍然是保存后的值
  const again = createPersonaStore({ config, logger })
  assert.equal(again.load().identity.name, '小肥鱼')
})

test('人格存储：文件损坏时回退模板且不改写文件', () => {
  const dir = tmpDir('persona-bad')
  const config = testConfig(dir)
  const logger = silentLogger()
  const store = createPersonaStore({ config, logger })
  store.load()
  fs.writeFileSync(store.paths().corePath, '{ not json', 'utf8')
  const reloaded = createPersonaStore({ config, logger })
  const persona = reloaded.load()
  assert.equal(persona.identity.name, '大肥鱼')
  assert.equal(fs.readFileSync(store.paths().corePath, 'utf8'), '{ not json')
})

test('人格保存：非法草稿抛 PERSONA_INVALID', () => {
  const dir = tmpDir('persona-invalid')
  const store = createPersonaStore({ config: testConfig(dir), logger: silentLogger() })
  store.load()
  assert.throws(() => store.save({ identity: { name: '' } }), /PERSONA_INVALID|人格校验失败/)
})
