// ============================================================
// 抖音私信收件箱（只读 + 回复）
//
// 结构（2026-11-12 实测）：
//   点顶部「消息」→ 右侧浮层 `.imContainer`
//   会话项 `.conversationConversationItemwrapper`（名字 / 时间 / 最后一条）
//   点会话 → 对话页，输入框 `.messageEditorinputArea`
//
// 监听用轮询（60 秒起步、空转退避），不在页面里注入任何脚本。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fromRoot } from '../../utils/paths.js'
import { captureScreenshot, closeComments, mouseClick, openVideo, readComments, readSnapshot } from './actions.js'
import { pasteClipboardImage, putImageInClipboard, prepareClipboardImage, releaseClipboardImage } from './clipboard.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export async function evalJs(page, expression) {
  try {
    const r = await page.cmd('Runtime.evaluate', { expression, returnByValue: true })
    return r && !r.exceptionDetails ? (r.result && r.result.value) : null
  } catch { return null }
}

/**
 * 页面上可能同时存在多个 `.imContainer`：一个 0×0 的隐藏缓存，一个真正展开的浮层。
 * 旧代码只取 querySelector 的第一个，结果会「明明开着却说没开」，
 * 或者读到隐藏缓存里的旧会话。这里只认真正可见、且面积最大的那个。
 */
const VISIBLE_IM_ROOT_JS = `(() => {
  const roots = [...document.querySelectorAll('.imContainer')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 200 && x.r.height > 200 && x.r.bottom > 0 && x.r.right > 0 && x.r.left < window.innerWidth)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  return roots[0] ? roots[0].el : null;
})()`

const INBOX_OPEN_JS = `(() => {
  const roots = [...document.querySelectorAll('.imContainer')];
  for (const box of roots) {
    const r = box.getBoundingClientRect();
    if (r.width > 200 && r.height > 200 && r.bottom > 0 && r.right > 0 && r.left < window.innerWidth) return 'open';
  }
  return 'closed';
})()`

async function threadViewOpen(page) {
  return await evalJs(page, `Boolean([...document.querySelectorAll('.messageEditorinputArea')].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 60 && r.height > 20 && r.bottom > 0 && r.top < window.innerHeight;
  }))`)
}

/**
 * 私信浮层有两种状态：会话列表 和 某个会话的聊天页。
 * 聊天页会盖住列表；这时直接点列表行，点到的是聊天内容，不是另一个会话，
 * 结果就是「每次都打开同一个线程」——2026-11-13 在真实面板里复现过。
 * 先点聊天页左上角的返回箭头，回到列表，再点目标会话。
 */
async function backToInbox(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await threadViewOpen(page))) return true
    const hit = await evalJs(page, `(() => {
      const root = ${VISIBLE_IM_ROOT_JS};
      if (!root) return null;
      const rr = root.getBoundingClientRect();
      const areas = [...root.querySelectorAll('[class*="StackLayoutStackTitleBarleftArea"]')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width >= 20 && x.r.width <= 60 && x.r.height >= 20 && x.r.height <= 60
          && x.r.top >= rr.top && x.r.top <= rr.top + 80 && x.r.left >= rr.left - 10
          && !(x.el.innerText || '').trim());
      if (areas.length) {
        const r = areas[0].r;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      // 不同版本没有稳定类名：聊天页左上角就是返回箭头，按面板左上角偏移兜底。
      return { x: Math.round(rr.left + 24), y: Math.round(rr.top + 23) };
    })()`)
    if (!hit) return false
    await mouseClick(page, hit.x, hit.y)
    await sleep(600)
  }
  return !(await threadViewOpen(page))
}

