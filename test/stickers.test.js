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

test('表情包：按「图的意思 + 当前对话」检索，不给全库随机', async () => {
  const { lib } = setup()
  const a = await lib.ingest(pngBytes(), { caption: '在的', intents: ['greeting', 'agree'], confidence: 0.95, tags: ['greeting'] })
  const b = await lib.ingest(Buffer.from(pngBytes().map((v, i) => i === 20 ? 1 : v)), { caption: '笑死', intents: ['laugh'], confidence: 0.9 })
  const hits = lib.search({ q: '在吗', intent: 'greeting', limit: 5 })
  assert.equal(hits[0].id, a.id, '问「在吗」先命中有「在」含义的那张')
  assert.ok(hits[0].score >= 0.5)

  const laugh = lib.search({ q: '哈哈哈哈', intent: 'laugh', limit: 5 })
  assert.equal(laugh[0].id, b.id)

  assert.equal(lib.search({ q: '在吗', intent: 'greeting', includeTagOnly: false }).some((x) => x.tagOnly), false)
  const updated = lib.updateMeta(a.id, { caption: '在', intents: ['greeting'], confidence: 1 })
  assert.equal(updated.ok, true)
  assert.equal(lib.get(a.id).caption, '在')
})

