// 首装鲁棒性与外发边界：坏配置不炸、任意文件发不出去、模板占位文字不被当人格
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'
import { resolveStickerFile } from '../src/platform/douyin/inbox.js'
import { resolveRefImage } from '../src/image/doubao.js'
import { parsePersonaCard, PERSONA_PROMPT_TEMPLATE } from '../src/persona/parse-card.js'
import { createFirstMeet, firstMeetText } from '../src/persona/first-meet.js'
import { tmpDir } from './helpers.js'

test('坏配置不炸：写成字符串/数字也照常出默认值', () => {
  const cases = [
    { memory: 5 },
    { decision: { quietHours: '23:00' } },
    { persona: 'x' },
    { gui: 1 },
    { image: { doubao: 3 } },
    { platforms: { douyin: 'nope' } },
    null,
    'str',
    [],
  ]
  for (const bad of cases) {
    const { config, warnings } = resolveConfig(bad)
    assert.equal(config.memory.dbPath, DEFAULT_CONFIG.memory.dbPath, `memory.dbPath 应回退默认：${JSON.stringify(bad)}`)
    assert.equal(config.decision.quietHours.start, DEFAULT_CONFIG.decision.quietHours.start, '静默时段应回退默认')
    assert.equal(typeof config.platforms.douyin.loginPort, 'number', '端口必须是数字')
    assert.ok(Array.isArray(warnings), 'warnings 必须是数组')
  }
})

test('默认配置不会被上一次调用污染', () => {
  const a = resolveConfig({})
  a.config.decision.quietHours.start = '01:00'
  a.config.memory.halfLifeDays.episodic = 1
  const b = resolveConfig({})
  assert.equal(b.config.decision.quietHours.start, '23:00')
  assert.equal(b.config.memory.halfLifeDays.episodic, 14)
  assert.equal(DEFAULT_CONFIG.decision.quietHours.start, '23:00', 'DEFAULT_CONFIG 本体不能被改')
})

test('端口配成字符串也不会变成 92241', () => {
  const { config } = resolveConfig({ platforms: { douyin: { loginPort: '9224' } } })
  assert.equal(config.platforms.douyin.loginPort, 9224)
  assert.equal(config.platforms.douyin.browsePort, 9225)
})

test('表情包外发：只认 data/stickers、data/images 里的图片', () => {
  const rejected = [
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/etc/passwd',
    'data/stickers/../../secret.png',
    '../../outside.png',
    'data/plugin.log',
    'package.json',
    '',
    null,
  ]
  for (const raw of rejected) {
    assert.equal(resolveStickerFile(raw), '', `不该接受：${raw}`)
  }
})

test('豆包参考图：同样不认目录外的路径', () => {
  assert.equal(resolveRefImage('C:\\Users\\Public\\x.png'), '')
  assert.equal(resolveRefImage('data/images/../../x.png'), '')
  assert.equal(resolveRefImage(''), '')
})

test('把模板原文误贴进「AI 结果」不会被当成人格', () => {
  const { draft, warnings } = parsePersonaCard(PERSONA_PROMPT_TEMPLATE, {})
  assert.ok(warnings.length > 0, '应该明确提示这是模板占位文字')
  assert.notEqual(draft.identity.name, '给它起个名字')
  assert.notEqual(draft.speech.ownerAddress, '它应该怎么称呼我')
})

test('正常的人格卡能解析出名字与称呼', () => {
  const text = ['【名字】团子', '【称呼我】老大', '【整体语气】懒懒的', '【自称】我'].join('\n')
  const { draft, found } = parsePersonaCard(text, {})
  assert.equal(draft.identity.name, '团子')
  assert.equal(draft.speech.ownerAddress, '老大')
  assert.ok(found.includes('name'))
})

test('首次见面：措辞里带称呼提示，且不写自我介绍', () => {
  const text = firstMeetText({ speech: { ownerAddress: '主人', selfReference: '我' } })
  assert.match(text, /第一次见面/)
  assert.match(text, /主人/)
  assert.match(text, /别做自我介绍/)
})

test('首次见面：已配置过的老用户不重复出现', () => {
  const dir = tmpDir('first-meet')
  const config = { persona: { firstMeetPath: `${dir}/first-meet.json` } }
  const fresh = createFirstMeet({ config, logger: { info() {}, warn() {} }, fresh: true })
  assert.equal(fresh.pending(), true)
  fresh.complete('test')
  assert.equal(fresh.pending(), false)

  // 模拟「升级上来、没有标记」：直接记成已见，不会被说「刚把你装进来」
  const upgraded = createFirstMeet({ config: { persona: { firstMeetPath: `${dir}/upgraded.json` } }, logger: { info() {}, warn() {} }, fresh: false })
  assert.equal(upgraded.pending(), false)
})