/** 打开右上角的消息浮层（幂等）。 */
export async function openInbox(page) {
  // 刚打开首页时是 interactive，顶栏「消息」按钮还没挂上；先等文档完成。
  for (let i = 0; i < 20; i++) {
    if (await evalJs(page, `document.readyState === 'complete' && Boolean(document.body)`) === true) break
    await sleep(400)
  }
  // 等顶栏真正挂载：readyState complete 时 React 顶栏可能还没渲染出来。
  await sleep(1200)
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await evalJs(page, INBOX_OPEN_JS) === 'open') return true
    let hit = await evalJs(page, `(() => {
      const nodes = [...document.querySelectorAll('div,span,a,button')].filter((n) => (n.innerText || '').trim() === '消息');
      const el = nodes.find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 90 && r.left > 900; });
      if (!el) return null;
      // 点图标自身，不要点它的父级按钮：父级可能横跨整个顶栏，中心会落到空白处。
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (!hit || typeof hit.x !== 'number') {
      // 兜底：不同宽度/布局下「消息」不一定在右边；也认 aria-label / title
      hit = await evalJs(page, `(() => {
        const cands = [];
        for (const n of document.querySelectorAll('[data-e2e*="message"],[aria-label*="消息"],[title*="消息"],div,span,a,button')) {
          const text = (n.innerText || '').trim();
          const label = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title') || '')) || '';
          if (text !== '消息' && !label.includes('消息')) continue;
          const r = n.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.top > 160) continue;
          cands.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height });
        }
        if (!cands.length) return null;
        cands.sort((a, b) => a.area - b.area);
        return cands[0];
      })()`)
    }
    if (hit && typeof hit.x === 'number') {
      await mouseClick(page, hit.x, hit.y)
      for (let i = 0; i < 20; i++) {
        await sleep(400)
        if (await evalJs(page, INBOX_OPEN_JS) === 'open') return true
      }
    } else {
      // 页面可能还没加载完（刚打开首页/刚从视频页回退），等一拍再找。
      await sleep(600)
    }
  }
  return false
}

/** 读会话列表：名字 / 时间 / 最后一条 / 有没有未读点。 */
export async function readInbox(page) {
  const opened = await openInbox(page)
  if (!opened) return { ok: false, reason: '打不开消息面板' }
  // 面板可能还停在上次打开的聊天页；先退回列表，否则读到的是旧线程。
  await backToInbox(page)
  // 面板刚弹出、或刚从聊天页退回列表时，列表可能先空着再渲染；
  // 等会话行真正出现再读，否则会把「还没画出来」当成「没有会话」。
  let items = []
  for (let i = 0; i < 10; i++) {
    const ready = await evalJs(page, `(() => {
      const root = ${VISIBLE_IM_ROOT_JS};
      if (!root) return { count: 0, titled: false };
      const rows = [...root.querySelectorAll('.conversationConversationItemwrapper')];
      return {
        count: rows.length,
        titled: rows.some((n) => (n.querySelector('.conversationConversationItemtitle') || {}).innerText?.trim()),
      };
    })()`)
    if (ready.count > 0 && ready.titled) break
    await sleep(500)
  }
  items = await evalJs(page, `(() => {
    const root = ${VISIBLE_IM_ROOT_JS};
    if (!root) return [];
    return [...root.querySelectorAll('.conversationConversationItemwrapper')].map((n) => {
      const t = (n.innerText || '').trim();
      const lines = t.split('\\n').map((s) => s.trim()).filter(Boolean);
      const title = (n.querySelector('.conversationConversationItemtitle') || {}).innerText || '';
      const time = (n.querySelector('.ConversationItemTagNextToTitletimeStr') || {}).innerText || '';
      const hintEl = n.querySelector('.ConversationItemHinttextBox') || n.querySelector('.ConversationItemDeschintWrapper');
      let last = hintEl ? String(hintEl.innerText || '').trim() : '';
      // 表情包/图片在列表预览里不一定有文字：保留类型，别把最后一条误判成空消息。
      const hasPic = Boolean(n.querySelector('.ConversationItemDeschintWrapper img, .ConversationItemDeschintWrapper video, .ConversationItemHintHint img, .ConversationItemHintHint video'));
      if (!last && hasPic) last = '[\u8868\u60c5\u5305/\u56fe\u7247]';
      if (!last) last = lines[2] || '';
      // 抖音的会话列表对图片/表情包只显示文字占位（[图片]、[表情包]），
      // 没有 img 节点；这类也要算媒体，否则排队时会被当成普通文本。
      const mediaText = /\\[(?:图片|表情包|表情|动画表情|视频)\\]|分享\\[视频\\]/.test(last);
      const mediaHint = Boolean(hasPic || mediaText);
      // 纯表情包/视频封面的预览文字可能永远一样；带上预览图的地址，
      // 让「同一人连发两张不同表情包」也能各自入队，而不是被 |last 去重吃掉。
      const mediaKey = [...n.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.getAttribute('src') || '')
        .filter((src) => src && !/avatar/i.test(src))
        .join('|');
      const dot = Boolean(n.querySelector('[class*="badge"],[class*="Badge"],[class*="unread"],[class*="Unread"],[class*="redDot"]'));
      return {
        name: (title || lines[0] || '').trim(),
        time: (time || lines[1] || '').trim(),
        last,
        mediaHint: mediaHint,
        mediaKey,
        unread: dot,
        raw: t.slice(0, 300),
      };
    }).filter((x) => x.name);
  })()`) || []
  return { ok: true, items }
}

/** 点开某个人的会话（按名字匹配）。
 *
 * 只认命中的会话，**绝不兜底到列表第一条**：模型给的名字对不上页面时，
 * 兜底会把私信发给最近聊过的陌生人，发出去收不回来。
 * 返回 { ok, name }，name 是页面上真实命中的名字，调用方可以复核。
 */
export async function openThread(page, name) {
  const opened = await openInbox(page)
  if (!opened) return { ok: false, reason: '打不开消息面板' }
  const target = String(name || '').trim()
  if (!target) return { ok: false, reason: '没给会话名字' }
  // 聊天页会盖住会话列表；不先返回列表，点击会落进当前聊天内容里。
  if (!(await backToInbox(page))) return { ok: false, reason: '退不回会话列表' }
  const found = await evalJs(page, `(() => {
    const target = ${JSON.stringify(target)};
    const root = ${VISIBLE_IM_ROOT_JS};
    if (!root) return { ok: false, reason: '找不到可见的会话列表' };
    const items = [...root.querySelectorAll('.conversationConversationItemwrapper')];
    const nameOf = (n) => ((n.querySelector('.conversationConversationItemtitle') || {}).innerText || '').split('\\n')[0].trim()
      || ((n.innerText || '').split('\\n')[0] || '').trim();
    // 先精确同名，再包含匹配；都没有就报错，不点第一条
    let hit = items.find((n) => nameOf(n) === target);
    if (!hit) {
      const loose = items.filter((n) => nameOf(n).includes(target));
      if (loose.length !== 1) return { ok: false, reason: '找不到唯一匹配的会话' };
      hit = loose[0];
    }
    // 列表很长时目标可能在滚动区外：先滚到中间，再重新算坐标
    try { hit.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* 忽略 */ }
    return { ok: true, name: nameOf(hit) };
  })()`)
  if (!found || !found.ok) return { ok: false, reason: (found && found.reason) || '点不开会话' }
  await sleep(250)
  const clicked = await evalJs(page, `(() => {
    const target = ${JSON.stringify(found.name)};
    const root = ${VISIBLE_IM_ROOT_JS};
    if (!root) return { ok: false, reason: '会话列表不见了' };
    const items = [...root.querySelectorAll('.conversationConversationItemwrapper')];
    const nameOf = (n) => ((n.querySelector('.conversationConversationItemtitle') || {}).innerText || '').split('\\n')[0].trim()
      || ((n.innerText || '').split('\\n')[0] || '').trim();
    const hit = items.find((n) => nameOf(n) === target);
    if (!hit) return { ok: false, reason: '会话在滚动后不见了' };
    const r = hit.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, reason: '会话不在可见区域' };
    return {
      ok: true,
      name: target,
      x: Math.round(r.left + Math.min(r.width / 2, 200)),
      y: Math.round(r.top + Math.min(r.height / 2, 34)),
    };
  })()`)
  if (!clicked || !clicked.ok) return { ok: false, reason: (clicked && clicked.reason) || '点不开会话' }
  if (typeof clicked.x === 'number') await mouseClick(page, clicked.x, clicked.y)
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    const ready = await evalJs(page, `(() => {
      const ed = document.querySelector('.messageEditorinputArea');
      if (!ed) return false;
      const r = ed.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`)
    if (!ready) continue
    // 点会话后必须核对聊天页标题。列表被盖住时旧代码会「点进聊天内容里」，
    // 输入框照样存在，但线程没切换；不核对就会把回复发给错误的人。
    const header = await evalJs(page, `(() => {
      const nodes = [...document.querySelectorAll('.StackLayoutStackChatHeadertitle')]
        .map((n) => ({ text: (n.innerText || '').trim(), r: n.getBoundingClientRect() }))
        .filter((x) => x.text && x.r.width > 0 && x.r.height > 0);
      return nodes.length ? nodes[0].text : '';
    })()`)
    if (!header) return { ok: false, reason: '聊天页标题没出来，无法确认点对了人' }
    if (header !== clicked.name) return { ok: false, reason: `聊天页标题是「${header}」，不是「${clicked.name}」` }
    return { ok: true, name: header }
  }
  return { ok: false, reason: '会话打开了但输入框没出来' }
}

/** 在已打开的会话里发一条消息。 */
export async function sendInThread(page, text) {
  const box = await evalJs(page, `(() => {
    const el = document.querySelector('.messageEditorinputArea');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
  })()`)
  if (!box) return { ok: false, reason: '找不到私信输入框' }
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 }).catch(() => {})
  await sleep(120)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(80)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(400)
  await page.cmd('Input.insertText', { text })
  await sleep(500)
  const typed = await evalJs(page, `(() => { const e = document.querySelector('.messageEditorinputArea'); return e ? e.innerText : '' })()`)
  if (!String(typed || '').trim()) return { ok: false, reason: '字没进输入框' }
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }).catch(() => {})
  await sleep(1500)
  return { ok: true }
}

/** 回复某个人：打开消息面板 → 点会话 → 发消息。 */
export async function replyTo(page, name, text) {
  const opened = await openThread(page, name)
  if (!opened.ok) return { ok: false, reason: opened.reason || `打不开「${name}」的会话` }
  return await sendInThread(page, text)
}

/** 收起消息浮层，别挡住刷视频。 */
export async function closeInbox(page) {
  const open = await evalJs(page, INBOX_OPEN_JS)
  if (open !== 'open') return
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  await sleep(400)
}

// ---- 发表情包（学 dsh-meme 的精华：私信里发一张图）----

const STICKER_ROOTS = [fromRoot('data/stickers'), fromRoot('data/images')].map((p) => path.resolve(p))
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const MAX_STICKER_BYTES = 8 * 1024 * 1024

/**
 * 模型给的路径一律收敛到 data/stickers、data/images 里。
 * 这是「任意本地图片 → 发到私信」的唯一入口，不收敛就等于给了模型一条外发本机文件的通道。
 * @returns {string} 可用的绝对路径；不合法返回空串
 */
export function resolveStickerFile(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let abs
  try {
    abs = path.resolve(fromRoot(raw))
  } catch {
    return ''
  }
  if (!IMAGE_EXT.test(abs)) return ''
  if (!STICKER_ROOTS.some((root) => abs.startsWith(root + path.sep))) return ''
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size === 0 || st.size > MAX_STICKER_BYTES) return ''
  } catch {
    return ''
  }
  return abs
}

/** 在已打开的会话里发一张图（剪贴板 → 粘贴 → 发送确认框）。 */
export async function sendStickerInThread(page, file) {
  const safeFile = resolveStickerFile(file)
  if (!safeFile) return { ok: false, reason: '图片路径不在允许的目录里（只收 data/stickers、data/images）' }
  const box = await evalJs(page, `(() => {
    const el = document.querySelector('.messageEditorinputArea');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
  })()`)
  if (!box) return { ok: false, reason: '找不到私信输入框' }
  let prepared = { file: safeFile, temp: false }
  try {
    // WebP/AVIF 不能直接进 Windows 剪贴板：先借浏览器画成 PNG 再放。
    prepared = await prepareClipboardImage(page, safeFile)
    putImageInClipboard(prepared.file)
  } catch (err) {
    releaseClipboardImage(prepared)
    return { ok: false, reason: `剪贴板放图失败：${err.message}` }
  }
  releaseClipboardImage(prepared)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 }).catch(() => {})
  await sleep(120)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(80)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {})
  await sleep(500)
  await pasteClipboardImage(page, { waitMs: 2600 })
  const sendBtn = await evalJs(page, `(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /^发送/.test((b.innerText || '').trim()) && b.offsetParent !== null);
    if (!btns.length) return null;
    const b = btns[btns.length - 1];
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (sendBtn && typeof sendBtn.x === 'number') await mouseClick(page, sendBtn.x, sendBtn.y)
  await sleep(2200)
  return { ok: Boolean(sendBtn), reason: sendBtn ? '' : '粘贴后没出现发送按钮（可能图片没进剪贴板）' }
}

/* ------------------------------------------------------------------
 * 私信消息的结构化读取
 *
 * 实测（2026-11-13）：
 *   - 真正展开的浮层和 0×0 的隐藏缓存都叫 .imContainer，必须只认可见的那个；
 *   - 一条消息是 .messageMessageListlist 下带 data-index 的直接子项；
 *   - 文字：.TextMessageTextpureText
 *   - 表情包：.MessageItemEmojiemojiBox / .MessageItemEmojiimage
 *   - 图片：.MessageItemImageImageBox / .MessageItemImageImage
 *   - 自己发的：.MessageBoxContentisFromMe
 *
 * 以前只取整段 innerText，既分不清谁说的，也读不到表情和卡片。这里先把每条
 * 消息拆成结构化对象，再由 dm-auto 决定要不要看图/打开视频。
 * ------------------------------------------------------------------ */

const THREAD_SNAPSHOT_JS = `(() => {
  const roots = [...document.querySelectorAll('.messageMessageListwrapper')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 150 && x.r.height > 80 && x.r.bottom > 0 && x.r.top < window.innerHeight)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  const root = roots[0] ? roots[0].el : null;
  if (!root) return null;
  const list = root.querySelector('.messageMessageListlist') || root;
  const nodes = [...list.children].filter((el) => el.hasAttribute('data-index'));
  const messages = nodes.map((el) => {
    const content = el.querySelector('[data-e2e="msg-item-content"]')
      || el.querySelector('.MessageBoxContentactiveClickArea')
      || el.querySelector('.MessageBoxContentcolumnBox');
    if (!content) return null;
    // 自己发的消息：不同版本、不同消息类型（文字/图片/表情包）的标记位置不一样。
    // 不能只看 el.querySelector：标记可能就在 el/content 本身，也可能在更外层。
    const ownByClass = Boolean(
      el.matches('.MessageBoxContentisFromMe, .messageMessageBoxisFromMe') ||
      content.matches('.MessageBoxContentisFromMe, .messageMessageBoxisFromMe') ||
      content.closest('.MessageBoxContentisFromMe, .messageMessageBoxisFromMe') ||
      el.querySelector('.MessageBoxContentisFromMe, .messageMessageBoxisFromMe') ||
      el.closest('.MessageBoxContentisFromMe, .messageMessageBoxisFromMe')
    );
    const text = [...content.querySelectorAll('.TextMessageTextpureText')]
      .map((x) => (x.innerText || x.textContent || '').trim())
      .filter(Boolean)
      .join('');
    const emojiEl = content.querySelector('.MessageItemEmojiemojiBox, .MessageItemEmojiimage');
    const imageEl = content.querySelector('.MessageItemImageImageBox, .MessageItemImageImage');
    const videoEl = content.querySelector('video');
    const classText = [content, ...content.querySelectorAll('*')]
      .map((x) => (typeof x.className === 'string' ? x.className : ''))
      .join(' ');
    const links = [...content.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => h && /^https?:\\/\\/|^\\//.test(h));
    let cardHref = links.find((h) => /\\/(?:share\\/)?video\\/|\\/note\\/|aweme_id=/i.test(h)) || '';
    // 有的卡片没有 a 标签，只在 data-* 属性里放视频地址/id；宁可读不到也不要猜。
    if (!cardHref) {
      for (const node of content.querySelectorAll('*')) {
        for (const attr of node.attributes || []) {
          const v = String(attr.value || '');
          if (/\\/(?:share\\/)?video\\/\\d+|aweme_id=\\d+/i.test(v)) { cardHref = v; break; }
        }
        if (cardHref) break;
      }
    }
    const videoId = (cardHref.match(/(?:video|note)\\/(\\d+)/) || cardHref.match(/aweme_id=(\\d+)/) || [])[1] || '';
    const hasEmoji = Boolean(emojiEl) || /MessageItemEmoji/i.test(classText);
    const hasImage = Boolean(imageEl) || /MessageItemImage/i.test(classText);
    const hasVideo = Boolean(videoEl) || cardHref.includes('/video/') || cardHref.includes('/note/') || /MessageItem(?:Video|Share)|ShareCard|VideoCard/i.test(classText);
    const kind = hasEmoji ? 'emoji' : hasImage ? 'image' : hasVideo ? 'video' : text ? 'text' : 'other';
    // 卡片的可读标题通常就在内容区；不要用整条消息的 innerText，避免把时间戳带进去。
    const cardText = kind === 'video' ? (content.innerText || '').trim() : '';
    const target = emojiEl || imageEl || videoEl
      || (kind === 'video' ? (content.querySelector('img') || content) : content);
    const tr = target ? target.getBoundingClientRect() : null;
    const listRect = list.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    // 有些图片/表情包消息没有 isFromMe 类，只能按气泡落在左半边还是右半边判断。
    // 图片元素可能还没加载出尺寸，这时退回内容区的位置，不要直接当成对方消息。
    const alignRect = tr && tr.width > 0 && tr.height > 0 ? tr : contentRect;
    const rightSide = Boolean(alignRect && listRect.width > 0
      && alignRect.left + alignRect.width / 2 > listRect.left + listRect.width * 0.58);
    const fromMe = ownByClass || rightSide;
    const ir = content.querySelector('img') ? content.querySelector('img').getBoundingClientRect() : null;
    return {
      index: Number(el.getAttribute('data-index')),
      fromMe,
      fromMeBy: ownByClass ? 'class' : (rightSide ? 'geometry' : 'none'),
      kind,
      text: text.slice(0, 300),
      cardTitle: cardText.slice(0, 240),
      href: cardHref,
      videoId,
      rect: tr ? [Math.round(tr.left), Math.round(tr.top), Math.round(tr.width), Math.round(tr.height)] : null,
      thumbRect: ir ? [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)] : null,
    };
  }).filter(Boolean);
  // 列表是 column-reverse：data-index 越小越新。转成时间正序，方便拼上下文。
  messages.sort((a, b) => Number(b.index) - Number(a.index));
  return { messages, viewport: { width: window.innerWidth, height: window.innerHeight } };
})()`

function clampRect(rect, viewport) {
  if (!Array.isArray(rect) || rect.length < 4) return null
  const [left, top, width, height] = rect.map(Number)
  if (![left, top, width, height].every(Number.isFinite) || width < 20 || height < 20) return null
  const x = Math.max(0, Math.floor(left))
  const y = Math.max(0, Math.floor(top))
  const w = Math.min(Math.ceil(width), Math.max(0, Math.floor(viewport.width - x)))
  const h = Math.min(Math.ceil(height), Math.max(0, Math.floor(viewport.height - y)))
  if (w < 20 || h < 20) return null
  // 元素滚出视口时 CDP 会截出一块黑底，宁可不截，也不能把黑图当成表情包。
  const visibleW = Math.max(0, Math.min(left + width, viewport.width) - Math.max(left, 0))
  const visibleH = Math.max(0, Math.min(top + height, viewport.height) - Math.max(top, 0))
  if (visibleW < 20 || visibleH < 20) return null
  if (visibleW * visibleH < width * height * 0.35) return null
  return { x, y, width: w, height: h }
}

async function captureElement(page, rect, viewport, { quality = 58 } = {}) {
  const clip = clampRect(rect, viewport)
  if (!clip) return null
  const shot = await captureScreenshot(page, { format: 'jpeg', quality, clip })
  if (!shot || !shot.ok || !shot.data) return null
  return { data: shot.data, mimeType: shot.mimeType || 'image/jpeg' }
}

/**
 * 长会话里，媒体消息可能在可视区上方。先滚到中间再取坐标，
 * 否则 CDP 会截到面板外的黑底（2026-11-13 实测踩过）。
 */
async function focusMessage(page, index, kind) {
  const scrolled = await evalJs(page, `(() => {
    const idx = ${JSON.stringify(String(index))};
    const lists = [...document.querySelectorAll('.messageMessageListlist')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 150 && x.r.height > 80)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const list = lists[0] && lists[0].el;
    if (!list) return null;
    const item = list.querySelector('[data-index="' + idx + '"]');
    if (!item) return null;
    try { item.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    return true;
  })()`)
  if (!scrolled) return null
  await sleep(320)
  return await evalJs(page, `(() => {
    const idx = ${JSON.stringify(String(index))};
    const lists = [...document.querySelectorAll('.messageMessageListlist')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 150 && x.r.height > 80)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const list = lists[0] && lists[0].el;
    const item = list && list.querySelector('[data-index="' + idx + '"]');
    if (!item) return null;
    const content = item.querySelector('[data-e2e="msg-item-content"]')
      || item.querySelector('.MessageBoxContentactiveClickArea')
      || item.querySelector('.MessageBoxContentcolumnBox');
    if (!content) return null;
    const kind = ${JSON.stringify(kind)};
    const target = kind === 'emoji'
      ? content.querySelector('.MessageItemEmojiemojiBox, .MessageItemEmojiimage')
      : kind === 'image'
        ? content.querySelector('.MessageItemImageImageBox, .MessageItemImageImage')
        : (content.querySelector('img') || content);
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`)
}

/** 在当前视频页按比例跳到不同位置，各截一帧；不依赖视频正在播放。
 * scopeSelector 用于弹窗：只截 `.modal-video-container` 里的视频，
 * 否则会选到弹窗背后推荐流的 video，或者选到同一个弹窗里已经滚出去的旧视频。
 */
async function captureSeekFrames(page, count = 2, { scopeSelector = '' } = {}) {
  const info = await evalJs(page, `(() => {
    const root = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'};
    if (!root) return null;
    const vids = [...root.querySelectorAll('video')]
      .map((v) => ({ v, r: v.getBoundingClientRect() }))
      .filter((x) => x.r.width > 100 && x.r.height > 100
        && x.r.top >= 0 && x.r.bottom > 0 && x.r.left < window.innerWidth && x.r.right > 0)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const v = vids[0] ? vids[0].v : null;
    if (!v) return null;
    return {
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      rect: [Math.round(vids[0].r.left), Math.round(vids[0].r.top), Math.round(vids[0].r.width), Math.round(vids[0].r.height)],
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`)
  if (!info || !info.rect) return { ok: false, reason: '视频页里没有可截的视频画面' }
  const frames = []
  const ratios = count >= 2 ? [0.18, 0.55] : [0.3]
  for (const ratio of ratios) {
    if (info.duration > 1.5) {
      await evalJs(page, `(() => {
        const root = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'};
        if (!root) return false;
        const vids = [...root.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() }))
          .filter((x) => x.r.width > 100 && x.r.height > 100
            && x.r.top >= 0 && x.r.bottom > 0 && x.r.left < window.innerWidth && x.r.right > 0)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        const v = vids[0] && vids[0].v;
        if (!v) return false;
        try { v.pause(); v.currentTime = Math.max(0, Math.min(v.duration - 0.25, v.duration * ${ratio})); } catch {}
        return true;
      })()`)
      await sleep(700)
    }
    const shot = await captureElement(page, info.rect, info.viewport, { quality: 55 })
    if (shot) frames.push(shot)
  }
  if (!frames.length) return { ok: false, reason: '视频画面没截到' }
  return { ok: true, frames }
}

/** 点开私信里的分享卡片。抖音现在有两种打开方式：
 *  - 老卡片带 /video/{id} 链接，导航到视频详情页；
 *  - 新卡片没有链接，点一下在当前页盖一层 `modal_id=...` 的视频弹窗。
 * 这里统一先尝试点卡片，成功后再从弹窗里读文案/评论/画面。
 */
async function openSharedCardModal(page, card) {
  const focused = await focusMessage(page, card.index, 'video')
  const rect = (focused && focused.rect) || card.thumbRect
  if (!rect) return { ok: false, reason: '找不到视频卡片的可点区域' }
  const x = Math.round(rect[0] + rect[2] / 2)
  const y = Math.round(rect[1] + rect[3] / 2)
  await mouseClick(page, x, y)
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    const state = await evalJs(page, `(() => {
      const root = document.querySelector('.modal-video-container');
      if (!root) return null;
      const r = root.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) return null;
      const id = new URLSearchParams(location.search).get('modal_id') || '';
      return { id, href: location.href };
    })()`)
    if (state) return { ok: true, ...state }
  }
  return { ok: false, reason: '点卡片后没有出现视频弹窗' }
}

