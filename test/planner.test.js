// 创作参数：视觉轮换、宿主视觉优先、发布身份与口吻检查
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fallbackLook,
  buildPrompt,
  normalizeDirection,
  voiceIssue,
} from '../src/creative/planner.js'

function makePlugin() {
  const themes = ['butter-yellow', 'sakura-pink', 'mist-blue', 'mint-green', 'apricot-orange', 'lavender-gray']
  return {
    themes: themes.map((id) => ({ id, name: id })),
    characters: [{
      id: 'dandan',
      name: '蛋蛋',
      avatar: 'characters/dandan/avatar.png',
      poses: ['stand', 'sit', 'wave', 'peek-left', 'peek-right'],
    }],
    templates: [{ id: 'black-card', placements: ['bottom-right', 'left-edge', 'right-edge'] }],
    presets: [{ id: 'dandan-with-character' }],
  }
}

const state = {
  state: 'rest',
  label: '放松',
  affect: {
    mood: { label: '开心' },
    emotion: { label: '开心' },
    plain: {},
  },
  vars: { energy: 75, socialNeed: 80, creativeUrge: 80 },
}

const persona = {
  identity: { name: '蛋蛋', species: '成年的蓝鲸女孩', identitySummary: '嘴硬心软的傲娇鲸鱼' },
  speech: { styleNotes: '自称我，偶尔自嘲大胖鱼；先嘴硬后服软；能一句答完就停。' },
}

test('视觉：同心情下主题和姿势会轮换，上一张的选项不重复', () => {
  const plugin = makePlugin()
  const previous = {
    theme: 'sakura-pink',
    character: { enabled: true, pose: 'wave', placement: 'bottom-right' },
  }
  const themes = new Set()
  const poses = new Set()
  for (const seed of [1234567, 9876543, 5555555, 2222222, 9999999, 3141592]) {
    const look = fallbackLook(plugin, state, previous, seed)
    assert.notEqual(look.theme, previous.theme)
    assert.notEqual(look.character.pose, previous.character.pose)
    themes.add(look.theme)
    poses.add(look.character.pose)
  }
  assert.ok(themes.size > 1, '主题不能锁死在一种')
  assert.ok(poses.size > 1, '姿势不能锁死在一种')
})

test('视觉：插件有姿势就启用角色，不再只跟粉色主题绑定', () => {
  const plugin = makePlugin()
  const look = fallbackLook(plugin, state, null, 42)
  assert.equal(look.character.enabled, true)
  assert.ok(plugin.characters[0].poses.includes(look.character.pose))
  assert.ok(['bottom-right', 'left-edge', 'right-edge'].includes(look.character.placement))
})

test('视觉：最近两张用过的主题和姿势也会继续避开', () => {
  const plugin = makePlugin()
  const previous = {
    theme: 'sakura-pink',
    character: { enabled: true, pose: 'wave', placement: 'bottom-right' },
    recentThemes: ['sakura-pink', 'apricot-orange'],
    recentPoses: ['wave', 'sit'],
  }
  const look = fallbackLook(plugin, state, previous, 42)
  assert.ok(!previous.recentThemes.includes(look.theme))
  assert.ok(!previous.recentPoses.includes(look.character.pose))
})

test('提示词：带完整口吻规则、禁用套话和短配文要求', () => {
  const text = buildPrompt({ plugin: makePlugin(), state, persona, fallback: fallbackLook(makePlugin(), state, null, 1) })
  assert.ok(text.includes(persona.speech.styleNotes), '必须带 speech.styleNotes')
  assert.ok(text.includes('心里嘀咕') && text.includes('自言自语'), '口吻要像大肥鱼自己的心理活动')
  assert.ok(text.includes('仪式感'), '必须显式禁用社媒套话')
  assert.ok(text.includes('6–24 字'), '配文要有明确长度上限')
  assert.ok(text.includes('35–50 个汉字'), '正文长度要收敛')
})

test('视觉：模型返回的 theme/character 不覆盖宿主已定视觉', () => {
  const plugin = makePlugin()
  const fallback = fallbackLook(plugin, state, null, 42)
  const normalized = normalizeDirection({
    theme: 'sakura-pink',
    character: { enabled: false, pose: 'wave', placement: 'bottom-right' },
    hook: '手机快没电了',
    body: '外卖先到。今天不想动，谁劝都没用。',
    highlights: ['手机快没电了'],
    caption: '别催，我在充电。',
  }, { plugin, persona, fallback, now: () => new Date(), account: { handle: '思维_', avatar: 'E:\\avatar.png' } })
  assert.equal(normalized.plan.theme, fallback.theme)
  assert.equal(normalized.plan.character.pose, fallback.character.pose)
  assert.equal(normalized.plan.character.enabled, true)
  assert.equal(normalized.plan.account.handle, '@思维_')
  assert.equal(normalized.plan.account.avatar, 'E:\\avatar.png')
})

test('口吻：命中套话、配文过长、配文整段复制正文都会拦下', () => {
  assert.match(voiceIssue({ caption: '摆烂也要有仪式感', body: '躺着刷手机' }), /仪式感/)
  assert.match(voiceIssue({ caption: '这句配文特别特别长已经超过三十个汉字所以必须被拦下来重新写一遍啊啊啊', body: '短句。' }), /30/)
  assert.match(voiceIssue({ caption: '我躺着刷手机假装在给生活充电', body: '我躺着刷手机假装在给生活充电' }), /整段重复/)
  assert.equal(voiceIssue({ caption: '别催，我在充电。', body: '手机快没电了。外卖先到。' }), '')
})
