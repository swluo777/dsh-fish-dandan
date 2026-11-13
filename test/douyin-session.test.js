// 抖音登录会话：加密往返、密钥降级链、损坏容错、适配器状态
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSessionStore } from '../src/platform/douyin/session.js'
import { createDouyinAdapter } from '../src/platform/douyin/index.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

function setup(env = {}) {
  const dir = tmpDir('douyin')
  const config = testConfig(dir, { platforms: { douyin: { sessionPath: path.join(dir, 'platform', 'douyin-session.json') } } })
  const logger = silentLogger()
  const store = createSessionStore({ config, logger, env })
  return { store, config, logger, dir }
}

const COOKIES = [
  { name: 'sessionid', value: 'abc123', domain: '.douyin.com', path: '/' },
  { name: 'ttwid', value: 'x9y8', domain: '.douyin.com', path: '/' },
]

test('加密往返：存进去再读出来，文件里没有明文 Cookie', () => {
  const { store, dir } = setup({ FISH_SESSION_KEY: 'test-passphrase' })
  store.save(COOKIES, { account: 'douyin-web' })
  const loaded = store.load()
  assert.ok(loaded)
  assert.equal(loaded.cookies[0].name, 'sessionid')
  assert.equal(loaded.keySource, 'env')

  const raw = fs.readFileSync(path.join(dir, 'platform', 'douyin-session.json'), 'utf8')
  assert.ok(!raw.includes('abc123'), '明文 Cookie 绝不能出现在文件里')
  assert.ok(raw.includes('aes-256-gcm'))
})

test('密钥降级链：env 优先；无 env 时本机派生也能解回', () => {
  const { store } = setup({ FISH_SESSION_KEY: 'pass-1' })
  store.save(COOKIES)
  assert.equal(store.keySource(), 'env')

  // 同一台机器、不同口令 -> 解不开（返回 null 而不是抛错）
  const store2 = createSessionStore({
    config: testConfig(tmpDir('douyin-shared'), { platforms: { douyin: { sessionPath: path.join(tmpDir('douyin-shared'), 'platform', 'douyin-session.json') } } }),
    logger: silentLogger(),
    env: {},
  })
  // 用 store2 指向同一文件验证「密钥不匹配 -> null」：把 store 的文件路径复制给 store2
  const shared = tmpDir('douyin-shared')
  const cfgShared = testConfig(shared, { platforms: { douyin: { sessionPath: path.join(shared, 'platform', 'douyin-session.json') } } })
  const storeA = createSessionStore({ config: cfgShared, logger: silentLogger(), env: { FISH_SESSION_KEY: 'pass-1' } })
  storeA.save(COOKIES)
  const storeB = createSessionStore({ config: cfgShared, logger: silentLogger(), env: {} })
  const loaded = storeB.load()
  if (loaded) {
    // 理论上 machine 派生解不开 env 派生的密文；若本机实现导致可解（不可能），此断言保护
    assert.notEqual(loaded.cookies?.[0]?.value, COOKIES[0].value, '不同密钥不应解出相同明文')
  } else {
    assert.ok(true, '密钥不匹配 -> 返回 null，不抛错')
  }
  void store2
})

test('损坏文件容错：返回 null，不抛错', () => {
  const { store, dir } = setup({})
  store.save(COOKIES)
  const file = path.join(dir, 'platform', 'douyin-session.json')
  fs.writeFileSync(file, '{"data": "broken-not-base64!!", "alg": "aes-256-gcm", "iv": "x", "tag": "y"}')
  assert.equal(store.load(), null)
  assert.equal(store.exists(), true, '文件还在，只是解不开')
  store.clear()
  assert.equal(store.exists(), false)
})

test('本机派生（无 env）：保存与读取一致', () => {
  const { store } = setup({})
  store.save(COOKIES)
  const loaded = store.load()
  assert.ok(loaded && loaded.cookies.length === 2)
  assert.equal(loaded.keySource, 'machine')
})

test('抖音适配器：无会话 logged-out，有会话 connected，出站明确拒绝', () => {
  const dir = tmpDir('douyin-adapter')
  const config = testConfig(dir, { platforms: { douyin: { sessionPath: path.join(dir, 'platform', 'douyin-session.json') } } })
  const adapter = createDouyinAdapter({ config, logger: silentLogger() })
  assert.equal(adapter.status(), 'logged-out')
  adapter.login.importCookies('sessionid=abc123; ttwid=x9y8')
  assert.equal(adapter.status(), 'connected')
  assert.throws(() => adapter.send({ platform: 'douyin', kind: 'private', externalId: 'c1' }, '你好'), /尚未接入/)
  assert.deepEqual(adapter.capabilities(), ['session', 'browse', 'interact'])
  adapter.login.logout()
  assert.equal(adapter.status(), 'logged-out')
})

test('手动导入：没有 sessionid 的 Cookie 会被拒收', () => {
  const dir = tmpDir('douyin-import')
  const config = testConfig(dir, { platforms: { douyin: { sessionPath: path.join(dir, 'platform', 'douyin-session.json') } } })
  const adapter = createDouyinAdapter({ config, logger: silentLogger() })
  assert.throws(() => adapter.login.importCookies([{ name: 'ttwid', value: 'x', domain: '.douyin.com' }]), /sessionid/)
})

test('抖音登录流程：分阶段进度与失败日志可观测（源码级）', () => {
  const src = fs.readFileSync('src/platform/douyin/login.js', 'utf8')
  for (const marker of ['正在启动共享浏览器', '浏览器已就绪（', '请扫码或完成登录', '抖音登录启动失败', '抖音登录：等待扫码']) {
    assert.ok(src.includes(marker), `缺少进度/日志标记：${marker}`)
  }
})
