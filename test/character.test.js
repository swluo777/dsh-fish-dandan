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

function characterConfig(dir) {
  return {
    characters: {
      packsDir: path.join(dir, 'packs'),
      statePath: path.join(dir, 'state.json'),
      uploadsDir: path.join(dir, 'uploads'),
      indexPath: path.join(dir, 'characters-index.json'),
    },
  }
}

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
    config: characterConfig(dir),
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
    config: characterConfig(dir),
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
    config: characterConfig(dir),
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

test('本机上传会合并进形象库、能设主形象，也能删除', async () => {
  const dir = tmpDir('character-upload')
  const library = createCharacterLibrary({ config: characterConfig(dir), logger: silentLogger() })
  const before = library.state()
  assert.equal(before.items.length, 13)
  assert.equal(before.stats.uploads, 0)

  const uploaded = await library.upload({
    dataBase64: PNG_1X1,
    thumbBase64: PNG_1X1,
    name: '我的少女三视图.png',
    title: '少女·本机测试',
    ageGroup: 'teen',
    outfitId: 'custom',
    tags: ['三视图', '本机'],
    width: 1,
    height: 1,
  })
  const id = uploaded.item.id
  assert.match(id, /^upload-/)
  assert.equal(uploaded.state.items.length, 14)
  assert.equal(uploaded.state.stats.uploads, 1)
  assert.equal(uploaded.state.stats.total, 14)
  assert.equal(uploaded.state.stats.byAge.teen, 11)
  assert.equal(uploaded.state.counts.teen, 11)
  assert.ok(uploaded.state.outfits.some((outfit) => outfit.id === 'custom'))
  const item = uploaded.state.items.find((entry) => entry.id === id)
  assert.equal(item.sourceType, 'local-upload')
  assert.equal(item.fileName, 'image.png')
  assert.equal(item.originalReady, true)
  assert.equal(item.thumbUrl, `/characters/thumb?id=${encodeURIComponent(id)}`)
  assert.equal(item.fileUrl, `/characters/file?id=${encodeURIComponent(id)}`)
  assert.equal(fs.existsSync(library.thumbnailPath(id)), true)
  assert.equal(fs.existsSync(library.fullImagePath(id)), true)

  const primary = library.setPrimary(id)
  assert.equal(primary.primaryImageId, id)
  assert.equal(primary.items.find((entry) => entry.id === id).isPrimary, true)

  const deleted = await library.removeUpload(id)
  assert.equal(deleted.items.length, 13)
  assert.equal(deleted.stats.uploads, 0)
  assert.equal(deleted.primaryImageId, 'teen-initial-maid-v1')
  assert.equal(fs.existsSync(path.join(dir, 'uploads', id)), false)
  assert.equal(library.imageById(id), null)
})

test('本机上传拒绝 SVG 和超限，支持 GIF', async () => {
  const dir = tmpDir('character-upload-invalid')
  const library = createCharacterLibrary({
    config: {
      ...characterConfig(dir),
      characters: { ...characterConfig(dir).characters, maxUploadBytes: 1024 },
    },
    logger: silentLogger(),
  })
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
  const gif = Buffer.from('GIF89a' + '\0'.repeat(20)).toString('base64')
  const bmp = Buffer.from('BM' + '\0'.repeat(30)).toString('base64')
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypavif'), Buffer.alloc(20)]).toString('base64')
  const tooBig = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1200)]).toString('base64')

  await assert.rejects(
    () => library.upload({ dataBase64: svg }),
    /不支持这种图片格式/,
  )
  await assert.rejects(
    () => library.upload({ dataBase64: tooBig }),
    /超过/,
  )
  const uploaded = await library.upload({ dataBase64: gif, name: 'test.gif' })
  assert.equal(uploaded.item.format, 'gif')
  assert.equal(uploaded.item.outfitId, 'custom')
  const uploadedBmp = await library.upload({ dataBase64: bmp, name: 'test.bmp' })
  assert.equal(uploadedBmp.item.format, 'bmp')
  const uploadedAvif = await library.upload({ dataBase64: avif, name: 'test.avif' })
  assert.equal(uploadedAvif.item.format, 'avif')
  await assert.rejects(
    () => library.removeUpload('../outside'),
    /没有这张本机形象/,
  )
})

test('本机上传可以归入内置造型，也可以自己命名分类', async () => {
  const dir = tmpDir('character-upload-outfit')
  const library = createCharacterLibrary({ config: characterConfig(dir), logger: silentLogger() })

  const builtIn = await library.upload({
    dataBase64: PNG_1X1,
    outfitLabel: '初始深蓝女仆装',
  })
  assert.equal(builtIn.item.outfitId, 'initial-maid')
  assert.equal(builtIn.item.outfitLabel, '初始深蓝女仆装')

  const custom = await library.upload({
    dataBase64: PNG_1X1,
    outfitLabel: '我的私人造型',
  })
  assert.match(custom.item.outfitId, /^custom-/)
  assert.equal(custom.item.outfitLabel, '我的私人造型')
  assert.ok(custom.state.outfits.some((outfit) => outfit.id === custom.item.outfitId && outfit.label === '我的私人造型'))
})

test('GUI /characters/upload 能上传并删除本机形象', async () => {
  const dir = tmpDir('character-upload-api')
  const config = testConfig(dir)
  const logger = silentLogger()
  const persona = createPersonaStore({ config, logger })
  persona.load()
  const memory = createMemory({ config, logger })
  const decision = createDecision({ config, logger })
  const characters = createCharacterLibrary({ config, logger })
  const handlers = createHandlers({ config, logger, persona, memory, decision, characters })

  const uploaded = await callHandler(handlers['/characters/upload'], {
    method: 'POST',
    body: {
      dataBase64: PNG_1X1,
      thumbBase64: PNG_1X1,
      name: 'api-upload.png',
      title: '接口上传',
      ageGroup: 'adult',
      outfitId: 'custom',
      tags: ['接口'],
      width: 1,
      height: 1,
    },
  })
  assert.equal(uploaded.status, 200)
  assert.equal(uploaded.body.ok, true)
  assert.match(uploaded.body.itemId, /^upload-/)
  assert.equal(uploaded.body.stats.uploads, 1)
  assert.equal(uploaded.body.counts.adult, 1)

  const withoutRights = await callHandler(handlers['/characters/upload'], {
    method: 'POST',
    body: { dataBase64: PNG_1X1 },
  })
  assert.equal(withoutRights.status, 200)
  assert.equal(withoutRights.body.stats.uploads, 2)

  const builtinDelete = await callHandler(handlers['/characters/delete'], {
    method: 'POST',
    body: { id: 'child-initial-maid' },
  })
  assert.equal(builtinDelete.status, 403)
  assert.equal(builtinDelete.body.error.code, 'BUILTIN_READONLY')

  const removed = await callHandler(handlers['/characters/delete'], {
    method: 'POST',
    body: { id: uploaded.body.itemId },
  })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.stats.uploads, 1)
  assert.equal(removed.body.items.some((item) => item.id === uploaded.body.itemId), false)

  const removedSecond = await callHandler(handlers['/characters/delete'], {
    method: 'POST',
    body: { id: withoutRights.body.itemId },
  })
  assert.equal(removedSecond.status, 200)
  assert.equal(removedSecond.body.stats.uploads, 0)
})
