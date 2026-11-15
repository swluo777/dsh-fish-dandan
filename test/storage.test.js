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
    'browser-profile/ShaderCache/shader.bin': Buffer.alloc(256, 16),
    'browser-profile/GrShaderCache/gr-shader.bin': Buffer.alloc(128, 17),
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
    'creative/account/avatar.bin': Buffer.alloc(512, 18),
    'creative/inputs/job-a/plan.bin': Buffer.alloc(256, 19),
    'creative/creative-old.html': Buffer.alloc(1024, 20),
    'creative/creative-new.html': Buffer.alloc(2048, 21),
    'creative/index.json': '{"items":[]}',
    'creative/exports/old-job/image.bin': Buffer.alloc(512, 22),
    'creative/jobs/old-job/job.bin': Buffer.alloc(256, 23),
    'creative/runtime/old.bin': Buffer.alloc(128, 24),
    'images/day/a.png': Buffer.alloc(1024, 25),
    'images/ui-fail-1.png': Buffer.alloc(256, 26),
    'plugins/runtime/plugin.bin': Buffer.alloc(2048, 17),
    'memory/memory.db': Buffer.alloc(256, 15),
  })
}

function touchOlder(file, index) {
  const base = new Date('2026-01-01T00:00:00Z').getTime()
  const time = new Date(base + index * 60_000)
  fs.utimesSync(file, time, time)
}

function seedFreeDrafts(root) {
  makeTree(root, {
    'creative/account/avatar.bin': Buffer.alloc(512, 18),
    'creative/inputs/job-a/plan.bin': Buffer.alloc(256, 19),
    'creative/exports/old-job/image.bin': Buffer.alloc(512, 22),
    'creative/jobs/old-job/job.bin': Buffer.alloc(256, 23),
    'creative/runtime/old.bin': Buffer.alloc(128, 24),
    'images/day/a.png': Buffer.alloc(1024, 25),
    'images/ui-fail-1.png': Buffer.alloc(256, 26),
  })
  const names = []
  const items = []
  for (let i = 0; i < 20; i += 1) {
    const name = `creative-20260101-0000${String(i).padStart(2, '0')}.html`
    const file = path.join(root, 'creative', name)
    fs.writeFileSync(file, Buffer.alloc(1024 + i, 30 + i))
    touchOlder(file, i)
    names.push(name)
    items.push({
      at: Date.parse('2026-01-01T00:00:00Z') + i * 60_000,
      html: file,
      png: path.join(root, '..', 'desktop', `${i}.png`),
      title: `旧稿 ${i}`,
    })
  }
  fs.writeFileSync(path.join(root, 'creative', 'index.json'), JSON.stringify({ items, updatedAt: 1 }))
  return { names, items }
}

test('存储扫描：把创意工作室、自由创作、旧残留和其他数据分开', async () => {
  const root = tmpDir('storage-summary')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const summary = await storage.summary()

  assert.equal(summary.totalBytes > 0, true)
  const browser = summary.categories.find((item) => item.id === 'browser')
  assert.equal(browser.bytes, 5248 + 4224 + 128 + 64 + 32 + 16)
  assert.equal(summary.categories.find((item) => item.id === 'characters').bytes, 8192)
  assert.equal(summary.categories.find((item) => item.id === 'stickers').bytes, 4096)
  assert.equal(summary.categories.find((item) => item.id === 'creative-studio').bytes, 768)
  assert.equal(summary.categories.find((item) => item.id === 'creative-studio').files, 2)
  assert.equal(summary.categories.find((item) => item.id === 'creative-free').bytes, 3084 + 1280)
  assert.equal(summary.categories.find((item) => item.id === 'creative-legacy').bytes, 896)
  assert.equal(summary.categories.find((item) => item.id === 'plugins').bytes, 2048)
  assert.equal(summary.categories.find((item) => item.id === 'other').bytes, 256)
  assert.equal(summary.categories.find((item) => item.id === 'creative'), undefined)
  assert.equal(summary.cleanup.cache.bytes, 5248)
  assert.equal(summary.cleanup.legacy.bytes, 4224)
  assert.equal(summary.cleanup.freeDrafts.bytes, 896 + 256 + 256)
  assert.equal(summary.cleanup.freeDrafts.available, true)
  assert.equal(summary.cleanup.freeDrafts.keep, 15)
  assert.equal(summary.cleanup.cache.items.some((item) => item.rel === 'Default/Network'), false)
  assert.equal(summary.studio.readonly, true)
  assert.equal(summary.studio.current.exists, false)
})

test('清理缓存：只删可再生缓存，不动 Cookies / 登录数据和创作数据', async () => {
  const root = tmpDir('storage-cache')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const result = await storage.clean({ targets: ['cache'] })
  assert.equal(result.freedBytes, 5248)
  for (const rel of [
    'browser-profile/Default/Network/Cookies/cookies.bin',
    'browser-profile/Default/Login Data/login.bin',
    'browser-profile/Default/Preferences/prefs.bin',
    'browser-profile/Local State/local.bin',
    'browser-profile-listen/Default/Cache/old-cache.bin',
    'creative/account/avatar.bin',
    'creative/inputs/job-a/plan.bin',
    'creative/creative-old.html',
    'creative/index.json',
    'images/day/a.png',
    'plugins/runtime/plugin.bin',
  ]) {
    assert.equal(fs.existsSync(path.join(root, rel)), true, rel)
  }
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/Default/Cache')), false)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/ShaderCache')), false)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/GrShaderCache')), false)
  assert.equal(result.after.cleanup.cache.bytes, 0)
  assert.equal(result.errors.length, 0)
})

