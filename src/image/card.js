// ============================================================
// 文字卡片：生成「像文字卡片一样的图文」——白底、大字、一句话。
//
// 抖音上很多图文作品就是一张图配几句话。这里用 Windows 自带的
// System.Drawing 画（本机是 Windows + Edge 的抖音场景），零依赖。
//
// 输出统一放到 data/images/cards/，并做路径/字数校验，不写任意位置。
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fromRoot } from '../utils/paths.js'
import { resolvePowerShell } from '../utils/powershell.js'

const CARDS_DIR = () => fromRoot('data/images/cards')
const BG_DIR = () => fromRoot('data/templates/backgrounds')
const TITLE_MAX = 24
const LINES_MAX = 80
const FOOT_MAX = 24
const DEFAULT_SIZE = [1080, 1440]

function psQuote(text) {
  return String(text).replace(/'/g, "''")
}

/** 模板背景：data/templates/backgrounds 下的 png/jpg。没有就用纯色渐变。 */
export function listTemplates() {
  try {
    return fs.readdirSync(BG_DIR())
      .filter((n) => /\.(png|jpe?g)$/i.test(n))
      .sort()
      .map((n) => path.join(BG_DIR(), n))
  } catch { return [] }
}

/** 随机挑一张模板背景；没有就返回空串（走纯色渐变）。 */
export function pickTemplate(seed = Math.random()) {
  const list = listTemplates()
  if (!list.length) return ''
  return list[Math.min(list.length - 1, Math.floor(seed * list.length))] || ''
}

/**
 * 生成一张文字卡片。
 * @param {{ title?: string, lines: string, footer?: string, outFile?: string, bg?: string, theme?: 'light'|'dark', width?: number, height?: number }} input
 * @returns {{ ok: boolean, file?: string, bytes?: number, error?: string }}
 */
export function renderTextCard({ title = '', lines = '', footer = '', outFile = '', bg = '', bgImage = '', theme = 'light', width = DEFAULT_SIZE[0], height = DEFAULT_SIZE[1] } = {}) {
  const body = String(lines || '').trim()
  if (!body) return { ok: false, error: '卡片至少要有正文' }
  if (body.length > LINES_MAX) return { ok: false, error: `正文太长（最多 ${LINES_MAX} 字）` }
  const head = String(title || '').trim().slice(0, TITLE_MAX)
  const foot = String(footer || '').trim().slice(0, FOOT_MAX)
  const w = Math.max(480, Math.min(2048, Math.round(Number(width) || DEFAULT_SIZE[0])))
  const h = Math.max(480, Math.min(2560, Math.round(Number(height) || DEFAULT_SIZE[1])))

  const dir = CARDS_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const file = outFile
    ? path.resolve(fromRoot(outFile))
    : path.join(dir, `card-${Date.now()}.png`)
  const root = path.resolve(dir)
  if (!file.startsWith(root + path.sep) && !file.startsWith(path.resolve(fromRoot('data/images')) + path.sep)) {
    return { ok: false, error: '卡片只能生成到 data/images 下面' }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const palette = theme === 'dark'
    ? { bg: bg || '#0E1116', main: '#FFFFFF', accent: '#4EA3FF', soft: '#8C96A8', deco: [22, 120, 170, 255] }
    : { bg: bg || '#EEF3F8', main: '#2B3440', accent: '#2F6FB3', soft: '#6B7A8C', deco: [26, 120, 160, 220] }

  // 模板背景：只认 data/templates/backgrounds 和 data/images 里的图
  let bgFile = ''
  if (bgImage) {
    const abs = path.resolve(fromRoot(bgImage) || bgImage)
    const roots = [path.resolve(BG_DIR()), path.resolve(fromRoot('data/images'))].map((x) => x + path.sep)
    if (roots.some((r) => abs.startsWith(r))) bgFile = abs
  }

  const script = `
Add-Type -AssemblyName System.Drawing
$W = ${w}; $H = ${h}
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('${psQuote(palette.bg)}'))
$g.FillRectangle($bg, 0, 0, $W, $H); $bg.Dispose()
if ('${psQuote(bgFile)}' -ne '') {
  try {
    $img = [System.Drawing.Image]::FromFile('${psQuote(bgFile)}')
    $g.DrawImage($img, 0, 0, $W, $H)
    $img.Dispose()
    $mask = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(${theme === 'dark' ? 96 : 78}, 0, 0, 0))
    $g.FillRectangle($mask, 0, 0, $W, $H); $mask.Dispose()
  } catch { }
} else {
  $deco = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(${palette.deco[0]}, ${palette.deco[1]}, ${palette.deco[2]}, ${palette.deco[3]}))
  $g.FillEllipse($deco, ($W - 520), 60, 560, 560)
  $g.FillEllipse($deco, -160, ($H - 480), 520, 520); $deco.Dispose()
}
$tf = New-Object System.Drawing.Font('Microsoft YaHei', 58, [System.Drawing.FontStyle]::Bold)
$lf = New-Object System.Drawing.Font('Microsoft YaHei', 76, [System.Drawing.FontStyle]::Bold)
$ff = New-Object System.Drawing.Font('Microsoft YaHei', 28, [System.Drawing.FontStyle]::Regular)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('${palette.main}'))
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('${palette.accent}'))
$soft = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('${palette.soft}'))
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
if ('${psQuote(head)}' -ne '') {
  $r = New-Object System.Drawing.RectangleF(0, 190, $W, 110)
  $g.DrawString('${psQuote(head)}', $tf, $accent, $r, $fmt)
}
$r2 = New-Object System.Drawing.RectangleF(80, 350, ($W - 160), 700)
$g.DrawString('${psQuote(body)}', $lf, $dark, $r2, $fmt)
if ('${psQuote(foot)}' -ne '') {
  $r3 = New-Object System.Drawing.RectangleF(0, ($H - 190), $W, 60)
  $g.DrawString('${psQuote(foot)}', $ff, $soft, $r3, $fmt)
}
$bmp.Save('${psQuote(file.replace(/\\/g, '\\\\'))}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $g.Dispose()
Write-Output 'ok'
`
  try {
    execFileSync(resolvePowerShell(), ['-NoProfile', '-STA', '-Command', script], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
  } catch (err) {
    return { ok: false, error: `生成卡片失败：${String(err.message || err).slice(0, 200)}` }
  }
  try {
    const st = fs.statSync(file)
    return { ok: true, file, bytes: st.size }
  } catch {
    return { ok: false, error: '卡片文件没生成出来' }
  }
}
