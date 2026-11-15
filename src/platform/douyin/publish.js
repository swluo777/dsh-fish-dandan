// ============================================================
// 发抖音作品（图文）：creator.douyin.com 上传页 → 上传图片 → 填标题/正文 → 选推荐音乐 → 发布
//
// 2026-11-15 接入自动发布：只走网页，不碰私有接口。
// 每一步失败都停在当前浏览器页面，方便用户看到卡在哪，不静默重试。
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

/**
 * 找音乐侧栏里第一条推荐：用「万使用 / 人使用」这行数字往上找到整行，
 * 返回鼠标要移动到的行中心。抖音的「使用」按钮只在行 hover 时出现。
 */
async function findFirstMusicRow(page) {
  return evalJs(page, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
        && r.right > 0 && r.left < window.innerWidth;
    };
    const usage = [...document.querySelectorAll('div,span')].find((el) => {
      const t = (el.innerText || '').trim();
      return /^\\d+(?:\\.\\d+)?(?:万|亿)?\\s*人?使用$/.test(t) && visible(el)
        && el.getBoundingClientRect().left > window.innerWidth * 0.4;
    });
    if (!usage) return null;
    let row = usage;
    for (let i = 0; i < 6 && row.parentElement; i++) {
      row = row.parentElement;
      const r = row.getBoundingClientRect();
      if (r.width >= 260 && r.height >= 42 && r.height <= 150 && visible(row)) break;
    }
    const r = row.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width * 0.55),
      y: Math.round(r.top + r.height / 2),
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      text: (row.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 3),
    };
  })()`)
}

/** 在当前鼠标悬停的行里找可见的「使用」按钮。 */
async function findUseButton(page, row) {
  return evalJs(page, `(() => {
    const row = ${JSON.stringify(row)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 12 && r.bottom > 0 && r.top < window.innerHeight
        && r.right > 0 && r.left < window.innerWidth;
    };
    const candidates = [...document.querySelectorAll('button,div,span')].filter((el) => {
      const t = (el.innerText || '').trim();
      if (t !== '使用' || !visible(el)) return false;
      const r = el.getBoundingClientRect();
      // 只认落在第一条推荐行里的按钮，避免误点别的行
      return r.top >= row.top - 10 && r.bottom <= row.bottom + 10;
    });
    if (!candidates.length) return null;
    const b = candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return Math.abs((ra.left + ra.right) / 2 - row.x) - Math.abs((rb.left + rb.right) / 2 - row.x);
    })[0];
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
}

