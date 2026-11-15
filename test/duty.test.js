import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createDutyService } from '../src/platform/douyin/duty.js'
import { testConfig, tmpDir, silentLogger } from './helpers.js'

function makeService({ events = [], presetState = null, settings, persona } = {}) {
  const dir = tmpDir('duty')
  const home = path.join(dir, 'duty')
  fs.mkdirSync(home, { recursive: true })
  const config = testConfig(dir, { platforms: { douyin: { dutyPath: home, sessionPath: path.join(dir, 'session.json') } } })
  const logger = silentLogger()
  const journalRows = []
  const memRows = []
  const duty = createDutyService({
    config,
    logger,
    memory: { recordEvent: (ev, src) => memRows.push({ ev, src }) },
    journalStore: { record: (row) => journalRows.push(row) },
    platformSettings: { get: () => settings || ({ douyin: { browse: { enabled: true, mode: 'watch', commentLimit: 5 }, duty: { maxMinutes: 15, maxVideos: 15 } } }) },
    persona: persona || { current: () => ({ name: '小鱼', speech: { tone: '贫', selfReference: '我', catchphrases: [], styleNotes: '爱玩梗' } }) },
  })
  if (events.length) fs.writeFileSync(path.join(home, 'duty-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  if (presetState) fs.writeFileSync(path.join(home, 'duty-state.json'), JSON.stringify(presetState))
  return { duty, journalRows, memRows, home, logger }
}

test('值班：patch 里工具全关，只有我们的 MCP 出口', () => {
  const { duty, home } = makeService()
  const yml = duty._internal.dutyPatchYml('E:/x/duty-server.mjs', home, { maxMinutes: 15, maxVideos: 15, commentLimit: 5, sessionPath: 'E:/s.json' })
  for (const id of ['tool-fs', 'tool-pwsh', 'tool-web', 'tool-subagent']) {
    assert.ok(new RegExp(`- id: ${id}[\\s\\S]*?disabled: true`).test(yml), `值班会话不该有 ${id}`)
  }
  assert.ok(yml.includes("@deepseek-ai/dsh-mcp-client"), '要挂 dsh-mcp-client')
  assert.ok(yml.includes('duty-server.mjs'), 'MCP 服务端指到我们的文件')
  assert.ok(!yml.includes('FISH_MODE'), '不再传静默/围观模式：活动固定围观')
  assert.ok(yml.includes('FISH_CAPS'), '能力位通过环境变量传给工具层')
  assert.ok(yml.includes('FISH_MEMORY_DB'), '主动私信上下文要拿到同一个记忆库路径')
})

test('值班：memoryAllow 通过 FISH_LISTEN 传给子进程', () => {
  const { duty, home } = makeService({
    settings: { douyin: { browse: { enabled: true, commentLimit: 5 }, listen: { ownerName: '主人', memoryAllow: ['阿明', '阿红'] } } },
  })
  const cfg = duty.settings()
  const yml = duty._internal.dutyPatchYml('E:/x/duty-server.mjs', home, cfg)
  assert.match(yml, /"memoryAllow":\["阿明","阿红"\]/, '名单要原样写进 FISH_LISTEN')
  assert.ok(yml.includes('FISH_MEMORY_DB'), '记忆库路径要传给值班进程')
})

test('值班：找不到 dsh CLI 时明确拒绝，不静默', (t) => {
  const { duty, logger } = makeService()
  delete process.env.FISH_DSH_BIN
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmpDir('duty-profile')   // 别碰真 profile
  t.after(() => { if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome })
  const cli = duty._internal.findDshCli(logger)
  if (!cli) {
    const r = duty.start('manual')
    assert.equal(r.ok, false)
    assert.match(r.reason, /dsh CLI/)
    assert.equal(duty.snapshot().lastRun.ok, false, '失败要在状态里看得见')
  } else {
    assert.ok(cli.cli, '这台机器上有 CLI 也行，只要求结构对')
  }
})

test('值班：结束事件会导进记忆与流水账，偏移量只消费一次', () => {
  const events = [
    { at: 1, type: 'react', videoId: '7401', videoCaption: '猫咪', done: { like: true, follow: 'already', favorite: true } },
    { at: 2, type: 'say', kind: 'comment', text: '尾巴一摇我心都化了', target: {}, videoId: '7401', videoCaption: '猫咪' },
    { at: 3, type: 'memory', content: '我今天刷到了一群小猫打架，笑死' },
    { at: 4, type: 'say', kind: 'share', text: '这个视频有点意思', target: { name: '主人', isOwner: true }, videoId: '7401', videoCaption: '猫咪', cardSent: true, textSent: true, ok: true },
    { at: 5, type: 'owner-likes', visibility: 'open', newItems: [{ id: '7402', title: '机械臂组装' }, { id: '7403', title: '深夜炸鸡' }] },
    { at: 6, type: 'owner-likes', visibility: 'locked', newItems: [] },
    { at: 7, type: 'finish', summary: '一群小猫打架', videos: 12, seconds: 300, actions: { like: 3, forward: 1 }, aborted: false },
  ]
  const { duty, journalRows, memRows, home } = makeService({ events })
  duty._internal.importEvents()
  assert.ok(journalRows.some((r) => r.type === 'like'), '点赞要进流水账')
  assert.ok(!journalRows.some((r) => r.type === 'follow'), '已关注不算新动作')
  assert.ok(journalRows.some((r) => r.type === 'comment' && r.text.includes('尾巴')), '说话要进流水账')
  assert.ok(journalRows.some((r) => r.type === 'share' && r.ok === true && r.text.includes('有点意思')), '分享卡片+附言要进流水账')
  assert.ok(memRows.some((m) => m.ev.content.includes('小猫打架') && m.ev.importance === 5), '模型写的记忆要入库')
  assert.ok(memRows.some((m) => m.ev.content.includes('机械臂组装') && m.ev.person === '主人'), '主人新增喜欢要写进记忆')
  assert.ok(memRows.some((m) => m.ev.content.includes('喜欢列表现在是锁着的') && m.ev.importance === 2), '锁着也要记状态')
  assert.ok(memRows.some((m) => m.ev.content.includes('值班刷了 12 条') && m.ev.importance === 6), '总结要入库')
  const snap = duty.snapshot()
  assert.ok(snap.lastRun && snap.lastRun.ok && /12 条/.test(snap.lastRun.detail), '状态里能看到这轮结果')
  assert.equal(snap.lastRun.forwarded, 1, '收尾摘要要能看到分享次数')
  const afterFirst = journalRows.length
  // 再导一次：偏移量已前移，不重复写
  duty._internal.importEvents()
  assert.equal(journalRows.length, afterFirst, '重复导入不追加')
})

test('值班：中途增量导入不会吞掉正在写的那一行', () => {
  const { duty, memRows, home } = makeService()
  const file = path.join(home, 'duty-events.jsonl')
  const first = JSON.stringify({ at: 1, type: 'owner-likes', visibility: 'open', newItems: [{ id: '7402', title: '机械臂组装' }] })
  const second = JSON.stringify({ at: 2, type: 'memory', content: '主人喜欢看机械臂和深夜炸鸡' })
  const cut = Math.floor(second.length / 2)
  fs.writeFileSync(file, first + '\n' + second.slice(0, cut))
  duty._internal.importEvents()
  assert.equal(memRows.length, 1, '完整的第一行要先入库')
  assert.ok(memRows[0].ev.content.includes('机械臂组装'))
  fs.appendFileSync(file, second.slice(cut) + '\n')
  duty._internal.importEvents()
  assert.equal(memRows.length, 2, '补齐后的第二行不能丢')
  assert.ok(memRows[1].ev.content.includes('深夜炸鸡'))
  duty._internal.importEvents()
  assert.equal(memRows.length, 2, '再导一次不能重复')
})

test('值班：提示词带自由活动指南、无预算与人设', () => {
  const { duty } = makeService()
  const prompt = duty._internal.buildPrompt('manual')
  assert.ok(prompt.includes('自由活动指南'), '指南要内联')
  assert.ok(prompt.includes('没有时间预算') && prompt.includes('想待多久'), '不限时、不限条数')
  assert.ok(prompt.includes('douyin_open') && prompt.includes('douyin_self'), '自由活动要列出能做哪些事')
  assert.ok(prompt.includes('小鱼') && prompt.includes('我'), '人设要带上')
  assert.ok(prompt.includes('douyin_finish'), '收尾工具要提示')
  assert.ok(prompt.includes('douyin_dm_context'), '主动私信前要先读上下文')
  assert.ok(prompt.includes('名单外只返回上下文'), '提示词要说明名单外不返回记忆')
})

test('值班：艾特主人开着时，提示词要求评论自动 @ 主人并对主人说话', () => {
  const { duty } = makeService({
    settings: { douyin: { browse: { enabled: true, commentLimit: 5 }, actions: { mentionOwner: true }, listen: { ownerName: '思维_' } } },
  })
  const prompt = duty._internal.buildPrompt('manual')
  assert.ok(prompt.includes('「艾特主人」开着'), '开关打开要说明')
  assert.ok(prompt.includes('@ 思维_'), '提示词要带上主人昵称')
  assert.ok(prompt.includes('对主人说的话'), '要明确文案是给主人看的')
  assert.ok(prompt.includes('不要写成对视频作者'), '避免退化成普通视频评论')
  assert.ok(prompt.includes('douyin_owner_memory'), '艾特主人评论前要先读长期记忆')
  assert.ok(prompt.includes('普通评论') && prompt.includes('kind=reply'), '普通评论/回复不读记忆要写清楚')
})

test('值班：分享给主人开着时，提示词要求独立开关、最多一条、带文字先读记忆', () => {
  const { duty } = makeService({
    settings: { douyin: { browse: { enabled: true, commentLimit: 5 }, actions: { forward: true, dm: true }, listen: { ownerName: '思维_' } } },
  })
  const cfg = duty.settings()
  assert.equal(cfg.actions.forward, true, '设置里的分享开关要传给值班进程')
  const prompt = duty._internal.buildPrompt('manual')
  assert.ok(prompt.includes('douyin_share_to_owner'), '开关打开时要出现分享工具')
  assert.ok(prompt.includes('每次值班最多一条'), '每次值班最多一条要写进提示词')
  assert.ok(prompt.includes('先调 douyin_owner_memory'), '带文字前先读记忆要写进提示词')
  assert.ok(prompt.includes('私信（主动）'), '带文字需要私信开关要写清')
  assert.ok(prompt.includes('partial'), '卡片成功但文字失败要提示部分成功')
})

test('值班：社交互动是受限任务，只找主人、不刷视频', () => {
  const { duty, home } = makeService({
    settings: { douyin: { browse: { enabled: true }, actions: { dm: true }, listen: { ownerName: '思维_' } } },
  })
  const prompt = duty._internal.buildPrompt('社交互动', { task: 'social', owner: 'social' })
  assert.ok(prompt.includes('只做「社交互动」'), '要明确只做社交')
  assert.ok(prompt.includes('思维_'), '要带主人昵称')
  assert.ok(prompt.includes('douyin_dm_context'), '先读主人上下文')
  assert.ok(prompt.includes('douyin_finish'), '发完要收尾')
  assert.ok(!prompt.includes('douyin_open'), '社交任务不给刷视频工具')
  assert.ok(!prompt.includes('douyin_say'), '社交任务不给评论工具')
  const cfg = duty.settings()
  const yml = duty._internal.dutyPatchYml('E:/x/duty-server.mjs', home, cfg, 'social')
  assert.ok(yml.includes("FISH_TASK: 'social'"), '任务类型要传进值班进程')
})

test('值班：社交任务在启动前检查私信开关和主人昵称', () => {
  const { duty } = makeService({
    settings: { douyin: { browse: { enabled: true }, actions: { dm: false }, listen: { ownerName: '思维_' } } },
  })
  const r = duty.start('社交互动', { task: 'social', owner: 'social' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /私信/)
})


test('值班：人设从 identity.name 取名字，画面/主人喜欢按开关出现', () => {
  const { duty } = makeService({
    settings: { douyin: { browse: { enabled: true, commentLimit: 5, vision: true }, listen: { ownerName: '主人' }, owner: { profileUrl: 'https://www.douyin.com/user/abc', readLikes: true } } },
    persona: { current: () => ({ identity: { name: '蛋蛋', species: '蓝鲸女孩' }, speech: { tone: '傲娇', selfReference: '这条鲸鱼', catchphrases: [] } }) },
  })
  const prompt = duty._internal.buildPrompt('manual')
  assert.ok(prompt.includes('名字：蛋蛋'), '不能再回退成大肥鱼')
  assert.ok(prompt.includes('蓝鲸女孩'))
  assert.ok(prompt.includes('douyin_owner_likes'), '喜欢列表开关打开时要出现工具')
  assert.ok(prompt.includes('主人最近喜欢什么'), '喜欢列表新增后要提示先写记忆再继续')
  assert.ok(prompt.includes('画面截给你看'), '画面理解打开时要说明')
})
