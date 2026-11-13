import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createStorageMaintenance } from '../src/storage/index.js'
import { createHandlers } from '../src/gui/api.js'
import { callHandler, silentLogger, testConfig, tmpDir } from './helpers.js'

function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

function seed(root) {
  makeTree(root, {
    'browser-profile/Default/Cache/cache.bin': Buffer.alloc(1024, 1),
    'browser-profile/Default/Code Cache/code.bin': Buffer.alloc(512, 2),
    'browser-profile/Default/GPUCache/gpu.bin': Buffer.alloc(256, 3),
    'browser-profile/component_crx_cache/component.bin': Buffer.alloc(2048, 4),
    'browser-profile/ProvenanceData/provenance.bin': Buffer.alloc(1024, 5),
    'browser-profile/Default/Network/Cookies/cookies.bin': Buffer.alloc(128, 6),
    'browser-profile/Default/Login Data/login.bin': Buffer.alloc(64, 7),
    'browser-profile/Default/Preferences/prefs.bin': Buffer.alloc(32, 8),
    'browser-profile/Local State/local.bin': Buffer.alloc(16, 9),
    'browser-profile-listen/Default/Cache/old-cache.bin': Buffer.alloc(3072, 10),
    'browser-profile-listen/Default/Code Cache/old-code.bin': Buffer.alloc(1024, 11),
    'browser-profile-listen/Default/Network/Cookies/old-cookies.bin': Buffer.alloc(128, 12),
    'stickers/a.gif': Buffer.alloc(4096, 13),
    'characters/a.png': Buffer.alloc(8192, 14),
    'memory/memory.db': Buffer.alloc(256, 15),
  })
}

test('存储扫描：区分浏览器档案、形象原图、贴纸和其他数据', async () => {
  const root = tmpDir('storage-summary')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const summary = await storage.summary()
  assert.equal(summary.totalBytes > 0, true)
  const browser = summary.categories.find((item) => item.id === 'browser')
  assert.equal(browser.bytes > 0, true)
  assert.equal(summary.categories.find((item) => item.id === 'characters').bytes, 8192)
  assert.equal(summary.categories.find((item) => item.id === 'stickers').bytes, 4096)
  assert.equal(summary.cleanup.cache.bytes, 1024 + 512 + 256 + 2048 + 1024)
  assert.equal(summary.cleanup.legacy.bytes, 3072 + 1024 + 128)
  assert.equal(summary.cleanup.cache.items.some((item) => item.rel === 'Default/Network'), false)
})

test('清理缓存：只删可再生缓存，不动 Cookies / 登录数据和旧档案', async () => {
  const root = tmpDir('storage-cache')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const result = await storage.clean({ targets: ['cache'] })
  assert.equal(result.freedBytes, 1024 + 512 + 256 + 2048 + 1024)
  for (const rel of [
    'browser-profile/Default/Network/Cookies/cookies.bin',
    'browser-profile/Default/Login Data/login.bin',
    'browser-profile/Default/Preferences/prefs.bin',
    'browser-profile/Local State/local.bin',
    'browser-profile-listen/Default/Cache/old-cache.bin',
  ]) {
    assert.equal(fs.existsSync(path.join(root, rel)), true, rel)
  }
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/Default/Cache')), false)
  assert.equal(result.after.cleanup.cache.bytes, 0)
  assert.equal(result.errors.length, 0)
})

test('清理旧监听档案：只删这一份档案，共享档案登录态还在', async () => {
  const root = tmpDir('storage-legacy')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const result = await storage.clean({ targets: ['legacy'] })
  assert.equal(result.freedBytes, 3072 + 1024 + 128)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile-listen')), false)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/Default/Network/Cookies/cookies.bin')), true)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/Default/Login Data/login.bin')), true)
  assert.equal(result.after.cleanup.legacy.available, false)
})

test('清理 API：GET 出清单，POST 只接受 cache / legacy，未知项拒绝', async () => {
  const root = tmpDir('storage-api')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const config = testConfig(root)
  const handlers = createHandlers({
    config,
    logger: silentLogger(),
    persona: {},
    memory: {},
    decision: {},
    storage,
  })
  const got = await callHandler(handlers['/storage'])
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.cleanup.cache.available, true)
  assert.equal(got.body.cleanup.legacy.available, true)
  assert.equal(got.body.safeNote.includes('登录态'), true)

  const clean = await callHandler(handlers['/storage/cleanup'], { method: 'POST', body: { targets: ['cache'] } })
  assert.equal(clean.status, 200)
  assert.equal(clean.body.ok, true)
  assert.equal(clean.body.freedBytes > 0, true)

  const bad = await callHandler(handlers['/storage/cleanup'], { method: 'POST', body: { targets: ['all'] } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'TARGETS_INVALID')
})