/** 把用户/模型给的图片路径收敛到允许的目录里，避免上传到任意文件。 */
export function resolveImages(images = [], { extraRoots = [] } = {}) {
  const roots = [fromRoot('data/images'), fromRoot('data/stickers'), ...(Array.isArray(extraRoots) ? extraRoots : [])]
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => path.resolve(p))
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
  visibility = 'public', logger = console, timeoutMs = 150000, extraRoots = [],
} = {}) {
  if (!page) throw new Error('没有可用的浏览器页面')
  const files = resolveImages(images, { extraRoots })
  if (!files.length) throw new Error('没有可用的图片（图片不在允许的创作输出目录里）')
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

  const hasImageInput = await waitFor(page, `(() => {
    const list = [...document.querySelectorAll('input[type=file]')];
    return list.some((el) => /image\\//.test(el.accept || ''));
  })()`, { timeoutMs: 20000 })
  if (!hasImageInput) throw new Error('找不到图片上传框')

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

  // 标题：优先 input，兼容 contenteditable；字段在视口外时先滚过去再焦点。
  if (head) {
    const titleReady = await waitFor(page, `(() => {
      const candidates = [
        document.querySelector('input[placeholder*="作品标题"]'),
        document.querySelector('textarea[placeholder*="作品标题"]'),
        ...[...document.querySelectorAll('[contenteditable="true"]')].filter((el) => {
          const hint = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '') + ' ' + (el.innerText || '');
          return hint.includes('添加作品标题') || hint.includes('作品标题');
        }),
      ].filter(Boolean);
      const el = candidates.find((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 100 && r.height > 10;
      });
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return true;
    })()`, { timeoutMs: 15000 })
    if (titleReady) {
      await sleep(300)
      await page.cmd('Input.insertText', { text: head })
      await sleep(400)
    } else {
      logger.warn?.('标题框没找到，只发正文')
    }
  }

  // 正文：选带「作品描述」提示或高度明显更大的 contenteditable，避免把标题框当成正文。
  const bodyReady = await waitFor(page, `(() => {
    const list = [...document.querySelectorAll('[contenteditable="true"]')];
    const hintOf = (el) => (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '') + ' ' + (el.innerText || '');
    const el = list.find((node) => /添加作品描述|作品描述/.test(hintOf(node)))
      || list.find((node) => node.getBoundingClientRect().height > 90)
      || document.querySelector('[contenteditable="true"].editor-kit-container');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    return true;
  })()`, { timeoutMs: 15000 })
  if (!bodyReady) throw new Error('正文编辑框没找到')
  await sleep(300)
  await page.cmd('Input.insertText', { text })
  await sleep(600)

  // 配乐：滚到「选择音乐」→ 打开推荐侧栏 → 鼠标悬停第一首 → 点出现的「使用」。
  let musicPicked = ''
  if (music) {
    const musicRect = await waitFor(page, `(() => {
      const nodes = [...document.querySelectorAll('div,span,button')].filter((n) => (n.innerText || '').trim() === '选择音乐');
      const hits = nodes.map((n) => ({ n, r: n.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.width < 160 && r.height > 0);
      if (!hits.length) return null;
      // 页面上有两个「选择音乐」：左侧是行标题，右侧才是可点的动作。取靠右的那个。
      const { n: hit } = hits.sort((a, b) => b.r.left - a.r.left)[0];
      const t = hit.closest('button,[role="button"]') || hit;
      t.scrollIntoView({ block: 'center' });
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`, { timeoutMs: 15000 })
    if (!musicRect || typeof musicRect.x !== 'number') throw new Error('没找到「选择音乐」入口')
    await sleep(500)
    await mouseClick(page, musicRect.x, musicRect.y)

    const panelOpen = await waitFor(page, `(() => {
      const el = document.querySelector('input[placeholder="搜索音乐"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 10;
    })()`, { timeoutMs: 15000 })
    if (!panelOpen) {
      // 有些版本用纯坐标点不认（被浮层挡住或滚动后重排），补一次 DOM click 再等。
      await evalJs(page, `(() => {
        const nodes = [...document.querySelectorAll('div,span,button')].filter((n) => (n.innerText || '').trim() === '选择音乐');
        const hits = nodes.map((n) => ({ n, r: n.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.width < 160 && r.height > 0);
        if (!hits.length) return false;
        const { n: hit } = hits.sort((a, b) => b.r.left - a.r.left)[0];
        const t = hit.closest('button,[role="button"]') || hit;
        if (t) t.click();
        return Boolean(t);
      })()`)
      await sleep(1500)
    }
    const panelReady = panelOpen || await waitFor(page, `(() => {
      const el = document.querySelector('input[placeholder="搜索音乐"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 10;
    })()`, { timeoutMs: 8000 })
    if (!panelReady) {
      const debug = await evalJs(page, `(() => ({
        inputs: [...document.querySelectorAll('input,textarea')].map((el) => ({
          placeholder: el.getAttribute('placeholder') || '',
          type: el.getAttribute('type') || '',
          visible: Boolean(el.getBoundingClientRect().width),
        })).filter((x) => x.visible).slice(0, 20),
        text: (document.body.innerText || '').slice(0, 600),
      }))()`)
      logger.warn?.(`音乐面板没打开：${JSON.stringify(debug).slice(0, 900)}`)
      throw new Error('音乐面板没有打开')
    }
    // 侧栏先出现搜索框，再异步拉推荐列表；等第一条的「x 万使用」出现后再 hover。
    const listReady = await waitFor(page, `(() => {
      return [...document.querySelectorAll('div,span')].some((el) => {
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return /^\\d+(?:\\.\\d+)?(?:万|亿)?\\s*人?使用$/.test(t)
          && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
          && r.left > window.innerWidth * 0.4;
      });
    })()`, { timeoutMs: 15000 })
    if (!listReady) throw new Error('音乐列表没有加载出来')
    await sleep(500)

    const keyword = typeof music === 'string' && music.trim() && !['recommended', 'true'].includes(music.trim())
      ? music.trim().slice(0, 20)
      : ''
    if (keyword) {
      await evalJs(page, `(() => {
        const el = document.querySelector('input[placeholder="搜索音乐"]');
        if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
      })()`)
      await sleep(300)
      await page.cmd('Input.insertText', { text: keyword })
      await sleep(2500)
    }

    const row = await findFirstMusicRow(page)
    if (!row) throw new Error(keyword ? '搜索后没有找到可用的音乐' : '推荐音乐列表里没有第一首')
    await page.cmd('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: row.x, y: row.y, button: 'none', clickCount: 0,
    }).catch(() => {})
    await sleep(700)
    let useRect = await findUseButton(page, row)
    if (!useRect) {
      // 有些版本只听 React 的 mouseover，不认 CDP 的纯移动；补一次 DOM 悬停事件。
      await evalJs(page, `(() => {
        const el = document.elementFromPoint(${row.x}, ${row.y});
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: ${row.x}, clientY: ${row.y}, view: window }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: ${row.x}, clientY: ${row.y}, view: window }));
        return true;
      })()`)
      await sleep(500)
      useRect = await findUseButton(page, row)
    }
    if (!useRect) throw new Error('鼠标移到第一首后没有出现「使用」按钮')
    await mouseClick(page, useRect.x, useRect.y)

    const selected = await waitFor(page, `(() => {
      const text = document.body.innerText || '';
      return /修改音乐/.test(text) || !document.querySelector('input[placeholder="搜索音乐"]');
    })()`, { timeoutMs: 12000 })
    if (!selected) throw new Error('点了「使用」但音乐没有选上')
    musicPicked = (row.text && row.text[0]) || keyword || '推荐第一首'
    logger.info?.(`BGM 已选：${musicPicked}`)

    // 面板若还开着，收起来别挡发布按钮。
    const panelStillOpen = await evalJs(page, `Boolean(document.querySelector('input[placeholder="搜索音乐"]'))`)
    if (panelStillOpen) {
      await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
      await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
      await sleep(800)
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

  // 发布按钮在页面底部：先滚到视口中间，等按钮可点，再取新坐标点击。
  const pubReady = await waitFor(page, `(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '发布');
    if (!btns.length) return false;
    const b = btns[btns.length - 1];
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    b.scrollIntoView({ block: 'center' });
    return !b.disabled;
  })()`, { timeoutMs: 20000 })
  if (!pubReady) throw new Error('发布按钮不可用或一直没出现')
  await sleep(800)
  const pubBtn = await evalJs(page, `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
        && r.right > 0 && r.left < window.innerWidth;
    };
    const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '发布' && visible(b));
    if (!btns.length) return { err: 'none' };
    const b = btns[btns.length - 1];
    if (b.disabled) return { err: 'disabled' };
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (!pubBtn || pubBtn.err) throw new Error(`发布按钮不可用（${pubBtn && pubBtn.err}）`)
  await mouseClick(page, pubBtn.x, pubBtn.y)

  const done = await waitFor(page, `location.href.includes('/content/manage') || /发布成功|作品已发布|已发布/.test(document.body.innerText || '')`, { timeoutMs: 60000 })
  if (!done) {
    const still = await evalJs(page, `(document.body.innerText || '').slice(0, 300)`)
    throw new Error(`点了发布但没跳转（页面：${String(still).replace(/\s+/g, ' ').slice(0, 100)}）`)
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