/** 从卡片弹窗里读当前视频的 id / 作者 / 文案。不要用 readSnapshot：
 * 它读的是弹窗背后正在播的推荐流，会把别人的视频当成分享的视频（实测踩过）。
 */
async function readModalVideoInfo(page) {
  return await evalJs(page, `(() => {
    const root = document.querySelector('.modal-video-container');
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const players = [...root.querySelectorAll('[class*="modalPlayer"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 300 && x.r.height > 300 && x.r.top >= 0 && x.r.bottom > 0);
    const player = players.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    const modalRight = player ? player.r.right : rr.right;
    const infos = [...root.querySelectorAll('.video-info-detail')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 100 && x.r.height > 20 && x.r.top >= 0 && x.r.top < window.innerHeight
        && x.r.left < modalRight && x.r.right <= modalRight + 20)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const info = infos[0] ? infos[0].el : null;
    const authorEl = info && info.querySelector('.account-name-text, [class*="account-name"]');
    const capEl = info && (info.querySelector('.title.cursorPointer .UR5VrIl6') || info.querySelector('.title.cursorPointer'));
    const caption = capEl ? (capEl.innerText || '').trim().split('\\n')[0].trim().slice(0, 260) : '';
    const author = authorEl ? (authorEl.innerText || '').trim().replace(/^@/, '').slice(0, 80) : '';
    const modalId = new URLSearchParams(location.search).get('modal_id') || '';
    const vids = [...root.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() }))
      .filter((x) => x.r.width > 200 && x.r.height > 200 && x.r.top >= 0)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    return { modalId, author, caption, duration: Number(vids[0] && vids[0].v.duration) || 0, hasVideo: Boolean(vids[0]) };
  })()`)
}

