// 文字卡片：路径/字数校验 + Windows 下真生成一张
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderTextCard, listTemplates, pickTemplate } from '../src/image/card.js'
import { fromRoot } from '../src/utils/paths.js'

test('文字卡片：空正文和超长正文都拒绝', () => {
  assert.equal(renderTextCard({ lines: '' }).ok, false)
  assert.equal(renderTextCard({ lines: 'x'.repeat(200) }).ok, false)
})

test('文字卡片：不允许写到 data/images 之外', () => {
  const r = renderTextCard({ lines: '胖鱼一条', outFile: 'README.md' })
  assert.equal(r.ok, false)
  assert.match(r.error, /data\/images/)
})

test('文字卡片：真生成一张 PNG（Windows）', { skip: process.platform !== 'win32' }, () => {
  const r = renderTextCard({ title: '第一条', lines: '胖鱼一条\n爱睡\n别催', footer: '@fish-dandan', outFile: 'data/images/cards/test-card.png' })
  assert.equal(r.ok, true, r.error || '')
  assert.ok(r.bytes > 1000, '文件应该有内容')
  const head = fs.readFileSync(r.file).subarray(0, 8)
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数')
  fs.rmSync(path.resolve(r.file), { force: true })
  fs.rmSync(fromRoot('data/images/cards'), { recursive: true, force: true })
})

test('文字卡片：深色主题也能生成（抖音大字卡风格）', { skip: process.platform !== 'win32' }, () => {
  const r = renderTextCard({ theme: 'dark', title: '反省', lines: '鱼今天被说像AI\n鱼在反省', footer: '@fish-dandan', outFile: 'data/images/cards/test-dark.png' })
  assert.equal(r.ok, true, r.error || '')
  assert.ok(r.bytes > 1000)
  fs.rmSync(path.resolve(r.file), { force: true })
  fs.rmSync(fromRoot('data/images/cards'), { recursive: true, force: true })
})

test('文字卡片：模板背景库可枚举、可抽签', () => {
  const list = listTemplates()
  if (!list.length) return // 模板是本地素材（不进仓库），没下载时跳过
  const pick = pickTemplate(0)
  assert.ok(pick && fs.existsSync(pick), '抽到的模板要真实存在')
})

test('文字卡片：带模板背景生成一张', { skip: process.platform !== 'win32' }, () => {
  const bg = pickTemplate(0)
  if (!bg) return
  const r = renderTextCard({ theme: 'dark', bgImage: bg, title: '夜游', lines: '凌晨三点的海\n一条鱼还在游', footer: '@fish-dandan', outFile: 'data/images/cards/test-bg.png' })
  assert.equal(r.ok, true, r.error || '')
  assert.ok(r.bytes > 1000)
  fs.rmSync(path.resolve(r.file), { force: true })
  fs.rmSync(fromRoot('data/images/cards'), { recursive: true, force: true })
})
