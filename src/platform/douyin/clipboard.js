// ============================================================
// 抖音网页的「粘贴图片」：私信输入框用系统剪贴板 Ctrl+V。
//
// 评论/回复的图片走 actions.js 里的隐藏 file input（图片按钮背后），
// 不依赖这里的粘贴。这里只负责把图片放进剪贴板并按下粘贴，
// 不碰任何账号、Cookie 或隐藏接口。
// ============================================================

import { execFileSync } from 'node:child_process'
import { resolvePowerShell } from '../../utils/powershell.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 把本地图片放入 Windows 剪贴板；失败时抛出可读错误。 */
export function putImageInClipboard(file) {
  const safe = String(file).replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    `$img = [System.Drawing.Image]::FromFile('${safe}');`,
    '[System.Windows.Forms.Clipboard]::SetImage($img);',
    'Start-Sleep -Milliseconds 300;',
    '$img.Dispose();',
    "Write-Output 'ok'",
  ].join(' ')
  execFileSync(resolvePowerShell(), ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    timeout: 30000,
  })
}

/**
 * 在已经聚焦的输入框里按 Ctrl+V，并等图片预览出现。
 *
 * 实测（2026-11-13）：只发 rawKeyDown/keyUp 的「假 Ctrl+V」不会触发抖音的
 * paste 处理；必须同时发 `commands: ['paste']`，浏览器才会真正读取系统剪贴板。
 * 私信输入框会因此弹出「发送给 xxx」的图片确认框；评论图片不要用这个函数，
 * 走 actions.js 里的隐藏 file input 上传。
 */
export async function pasteClipboardImage(page, { waitMs = 2600 } = {}) {
  await page.cmd('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'v', code: 'KeyV',
    windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2,
    commands: ['paste'],
  }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'v', code: 'KeyV',
    windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2,
  }).catch(() => {})
  await sleep(waitMs)
}

/** 点击一个坐标，把焦点放到输入框；坐标来自调用方已经读到的 DOM。 */
export async function clickPoint(page, point) {
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return false
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 }).catch(() => {})
  await sleep(120)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(80)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(500)
  return true
}

/**
 * 把图片放进剪贴板，再粘到当前输入框。
 * 返回粘贴后输入区域是否出现了图片；没有出现就视为失败，不假装发出去。
 */
export async function pasteImageToFocusedInput(page, file, { point, waitMs = 2600 } = {}) {
  if (point) await clickPoint(page, point)
  try {
    putImageInClipboard(file)
  } catch (err) {
    return { ok: false, reason: `剪贴板放图失败：${err.message}` }
  }
  await pasteClipboardImage(page, { waitMs })
  const seen = await page.cmd('Runtime.evaluate', {
    expression: `(() => {
      // 私信粘贴图片不会进 contenteditable，而是弹出「发送给 xxx」确认框；
      // 评论的图片预览则挂在输入容器里，不在 Draft.js 编辑器的子树里。
      if (document.querySelector('.MsgInputSendFileModalbox')) return 'dialog';
      const roots = [
        ...document.querySelectorAll('.comment-input-container, .comment-input-inner-container, .messageMsgInputcontainer, .messageEditorinputArea'),
        ...document.querySelectorAll('[contenteditable="true"]'),
      ];
      return roots.some((el) => Boolean(el && el.querySelector && el.querySelector('img'))) ? 'inline' : '';
    })()`,
    returnByValue: true,
  }).catch(() => null)
  const mode = seen && seen.result ? seen.result.value : ''
  return mode
    ? { ok: true, mode }
    : { ok: false, reason: '图片粘进去了，但输入框里没有出现图片预览（可能不支持这个格式）' }
}