/** 点开弹窗里的评论入口，读前 N 条。评论只是外部文本，后续统一过注入过滤。 */
async function readModalComments(page, limit = 5) {
  const icon = await evalJs(page, `(() => {
    const root = document.querySelector('.modal-video-container');
    if (!root) return null;
    const icons = [...root.querySelectorAll('[data-e2e="feed-comment-icon"],[data-e2e="video-comment-icon"],[data-e2e="comment-icon"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 20 && x.r.height > 20 && x.r.top > 0 && x.r.bottom < window.innerHeight
        && x.r.left > 0 && x.r.right <= window.innerWidth);
    // 弹窗打开时，底层推荐流的评论图标也在 DOM 里但被盖住；用 elementFromPoint 只认最上层那个。
    const top = icons.filter((x) => {
      const at = document.elementFromPoint(x.r.left + x.r.width / 2, x.r.top + x.r.height / 2);
      return at && (at === x.el || x.el.contains(at));
    });
    const hit = (top.length ? top : icons).sort((a, b) => b.r.top - a.r.top)[0];
    if (!hit) return null;
    return { x: Math.round(hit.r.left + hit.r.width / 2), y: Math.round(hit.r.top + hit.r.height / 2) };
  })()`)
  if (!icon) return { ok: false, reason: '弹窗里找不到评论入口' }
  await mouseClick(page, icon.x, icon.y)
  let comments = []
  for (let i = 0; i < 6; i++) {
    await sleep(500)
    comments = await evalJs(page, `(() => {
      const list = document.querySelector('[data-e2e="comment-list"]');
      if (!list) return [];
      const lr = list.getBoundingClientRect();
      if (lr.width <= 0 || lr.height <= 0) return [];
      const items = [...list.querySelectorAll('[data-e2e="comment-item"], .comment-item')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width > 80 && x.r.height > 20 && x.r.top >= Math.max(0, lr.top)
          && x.r.top < window.innerHeight && x.r.bottom > 0)
        .sort((a, b) => a.r.top - b.r.top)
        .slice(0, ${JSON.stringify(Math.max(1, limit))});
      return items.map((x) => {
        const lines = (x.el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
        const author = lines[0] || '';
        let likes = '';
        const body = [];
        const more = lines.indexOf('...');
        for (let i = more >= 0 ? more + 1 : 1; i < lines.length; i++) {
          const line = lines[i];
          if (/^(分享|回复|作者|置顶|加载中|展开\\d*条回复)$/.test(line)) break;
          if (/^\\d+\\s*(?:月|天|周|年|小时|分钟)前/.test(line) || /·/.test(line)) continue;
          if (/^(\\d+(?:\\.\\d+)?(?:万|w)?)$/i.test(line)) { likes = line; break; }
          body.push(line);
        }
        return { author: author.slice(0, 40), text: body.join(' ').trim().slice(0, 120), likes: likes.slice(0, 20) };
      }).filter((c) => c.text);
    })()`) || []
    if (comments.length) break
  }
  return { ok: comments.length > 0, comments, reason: comments.length ? '' : '评论面板打开了但没读到评论' }
}

