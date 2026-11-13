// 共享浏览器 hub：一个进程、一份档案、多个标签页；停一个服务只关它自己的标签
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createBrowserHub } from '../src/platform/douyin/browser-hub.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

function setup() {
  const dir = tmpDir('browser-hub')
  const hubStatePath = path.join(dir, 'platform', 'browser-hub.json')
  const config = testConfig(dir, {
    platforms: {
      douyin: {
        loginPort: 29224,
        browsePort: 29225,
        dutyPort: 29334,
        browserProfilePath: path.join(dir, 'browser-profile'),
        hubStatePath,
      },
    },
  })
  const logger = silentLogger()
  const launches = []
  const opened = []
  const closed = []
  const commands = []
  const page = (kind) => ({
    kind,
    targetId: kind,
    httpBase: 'http://127.0.0.1:29224',
    cmd: async (method, params) => { commands.push({ kind, method, params }); return {} },
    close() {},
  })
  const driver = {
    ensureBrowser: async (opts) => {
      launches.push(opts)
      return {
        httpBase: 'http://127.0.0.1:29224',
        child: { pid: 999, once() {} },
        profileDir: opts.profileDir,
        version: 'fake/1.0',
        persistent: true,
        reused: false,
      }
    },
    attachPage: async () => { opened.push('attach'); return page('initial') },
    openNewPage: async (_base, url) => { opened.push(url); return page(url) },
    closePage: async (p) => { closed.push(p.kind) },
    closeBrowser: async () => { closed.push('browser') },
    isAlive: async () => true,
    probe: async () => false,
  }
  const hub = createBrowserHub({ config, logger, driver })
  return { hub, launches, opened, closed, commands, hubStatePath, dir }
}

test('共享 hub：只启动一次浏览器；登录/监听各用各的标签，停监听不关浏览器', async () => {
  const { hub, launches, opened, closed, hubStatePath } = setup()

  await hub.ensure()
  await hub.ensure()
  assert.equal(launches.length, 1, '第二个服务不能再起一个浏览器')
  assert.match(String(launches[0].profileDir).replace(/\\/g, '/'), /browser-profile$/)
  assert.equal(launches[0].headless, false, '共享浏览器必须可见')
  assert.ok(fs.existsSync(hubStatePath), '要留下发现文件给值班进程')

  const login = await hub.openTab('login', 'https://www.douyin.com/')
  assert.equal(login.kind, 'login')
  assert.equal(opened[0], 'attach', '刚启动的空白页先拿来用，不多开空白标签')
  const listen = await hub.openTab('listen', 'https://www.douyin.com/')
  assert.equal(listen.kind, 'listen')
  assert.deepEqual(hub.snapshot().tabs, ['login', 'listen'], '不同服务可以同时有标签页')
  assert.deepEqual(closed, [], '开监听不能把登录标签关掉')

  await hub.closeTab('listen')
  assert.deepEqual(closed, ['listen'])
  assert.equal(hub.snapshot().browserOpen, true, '关监听标签不能把浏览器关掉')
  assert.deepEqual(hub.snapshot().tabs, ['login'], '登录标签还在')
})

test('共享 hub：并发 ensure 只启动一次浏览器', async () => {
  const { hub, launches } = setup()
  await Promise.all([hub.ensure(), hub.ensure(), hub.ensure()])
  assert.equal(launches.length, 1, '并发调用不能各起一个浏览器抢同一份档案')
})

test('共享 hub：没有标签页时才收浏览器；shutdown 收全部', async () => {
  const { hub, closed, hubStatePath } = setup()
  await hub.openTab('listen', 'https://www.douyin.com/')
  await hub.closeTab('listen')
  await hub.closeIfIdle()
  assert.ok(closed.includes('browser'), '没有别的服务在用时才关浏览器')
  assert.equal(fs.existsSync(hubStatePath), false, '关浏览器后清掉发现文件')

  const second = setup()
  await second.hub.openTab('login', 'https://www.douyin.com/')
  await second.hub.openTab('listen', 'https://www.douyin.com/')
  assert.deepEqual(second.hub.snapshot().tabs, ['login', 'listen'], '不同服务可以同时有标签页')
  await second.hub.shutdown()
  assert.ok(second.closed.includes('browser'), 'shutdown 要关浏览器')
  assert.ok(second.closed.includes('login') && second.closed.includes('listen'), 'shutdown 要收掉所有标签')
})

test('isTabOpen：按 targetId 判断标签页是否还在，浏览器没了也算不在', async () => {
  const s = setup()
  const realFetch = globalThis.fetch
  const page = { targetId: 'listen', httpBase: 'http://127.0.0.1:29224' }
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 'listen' }, { id: 'login' }] })
    assert.equal(await s.hub.isTabOpen(page), true, 'targetId 还在列表里')

    globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 'login' }] })
    assert.equal(await s.hub.isTabOpen(page), false, '用户手动关掉标签页后 targetId 不在列表里')

    globalThis.fetch = async () => { throw new Error('浏览器已关闭') }
    assert.equal(await s.hub.isTabOpen(page), false, '浏览器没了，连列表都拿不到')
  } finally {
    globalThis.fetch = realFetch
    await s.hub.shutdown()
  }
})

test('共享 hub：退出登录清浏览器 Cookie；浏览器没开时留标记，下次启动前清', async () => {
  const s = setup()
  const flag = path.join(s.dir, 'platform', 'douyin-logout-pending')
  await s.hub.openTab('listen', 'https://www.douyin.com/')
  await s.hub.logout()
  assert.ok(s.commands.some((c) => c.method === 'Network.clearBrowserCookies'), '浏览器开着时要清 Cookie')
  assert.ok(s.commands.some((c) => c.method === 'Storage.clearDataForOrigin'), '也要清抖音源的本地存储')
  assert.equal(fs.existsSync(flag), false, '清理成功就删掉待退出标记')
  await s.hub.shutdown()

  const next = setup()
  const nextFlag = path.join(next.dir, 'platform', 'douyin-logout-pending')
  await next.hub.logout()
  assert.equal(fs.existsSync(nextFlag), true, '浏览器没开时不能假装清过，要留标记')
  await next.hub.ensure()
  assert.ok(next.commands.some((c) => c.method === 'Network.clearBrowserCookies'), '下次启动先清 Cookie 再开页面')
  assert.equal(fs.existsSync(nextFlag), false, '启动时清完就删标记')
  await next.hub.shutdown()
})

