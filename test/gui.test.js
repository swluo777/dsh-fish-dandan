import test from 'node:test'
import assert from 'node:assert/strict'
import { createHandlers, isLoopbackAddress, isLoopbackOrigin, registerGui } from '../src/gui/api.js'
import { createPersonaStore, personaDraft } from '../src/persona/index.js'
import { createMemory } from '../src/memory/index.js'
import { createDecision } from '../src/decision/index.js'
import { createPlatforms } from '../src/platform/index.js'
import { callHandler, FakeReq, FakeRes, silentLogger, testConfig, tmpDir } from './helpers.js'

function setup(extra = {}) {
  const dir = tmpDir('gui')
  const config = testConfig(dir)
  const logger = silentLogger()
  const persona = createPersonaStore({ config, logger })
  persona.load()
  const memory = createMemory({ config, logger })
  const decision = createDecision({ config, logger })
  const handlers = createHandlers({ config, logger, persona, memory, decision, ...extra })
  return { handlers, persona, memory, decision, config, logger }
}

test('接入保护：只有回环地址与可信来源被放行', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackOrigin(undefined), true)
  assert.equal(isLoopbackOrigin(undefined, 'localhost:7431'), true)
  assert.equal(isLoopbackOrigin('http://localhost:3000'), true)
  assert.equal(isLoopbackOrigin('https://evil.example'), false)
  // DNS rebinding：Host 是恶意域名、Origin 也自称同源，也不许
  assert.equal(isLoopbackOrigin('http://evil.example:7431', 'evil.example:7431'), false)
  // 桌面端：宿主自有协议 / file://
  assert.equal(isLoopbackOrigin('dsh-app://fish'), true)
  assert.equal(isLoopbackOrigin('file://'), true)
  // Web 端同源：默认只放行本机 Host；显式开远程访问后才放行局域网 Host
  assert.equal(isLoopbackOrigin('http://127.0.0.1:7431', '127.0.0.1:7431'), true)
  assert.equal(isLoopbackOrigin('http://192.168.1.9:7431', '192.168.1.9:7431'), false)
  assert.equal(isLoopbackOrigin('http://192.168.1.9:7431', '192.168.1.9:7431', { allowRemote: true }), true)
  assert.equal(isLoopbackOrigin('http://192.168.1.9:7431', '127.0.0.1:7431'), false)
})

test('概览接口返回人格、记忆、状态与限制', async () => {
  const { handlers, memory } = setup()
  memory.recordEvent({ content: '一条测试记忆', importance: 6 }, 'test')
  const { status, body } = await callHandler(handlers['/overview'])
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.persona.name, '大肥鱼')
  assert.ok(body.memory.total >= 1)
  assert.ok(body.decision.vars.energy >= 0)
  assert.ok(Array.isArray(body.limits.traits))
})

test('人格接口：GET 返回草稿，PUT 保存并返回变更字段', async () => {
  const { handlers, persona } = setup()
  const got = await callHandler(handlers['/persona'], { method: 'GET' })
  assert.equal(got.status, 200)
  const draft = got.body.draft
  draft.identity.name = '面板改的名字'

  const saved = await callHandler(handlers['/persona'], { method: 'PUT', body: { draft } })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.changed, ['identity.name'])
  assert.equal(persona.current().identity.name, '面板改的名字')
})