/** 没有 /video/ 链接的新式分享卡片：点开弹窗，读文案、评论、画面，再回到原页面。 */
async function analyzeSharedVideoModal(page, card, { logger = console } = {}) {
  const originalUrl = await evalJs(page, 'location.href') || 'https://www.douyin.com/'
  const out = { status: 'ready', url: '', videoId: '', title: String(card.cardTitle || '').trim(), caption: '', author: '', comments: [], frames: [] }
  try {
    const opened = await openSharedCardModal(page, card)
    if (!opened.ok) {
      out.status = 'failed'
      out.reason = opened.reason || '点不开视频卡片'
      return out
    }
    await sleep(1800)
    const info = await readModalVideoInfo(page)
    if (!info) {
      out.status = 'failed'
      out.reason = '弹窗打开了但没读到视频信息'
      return out
    }
    out.videoId = String(info.modalId || '').trim()
    if (out.videoId) out.url = `https://www.douyin.com/video/${out.videoId}`
    out.caption = String(info.caption || '').trim().slice(0, 240)
    out.author = String(info.author || '').trim().slice(0, 80)
    if (out.caption) out.title = out.caption
    const vf = await captureSeekFrames(page, 2, { scopeSelector: '.modal-video-container' })
    if (vf.ok) out.frames = vf.frames
    else out.visualReason = vf.reason || '视频画面没截到'
    const rc = await readModalComments(page, 5)
    out.comments = rc && rc.ok ? (rc.comments || []).map((c) => ({
      author: String(c.author || '').trim().slice(0, 40),
      text: String(c.text || '').trim().slice(0, 120),
      likes: String(c.likes || '').trim().slice(0, 20),
    })).filter((c) => c.text) : []
    if (!rc.ok && rc.reason) out.commentsReason = rc.reason
    logger.info?.(`私信媒体：已打开分享卡片弹窗，读到「${out.caption || out.title || out.videoId}」、${out.comments.length} 条评论、${out.frames.length} 帧画面`)
  } catch (err) {
    out.status = 'failed'
    out.reason = `视频卡片读取失败：${err.message}`
  } finally {
    // 不管弹窗有没有正常关掉，都导航回原页面；下一次轮询不能在弹窗/视频页上。
    try {
      await page.cmd('Page.navigate', { url: originalUrl }).catch(() => {})
      await sleep(2200)
    } catch { /* 忽略 */ }
  }
  return out
}

