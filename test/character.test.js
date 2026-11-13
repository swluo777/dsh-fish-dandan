import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { createCharacterLibrary } from '../src/character/index.js'
import { downloadPack } from '../src/character/download.js'
import { createHandlers } from '../src/gui/api.js'
import { createPersonaStore } from '../src/persona/index.js'
import { createMemory } from '../src/memory/index.js'
import { createDecision } from '../src/decision/index.js'
import { callHandler, silentLogger, testConfig, tmpDir } from './helpers.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHARACTER_DIR = path.join(ROOT, 'assets', 'character', 'dandan')
const PACKS_FILE = path.join(ROOT, 'assets', 'character-packs.json')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('形象资源包清单与 manifest 对得上', () => {
  const manifest = readJson(path.join(CHARACTER_DIR, 'manifest.json'))
  const registry = readJson(PACKS_FILE)
  const pack = registry.packs.find((item) => item.id === 'dandan-initial')
  assert.ok(pack)
  assert.equal(pack.version, '1.0.0')
  assert.equal(pack.releaseTag, 'character-dandan-v1')
  assert.equal(pack.files.length, 13)
  assert.equal(manifest.images.length, 13)
  assert.equal(pack.fileCount, 13)
  assert.equal(pack.totalBytes, pack.files.reduce((sum, file) => sum + file.bytes, 0))
  assert.equal(manifest.images.filter((image) => image.isOrigin).length, 1)
  assert.equal(manifest.images.filter((image) => image.isPrimary).length, 1)
  for (const image of manifest.images) {
    assert.ok(fs.existsSync(path.join(CHARACTER_DIR, image.thumbFile)), image.thumbFile)
    const file = pack.files.find((item) => item.path === image.file)
    assert.ok(file, image.file)
    assert.equal(file.bytes, image.bytes)
    assert.equal(file.sha256, image.sha256)
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
  }
})

test('形象库 state 返回 13 张，原图未下载时只有缩略图地址', () => {
  const dir = tmpDir('character-state')
  const library = createCharacterLibrary({
    config: { characters: { packsDir: path.join(dir, 'packs'), statePath: path.join(dir, 'state.json') } },
    logger: silentLogger(),
  })
  const state = library.state()
  assert.equal(state.ok, true)
  assert.equal(state.items.length, 13)
  assert.equal(state.counts.child, 3)
  assert.equal(state.counts.teen, 10)
  assert.equal(state.counts.adult, 0)
  assert.equal(state.primaryImageId, 'teen-initial-maid-v1')
  assert.equal(state.pack.installed, false)
  assert.equal(state.pack.originalReady, false)
  assert.equal(state.items.every((item) => item.thumbUrl && !item.fileUrl), true)
  const primary = state.items.find((item) => item.id === state.primaryImageId)
  assert.equal(primary.isPrimary, true)
  assert.equal(primary.thumbUrl, '/characters/thumb?id=teen-initial-maid-v1')
  const changed = library.setPrimary('teen-starlit-cape')
  assert.equal(changed.primaryImageId, 'teen-starlit-cape')
  assert.equal(changed.items.find((item) => item.id === 'teen-starlit-cape').isPrimary, true)
  assert.equal(library.state().primaryImageId, 'teen-starlit-cape')
})

test('形象库 removePack 删除本机原图目录，并回到未安装状态', async () => {
  const dir = tmpDir('character-remove')
  const library = createCharacterLibrary({
    config: { characters: { packsDir: path.join(dir, 'packs'), statePath: path.join(dir, 'state.json') } },
    logger: silentLogger(),
  })
  const target = path.join(dir, 'packs', 'dandan-initial')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'install.json'), JSON.stringify({ packId: 'dandan-initial' }))
  assert.equal(fs.existsSync(target), true)
  const data = await library.removePack('dandan-initial')
  assert.equal(fs.existsSync(target), false)
  assert.equal(data.pack.installed, false)
})

test('GUI /characters/packs/remove 遇到占用返回 409 和可读提示', async () => {
  const dir = tmpDir('character-remove-locked')
  const config = testConfig(dir)
  const logger = silentLogger()
  const persona = createPersonaStore({ config, logger })
  persona.load()
  const memory = createMemory({ config, logger })
  const decision = createDecision({ config, logger })
  const characters = {
    removePack: async () => {
      throw Object.assign(new Error('原图文件正被其他程序占用，暂时不能删除；先关掉正在看的原图，或等几秒再试。'), {
        code: 'PACK_LOCKED',
      })
    },
  }
  const handlers = createHandlers({ config, logger, persona, memory, decision, characters })
  const got = await callHandler(handlers['/characters/packs/remove'], {
    method: 'POST',
    body: { packId: 'dandan-initial' },
  })
  assert.equal(got.status, 409)
  assert.equal(got.body.ok, false)
  assert.equal(got.body.error.code, 'PACK_LOCKED')
  assert.match(got.body.error.message, /占用/)
})

