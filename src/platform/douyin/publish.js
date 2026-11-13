// ============================================================
// 发抖音作品（图文）：creator.douyin.com 上传页 → 上传图片 → 填标题/正文 → 发布
//
// 【暂停使用】2026-11-13 起发作品功能整体关闭：生产入口（设置开关、值班工具、
// 提示词、操作手册）已全部撤掉。这里只保留实现，供以后重新设计时参考，
// 不要在没有重新设计前把 publishImagePost 接回任何入口。
//
// 2026-11-12 实测流程（本机 Edge + 已登录的固定档案）：
//   1. 打开 creator.douyin.com/creator-micro/content/upload
//   2. 点「发布图文」→ 出现 accept 图片的 input[type=file]（multiple，最多 35 张）
//   3. DOM.setFileInputFiles 塞图 → 自动跳到 .../content/post/image
//   4. 标题 input[placeholder="添加作品标题"]（≤20 字）
//   5. 正文 contenteditable（≤1000 字）
//   6. 点按钮「发布」→ 跳到 .../content/manage，列表里出现「审核中」的新作品
// 不碰任何私有接口，只走网页。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fromRoot } from '../../utils/paths.js'
import { mouseClick } from './actions.js'

const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const MAX_IMAGES = 9
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const TITLE_MAX = 20
const BODY_MAX = 1000
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function evalJs(page, expression) {
  return page.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    .then((r) => (r && r.exceptionDetails ? null : (r && r.result && r.result.value)))
    .catch(() => null)
}

async function waitFor(page, expression, { timeoutMs = 30000, intervalMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await evalJs(page, expression)
    if (v) return v
    await sleep(intervalMs)
  }
  return null
}

/** 把用户/模型给的图片路径收敛到允许的目录里，避免上传到任意文件。 */
export function resolveImages(images = []) {
  const roots = [fromRoot('data/images'), fromRoot('data/stickers')].map((p) => path.resolve(p))
  const out = []
  for (const raw of images) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const abs = path.resolve(fromRoot(raw) || raw)
    if (!IMAGE_EXT.test(abs)) continue
    if (!roots.some((root) => abs.startsWith(root + path.sep))) continue
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) continue
    } catch { continue }
    if (!out.includes(abs)) out.push(abs)
    if (out.length >= MAX_IMAGES) break
  }
  return out
}

/**
 * 发一条图文作品。
 * @param {{ page: object, images: string[], title?: string, body: string, music?: string|boolean, visibility?: 'public'|'self', logger?: object, timeoutMs?: number }} input
 */
