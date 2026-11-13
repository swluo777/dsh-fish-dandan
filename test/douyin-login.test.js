// 登录流程运行时测试：用假浏览器把整条链路跑一遍，
// 防止「未定义函数/引用」这类只在真实运行时才炸的问题（曾漏定义 sleep 导致窗口闪退）。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createLoginFlow } from '../src/platform/douyin/login.js'
import { createBrowserHub } from '../src/platform/douyin/browser-hub.js'
import { createSessionStore } from '../src/platform/douyin/session.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

function setup(launcher) {
  const dir = tmpDir('douyin-login')
  const config = testConfig(dir, { platforms: { douyin: { sessionPath: path.join(dir, 'platform', 'douyin-session.json'), hubStatePath: path.join(dir, 'platform', 'browser-hub.json') } } })
  const logger = silentLogger()
  const store = createSessionStore({ config, logger })
  const hub = createBrowserHub({
    config,
    logger,
    driver: {
      ensureBrowser: launcher.ensureBrowser || launcher.launchBrowser,
      attachPage: launcher.attachPage,
      openNewPage: launcher.openNewPage || launcher.attachPage,
      closePage: launcher.closePage || (async () => {}),
      isAlive: launcher.isAlive || (async () => true),
      closeBrowser: launcher.closeBrowser || (async () => {}),
      probe: async () => false,
    },
  })
  const flow = createLoginFlow({ config, logger, sessionStore: store, hub })
  return { flow, store }
}

/** 等相位离开 waiting（流程在后台跑，轮询几次即可）。 */
async function waitSettled(flow, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && flow.snapshot().phase === 'waiting') {
    await new Promise((r) => setTimeout(r, 20))
  }
  return flow.snapshot()
}

test('登录流程：假浏览器跑通全链路，命中 sessionid 即成功落盘', async () => {
  const fakePage = {
    cmd: async (method) => (method === 'Network.getCookies'
      ? { cookies: [
          { name: 'sessionid', value: 'abc123', domain: '.douyin.com', path: '/' },
          { name: 'ttwid', value: 'x9y8', domain: '.douyin.com', path: '/' },
        ] }
      : {}),
    close() {},
  }
  const { flow, store } = setup({
    launchBrowser: async () => ({ httpBase: 'http://127.0.0.1:1', child: { kill() {} }, profileDir: tmpDir('fake-profile'), version: 'fake/1.0' }),
    attachPage: async () => fakePage,
  })
  flow.start()
  const snap = await waitSettled(flow)
  assert.equal(snap.phase, 'success', `应成功，实际 ${snap.phase}：${snap.detail}`)
  assert.ok(store.exists(), '登录态应加密落盘')
})

test('登录流程：启动失败进入 error 相位并带原因（不会卡在 waiting）', async () => {
  const { flow } = setup({
    launchBrowser: async () => { throw new Error('本机没有找到 Chrome/Edge，可在 platforms.douyin.browserPath 手动指定') },
    attachPage: async () => { throw new Error('不应走到这里') },
  })
  flow.start()
  const snap = await waitSettled(flow)
  assert.equal(snap.phase, 'error')
  assert.ok(snap.detail.includes('Chrome/Edge'), `错误原因要透传，实际：${snap.detail}`)
})

test('登录流程：轮询期间页面暂时取不到 Cookie 不会中断流程', async () => {
  let calls = 0
  const fakePage = {
    cmd: async (method) => {
      if (method !== 'Network.getCookies') return {}
      calls += 1
      if (calls <= 2) throw new Error('页面导航中') // 前两次模拟取不到
      return { cookies: [{ name: 'sessionid', value: 'abc', domain: '.douyin.com', path: '/' }] }
    },
    close() {},
  }
  const { flow } = setup({
    launchBrowser: async () => ({ httpBase: 'http://127.0.0.1:1', child: { kill() {} }, profileDir: tmpDir('fake-profile2'), version: 'fake/1.0' }),
    attachPage: async () => fakePage,
  })
  flow.start()
  const snap = await waitSettled(flow, 8000) // 每次失败后 sleep 2s 重试
  assert.equal(snap.phase, 'success', `容错后应成功，实际 ${snap.phase}：${snap.detail}`)
  assert.ok(calls >= 3)
})

test('登录流程：browserProfilePath 为空时也落到固定档案，不建临时目录', async () => {
  const dir = tmpDir('douyin-login-fallback')
  const config = testConfig(dir, {
    platforms: {
      identityPath: path.join(dir, 'identity', 'identities.json'),
      settingsPath: path.join(dir, 'state', 'platform-settings.json'),
      douyin: { browserProfilePath: '', sessionPath: path.join(dir, 'platform', 'douyin-session.json'), hubStatePath: path.join(dir, 'platform', 'browser-hub.json') },
    },
  })
  const logger = silentLogger()
  const store = createSessionStore({ config, logger })
  let seen = null
  const hub = createBrowserHub({
    config,
    logger,
    driver: {
      ensureBrowser: async (opts) => { seen = opts; throw new Error('到此为止，不真开浏览器') },
      attachPage: async () => { throw new Error('不应走到这里') },
      closePage: async () => {},
      probe: async () => false,
    },
  })
  const flow = createLoginFlow({ config, logger, sessionStore: store, hub })

  flow.start()
  const snap = await waitSettled(flow)

  assert.equal(snap.phase, 'error')
  assert.ok(seen?.profileDir, 'profileDir 不能为空')
  assert.match(String(seen.profileDir).replace(/\\/g, '/'), /data\/browser-profile$/)
})
