// 表情包库：不内置素材、按魔数收图、哈希去重、导入后可删
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStickerLibrary, sniffImageExt } from '../src/stickers/index.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stickers-'))
  const lib = createStickerLibrary({ config: { stickers: { dir, maxBytes: 1024 * 1024 } }, logger: quiet })
  return { dir, lib }
}

function pngBytes(extra = 0) {
  const b = Buffer.alloc(64 + extra)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a
  b.writeUInt32BE(0x0d0a1a0a, 8)
  b[12] = 0x49; b[13] = 0x48; b[14] = 0x44; b[15] = 0x52
  return b
}

test('表情包：只认图片魔数，不收文本和 SVG', () => {
  assert.equal(sniffImageExt(pngBytes()), 'png')
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(sniffImageExt(jpg), 'jpg')
  const gif = Buffer.from('GIF89a' + '\0'.repeat(10), 'binary')
  assert.equal(sniffImageExt(gif), 'gif')
  const webp = Buffer.alloc(16)
  webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii')
  assert.equal(sniffImageExt(webp), 'webp')
  assert.equal(sniffImageExt(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), '')
})

test('表情包：入库写文件、记索引、同图去重', async () => {
  const { dir, lib } = setup()
  const buf = pngBytes()
  const first = await lib.ingest(buf, { caption: '笑', tags: ['开心'], sourceType: 'upload' })
  assert.equal(first.ok, true)
  assert.equal(first.duplicate, false)
  assert.ok(fs.existsSync(path.join(dir, first.item.path)), '图片要真的落盘')

  const again = await lib.ingest(buf, { caption: '重复' })
  assert.equal(again.duplicate, true, '同样字节只存一份')
  assert.equal(lib.stats().total, 1)
  await assert.rejects(() => lib.ingest(Buffer.from('不是图片')), /只收 PNG/)
})

test('表情包：文本被拒、超大被拒', async () => {
  const { lib } = setup()
  await assert.rejects(() => lib.ingest(Buffer.from('hello world')), /只收 PNG/)
  const big = Buffer.alloc(2 * 1024 * 1024)
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47
  await assert.rejects(() => lib.ingest(big), /上限/)
})

test('表情包：base64 上传与列表检索', async () => {
  const { lib } = setup()
  const up = await lib.upload({ dataBase64: pngBytes().toString('base64'), name: '开心.png', tags: ['开心', '日常'] })
  assert.equal(up.ok, true)
  const found = lib.list({ q: '开心' })
  assert.equal(found.total, 1)
  assert.equal(lib.list({ q: '不存在' }).total, 0)
  assert.equal(lib.stats().packs, 1)
})

test('表情包：从链接导入走 fetch，失败不落库', async () => {
  const { lib } = setup()
  const fetchOk = async () => ({
    ok: true,
    headers: { get: () => String(64) },
    arrayBuffer: async () => pngBytes().buffer.slice(0, 64),
  })
  const ok = await lib.importUrl('https://example.com/a.png', { tags: ['远程'] }, { fetchImpl: fetchOk })
  assert.equal(ok.ok, true)
  assert.equal(lib.stats().total, 1)

  await assert.rejects(() => lib.importUrl('file:///etc/passwd', {}, { fetchImpl: fetchOk }), /http/)
  const fetch404 = async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) })
  await assert.rejects(() => lib.importUrl('https://example.com/b.png', {}, { fetchImpl: fetch404 }), /HTTP 404/)
})

test('表情包：没接图义模型时，标语义明确返回 ready=false', () => {
  const { lib } = setup()
  const r = lib.enrichMissing()
  assert.equal(r.ready, false)
  assert.equal(lib.stats().captionReady, false)
})

test('表情包：点「标语义」后才补图义，入库不会自动标', async () => {
  const { lib } = setup()
  const item = await lib.ingest(pngBytes(), { sourceType: 'upload' })
  let calls = 0
  lib.setCaptioner(async (record) => {
    calls += 1
    assert.ok(record.file.endsWith('.png'))
    return { caption: '在的，收到', emotion: ['友好'], intents: ['greeting', 'agree'], confidence: 0.9 }
  })
  assert.equal(lib.stats().captionReady, true, '接上图义模型后前端才显示进度')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls, 0, '接上模型、图片入库都不会自动标')
  assert.equal(lib.stats().captionPending, 1)

  const started = lib.enrichMissing()
  assert.equal(started.queued, 1, '只有点「标语义」才排队')
  for (let i = 0; i < 80 && lib.stats().captionPending > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(calls, 1, '点按钮后后台才跑一次')
  assert.equal(lib.get(item.id).caption, '在的，收到')
  assert.deepEqual(lib.get(item.id).intents, ['greeting', 'agree'])
  assert.equal(lib.stats().captioned, 1)
  assert.equal(lib.stats().captionFailed, 0)
})