/** 打开分享卡片对应的视频页，读文案/评论/画面，再尽量回到原页面。 */
async function analyzeSharedVideo(page, card, { logger = console } = {}) {
  const rawHref = String(card.href || '').trim()
  let url = ''
  if (/^https?:\/\//i.test(rawHref)) url = rawHref
  else if (rawHref.startsWith('/')) url = `https://www.douyin.com${rawHref}`
  else if (card.videoId) url = `https://www.douyin.com/video/${card.videoId}`
  if (!url) return await analyzeSharedVideoModal(page, card, { logger })

  const originalUrl = await evalJs(page, 'location.href') || 'https://www.douyin.com/'
  const out = { status: 'ready', url, title: String(card.cardTitle || '').trim(), caption: '', author: '', comments: [], frames: [] }
  try {
    await openVideo(page, url)
    await sleep(2200)
    const snap = await readSnapshot(page)
    if (!snap) {
      out.status = 'failed'
      out.reason = '视频页没有读到内容（可能被登录/验证挡住，或页面不是视频详情）'
      return out
    }
    out.videoId = snap.id || card.videoId || ''
    out.caption = String(snap.caption || '').trim().slice(0, 240)
    out.author = String(snap.author || '').trim().slice(0, 80)
    if (!out.title) out.title = out.caption
    // 评论区是外部不可信文本；这里只读前 5 条，dm-auto 会再过 sanitizeInput/detectInjection。
    const rc = await readComments(page, 5).catch(() => ({ ok: false, comments: [] }))
    out.comments = rc && rc.ok ? (rc.comments || []).map((c) => ({
      author: String(c.author || '').trim().slice(0, 40),
      text: String(c.text || '').trim().slice(0, 120),
      likes: String(c.likes || '').trim().slice(0, 20),
    })).filter((c) => c.text) : []
    try { await closeComments(page) } catch { /* 忽略 */ }
    const vf = await captureSeekFrames(page, 2)
    if (vf.ok) out.frames = vf.frames
    else out.visualReason = vf.reason || '视频画面没截到'
    logger.info?.(`私信媒体：已打开分享视频并读取 ${out.comments.length} 条评论、${out.frames.length} 帧画面`)
  } catch (err) {
    out.status = 'failed'
    out.reason = `视频读取失败：${err.message}`
  } finally {
    // 监听标签页必须回到原来的页面，不能让下一次私信轮询落在一个视频详情页上。
    try {
      await page.cmd('Page.navigate', { url: originalUrl }).catch(() => {})
      await sleep(2200)
    } catch { /* 忽略 */ }
  }
  return out
}

function mediaLabel(kind) {
  return kind === 'emoji' ? '表情包' : kind === 'image' ? '图片' : kind === 'video' ? '视频卡片' : '内容'
}

/**
 * 点进会话，读结构化消息 + 最近一条对方媒体。
 * 返回 text（兼容旧调用）和 messages/media（新链路使用）。
 */
export async function peekThread(page, name, { analyzeVideo = true, logger = console, mediaWindow = 'sinceMine', includeMine = false } = {}) {
  const opened = await openThread(page, name)
  if (!opened || !opened.ok) return { ok: false, reason: (opened && opened.reason) || '打不开会话' }
  await sleep(1500)
  const snap = await evalJs(page, THREAD_SNAPSHOT_JS)
  let messages = Array.isArray(snap && snap.messages) ? snap.messages : []
  const viewport = (snap && snap.viewport) || { width: 1280, height: 800 }
  const media = { images: [], video: null, text: '' }
  try {
    // 只处理「最近一波对方消息」里的媒体：从最后一条自己发出的消息之后开始。
    // mediaWindow='all' 只给自测用，避免把已经回过的旧表情包当成新消息再理解一次。
    const lastMine = messages.map((m) => m.fromMe).lastIndexOf(true)
    const pool = mediaWindow === 'all' ? messages : messages.slice(lastMine + 1)
    const recent = includeMine ? pool : pool.filter((m) => !m.fromMe)
    const mediaCandidates = recent.filter((m) => m.kind === 'emoji' || m.kind === 'image' || m.kind === 'video')
    for (const item of mediaCandidates.slice(-3).reverse()) {
      if ((item.kind === 'emoji' || item.kind === 'image') && media.images.length < 3) {
        const focused = await focusMessage(page, item.index, item.kind)
        const shot = await captureElement(page, (focused && focused.rect) || item.rect || item.thumbRect, (focused && focused.viewport) || viewport, { quality: 62 })
        if (shot) media.images.push({ ...shot, kind: item.kind, label: mediaLabel(item.kind) })
      }
      if (item.kind === 'video' && !media.video) {
        // 卡片先留一张封面：视频页的帧失败了，至少还能看懂它分享的是什么。
        if (item.thumbRect) {
          const focused = await focusMessage(page, item.index, 'video')
          const thumb = await captureElement(page, (focused && focused.rect) || item.thumbRect, (focused && focused.viewport) || viewport, { quality: 55 })
          if (thumb) media.images.push({ ...thumb, kind: 'video-thumb', label: '视频封面' })
        }
        if (analyzeVideo) media.video = await analyzeSharedVideo(page, item, { logger })
        else media.video = { status: 'skipped', reason: '这次没有打开视频', title: item.cardTitle || '' }
      }
    }
    if (media.video) {
      // 标题和文案经常是同一句，去重后再拼评论，省 prompt 字数。
      const lines = [];
      const seen = new Set();
      for (const line of [media.video.title, media.video.caption, ...(media.video.comments || []).map((c) => `${c.author}：${c.text}`)]) {
        const s = String(line || '').trim();
        const key = s.replace(/\s+/g, '');
        if (key && !seen.has(key)) { seen.add(key); lines.push(s); }
      }
      media.text = lines.join('\n').slice(0, 1200);
    }
    const labels = { emoji: '表情包', image: '图片', video: '分享视频', other: '非文字消息' }
    const transcript = messages.map((m) => {
      const who = m.fromMe ? '我' : '对方'
      const body = m.text || (labels[m.kind] ? `[${labels[m.kind]}]` : '')
      return body ? `${who}：${body}` : ''
    }).filter(Boolean).join('\n').slice(-800)
    return { ok: true, text: transcript, messages, media }
  } finally {
    // 读完就收起浮层；如果已经导航到视频页，回到首页后浮层本来就不在。
    try { await closeInbox(page) } catch { /* 忽略 */ }
  }
}

/** 兼容旧调用：只返回文本。 */
export async function peekThreadText(page, name) {
  const r = await peekThread(page, name)
  return r && r.ok ? { ok: true, text: r.text } : r
}
/** 给某个人发一张表情包：打开会话 → 粘贴图 → 发送。 */
export async function sendStickerTo(page, name, file) {
  const opened = await openThread(page, name)
  if (!opened.ok) return { ok: false, reason: opened.reason || `打不开「${name}」的会话` }
  return await sendStickerInThread(page, file)
}
