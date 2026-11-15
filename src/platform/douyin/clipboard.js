// ============================================================
// 抖音网页的「粘贴图片」：私信输入框用系统剪贴板 Ctrl+V。
//
// 评论/回复的图片走 actions.js 里的隐藏 file input（图片按钮背后），
// 不依赖这里的粘贴。这里只负责把图片放进剪贴板并按下粘贴，
// 不碰任何账号、Cookie 或隐藏接口。
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolvePowerShell } from '../../utils/powershell.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * Windows 剪贴板（System.Drawing）只认 PNG/JPEG/GIF/BMP，不认 WebP/AVIF。
 * 表情包库大量是 WebP；直接丢给剪贴板会报 "Out of memory"，图根本没进去。
 * 这里先用已打开的 Chromium 把 WebP/AVIF 画到 canvas，再转成临时 PNG。
 */
export async function prepareClipboardImage(page, file) {
  const src = String(file || '')
  if (!/\.(webp|avif)$/i.test(src)) return { file: src, temp: false }
  const ext = path.extname(src).toLowerCase()
  const mime = ext === '.avif' ? 'image/avif' : 'image/webp'
  const dataUrl = `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`
  const r = await page.cmd('Runtime.evaluate', {
    expression: `(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      if (!canvas.width || !canvas.height) throw new Error('图片尺寸为 0');
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const png = r && r.result && r.result.value
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) {
    throw new Error('WebP/AVIF 转 PNG 失败，浏览器没有返回图片数据')
  }
  const out = path.join(os.tmpdir(), `fish-clipboard-${randomUUID()}.png`)
  fs.writeFileSync(out, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'))
  return { file: out, temp: true }
}

/** 删掉 prepareClipboardImage 生成的临时 PNG；原始图片不动。 */
export function releaseClipboardImage(prepared) {
  if (!prepared || prepared.temp !== true || !prepared.file) return
  try { fs.rmSync(prepared.file, { force: true }) } catch { /* 临时文件删不掉不影响已经放进剪贴板的图 */ }
}

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
  let prepared = { file, temp: false }
  try {
    prepared = await prepareClipboardImage(page, file)
    putImageInClipboard(prepared.file)
  } catch (err) {
    releaseClipboardImage(prepared)
    return { ok: false, reason: `剪贴板放图失败：${err.message}` }
  }
  releaseClipboardImage(prepared)
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