test('人格接口：非法草稿返回 400 且不落库', async () => {
  const { handlers, persona } = setup()
  const before = persona.current().identity.name
  const bad = await callHandler(handlers['/persona'], {
    method: 'PUT',
    body: { draft: { identity: { name: '', species: '' } } },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'PERSONA_INVALID')
  assert.equal(persona.current().identity.name, before)
})

test('人格接口：错误方法返回 405', async () => {
  const { handlers } = setup()
  const result = await callHandler(handlers['/persona'], { method: 'DELETE' })
  assert.equal(result.status, 405)
})

test('记忆接口：搜索与锚定', async () => {
  const { handlers, memory } = setup()
  const { body: created } = await callHandler(handlers['/memory'], {})
  const recorded = memory.recordEvent({ content: '面板里应该能搜到这条', importance: 7 }, 'test')

  const search = await callHandler(handlers['/memory'], { url: '/fish-dandan/api/memory?q=搜到&limit=10' })
  assert.equal(search.status, 200)
  assert.ok(search.body.items.some((item) => item.id === recorded.id))

  const pinned = await callHandler(handlers['/memory/pin'], { method: 'POST', body: { id: recorded.id } })
  assert.equal(pinned.status, 200)
  assert.ok(pinned.body.stats.pinned >= 1)
})

test('记忆接口：缺少 id 返回 400', async () => {
  const { handlers } = setup()
  const result = await callHandler(handlers['/memory/pin'], { method: 'POST', body: {} })
  assert.equal(result.status, 400)
})

test('状态接口：策略三档保存并立即生效', async () => {
  const { handlers, decision } = setup()
  const saved = await callHandler(handlers['/decision/policy'], {
    method: 'PUT',
    body: { explore: 'auto', social: 'off', create: 'ask' },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.policy, { explore: 'auto', social: 'off', create: 'ask' })
  assert.deepEqual(decision.getInternalState().policy, { explore: 'auto', social: 'off', create: 'ask' })
  const invalid = await callHandler(handlers['/decision/policy'], {
    method: 'POST',
    body: { explore: 'always' },
  })
  assert.equal(invalid.status, 400)
})

test('状态接口：nudge 与调度参数更新', async () => {
  const { handlers } = setup()
  const nudged = await callHandler(handlers['/decision/nudge'], { method: 'POST', body: { action: 'explore', ttlMinutes: 5 } })
  assert.equal(nudged.status, 200)
  assert.equal(nudged.body.state, 'explore')

  const scheduler = await callHandler(handlers['/decision/scheduler'], {
    method: 'PUT',
    body: {
      dailyBudget: 3,
      quietHours: { start: '22:00', end: '06:00' },
      actionLimits: { explore: { dailyBudget: 2, gapMs: 30 * 60_000 } },
    },
  })
  assert.equal(scheduler.status, 200)
  assert.equal(scheduler.body.scheduler.dailyBudget, 3)
  assert.equal(scheduler.body.scheduler.actionLimits.explore.dailyBudget, 2)
  assert.equal(scheduler.body.scheduler.actionLimits.explore.gapMs, 30 * 60_000)
})

test('状态接口：未知动作返回 400', async () => {
  const { handlers } = setup()
  const result = await callHandler(handlers['/decision/nudge'], { method: 'POST', body: { action: '飞走' } })
  assert.equal(result.status, 400)
})

test('审计接口：写入后可读', async () => {
  const { handlers, memory } = setup()
  memory.recordEvent('审计接口测试', 'test')
  const result = await callHandler(handlers['/audit'], { url: '/fish-dandan/api/audit?limit=5' })
  assert.equal(result.status, 200)
  assert.ok(result.body.memory.length >= 1)
})

test('复盘接口：手动触发返回统计', async () => {
  const { handlers, memory } = setup()
  memory.recordEvent({ content: '看了天文视频', tags: ['天文'], importance: 6 }, 'test')
  const result = await callHandler(handlers['/memory/review'], { method: 'POST' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(typeof result.body.created, 'number')
})

test('人格预览接口：返回与注入一致的文本', async () => {
  const { handlers } = setup()
  const got = await callHandler(handlers['/persona'], { method: 'GET' })
  got.body.draft.identity.name = '预览鱼'
  const res = await callHandler(handlers['/persona/preview'], { method: 'POST', body: { draft: got.body.draft } })
  assert.equal(res.status, 200)
  assert.match(res.body.text, /预览鱼/)
  assert.equal(res.body.valid, true)
})

test('网页版设置页：注入 API 基址并返回 HTML', async () => {
  const dir = tmpDir('gui-ui')
  const config = testConfig(dir)
  const logger = silentLogger()
  const persona = createPersonaStore({ config, logger })
  persona.load()
  const memory = createMemory({ config, logger })
  const decision = createDecision({ config, logger })
  const platforms = createPlatforms({ config, logger })
  const routes = []
  const ctx = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:4321',
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  registerGui(ctx, { config, logger, persona, memory, decision, platforms })
  const ui = routes.find((route) => route.path === '/fish-dandan/ui')
  assert.ok(ui)
  const res = new FakeRes()
  await ui.handler(new FakeReq({ method: 'GET', url: '/fish-dandan/ui' }), res)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /__FD_API_BASE__/)
  assert.match(res.body, /"\/fish-dandan\/api"/)
  assert.match(res.body, /大肥鱼/)
})

test('待确认动作：不存在的 id 返回 404', async () => {
  const { handlers } = setup()
  const res = await callHandler(handlers['/pending/approve'], { method: 'POST', body: { id: 'nope' } })
  assert.equal(res.status, 404)
})

test('向导完成标记：GET/PUT 往返并落盘，重启后仍可读，非法 body 拒绝', async () => {
  const { handlers } = setup()
  const first = await callHandler(handlers['/wizard'], { method: 'GET' })
  assert.equal(first.status, 200)
  assert.equal(first.body.done, false, '出厂模板人格 -> 未配置')
  const put = await callHandler(handlers['/wizard'], { method: 'PUT', body: { done: true } })
  assert.equal(put.status, 200)
  assert.equal(put.body.done, true)
  const again = await callHandler(handlers['/wizard'], { method: 'GET' })
  assert.equal(again.body.done, true, '等价于「关掉网页再打开」之后的状态')
  const bad = await callHandler(handlers['/wizard'], { method: 'PUT', body: { done: 'yes' } })
  assert.equal(bad.status, 400, 'done 必须是布尔值')
  const wrongMethod = await callHandler(handlers['/wizard'], { method: 'DELETE' })
  assert.equal(wrongMethod.status, 405)
})

test('向导完成标记：人格已改过的老用户首次访问自动补记为已完成', async () => {
  const { handlers, persona } = setup()
  const draft = personaDraft(persona)
  draft.identity.name = '团子'
  persona.save(draft, { actor: 'test' })
  const res = await callHandler(handlers['/wizard'], { method: 'GET' })
  assert.equal(res.body.done, true, '升级后不应把已配置的用户退回向导第 1 步')
})

test('一句话微调：只解析预览，联动阈值与可选调度提案齐全', async () => {
  const { handlers } = setup()
  const res = await callHandler(handlers['/persona/tune'], {
    method: 'POST',
    body: { text: '话稍微少一点点，但还是话痨' },
  })
  assert.equal(res.status, 200)
  const c = res.body.changes.find((x) => x.key === 'extraversion')
  assert.ok(c, '应有外向变更')
  assert.equal(c.to, 5)
  assert.ok(c.anchor, '保底锚要写清')
  assert.ok(res.body.linkages.length >= 1, '性格阈值联动预告（想找人的线等）')
  assert.ok(res.body.optional.length >= 1, '少说话时给可选调度提案，默认不勾由用户决定')
  assert.ok(res.body.newTraits.extraversion === 5)
  const blank = await callHandler(handlers['/persona/tune'], { method: 'POST', body: { text: '   ' } })
  assert.equal(blank.status, 400)
  const nm = await callHandler(handlers['/persona/tune'], { method: 'GET' })
  assert.equal(nm.status, 405)
})

test('一句话微调：新增的年龄 / 外貌 / 标签等字段也能解析', async () => {
  const { handlers } = setup()
  const age = await callHandler(handlers['/persona/tune'], { method: 'POST', body: { text: '年龄改成 28' } })
  assert.equal(age.status, 200)
  const c = age.body.changes.find((x) => x.path === 'identity.age')
  assert.ok(c, '应产出年龄变更')
  assert.equal(c.kind, 'text')
  assert.equal(c.to, '28')

  const tag = await callHandler(handlers['/persona/tune'], { method: 'POST', body: { text: '标签加上科技宅' } })
  assert.equal(tag.status, 200)
  assert.ok(tag.body.changes.some((x) => x.kind === 'list-add' && x.path === 'personality.tags'))
})

test('抖音登录端点：适配器未注入时给出兜底，方法不对返回 405', async () => {
  const { handlers } = setup()
  const res = await callHandler(handlers['/platforms/douyin/session'], { method: 'GET' })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'planned', '没有 platforms 依赖时兜底为规划中')
  const nm = await callHandler(handlers['/platforms/douyin/login'], { method: 'GET' })
  assert.equal(nm.status, 405)
  const cancel = await callHandler(handlers['/platforms/douyin/cancel'], { method: 'POST' })
  assert.equal(cancel.status, 409, '没有适配器时取消登录要明确报缺适配器')
  const cancelMethod = await callHandler(handlers['/platforms/douyin/cancel'], { method: 'GET' })
  assert.equal(cancelMethod.status, 405)

  const browseGet = await callHandler(handlers['/platforms/douyin/browse'], { method: 'GET' })
  assert.equal(browseGet.status, 409, '没有抖音适配器时刷流端点要明确报缺适配器')
  const browsePost = await callHandler(handlers['/platforms/douyin/browse'], { method: 'POST' })
  assert.equal(browsePost.status, 409)
  const browseStop = await callHandler(handlers['/platforms/douyin/browse/stop'], { method: 'POST' })
  assert.equal(browseStop.status, 409, '停止本轮同样要有缺适配器的兜底')
  const browseStopMethod = await callHandler(handlers['/platforms/douyin/browse/stop'], { method: 'GET' })
  assert.equal(browseStopMethod.status, 405)

  const journalList = await callHandler(handlers['/platforms/douyin/journal'], { method: 'GET' })
  assert.equal(journalList.status, 409, '没有适配器时行为日志要明确报缺适配器')
  const journalMethod = await callHandler(handlers['/platforms/douyin/journal'], { method: 'POST' })
  assert.equal(journalMethod.status, 409)
  const commentsGet = await callHandler(handlers['/platforms/douyin/comments'], { method: 'GET' })
  assert.equal(commentsGet.status, 409, '没有抖音适配器时回评论端点要明确报缺适配器')
  const commentsPost = await callHandler(handlers['/platforms/douyin/comments'], { method: 'POST', body: { enabled: true } })
  assert.equal(commentsPost.status, 409)
})

test('行为动作：手动触发走执行器，未知动作与缺执行器都明确拒绝', async () => {
  const calls = []
  let stopCalls = 0
  const actionRunner = {
    start(kind, options) {
      calls.push({ kind, options })
      return { ok: true, activity: { kind, status: 'running', label: kind } }
    },
    async stop(reason) {
      stopCalls += 1
      return { ok: true, reason, activity: { kind: 'explore', status: 'cancelled', label: '自主探索' } }
    },
    snapshot() {
      return { kind: 'explore', status: 'running' }
    },
  }
  const { handlers } = setup({ actionRunner })
  for (const kind of ['explore', 'social', 'create']) {
    const res = await callHandler(handlers['/decision/action'], {
      method: 'POST',
      body: { kind },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.started, true)
    assert.equal(res.body.kind, kind)
  }
  assert.deepEqual(calls.map((x) => x.kind), ['explore', 'social', 'create'])
  assert.equal(calls[0].options.trigger, 'manual', '手动触发不经过自动策略')

  const stopped = await callHandler(handlers['/decision/activity/stop'], { method: 'POST' })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.stopped, true)
  assert.equal(stopCalls, 1, '活动行里的终止按钮复用同一个停止端点')
  const stopWrongMethod = await callHandler(handlers['/decision/activity/stop'], { method: 'GET' })
  assert.equal(stopWrongMethod.status, 405)

  const bad = await callHandler(handlers['/decision/action'], {
    method: 'POST',
    body: { kind: 'sleep' },
  })
  assert.equal(bad.status, 400)
  const wrongMethod = await callHandler(handlers['/decision/action'], { method: 'GET' })
  assert.equal(wrongMethod.status, 405)

  const { handlers: bare } = setup()
  const noRunner = await callHandler(bare['/decision/action'], {
    method: 'POST',
    body: { kind: 'explore' },
  })
  assert.equal(noRunner.status, 409)
})

test('回评论端点：GET 返回快照，POST 写开关并调用 apply', async () => {
  let enabled = false
  const applied = []
  const platforms = {
    getAdapter: () => ({
      comments: {
        snapshot: () => ({ enabled, running: enabled, tabOpen: enabled, mode: 'shared-browser-tab' }),
        apply: async (reason) => {
          applied.push(reason)
          enabled = true
          return { ok: true, running: enabled }
        },
      },
    }),
  }
  const { handlers } = setup({ platforms })

  const before = await callHandler(handlers['/platforms/douyin/comments'], { method: 'GET' })
  assert.equal(before.status, 200)
  assert.equal(before.body.enabled, false)

  const post = await callHandler(handlers['/platforms/douyin/comments'], {
    method: 'POST',
    body: { enabled: true },
  })
  assert.equal(post.status, 200)
  assert.deepEqual(applied, ['toggle'])
  assert.equal(post.body.enabled, true)
  assert.equal(post.body.tabOpen, true)

  const saved = await callHandler(handlers['/platform/settings'], { method: 'GET' })
  assert.equal(saved.body.settings.douyin.comments.enabled, true, '开关要写进平台设置')
})

test('行为日志接口：只读返回它自己做过的事，没有审批入口', async () => {
  const dir = tmpDir('gui-journal')
  const config = testConfig(dir)
  const logger = silentLogger()
  const persona = createPersonaStore({ config, logger })
  persona.load()
  const memory = createMemory({ config, logger })
  const decision = createDecision({ config, logger })
  const journal = {
    list: (limit) => [{ id: 'j1', type: 'comment', text: '好家伙', mood: '雀跃', ok: true, at: Date.now(), _limit: limit }],
    counts: () => ({ total: 1, today: 1, byType: { comment: 1 } }),
  }
  const platforms = { getAdapter: () => ({ journal }) }
  const handlers = createHandlers({ config, logger, persona, memory, decision, platforms })
  const res = await callHandler(handlers['/platforms/douyin/journal'], { method: 'GET', url: '/fish-dandan/api/platforms/douyin/journal?limit=5' })
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 1)
  assert.equal(res.body.items[0].text, '好家伙')
  assert.equal(res.body.counts.today, 1)
  assert.equal(handlers['/platforms/douyin/pending'], undefined, '旧的审批端点应已移除')
})

test('自动发布：只拉起带登录档案的共享浏览器并进入创作者中心', async () => {
  let opens = 0
  const platforms = {
    getAdapter: () => ({
      publishBrowser: {
        open: async () => {
          opens += 1
          return { ok: true, url: 'https://creator.douyin.com/creator-micro/content/upload', tabKind: 'publish', tabOpen: true }
        },
      },
    }),
  }
  const { handlers } = setup({ platforms })
  const post = await callHandler(handlers['/creative-studio/publish-browser'], { method: 'POST' })
  assert.equal(post.status, 200)
  assert.equal(opens, 1, '点自动发布只调用一次打开浏览器')
  assert.equal(post.body.url, 'https://creator.douyin.com/creator-micro/content/upload')
  assert.equal(post.body.tabKind, 'publish')

  const wrong = await callHandler(handlers['/creative-studio/publish-browser'], { method: 'GET' })
  assert.equal(wrong.status, 405)

  const { handlers: bare } = setup()
  const missing = await callHandler(bare['/creative-studio/publish-browser'], { method: 'POST' })
  assert.equal(missing.status, 409, '没有共享浏览器时要说清楚')
})

test('自动发布：把当前作品交给共享浏览器走完整图文发布', async () => {
  let published = null
  const platforms = {
    getAdapter: () => ({
      publishBrowser: {
        publish: async (payload) => {
          published = payload
          return { ok: true, url: 'https://creator.douyin.com/creator-micro/content/manage', reviewing: true, music: 'Timeisbroken', images: 1, seconds: 42 }
        },
      },
    }),
  }
  const outputDir = 'E:\\Projects\\dandan-creative-studio\\data\\exports\\creative-test'
  const creativeStudio = {
    publication: () => ({
      jobId: 'creative-test',
      imagePath: outputDir + '\\image.png',
      title: '就赖这一会儿，别喊我',
      body: '我翻了个身，爪子扒住边儿，尾巴先到，脸随后。',
      caption: '就赖这一会儿，别喊我',
      outputDir,
    }),
  }
  const { handlers } = setup({ platforms, creativeStudio })
  const res = await callHandler(handlers['/creative-studio/publish-image-post'], { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.reviewing, true)
  assert.equal(res.body.music, 'Timeisbroken')
  assert.equal(published.imagePath, outputDir + '\\image.png')
  assert.equal(published.title, '就赖这一会儿，别喊我')
  assert.equal(published.body, '我翻了个身，爪子扒住边儿，尾巴先到，脸随后。')
  assert.equal(published.music, 'recommended', '默认选推荐第一首')
  assert.equal(published.visibility, 'public')
  assert.deepEqual(published.extraRoots, [outputDir], '创作输出目录作为受信图片根')

  const wrong = await callHandler(handlers['/creative-studio/publish-image-post'], { method: 'GET' })
  assert.equal(wrong.status, 405)

  const { handlers: bare } = setup({ creativeStudio })
  const missingBrowser = await callHandler(bare['/creative-studio/publish-image-post'], { method: 'POST' })
  assert.equal(missingBrowser.status, 409)

  const noWork = {
    publication: () => {
      const err = new Error('当前没有作品，先做一张图文')
      err.code = 'CREATIVE_NO_WORK'
      throw err
    },
  }
  const { handlers: empty } = setup({ platforms, creativeStudio: noWork })
  const noWorkRes = await callHandler(empty['/creative-studio/publish-image-post'], { method: 'POST' })
  assert.equal(noWorkRes.status, 409)
  assert.equal(noWorkRes.body.error.code, 'CREATIVE_NO_WORK')
})

test('平台设置：GET 默认值、PUT 局部合并落盘、非法请求被拒', async () => {
  const { handlers } = setup()
  const get = await callHandler(handlers['/platform/settings'], { method: 'GET' })
  assert.equal(get.status, 200)
  assert.equal(get.body.settings.douyin.browse.enabled, false)

  const put = await callHandler(handlers['/platform/settings'], {
    method: 'PUT',
    body: { douyin: { browse: { enabled: true }, actions: { reply: true } } },
  })
  assert.equal(put.status, 200)
  assert.equal(put.body.settings.douyin.browse.enabled, true)
  assert.equal(put.body.settings.douyin.actions.reply, true)
  assert.equal(put.body.settings.douyin.browse.commentLimit, 5, '未提到的权限位保持默认')
  assert.ok(!('pace' in put.body.settings.douyin), '不再有节奏/预算字段')

  const again = await callHandler(handlers['/platform/settings'], { method: 'GET' })
  assert.equal(again.body.settings.douyin.actions.reply, true, '落盘后再读仍在')

  const bad = await callHandler(handlers['/platform/settings'], { method: 'PUT', body: [1, 2, 3] })
  assert.equal(bad.status, 400)
  const wrong = await callHandler(handlers['/platform/settings'], { method: 'DELETE' })
  assert.equal(wrong.status, 405)
})

test('平台设置 PUT：切回评论开关会触发 comments.apply', async () => {
  const applied = []
  const platforms = {
    getAdapter: () => ({
      comments: {
        snapshot: () => ({ enabled: true, running: true, tabOpen: false }),
        apply: async (reason) => { applied.push(reason); return { ok: true } },
      },
    }),
  }
  const { handlers } = setup({ platforms })
  const put = await callHandler(handlers['/platform/settings'], {
    method: 'PUT',
    body: { douyin: { comments: { enabled: true } } },
  })
  assert.equal(put.status, 200)
  assert.deepEqual(applied, ['settings'], '网页开关走平台设置时也要真正打开/关闭回评论页')
  assert.equal(put.body.settings.douyin.comments.enabled, true)
})

test('表情包标语义端点：POST 只排队，GET 返回进度，DELETE 停止', async () => {
  let enrichCalls = 0
  let stopCalls = 0
  const stats = {
    total: 3, captioned: 0, captionPending: 3, captionActive: 0,
    captionFailed: 0, captionReady: true,
  }
  const stickers = {
    stats: () => ({ ...stats }),
    enrichMissing: () => {
      enrichCalls += 1
      return { ready: true, queued: 2, pending: 3, total: 3, captioned: 0 }
    },
    stopCaptioning: () => {
      stopCalls += 1
      return { stopped: 1, active: 2, pending: 3, total: 3, captioned: 0 }
    },
  }
  const { handlers } = setup({ stickers })

  const post = await callHandler(handlers['/stickers/enrich'], { method: 'POST' })
  assert.equal(post.status, 200)
  assert.equal(post.body.ok, true)
  assert.equal(post.body.ready, true)
  assert.equal(post.body.queued, 2)
  assert.equal(enrichCalls, 1)
  assert.equal(post.body.stats.captionPending, 3)

  const get = await callHandler(handlers['/stickers/enrich'], { method: 'GET' })
  assert.equal(get.status, 200)
  assert.equal(get.body.stats.captionReady, true)
  assert.equal(get.body.stats.total, 3)

  const del = await callHandler(handlers['/stickers/enrich'], { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.equal(del.body.ok, true)
  assert.equal(del.body.stopped, 1)
  assert.equal(del.body.active, 2)
  assert.equal(stopCalls, 1)

  const wrong = await callHandler(handlers['/stickers/enrich'], { method: 'PUT' })
  assert.equal(wrong.status, 405)
})
