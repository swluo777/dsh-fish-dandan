// ============================================================
// 画图页的本地静态服务：只认三份文件（页面 / 渲染器 / 字体）。
// 不开目录列表、不接受用户传路径，端口只监听 127.0.0.1。
// ============================================================

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * @param {{ pageHtml: string, rendererPath: string, fontPath: string, logger?: object }} opts
 */
export async function startDrawServer({ pageHtml, rendererPath, fontPath, spriteDir, logger = console } = {}) {
  const renderer = fs.readFileSync(rendererPath, 'utf8')
  const font = fs.readFileSync(fontPath)
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const pathname = url.pathname
      if (pathname === '/' || pathname === '/draw.html' || pathname === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', pageHtml)
      }
      if (pathname === '/assets/draw/renderer.js') {
        return send(res, 200, 'text/javascript; charset=utf-8', renderer)
      }
      if (pathname.startsWith('/assets/draw/sprites/')) {
        const name = path.basename(pathname)
        if (!/^[a-z0-9-]+\.png$/.test(name) || !spriteDir) {
          return send(res, 404, 'text/plain; charset=utf-8', '没有这个角色底稿')
        }
        const file = path.join(spriteDir, name)
        if (!fs.existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', '没有这个角色底稿')
        const body = fs.readFileSync(file)
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': body.length,
        })
        return res.end(body)
      }
      if (pathname === '/assets/fonts/LongCang-Regular.ttf') {
        res.writeHead(200, {
          'content-type': 'font/ttf',
          'cache-control': 'no-store',
          'content-length': font.length,
        })
        return res.end(font)
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204)
        return res.end()
      }
      return send(res, 404, 'text/plain; charset=utf-8', '没有这个文件')
    } catch (err) {
      logger?.warn?.(`画图页服务请求失败：${err.message}`)
      try { send(res, 500, 'text/plain; charset=utf-8', '画图页服务出错') } catch { /* 忽略 */ }
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  logger?.debug?.(`画图页服务已启动：${origin}`)
  return {
    origin,
    url: `${origin}/draw.html`,
    close: () => new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
    }),
  }
}

/** 页面 HTML：内联 plan，引用同项目里的渲染器与字体（file:// 与本地服务都能用）。 */
export function buildPageHtml(plan, { title = '专注创作' } = {}) {
  const safe = JSON.stringify(plan).replace(/</g, '\\u003c')
  const width = Number(plan?.width) || 1080
  const height = Number(plan?.height) || 1440
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @font-face {
    font-family: 'LongCang';
    src: url('../assets/fonts/LongCang-Regular.ttf') format('truetype');
    font-display: block;
  }
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #f2ede2; }
  #c { display: block; width: ${width}px; height: ${height}px; }
</style>
</head>
<body>
<canvas id="c" width="${width}" height="${height}"></canvas>
<script>window.__PLAN__ = ${safe};</script>
<script src="../assets/draw/renderer.js"></script>
</body>
</html>`
}

export function drawAssetsPaths() {
  return {
    rendererPath: path.resolve(import.meta.dirname, '../../../assets/draw/renderer.js'),
    fontPath: path.resolve(import.meta.dirname, '../../../assets/fonts/LongCang-Regular.ttf'),
    spriteDir: path.resolve(import.meta.dirname, '../../../assets/draw/sprites'),
  }
}

