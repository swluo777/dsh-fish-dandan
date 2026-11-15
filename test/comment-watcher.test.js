// 回评论监听器：只连共享 hub，开自己的 comments 标签页；标签页没了要写回开关。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommentWatcher } from '../src/platform/douyin/comment-listener.js'
import { PAUSE_VIDEOS_JS } from '../src/platform/douyin/tab-quiet.js'

function fakeHub() {
  const opened = []
  const closed = []
  const commands = []
  let open = true
  const closeHandlers = []
  const page = {
    targetId: 'comment-tab-1',
    cmd: async (method, params) => {
      commands.push({ method, params })
      if (method === 'Runtime.evaluate') return { result: { value: 1 } }
      return { ok: true }
    },
    onClose: (fn) => { closeHandlers.push(fn); return () => {} },
  }
  const hub = {
    openTab: async (kind, url, options) => {
      opened.push({ kind, url, options })
      return page
    },
    closeTab: async (p) => { closed.push(p) },
    isTabOpen: async () => open,
    snapshot: () => ({ port: 9224, profile: 'shared' }),
    setOpen: (v) => { open = v },
    fireClose: () => { for (const fn of closeHandlers) fn() },
    opened,
    closed,
    commands,
  }
  return hub
}

function settings(initial = true) {
  let enabled = initial
  const patches = []
  return {
    get: () => ({ douyin: { comments: { enabled } } }),
    patch: (p) => { patches.push(p); enabled = p.douyin.comments.enabled },
    set: (v) => { enabled = v },
    patches,
  }
}

test('回评论监听：复用共享 hub，只开自己的 comments 标签页', async () => {
  const hub = fakeHub()
  const store = settings(true)
  const w = createCommentWatcher({ hub, platformSettings: store, logger: { info: () => {}, warn: () => {} } })
  await w.ensurePage(0)
  assert.equal(hub.opened.length, 1)
  assert.equal(hub.opened[0].kind, 'comments', '不能用 listen 的 kind，否则会顶掉私信监听')
  assert.equal(hub.opened[0].options.bringToFront, true, '打开时要让用户看见')
  assert.equal(w.snapshot().tabOpen, true)
  const injected = hub.commands.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')
  assert.equal(injected?.params?.source, PAUSE_VIDEOS_JS, '回评论和私信监听共用同一份暂停脚本')
  assert.match(PAUSE_VIDEOS_JS, /v\.autoplay = false/, '要关掉自动播放')
  assert.match(PAUSE_VIDEOS_JS, /__fishTabQuietPlay/, '要拦住后续 play 事件')
  w.stop()
})

test('回评论监听：打开前把加密会话里的登录 Cookie 注入共享浏览器', async () => {
  const hub = fakeHub()
  const store = settings(true)
  const sessionStore = {
    load: () => ({
      cookies: [
        { name: 'sessionid', value: 'test-session', domain: '.douyin.com', path: '/' },
        { name: 'ttwid', value: 'test-ttwid', domain: '.douyin.com', path: '/' },
      ],
    }),
  }
  const w = createCommentWatcher({ hub, platformSettings: store, sessionStore, logger: { info: () => {}, warn: () => {} } })
  await w.ensurePage(0)
  assert.equal(hub.opened[0].url, 'about:blank', '先开空白页，注入登录态后再导航')
  const setCookies = hub.commands.find((c) => c.method === 'Network.setCookies')
  assert.equal(setCookies?.params?.cookies?.[0]?.name, 'sessionid', '要把 sessionid 注进共享浏览器')
  assert.equal(setCookies?.params?.cookies?.[0]?.value, 'test-session')
  const navigated = hub.commands.filter((c) => c.method === 'Page.navigate').at(-1)
  assert.equal(navigated?.params?.url, 'https://www.douyin.com/', '注入后回到抖音首页')
  w.stop()
})

test('回评论监听：用户叉掉标签页后，写回 comments.enabled=false', async () => {
  const hub = fakeHub()
  const store = settings(true)
  const w = createCommentWatcher({ hub, platformSettings: store, logger: { info: () => {}, warn: () => {} } })
  await w.ensurePage(0)
  hub.setOpen(false)
  await w.tick()
  assert.equal(store.patches.length, 1)
  assert.deepEqual(store.patches[0], { douyin: { comments: { enabled: false } } })
  assert.equal(w.snapshot().enabled, false, '快照要跟着变成关')
  assert.equal(hub.closed.length, 1, '关掉标签页')
  w.stop()
})

test('回评论监听：用户关标签页事件一到就写回开关，不等下一轮轮询', async () => {
  const hub = fakeHub()
  const store = settings(true)
  const w = createCommentWatcher({ hub, platformSettings: store, logger: { info: () => {}, warn: () => {} } })
  await w.ensurePage(0)
  assert.equal(store.get().douyin.comments.enabled, true)
  hub.fireClose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.get().douyin.comments.enabled, false, '标签页关闭事件要立即把开关写回 false')
  assert.deepEqual(store.patches.at(-1), { douyin: { comments: { enabled: false } } })
  assert.equal(hub.closed.length, 1, '关掉已经消失的标签页')
  w.stop()
})
