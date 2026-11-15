import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildPageHtml } from '../src/creative/draw/server.js'

const SPRITES = [
  'front-happy', 'front-sad', 'front-sleepy', 'front-excited',
  'front-blank', 'front-wronged', 'front-proud', 'front-calm',
  'sit-happy', 'sit-sad', 'sit-sleepy', 'sit-calm',
  'back-happy', 'back-sad', 'curl-wronged', 'peek-blank', 'sleep-sleepy',
]

test('角色底稿：17 张精灵都随项目存在，缺一张就会回退成几何角色', () => {
  const dir = path.resolve(import.meta.dirname, '../assets/draw/sprites')
  for (const name of SPRITES) {
    const file = path.join(dir, `${name}.png`)
    assert.ok(fs.existsSync(file), `缺精灵 ${name}.png`)
    assert.ok(fs.statSync(file).size > 20_000, `精灵 ${name}.png 文件过小`)
  }
})

test('角色底稿：renderer 的 SPRITE_FILES 覆盖全部文件', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../assets/draw/renderer.js'), 'utf8')
  for (const name of SPRITES) {
    assert.match(source, new RegExp(`'${name}': '${name}\\.png'`), `SPRITE_FILES 缺少 ${name}`)
  }
})

test('画图页：画布尺寸跟 plan 走，不再固定死 1080×1440', () => {
  const html = buildPageHtml({ width: 1200, height: 1600, seed: 1 })
  assert.match(html, /width: 1200px/)
  assert.match(html, /height: 1600px/)
  assert.match(html, /<canvas id="c" width="1200" height="1600">/)
})

test('画图页：字体只认项目内的 LongCang，页面不请求外网', () => {
  const html = buildPageHtml({ seed: 1 })
  assert.match(html, /font-family: 'LongCang'/)
  assert.match(html, /\/assets\/fonts\/LongCang-Regular\.ttf/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('画图页：plan 注入前转义尖括号，避免提前闭合脚本', () => {
  const html = buildPageHtml({ seed: 1, note: '</script><script>alert(1)</script>' })
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)<\/script>/)
  assert.match(html, /\\u003c/)
})
