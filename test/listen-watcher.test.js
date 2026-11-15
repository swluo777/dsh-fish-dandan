// 私信监听：关掉开关时，还在打开中的旧页不能重新登记回来。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createInboxWatcher } from '../src/platform/douyin/listener.js'
import { createSessionStore } from '../src/platform/douyin/session.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

test('私信监听：开页过程中关掉开关，旧页要还回去，不能把开关留在“开着”', async () => {
  const dir = tmpDir('listen-race')
  const config = testConfig(dir, {
    platforms: {
      douyin: {
        sessionPath: path.join(dir, 'platform', 'douyin-session.json'),
      },
    },
  })
  const logger = silentLogger()
  const store = createSessionStore({ config, logger })
  store.save([{ name: 'sessionid', value: 'test-session', domain: '.douyin.com' }], { account: 'test' })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let opened = 0
  const closed = []
  const page = {
    targetId: 'listen-1',
    httpBase: 'http://127.0.0.1:9224',
    cmd: async (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      if (method === 'Network.getCookies') return { cookies: [] }
      return {}
    },
    onClose() {},
    prepareClose() {},
    close() {},
  }
  const hub = {
    openTab: async () => { opened += 1; await gate; return page },
    closeTab: async (p) => { closed.push(p.targetId) },
    isTabOpen: async () => true,
    snapshot: () => ({ port: 9224, profile: 'test-profile' }),
  }
  const platformSettings = {
    get: () => ({ douyin: { listen: { enabled: true } } }),
    patch: () => {},
  }
  const watcher = createInboxWatcher({ config, logger, platformSettings, hub })

  watcher.apply('test')
  // 让 tick 走到 openTab 的 await，再模拟用户立刻关掉开关。
  await new Promise((resolve) => setImmediate(resolve))
  watcher.stop()
  release()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(opened, 1, '旧一轮确实尝试开页了')
  assert.deepEqual(closed, ['listen-1'], '换届后发现旧页，必须还回去，不能留着孤儿标签')
  assert.equal(watcher.snapshot().running, false, '关掉后不能留下定时器')
})
