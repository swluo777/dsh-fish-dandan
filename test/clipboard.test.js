// 抖音的「假 Ctrl+V」不会触发粘贴；必须带 commands:['paste']，浏览器才读系统剪贴板。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pasteClipboardImage } from '../src/platform/douyin/clipboard.js'

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
