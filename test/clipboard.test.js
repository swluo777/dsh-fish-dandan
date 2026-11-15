// 抖音的「假 Ctrl+V」不会触发粘贴；必须带 commands:['paste']，浏览器才读系统剪贴板。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pasteClipboardImage, prepareClipboardImage, releaseClipboardImage } from '../src/platform/douyin/clipboard.js'

test('剪贴板粘贴：发 keyDown + nativeVirtualKeyCode + paste 命令', async () => {
  const events = []
  const page = {
    cmd: async (method, params) => {
      events.push({ method, params })
      return {}
    },
  }
  await pasteClipboardImage(page, { waitMs: 1 })
  const down = events.find((e) => e.method === 'Input.dispatchKeyEvent' && e.params.type === 'keyDown')
  assert.ok(down, '必须发 keyDown，而不是 rawKeyDown')
  assert.equal(down.params.windowsVirtualKeyCode, 86)
  assert.equal(down.params.nativeVirtualKeyCode, 86, '要带原生虚拟键码')
  assert.deepEqual(down.params.commands, ['paste'], '必须让浏览器执行 paste 命令')
  assert.ok(events.some((e) => e.method === 'Input.dispatchKeyEvent' && e.params.type === 'keyUp'))
})

test('剪贴板：WebP 先经浏览器转成临时 PNG，再交给 System.Drawing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-clip-'))
  const src = path.join(dir, 'sticker.webp')
  fs.writeFileSync(src, Buffer.from('fake-webp'))
  const page = {
    cmd: async (method, params) => {
      assert.equal(method, 'Runtime.evaluate')
      assert.equal(params.awaitPromise, true)
      return { result: { value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1kAAAAASUVORK5CYII=' } }
    },
  }
  try {
    const prepared = await prepareClipboardImage(page, src)
    assert.equal(prepared.temp, true)
    assert.match(prepared.file, /fish-clipboard-.*\.png$/i)
    assert.ok(fs.statSync(prepared.file).size > 0, '临时 PNG 要真正落盘')
    releaseClipboardImage(prepared)
    assert.equal(fs.existsSync(prepared.file), false, '临时 PNG 用完要删')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('剪贴板：PNG/JPEG 不需要转换，直接用原文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-clip-'))
  const src = path.join(dir, 'sticker.png')
  fs.writeFileSync(src, Buffer.from('fake-png'))
  try {
    const prepared = await prepareClipboardImage({ cmd: async () => { throw new Error('不该调用浏览器') } }, src)
    assert.deepEqual(prepared, { file: src, temp: false })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