test('表情包：图义失败后不自动重试，点「标语义」才重试', async () => {
  const { lib } = setup()
  const item = await lib.ingest(pngBytes(), { sourceType: 'upload' })
  let calls = 0
  const fail = async () => {
    calls += 1
    throw new Error('模型暂时不可用')
  }
  lib.setCaptioner(fail)
  assert.equal(calls, 0, '接上模型不会自动标')
  assert.equal(lib.enrichMissing().queued, 1, '点「标语义」才开始')
  for (let i = 0; i < 80 && lib.stats().captionFailed === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(calls, 1, '失败只跑一次，不无限重试')
  assert.equal(lib.get(item.id).enrichError, '模型暂时不可用')
  assert.ok(lib.get(item.id).enrichAttemptAt > 0)
  assert.equal(lib.stats().captionFailed, 1)

  const reconnected = lib.setCaptioner(fail)
  assert.equal(reconnected.ready, true)
  assert.equal(reconnected.pending, 1)
  assert.equal(calls, 1, '重新接上模型也不会偷偷重试失败图')
  assert.equal(lib.enrichMissing().queued, 1, '点标语义才会把失败图重新排队')
  for (let i = 0; i < 80 && calls < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(calls, 2, '手动重试真的又跑了一次')
  assert.equal(lib.stats().captionFailed, 1, '再次失败后仍然等下一次手动点击')
})

test('表情包：标语义可中途停止，未开始的取消，在跑的中断，不记失败', async () => {
  const { lib } = setup()
  const items = []
  for (let i = 0; i < 3; i += 1) items.push(await lib.ingest(pngBytes(i), { sourceType: 'upload' }))

  let calls = 0
  lib.setCaptioner(async (record, opts = {}) => {
    calls += 1
    const signal = opts.signal
    assert.ok(signal, '必须把停止信号传进模型调用')
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        const err = new Error('已停止')
        err.name = 'AbortError'
        reject(err)
        return
      }
      signal.addEventListener('abort', () => {
        const err = new Error('已停止')
        err.name = 'AbortError'
        reject(err)
      }, { once: true })
    })
    return { caption: '不该标成功' }
  })

  const started = lib.enrichMissing()
  assert.equal(started.queued, 3, '三张都先排进来')
  for (let i = 0; i < 40 && calls < 2; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls, 2, '并发两路已经在跑')

  const stopped = lib.stopCaptioning()
  assert.equal(stopped.stopped, 1, '队列里还没开始的那张直接取消')
  assert.equal(stopped.active, 2, '正在跑的两张要中断')

  for (let i = 0; i < 80 && lib.stats().captionActive > 0; i += 1) await new Promise((r) => setTimeout(r, 10))
  const s = lib.stats()
  assert.equal(s.captionQueued, 0)
  assert.equal(s.captionActive, 0)
  assert.equal(s.captionStopping, false)
  assert.equal(s.captionFailed, 0, '用户主动停止不算失败')
  assert.equal(s.captionPending, 3)
  for (const item of items) assert.equal(lib.get(item.id).enrichError || '', '', '停止不写失败原因')

  lib.setCaptioner(async () => ({ caption: '收到', emotion: ['友好'], confidence: 0.9 }))
  assert.equal(lib.enrichMissing().queued, 3, '停止后再点按钮，三张重新排队')
  for (let i = 0; i < 100 && lib.stats().captioned < 3; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal(lib.stats().captioned, 3)
})

test('表情包：按「图的意思 + 当前对话」检索，不给全库随机', async () => {
  const { lib } = setup()
  const a = await lib.ingest(pngBytes(), { caption: '在的', intents: ['greeting', 'agree'], confidence: 0.95, tags: ['greeting'] })
  const b = await lib.ingest(Buffer.from(pngBytes().map((v, i) => i === 20 ? 1 : v)), { caption: '笑死', intents: ['laugh'], confidence: 0.9 })
  const hits = lib.search({ q: '在吗', intent: 'greeting', limit: 5 })
  assert.equal(hits[0].id, a.id, '问「在吗」先命中有「在」含义的那张')
  assert.ok(hits[0].score >= 0.5)

  const laugh = lib.search({ q: '哈哈哈哈', intent: 'laugh', limit: 5 })
  assert.equal(laugh[0].id, b.id)

  // 没有 caption 的旧图只允许当兜底，不能被 confidence 抬过 0.38
  const tagOnly = await lib.ingest(Buffer.from(pngBytes().map((v, i) => i === 24 ? 2 : v)), {
    intents: ['laugh'], confidence: 1,
  })
  const tagHit = lib.search({ q: '', intent: 'laugh', includeTagOnly: true })
    .find((item) => item.id === tagOnly.id)
  assert.equal(tagHit.tagOnly, true)
  assert.ok(tagHit.score <= 0.38, `tagOnly 分数应封顶 0.38，实际 ${tagHit.score}`)

  assert.equal(lib.search({ q: '在吗', intent: 'greeting', includeTagOnly: false }).some((x) => x.tagOnly), false)
  const updated = lib.updateMeta(a.id, { caption: '在', intents: ['greeting'], confidence: 1 })
  assert.equal(updated.ok, true)
  assert.equal(lib.get(a.id).caption, '在')
})