export async function publishImagePost({
  page, images = [], title = '', body = '', music = '',
  visibility = 'public', logger = console, timeoutMs = 150000,
} = {}) {
  if (!page) throw new Error('没有可用的浏览器页面')
  const files = resolveImages(images)
  if (!files.length) throw new Error('没有可用的图片（只收 data/images 或 data/stickers 里的 png/jpg/webp）')
  const text = String(body || '').trim().slice(0, BODY_MAX)
  if (!text) throw new Error('正文不能为空')
  const head = String(title || '').trim().slice(0, TITLE_MAX)
  const startedAt = Date.now()

  logger.info?.(`发抖音图文：${files.length} 张图，标题「${head}」`)
  await page.cmd('Page.navigate', { url: UPLOAD_URL })

  const tabRect = await waitFor(page, `(() => {
    const nodes = [...document.querySelectorAll('div,span,button,a')].filter((n) => (n.innerText || '').trim() === '发布图文');
    if (!nodes.length) return null;
    const r = nodes[nodes.length - 1].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, { timeoutMs: 40000 })
  if (!tabRect || typeof tabRect.x !== 'number') throw new Error('没能打开「发布图文」（可能没登录创作者中心）')
  await mouseClick(page, tabRect.x, tabRect.y)
  await sleep(1500)

  const inputNodeId = await waitFor(page, `(async () => {
    const list = [...document.querySelectorAll('input[type=file]')];
    const idx = list.findIndex((el) => /image\\//.test(el.accept || ''));
    return idx >= 0 ? idx : false;
  })()`, { timeoutMs: 20000 })
  if (inputNodeId === null || inputNodeId === false) throw new Error('找不到图片上传框')

  const doc = await page.cmd('DOM.getDocument', { depth: -1 })
  const query = await page.cmd('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  const ids = (query && query.nodeIds) || []
  // 按 DOM 顺序取 accept 图片的那个
  const imageInputs = []
  for (const nodeId of ids) {
    const attrs = await page.cmd('DOM.getAttributes', { nodeId }).catch(() => null)
    const flat = attrs && attrs.attributes ? attrs.attributes : []
    let accept = ''
    for (let i = 0; i < flat.length; i += 2) if (flat[i] === 'accept') accept = flat[i + 1] || ''
    if (/image\//.test(accept)) imageInputs.push(nodeId)
  }
  if (!imageInputs.length) throw new Error('上传框里没有图片类型')

  await page.cmd('DOM.setFileInputFiles', { files, nodeId: imageInputs[0] })
  logger.info?.('图片已塞入上传框，等编辑页…')

  const onEditor = await waitFor(page, `location.href.includes('/content/post/image')`, { timeoutMs: 60000 })
  if (!onEditor) throw new Error('上传后没有进入图文编辑页（可能图片被拒或网络慢）')
  await sleep(2500)

  // 标题
  if (head) {
    const titleFilled = await waitFor(page, `(() => {
      const el = document.querySelector('input[placeholder="添加作品标题"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r.width) return false;
      el.focus();
      return true;
    })()`, { timeoutMs: 15000 })
    if (titleFilled) {
      await page.cmd('Input.insertText', { text: head })
      await sleep(400)
    } else {
      logger.warn?.('标题框没找到，只发正文')
    }
  }

  // 正文
  const bodyReady = await waitFor(page, `(() => {
    const el = document.querySelector('[contenteditable="true"].editor-kit-container, [contenteditable="true"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width) return false;
    el.focus();
    return true;
  })()`, { timeoutMs: 15000 })
  if (!bodyReady) throw new Error('正文编辑框没找到')
  await page.cmd('Input.insertText', { text })
  await sleep(600)

  // 配乐：抖音图文可以选 BGM（发布页「选择音乐」→ 推荐或搜索 → 使用）
  let musicPicked = ''
  if (music) {
    const musicRect = await evalJs(page, `(() => {
      const nodes = [...document.querySelectorAll('div,span,button')].filter((n) => (n.innerText || '').trim() === '选择音乐');
      const hit = nodes.find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.width < 140 });
      if (!hit) return null;
      const t = hit.closest('button,[role="button"]') || hit;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (musicRect && typeof musicRect.x === 'number') await mouseClick(page, musicRect.x, musicRect.y)
    if (!musicRect) {
      logger.warn?.('没找到「选择音乐」入口，这次不带 BGM')
    } else {
      await sleep(1500)
      const keyword = typeof music === 'string' ? music.trim().slice(0, 20) : ''
      if (keyword) {
        const focused = await evalJs(page, `(() => {
          const el = document.querySelector('input[placeholder="搜索音乐"]');
          if (!el) return false;
          el.focus();
          return true;
        })()`)
        if (focused) {
          await page.cmd('Input.insertText', { text: keyword })
          await sleep(2500)
        }
      }
      const useRect = await evalJs(page, `(() => {
        const btns = [...document.querySelectorAll('button,span,div')].filter((n) => (n.innerText || '').trim() === '使用' && n.offsetParent !== null);
        if (!btns.length) return null;
        const r = btns[0].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`)
      if (useRect && typeof useRect.x === 'number') await mouseClick(page, useRect.x, useRect.y)
      if (useRect) {
        await sleep(1200)
        // 关掉选择面板，别挡住后续操作
        await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
        await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
        musicPicked = keyword || '推荐第一首'
        logger.info?.(`BGM 已选：${musicPicked}`)
      } else {
        logger.warn?.('音乐列表里没找到可点的「使用」')
      }
    }
  }

  // 可见范围（默认公开；只在明确要求时切）
  if (visibility === 'self') {
    const labelRect = await evalJs(page, `(() => {
      const label = [...document.querySelectorAll('label,span,div')].find((n) => (n.innerText || '').trim() === '仅自己可见');
      if (!label) return null;
      const r = label.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (labelRect && typeof labelRect.x === 'number') await mouseClick(page, labelRect.x, labelRect.y)
    if (!labelRect) logger.warn?.('没找到「仅自己可见」，仍按默认公开发布')
    await sleep(300)
  }

  const pubBtn = await evalJs(page, `(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '发布' && b.offsetParent !== null);
    if (!btns.length) return { err: 'none' };
    const b = btns[btns.length - 1];
    if (b.disabled) return { err: 'disabled' };
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (!pubBtn || pubBtn.err) throw new Error(`发布按钮不可用（${pubBtn && pubBtn.err}）`)
  await mouseClick(page, pubBtn.x, pubBtn.y)

  const done = await waitFor(page, `location.href.includes('/content/manage')`, { timeoutMs: 30000 })
  if (!done) {
    const still = await evalJs(page, `(document.body.innerText || '').slice(0, 200)`)
    throw new Error(`点了发布但没跳转（页面：${String(still).replace(/\s+/g, ' ').slice(0, 80)}）`)
  }
  await sleep(1200)
  const summary = await evalJs(page, `(() => {
    const t = document.body.innerText || '';
    return { page: location.href, reviewing: /审核中|审核/.test(t), hasTitle: t.includes(${JSON.stringify(head || '')}) };
  })()`)

  logger.info?.(`发布完成，用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`)
  return {
    ok: true,
    url: summary && summary.page ? summary.page : '',
    reviewing: Boolean(summary && summary.reviewing),
    images: files.length,
    title: head,
    body: text,
    music: musicPicked,
    visibility,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }
}