test('清理旧监听档案：只删这一份档案，共享档案登录态还在', async () => {
  const root = tmpDir('storage-legacy')
  seed(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const result = await storage.clean({ targets: ['legacy'] })
  assert.equal(result.freedBytes, 4224)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile-listen')), false)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/Default/Network/Cookies/cookies.bin')), true)
  assert.equal(fs.existsSync(path.join(root, 'browser-profile/Default/Login Data/login.bin')), true)
  assert.equal(result.after.cleanup.legacy.available, false)
})

test('清理自由创作旧稿：保留最近 15 张，索引同步收敛，旧残留和输入清掉，生图不动', async () => {
  const root = tmpDir('storage-free-drafts')
  const { names } = seedFreeDrafts(root)
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const before = await storage.summary()
  assert.equal(before.cleanup.freeDrafts.total, 20)
  assert.equal(before.cleanup.freeDrafts.keep, 15)
  assert.equal(before.cleanup.freeDrafts.remove, 5)
  const oldBytes = 5 * 1024 + (0 + 1 + 2 + 3 + 4)
  assert.equal(before.cleanup.freeDrafts.bytes, oldBytes + 896 + 256 + 256)

  const result = await storage.clean({ targets: ['free-drafts'] })
  assert.equal(result.errors.length, 0)
  assert.equal(result.freedBytes, oldBytes + 896 + 256 + 256)
  for (let i = 0; i < 20; i += 1) {
    const still = i >= 5
    assert.equal(fs.existsSync(path.join(root, 'creative', names[i])), still, names[i])
  }
  const index = JSON.parse(fs.readFileSync(path.join(root, 'creative', 'index.json'), 'utf8'))
  assert.equal(index.items.length, 15)
  assert.equal(index.items[0].html.endsWith(names[5]), true)
  assert.equal(fs.existsSync(path.join(root, 'creative/exports')), false)
  assert.equal(fs.existsSync(path.join(root, 'creative/jobs')), false)
  assert.equal(fs.existsSync(path.join(root, 'creative/runtime')), false)
  assert.equal(fs.existsSync(path.join(root, 'creative/inputs')), false)
  assert.equal(fs.existsSync(path.join(root, 'images/ui-fail-1.png')), false)
  assert.equal(fs.existsSync(path.join(root, 'images/day/a.png')), true)
  assert.equal(fs.existsSync(path.join(root, 'creative/account/avatar.bin')), true)
  assert.equal(result.after.cleanup.freeDrafts.available, false)
})

test('创意工作室当前作品只读：只统计，不会被自由创作旧稿清理删掉', async () => {
  const root = tmpDir('storage-studio-current')
  const output = tmpDir('storage-studio-output')
  fs.writeFileSync(path.join(output, 'image.png'), Buffer.alloc(100, 1))
  makeTree(root, {
    'state/creative-studio-last.json': JSON.stringify({
      schemaVersion: 1,
      jobId: 'job-current',
      ok: true,
      outputDir: output,
      imagePath: path.join(output, 'image.png'),
    }),
    'creative/account/avatar.bin': Buffer.alloc(512, 2),
  })
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const before = await storage.summary()
  assert.equal(before.studio.current.exists, true)
  assert.equal(before.studio.current.bytes, 100)
  assert.equal(before.studio.current.readonly, true)
  await storage.clean({ targets: ['free-drafts'] })
  assert.equal(fs.existsSync(path.join(output, 'image.png')), true)
  assert.equal(fs.existsSync(path.join(root, 'creative/account/avatar.bin')), true)
})

test('索引损坏时先不删旧稿，避免索引和文件对不上', async () => {
  const root = tmpDir('storage-free-bad-index')
  const { names } = seedFreeDrafts(root)
  fs.writeFileSync(path.join(root, 'creative', 'index.json'), '{"items":')
  const storage = createStorageMaintenance({ root, logger: silentLogger() })
  const result = await storage.clean({ targets: ['free-drafts'] })
  assert.equal(result.errors.some((item) => item.code === 'INDEX_INVALID'), true)
  assert.equal(fs.existsSync(path.join(root, 'creative', names[0])), true)
  assert.equal(fs.existsSync(path.join(root, 'creative', names[19])), true)
  assert.equal(fs.existsSync(path.join(root, 'creative/inputs/job-a/plan.bin')), true)
})

test('正在创作时拒绝清理旧稿', async () => {
  const root = tmpDir('storage-free-busy')
  seedFreeDrafts(root)
  const storage = createStorageMaintenance({
    root,
    logger: silentLogger(),
    getCreativeStudio: () => ({ status: () => ({ run: { jobId: 'running' } }) }),
  })
  await assert.rejects(
    () => storage.clean({ targets: ['free-drafts'] }),
    (err) => err.code === 'CREATIVE_BUSY',
  )
  assert.equal(fs.existsSync(path.join(root, 'creative/inputs/job-a/plan.bin')), true)
})

test('清理 API：GET 出三项清单，POST 接受 free-drafts，未知项拒绝', async () => {
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
  assert.equal(got.body.cleanup.freeDrafts.available, true)
  assert.equal(got.body.safeNote.includes('当前创作作品'), true)

  const clean = await callHandler(handlers['/storage/cleanup'], { method: 'POST', body: { targets: ['free-drafts'] } })
  assert.equal(clean.status, 200)
  assert.equal(clean.body.ok, true)
  assert.equal(clean.body.freedBytes > 0, true)
  assert.equal(fs.existsSync(path.join(root, 'images/day/a.png')), true)

  const bad = await callHandler(handlers['/storage/cleanup'], { method: 'POST', body: { targets: ['all'] } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'TARGETS_INVALID')
})