test('GUI /characters 返回形象库与资源包状态', async () => {
  const dir = tmpDir('character-api')
  const config = testConfig(dir)
  const logger = silentLogger()
  const persona = createPersonaStore({ config, logger })
  persona.load()
  const memory = createMemory({ config, logger })
  const decision = createDecision({ config, logger })
  const characters = createCharacterLibrary({
    config: { characters: { packsDir: path.join(dir, 'packs'), statePath: path.join(dir, 'state.json') } },
    logger,
  })
  const handlers = createHandlers({ config, logger, persona, memory, decision, characters })
  const got = await callHandler(handlers['/characters'])
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.items.length, 13)
  assert.equal(got.body.pack.id, 'dandan-initial')
  assert.equal(got.body.pack.installed, false)
  assert.equal(got.body.items[0].thumbUrl.startsWith('/characters/thumb?id='), true)
})

test('下载 worker 能流式落盘、计算 SHA-256 并回传进度', async () => {
  const payload = Buffer.from('dsh-fish-dandan-character-test-payload')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const dir = tmpDir('character-worker')
  const dest = path.join(dir, 'sample.png')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length })
    res.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const worker = new Worker(new URL('../src/character/download-worker.js', import.meta.url), {
    workerData: { proxy: '' },
  })
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 5000)
      let progress = 0
      worker.on('message', (msg) => {
        if (msg.type === 'progress') progress = Math.max(progress, msg.bytes)
        if (msg.type === 'done') { clearTimeout(timer); resolve({ ...msg, progress }) }
        if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.message)) }
      })
      worker.on('error', (err) => { clearTimeout(timer); reject(err) })
      worker.postMessage({
        type: 'download',
        id: 1,
        url: `http://127.0.0.1:${port}/sample.png`,
        dest,
        bytes: payload.length,
        sha256,
      })
    })
    assert.equal(result.bytes, payload.length)
    assert.equal(result.sha256, sha256)
    assert.equal(fs.readFileSync(dest).length, payload.length)
    assert.ok(result.progress > 0)
  } finally {
    await worker.terminate()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('下载器并发落盘、校验并原子安装整个包', async () => {
  const dir = tmpDir('character-pack')
  const target = path.join(dir, 'packs', 'dandan-initial')
  const files = [
    { path: '01.png', data: Buffer.from('first-image') },
    { path: '02.png', data: Buffer.from('second-image-is-a-bit-longer') },
    { path: '03.png', data: Buffer.from('third') },
  ]
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname)
    const hit = files.find((file) => file.path === name)
    if (!hit) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': hit.data.length })
    res.end(hit.data)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const pack = {
    id: 'dandan-initial',
    version: '1.0.0',
    releaseTag: 'test',
    baseUrl: `http://127.0.0.1:${port}`,
    files: files.map((file) => ({
      path: file.path,
      bytes: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
    })),
  }
  const progress = []
  try {
    await downloadPack({
      pack,
      targetDir: target,
      proxy: '',
      concurrency: 2,
      allowTestUrls: true,
      onProgress: (value) => progress.push(value),
      logger: silentLogger(),
    })
    const meta = JSON.parse(fs.readFileSync(path.join(target, 'install.json'), 'utf8'))
    assert.equal(meta.packId, 'dandan-initial')
    assert.equal(meta.version, '1.0.0')
    assert.deepEqual(Object.keys(meta.files).sort(), files.map((file) => file.path).sort())
    for (const file of files) assert.equal(fs.readFileSync(path.join(target, file.path)).toString(), file.data.toString())
    assert.ok(progress.length > 0)
    assert.equal(progress.at(-1).filesDone, 3)

    // 再次安装同一套资源：旧目录要被替换，不能把上一次的文件留在新目录里。
    fs.writeFileSync(path.join(target, 'stale.txt'), 'stale')
    await downloadPack({
      pack,
      targetDir: target,
      proxy: '',
      concurrency: 2,
      allowTestUrls: true,
      logger: silentLogger(),
    })
    assert.equal(fs.existsSync(path.join(target, 'stale.txt')), false)
    for (const file of files) assert.equal(fs.readFileSync(path.join(target, file.path)).toString(), file.data.toString())
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('下载器拒绝非 GitHub 资源包和路径穿越', async () => {
  const dir = tmpDir('character-invalid')
  const pack = {
    id: 'dandan-initial',
    version: '1.0.0',
    baseUrl: 'https://example.com/download',
    files: [{ path: '../evil.png', bytes: 1, sha256: 'a'.repeat(64) }],
  }
  await assert.rejects(
    () => downloadPack({ pack, targetDir: path.join(dir, 'target'), proxy: '' }),
    /(GitHub|文件名不合法)/,
  )
})
