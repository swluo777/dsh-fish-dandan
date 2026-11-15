// 发抖音图文实现：路径收敛 + 发布按钮入口不再挂在值班工具上
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveImages } from '../src/platform/douyin/publish.js'
import { fromRoot } from '../src/utils/paths.js'

test('发作品：只收 data/images 与 data/stickers 里的图片', () => {
  const imgDir = fromRoot('data/images/send')
  fs.mkdirSync(imgDir, { recursive: true })
  const png = path.join(imgDir, 'test-cover.png')
  const gif = path.join(imgDir, 'test-cover.gif')
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(gif, Buffer.from('GIF89a'))

  assert.deepEqual(resolveImages([png]), [png], '图片保留')
  assert.deepEqual(resolveImages([gif]), [], 'gif 不支持')
  assert.deepEqual(resolveImages([path.join(fromRoot('.'), 'README.md')]), [], '库外文件一律不收')
  assert.deepEqual(resolveImages(['../../Windows/win.ini']), [], '越界路径不收')
  assert.deepEqual(resolveImages([png, png]), [png], '同一张只留一次')

  fs.rmSync(png, { force: true })
  fs.rmSync(gif, { force: true })
})

test('发作品：创作工作室自己的输出目录可以作为受信图片根', () => {
  const dir = fromRoot('data/creative/exports/publish-root-test')
  fs.mkdirSync(dir, { recursive: true })
  const png = path.join(dir, 'image.png')
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
  try {
    assert.deepEqual(resolveImages([png], { extraRoots: [dir] }), [png], '受信根里的图可以发')
    assert.deepEqual(resolveImages([png]), [], '没有声明受信根时仍然拒绝')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('发作品：最多 9 张（超出的截掉）', () => {
  const dir = fromRoot('data/images/send')
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  for (let i = 0; i < 12; i++) {
    const f = path.join(dir, `bulk-${i}.png`)
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, i]))
    files.push(f)
  }
  assert.equal(resolveImages(files).length, 9)
  for (const f of files) fs.rmSync(f, { force: true })
})

test('发作品 / 关注保持关闭，分享给主人只留精确入口', () => {
  const server = fs.readFileSync('src/platform/douyin/duty-server.mjs', 'utf8')
  assert.ok(!server.includes('douyin_publish'), '值班工具里不再有 douyin_publish')
  assert.ok(!server.includes('publish:image'), '能力清单里不再出现 publish:image')
  assert.ok(!server.includes("follow: { type: 'boolean' }"), 'douyin_react 不再有关注参数')
  assert.ok(!server.includes("['like', 'follow', 'favorite']"), 'douyin_react 能力清单不再有关注')
  assert.ok(!server.includes("kind === 'forward'"), 'douyin_say 不再有转发分支')
  assert.ok(!server.includes("'comment', 'reply', 'dm', 'forward'"), 'douyin_say 的 kind 枚举不再有转发')
  const duty = fs.readFileSync('src/platform/douyin/duty.js', 'utf8')
  assert.ok(!duty.includes('forwardToAny'), '不再用通用转发实现')
  assert.ok(duty.includes('follow: false'), '值班能力清单硬关关注')
  assert.ok(duty.includes('douyin_share_to_owner') || duty.includes('actions?.forward'), '只保留「分享给主人」这一条转发类入口')
  const prompt = fs.readFileSync('prompts/douyin-duty.md', 'utf8')
  assert.ok(!prompt.includes('douyin_publish'), '自由活动指南不再提发布工具')
  const html = fs.readFileSync('src/gui/web/index.html', 'utf8')
  assert.ok(!html.includes('actions.publish'), '设置页不再有发作品开关')
  assert.ok(!html.includes('actions.follow'), '设置页不再有关注开关')
  assert.ok(html.includes('actions.forward') && html.includes('分享给主人'), '只保留「分享给主人」开关')
})
