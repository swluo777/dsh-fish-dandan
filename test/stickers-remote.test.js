// 远程表情包：zip 解包 + 社区索引 + 整包安装
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { readZipEntries, stripZipRoot } from '../src/stickers/zip.js'
import { fetchCommunityIndex, installPack } from '../src/stickers/remote.js'
import { createStickerLibrary } from '../src/stickers/index.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function pngBytes(seed = 0) {
  const b = Buffer.alloc(64)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a
  b[60] = seed
  return b
}
function gifBytes(seed = 0) {
  const b = Buffer.alloc(32)
  b.write('GIF89a', 0, 'ascii')
  b[20] = seed
  return b
}

/** 构造一个最小 zip（deflate），用来测解包器。 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data))
    const compressed = zlib.deflateRawSync(data)
    const nameBuf = Buffer.from(f.name, 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length + compressed.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    compressed.copy(local, 30 + nameBuf.length)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stk-remote-'))
  return { dir, lib: createStickerLibrary({ config: { stickers: { dir, maxBytes: 1024 * 1024 } }, logger: quiet }) }
}

const manifest = {
  schema_version: 1,
  id: 'test-pack',
  name: '测试表情包',
  version: '1.0.0',
  license: 'CC-BY-NC-SA-4.0',
  tags: ['official'],
  categories: { happy: { description: '开心' }, sad: { description: '难过' } },
}

function packTree() {
  return [
    { path: 'manifest.json', type: 'blob', size: 100 },
    { path: 'memes/happy/a.png', type: 'blob', size: 64 },
    { path: 'memes/happy/b.png', type: 'blob', size: 64 },
    { path: 'memes/sad/c.gif', type: 'blob', size: 32 },
    { path: 'memes/unknown/d.png', type: 'blob', size: 64 },
    { path: 'previews/cover.png', type: 'blob', size: 64 },
  ]
}
function packFiles() {
  return {
    'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'memes/happy/a.png': pngBytes(1),
    'memes/happy/b.png': pngBytes(2),
    'memes/sad/c.gif': gifBytes(3),
    'memes/unknown/d.png': pngBytes(4),
    'previews/cover.png': pngBytes(5),
  }
}
function mockGithub() {
  const tree = packTree()
  const files = packFiles()
  return async (url) => {
    if (String(url).includes('/git/trees/')) {
      const body = Buffer.from(JSON.stringify({ tree, truncated: false }))
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(body).buffer }
    }
    const m = String(url).match(/\/raw\/[^/]+\/(.+)$/)
    const rel = m ? decodeURIComponent(m[1]) : ''
    const data = files[rel]
    if (!data) return { ok: false, status: 404, arrayBuffer: async () => new Uint8Array(0).buffer }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(data).buffer }
  }
}

test('zip：能解出文件内容并去掉顶层目录', () => {
  const zip = makeZip([
    { name: 'owner-repo-sha/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'owner-repo-sha/memes/happy/a.png', data: pngBytes(1) },
  ])
  const entries = readZipEntries(zip)
  assert.ok(entries.length >= 2)
  const manifestEntry = entries.find((e) => e.name.endsWith('manifest.json'))
  assert.ok(manifestEntry)
  assert.equal(JSON.parse(manifestEntry.data.toString('utf8')).id, 'test-pack')
  const stripped = stripZipRoot(entries)
  assert.ok(stripped.some((e) => e.name === 'manifest.json'))
  assert.ok(stripped.some((e) => e.name === 'memes/happy/a.png'))
})

test('zip：不是 zip 的字节会明确报错', () => {
  assert.throws(() => readZipEntries(Buffer.from('hello world')), /不是有效的 zip/)
})

test('社区索引：支持 GitHub API 返回的 base64 文件对象', async () => {
  const payload = {
    schema_version: '1.0.0',
    packs: [
      { id: 'p1', name: '包一', source: { type: 'github', repo: 'a/b', ref: 'main', subpath: '.' }, license: 'MIT' },
      { id: 'p2', name: '包二', source: { type: 'http', repo: 'x' } },
    ],
  }
  const fetchImpl = async () => {
    const body = Buffer.from(JSON.stringify({ content: Buffer.from(JSON.stringify(payload)).toString('base64'), encoding: 'base64' }))
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(body).buffer }
  }
  const index = await fetchCommunityIndex({ fetchImpl })
  assert.equal(index.packs.length, 1, '只保留 github 来源的包')
  assert.equal(index.packs[0].source.repo, 'a/b')
  assert.equal(index.packs[0].license, 'MIT')
})

test('整包安装：只收已声明的分类，重复内容不重复入库', async () => {
  const { lib } = setup()
  const fetchImpl = mockGithub()
  const r = await installPack({ repo: 'owner/repo', ref: 'main', library: lib, fetchImpl, logger: quiet })
  assert.equal(r.ok, true)
  assert.equal(r.total, 3, 'happy 两张 + sad 一张；未知分类和预览图不算')
  assert.equal(r.added, 3)
  assert.equal(lib.stats().total, 3)
  const pack = lib.stats().packsList.find((p) => p.id === 'test-pack')
  assert.ok(pack, '包元信息要登记')
  assert.equal(pack.license, 'CC-BY-NC-SA-4.0')

  // 再装一次：全部被哈希去重
  const again = await installPack({ repo: 'owner/repo', ref: 'main', library: lib, fetchImpl, logger: quiet })
  assert.equal(again.added, 0)
  assert.equal(again.duplicate, 3)
  assert.equal(lib.stats().total, 3)
})

test('整包安装：没有 manifest 直接拒绝', async () => {
  const { lib } = setup()
  const fetchImpl = async (url) => {
    if (String(url).includes('/git/trees/')) {
      const body = Buffer.from(JSON.stringify({ tree: [{ path: 'x/memes/happy/a.png', type: 'blob', size: 64 }], truncated: false }))
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(body).buffer }
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(pngBytes(1)).buffer }
  }
  await assert.rejects(() => installPack({ repo: 'owner/repo', library: lib, fetchImpl, logger: quiet }), /manifest/)
})
