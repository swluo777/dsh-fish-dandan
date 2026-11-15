// ============================================================
// 抖音网页里的「手」：读当前视频、读评论、点赞/收藏/评论/回复/转发/私信。
//
// 原则：
// - 所有动作都走真实页面点击/输入，不碰逆向接口；
// - 每个动作都返回 { ok, reason }，失败就如实记录，不重试、不硬猜；
// - 选择器集中在这里，抖音改版只需要改这一个文件；
// - 评论/回复/转发/私信由它自己判断后调用，本模块只负责「怎么做」，不判断该不该做。
// ============================================================

// 评论图片走输入框右侧图片按钮的隐藏 input；私信剪贴板粘贴在 inbox.js 里。

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function evaluate(page, expression, fallback = null) {
  try {
    const r = await page.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r && r.result ? r.result.value : fallback
  } catch {
    return fallback
  }
}

const CAPTION_SEL = ['[data-e2e="video-desc"]', '[data-e2e="video-desc"] span', '[data-e2e="video-title"]', '.video-info-detail']
// feed-video-nickname 是推荐页（全屏播放器）的作者，video-author-name 是视频详情页的
const AUTHOR_SEL = ['[data-e2e="video-author-name"]', '[data-e2e="feed-video-nickname"]', '[data-e2e="user-name"]', 'a[href*="/user/"] span']
const LIKE_CNT = ['[data-e2e="video-like-count"]', '[data-e2e="like-count"]', '[data-e2e="video-player-digg"]']
const COMMENT_CNT = ['[data-e2e="video-comment-count"]', '[data-e2e="comment-count"]', '[data-e2e="feed-comment-icon"]']
const COLLECT_CNT = ['[data-e2e="video-collect-count"]', '[data-e2e="collect-count"]', '[data-e2e="video-player-collect"]']
const SHARE_CNT = ['[data-e2e="video-share-count"]', '[data-e2e="share-count"]', '[data-e2e="video-player-share"]']

/** 推荐页全屏播放器把当前视频 id 放在 feed-active-video 的 data-e2e-vid / class video_<id> 上。 */
const ACTIVE_VIDEO_ID_JS = `(() => {
  const feed = document.querySelector('[data-e2e="feed-active-video"]');
  const fromFeed = feed ? (feed.getAttribute('data-e2e-vid') || (String(feed.className || '').match(/video_(\\d+)/) || [])[1] || '') : '';
  const m = (location.pathname || '').match(/\\/video\\/(\\d+)/);
  const modal = new URLSearchParams(location.search || '').get('modal_id') || '';
  return (m && m[1]) || modal || fromFeed || '';
})()`

const SNAPSHOT_JS = `(() => {
  const pick = (root, sels, reject) => { for (const s of sels) { for (const el of root.querySelectorAll(s)) { const t = (el.innerText || el.textContent || '').trim(); if (t && !(reject && reject.test(t))) return t } } return '' };
  const feed = document.querySelector('[data-e2e="feed-active-video"]');
  // 推荐页同一时刻 DOM 里有多条 feed-item，必须锁在正在播的那条里读，否则读到上一条
  const scope = feed ? (feed.closest('[data-e2e="feed-item"]') || feed.parentElement || document) : document;
  const fromFeed = feed ? (feed.getAttribute('data-e2e-vid') || (String(feed.className || '').match(/video_(\\d+)/) || [])[1] || '') : '';
  const m = (location.pathname || '').match(/\\/video\\/(\\d+)/);
  const modal = new URLSearchParams(location.search || '').get('modal_id') || '';
  const items = [...document.querySelectorAll('[data-e2e="comment-item"], .comment-item')].slice(0, 30).map((el) => {
    const q = (s) => { const n = el.querySelector(s); return n ? (n.innerText || '').trim() : '' };
    const lines = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const author = q('[data-e2e="comment-username"]') || q('.comment-item-info-wrap .name') || q('a[href*="/user/"]') || lines[0] || '';
    let text = q('[data-e2e="comment-content"]') || q('.comment-item-content');
    if (!text) {
      // 2026-11 实测评论正文的 class 是构建哈希（FduGc_lz），不是固定 .comment-item-content；
      // 从整条评论的文本里跳过作者、省略按钮、时间和互动栏，取中间正文。
      const more = lines.indexOf('...');
      const body = [];
      for (let i = more >= 0 ? more + 1 : 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^(分享|回复|作者|置顶|加载中|展开\\d*条回复)$/.test(line)) break;
        if (/^(\\d+(?:\\.\\d+)?(?:万|w)?)$/i.test(line)) break;
        if (/^\\d+\\s*(?:月|天|周|年|小时|分钟)前/.test(line) || /·/.test(line)) break;
        body.push(line);
      }
      text = body.join(' ').trim();
    }
    const likes = q('[data-e2e="comment-like-count"]') || q('.comment-item-like-count') || (q('.comment-item-stats-container').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || '');
    return { author, text, likes };
  }).filter((c) => c.text);
  return {
    id: (m && m[1]) || modal || fromFeed || '',
    url: location.href,
    caption: pick(scope, ${JSON.stringify(CAPTION_SEL)}, /^(展开|收起|更多|全文)$/) || pick(document, ${JSON.stringify(CAPTION_SEL)}, /^(展开|收起|更多|全文)$/),
    author: pick(scope, ${JSON.stringify(AUTHOR_SEL)}, /^(我的|关注|朋友|消息|通知|投稿|搜索|精选|推荐|AI抖音|直播|放映厅|短剧|小游戏)$/) || pick(document, ${JSON.stringify(AUTHOR_SEL)}, /^(我的|关注|朋友|消息|通知|投稿|搜索|精选|推荐|AI抖音|直播|放映厅|短剧|小游戏)$/),
    stats: {
      like: pick(scope, ${JSON.stringify(LIKE_CNT)}) || pick(document, ${JSON.stringify(LIKE_CNT)}),
      comment: pick(scope, ${JSON.stringify(COMMENT_CNT)}) || pick(document, ${JSON.stringify(COMMENT_CNT)}),
      collect: pick(scope, ${JSON.stringify(COLLECT_CNT)}) || pick(document, ${JSON.stringify(COLLECT_CNT)}),
      share: pick(scope, ${JSON.stringify(SHARE_CNT)}) || pick(document, ${JSON.stringify(SHARE_CNT)}),
    },
    comments: items
  };
})()`

/** 读当前视频的可见信息；读不到就返回 null，不编造。 */
export async function readSnapshot(page) {
  const v = await evaluate(page, SNAPSHOT_JS, null)
  if (!v || typeof v !== 'object') return null
  const caption = String(v.caption || '').trim()
  const id = String(v.id || '').trim()
  if (!caption && !id) return null
  return {
    id,
    url: String(v.url || ''),
    caption,
    author: String(v.author || '').trim().replace(/^@/, ''),
    stats: v.stats || {},
    comments: Array.isArray(v.comments) ? v.comments.slice(0, 30) : [],
  }
}

/** 截一张当前页面；clip 用 CSS 像素，不传就截整个可视区域。 */
export async function captureScreenshot(page, { format = 'jpeg', quality = 60, clip = null } = {}) {
  if (!page || typeof page.cmd !== 'function') return { ok: false, reason: '没有页面句柄' }
  try {
    const params = { format, quality, fromSurface: true, captureBeyondViewport: false }
    if (clip && clip.width > 0 && clip.height > 0) {
      params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    }
    const r = await page.cmd('Page.captureScreenshot', params)
    if (!r || !r.data) return { ok: false, reason: '截图没有返回数据' }
    return { ok: true, data: r.data, mimeType: `image/${format}` }
  } catch (err) {
    return { ok: false, reason: `截图失败：${err.message}` }
  }
}

/**
 * 截当前视频画面 1-2 帧，供宿主的多模态模型直接看图。
 * 必须绑定当前 videoId：调用方在截完后会再核对一次页面 id，变了就作废。
 */
export async function captureVideoFrames(page, { count = 2, intervalMs = 900, quality = 55 } = {}) {
  if (!page || typeof page.cmd !== 'function') return { ok: false, reason: '没有页面句柄' }
  const rect = await evaluate(page, `(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (!r || r.width < 80 || r.height < 80) return null;
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const width = Math.min(r.width, Math.max(1, window.innerWidth - x));
    const height = Math.min(r.height, Math.max(1, window.innerHeight - y));
    return { x, y, width, height };
  })()`, null)
  if (!rect) return { ok: false, reason: '页面里没有可截的视频画面（可能是黑屏/浮层/已切走）' }
  const frames = []
  for (let i = 0; i < Math.max(1, Math.min(3, count)); i += 1) {
    if (i > 0) await sleep(Math.max(250, intervalMs))
    const shot = await captureScreenshot(page, { format: 'jpeg', quality, clip: rect })
    if (!shot.ok) {
      if (!frames.length) return shot
      break
    }
    frames.push({ data: shot.data, mimeType: shot.mimeType, at: Date.now() })
  }
  if (!frames.length) return { ok: false, reason: '一帧都没截到' }
  return { ok: true, frames, capturedAt: Date.now(), clip: rect }
}

/**
 * 只读主人主页的「喜欢」列表。
 * 不按昵称搜人，只认完整主页链接；锁着就返回 locked，不绕过、不猜。
 * 抖音改版时这里的选择器可能需要调整，所以返回里保留了可见条数与原因，方便现场核对。
 */
export async function readOwnerLikes(page, profileUrl, { maxItems = 20 } = {}) {
  const url = String(profileUrl || '').trim()
  if (!/^https?:\/\/(?:www\.)?douyin\.com\/user\//i.test(url)) {
    return { ok: false, reason: '主人主页链接不对：要 https://www.douyin.com/user/... 这种完整链接' }
  }
  if (!page || typeof page.cmd !== 'function') return { ok: false, reason: '没有页面句柄' }
  try {
    await page.cmd('Page.navigate', { url }).catch(() => {})
    await sleep(2600)

    // 主页里的「喜欢」页签：只找页面上半部分、可见、文字以「喜欢」开头的入口。
    const tab = await evaluate(page, `(() => {
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        return r && r.width > 10 && r.height > 10 && r.top >= 0 && r.top < 420 && r.left >= 0 && r.left < window.innerWidth;
      };
      let best = null;
      for (const n of document.querySelectorAll('a,button,div,span')) {
        const t = (n.innerText || '').trim();
        if (!/^喜欢(\\s|\\d|$)/.test(t)) continue;
        if (!visible(n)) continue;
        const r = n.getBoundingClientRect();
        // 取面积最小的那个，避免点到整个导航容器
        if (!best || r.width * r.height < best.w * best.h) best = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      }
      return best;
    })()`, null)
    if (!tab) return { ok: false, reason: '主人主页上找不到「喜欢」入口（可能未登录、主页没加载完或页面结构变了）' }
    await mouseClick(page, tab.x, tab.y)
    await sleep(1600)

    const body = await evaluate(page, 'document.body ? document.body.innerText : ""', '')
    const locked = /(喜欢列表[^\n]{0,40}(锁|仅自己|私密|不可见|不公开)|该内容不可见|无权查看|私密账号)/.test(String(body || ''))
    if (locked) {
      return { ok: true, visibility: 'locked', items: [], totalVisible: 0, reason: '主人喜欢列表是锁着的，只能看到锁定状态' }
    }

    const items = await evaluate(page, `(() => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        const r = a.getBoundingClientRect();
        if (!r || r.width < 20 || r.height < 20 || r.top < 0 || r.bottom > window.innerHeight) continue;
        const m = String(a.href || '').match(/\\/video\\/(\\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const card = a.closest('[data-e2e*="item"], li, article, div') || a;
        const title = String((card.innerText || a.innerText || '')).replace(/\\s+/g, ' ').trim().slice(0, 100);
        const img = a.querySelector('img') || card.querySelector('img');
        out.push({ id: m[1], url: a.href, title, cover: img ? String(img.src || '') : '' });
      }
      return out.slice(0, ${Math.max(1, Math.min(50, maxItems))});
    })()`, [])
    const list = Array.isArray(items) ? items : []
    const shot = await captureScreenshot(page, { format: 'jpeg', quality: 50 })
    return {
      ok: true,
      visibility: list.length ? 'open' : 'empty',
      items: list,
      totalVisible: list.length,
      shot: shot.ok ? shot : null,
      reason: list.length ? '' : '喜欢页签打开了，但当前可视区域没有读到视频卡片',
    }
  } catch (err) {
    return { ok: false, reason: `读主人喜欢列表失败：${err.message}` }
  }
}


// 找元素在屏幕上的坐标（给真实鼠标点击用）。
// 关键教训：el.click() 是合成事件，抖音不认（UI 会变红、但手机端没记录）；
// 必须用 CDP 发真实鼠标事件，才会产生完整的 pointerdown → mousedown → pointerup → mouseup → click 序列。
const CLICK_RECT_JS = (sels, texts) => `(() => {
  const sels = ${JSON.stringify(sels)};
  const texts = ${JSON.stringify(texts)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight;
  };
  const feed = document.querySelector('[data-e2e="feed-active-video"]');
  const scope = feed ? (feed.closest('[data-e2e="feed-item"]') || null) : null;
  const roots = scope ? [scope, document] : [document];
  for (const root of roots) {
    for (const s of sels) {
      for (const el of root.querySelectorAll(s)) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sel: s };
      }
    }
  }
  for (const root of roots) {
    const nodes = [...root.querySelectorAll('button,[role="button"],span,div')];
    for (const n of nodes) {
      const t = (n.innerText || '').trim();
      if (!t || !texts.includes(t) || !visible(n)) continue;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sel: 'text:' + t };
    }
  }
  return null;
})()`

/** 真实鼠标点击（可信事件序列，抖音才会真的发请求）。 */
export async function mouseClick(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }).catch(() => {})
  await sleep(50)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
  await sleep(45)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
}

async function clickFirst(page, sels, texts = []) {
  const rect = await evaluate(page, CLICK_RECT_JS(sels, texts), null)
  if (!rect || typeof rect.x !== 'number') return ''
  await mouseClick(page, rect.x, rect.y)
  return rect.sel || ''
}

/** 评论区面板是否已经存在（包括空评论区，只要输入框在）。 */
async function commentsVisible(page) {
  return evaluate(page, `(() => {
    const shown = (el, minW = 100, minH = 16) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width >= minW && r.height >= minH && r.bottom > 0 && r.top < window.innerHeight
        && r.left >= 0 && r.left < window.innerWidth
        && r.left + Math.min(r.width, 100) <= window.innerWidth;
    };
    const base = [...document.querySelectorAll('.comment-input-inner-container, .comment-input-container, [data-e2e="comment-item"], .comment-item')].some((el) => {
      const r = el.getBoundingClientRect();
      // 关闭后的旧面板可能残留一个几像素宽的空容器，不能算“已打开”
      return r.width >= 100 && r.height >= 16 && r.bottom > 0 && r.top < window.innerHeight
        && r.left >= 0 && r.left + Math.min(r.width, 100) <= window.innerWidth;
    });
    if (base) return true;
    // 真实视频详情页的评论项 class 是构建哈希，没有 comment-item。
    // 右侧面板仍有稳定语义：标题「全部评论(n)」和每条评论下的「回复」。
    const right = window.innerWidth * 0.55;
    const title = [...document.querySelectorAll('div,span,section')].some((el) => {
      if (!shown(el, 60, 12)) return false;
      const r = el.getBoundingClientRect();
      if (r.left < right || r.width > 600) return false;
      return /^全部评论(?:\\s*[\\(（]\\d+[\\)）])?$/.test((el.innerText || el.textContent || '').trim());
    });
    if (title) return true;
    const replies = [...document.querySelectorAll('button,[role="button"],span,div')].filter((el) => {
      if (!shown(el, 8, 8)) return false;
      const r = el.getBoundingClientRect();
      return r.left >= right && /^(回复|回复中|Reply)$/.test((el.innerText || '').trim());
    });
    return replies.length >= 2;
  })()`, false)
}

/**
 * 评论输入栏里“有字的那一块”的坐标。
 * 不能拿整个输入容器取中心：容器右侧还有图片/@/表情三个图标，取中心会擦到图片按钮，
 * 弹出 Windows 文件选择框，整条回评论就卡住。
 * 这里优先点占位文字/编辑区本身，并把点击点限制在右侧图标左边。
 */
async function commentTextPoint(page) {
  return evaluate(page, `(() => {
    const panel = document.querySelector('.comment-input-inner-container')
      || document.querySelector('.comment-input-container');
    if (!panel) return null;
    const panelRect = panel.getBoundingClientRect();
    // 评论区关掉后可能残留一个几像素宽的空容器；不能把它当输入框点。
    if (panelRect.width < 120 || panelRect.height < 20) return null;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 80 && r.height >= 14 && r.bottom > 0 && r.top < window.innerHeight
        && r.left >= 0 && r.left + Math.min(r.width, 80) <= window.innerWidth;
    };
    const isPlaceholder = (t) => /留下你的精彩评论|说点什么|善语结善缘|发一条.{0,8}评论|添加评论/.test(t);
    const candidates = [];
    const editor = panel.querySelector('[contenteditable="true"]');
    if (editor && visible(editor)) candidates.push(editor);
    for (const n of panel.querySelectorAll('span,div,p,textarea,input')) {
      if (n.tagName === 'INPUT' && /^(file|checkbox|radio|hidden)$/i.test(n.type || '')) continue;
      const t = String(n.innerText || n.value || n.getAttribute('placeholder') || '').trim();
      if (!t || !isPlaceholder(t) || !visible(n)) continue;
      // 只取最内层那块占位文字，避免点到包住整条工具栏的外层容器
      const child = [...n.querySelectorAll('span,div,p')]
        .find((c) => isPlaceholder(String(c.innerText || '').trim()) && visible(c));
      if (!child) candidates.push(n);
    }
    const target = candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    })[0] || panel;
    const r = target.getBoundingClientRect();
    // 以右侧工具栏小图标的最左边界作为禁区，绝不把点击落到图片按钮上。
    const iconLefts = [];
    for (const n of panel.querySelectorAll('span,button,i,a')) {
      const ir = n.getBoundingClientRect();
      if (ir.width >= 16 && ir.width <= 64 && ir.height >= 16 && ir.height <= 64
        && ir.left >= panelRect.left + 60) iconLefts.push(ir.left);
    }
    let x = r.left + Math.min(Math.max(20, r.width * 0.28), 120);
    if (iconLefts.length) x = Math.min(x, Math.min(...iconLefts) - 16);
    x = Math.max(panelRect.left + 8, Math.min(x, panelRect.right - 8));
    return { x: Math.round(x), y: Math.round(r.top + r.height / 2) };
  })()`, null)
}

/** 当前可见评论输入框的安全点击点；旧面板残留的空容器不算。 */
async function commentInputRect(page) {
  return commentTextPoint(page)
}

/** 打开评论区。已经开着就直接读，别再按关闭——否则同一页会把刚打开的评论又关掉。 */
export async function openComments(page) {
  if (await commentsVisible(page)) return { ok: true, reason: '' }
  // 推荐流的 DOM 里会同时存在背景 feed 的评论图标；按 DOM 顺序取第一个会点到别的视频。
  // 当前详情页的互动栏在最右侧，取视口内最靠右的可见评论图标。
  const icon = await evaluate(page, `(() => {
    const sels = ['[data-e2e="video-comment-icon"]', '[data-e2e="feed-comment-icon"]', '[data-e2e="comment-icon"]', 'button[aria-label*="评论"]'];
    const cands = [];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 20 || r.height < 20) continue;
        if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
        if (r.left < 0 || r.left >= window.innerWidth) continue;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        cands.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: r.left, sel: s });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.left - a.left);
    return cands[0];
  })()`, null)
  if (icon && typeof icon.x === 'number') await mouseClick(page, icon.x, icon.y)
  else {
    const hit = await clickFirst(page, ['[data-e2e="video-comment-icon"]', '[data-e2e="feed-comment-icon"]', '[data-e2e="comment-icon"]', 'button[aria-label*="评论"]'], ['评论'])
    if (!hit) return { ok: false, reason: '找不到评论区入口' }
  }
  // 面板有动画/懒加载，固定等 900ms 会误判成“没打开”；轮询到出现为止。
  let opened = false
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    opened = await commentsVisible(page)
    if (opened) break
  }
  return opened ? { ok: true, reason: '' } : { ok: false, reason: '评论区没打开（可能还停在旧面板）' }
}

export async function closeComments(page) {
  if (!(await commentsVisible(page))) return
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
    await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
    await sleep(300)
    if (!(await commentsVisible(page))) return
  }
}

/** 打开评论区并读前 N 条评论。 */
export async function readComments(page, limit = 5) {
  const before = await readSnapshot(page)
  const open = await openComments(page)
  if (!open.ok) return { ok: false, reason: open.reason, comments: [] }
  // 评论区是懒加载的：面板先出来，评论项晚半拍到一秒才挂上。
  let after = null
  for (let i = 0; i < 5; i++) {
    await sleep(500)
    after = await readSnapshot(page)
    if (after && Array.isArray(after.comments) && after.comments.length) break
  }
  // 打开评论区期间页面被换掉时，after 里的评论不属于 before 这条视频。
  if (before && after && before.id && after.id && before.id !== after.id) {
    return { ok: false, reason: '读评论时页面已经翻到别的视频了', comments: [] }
  }
  const comments = after && Array.isArray(after.comments) ? after.comments.slice(0, Math.max(1, limit)) : []
  return { ok: true, comments, reason: comments.length ? '' : '评论区没读到内容' }
}

/** 滑到下一条视频：优先点官方下箭头，再退回方向键，最后滚动。 */
export async function nextVideo(page) {
  const idOf = async () => String(await evaluate(page, ACTIVE_VIDEO_ID_JS, '') || '')
  const before = await idOf()
  for (let attempt = 0; attempt < 2; attempt++) {
    const arrow = await clickFirst(page, ['[data-e2e="video-switch-next-arrow"]'], [])
    if (!arrow) {
      // 推荐页是单条全屏播放，方向键和详情页一样能翻
      await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }).catch(() => {})
      await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }).catch(() => {})
    }
    await sleep(1200)
    const now = await idOf()
    if (now && now !== before) return { ok: true, reason: '' }
  }
  await evaluate(page, 'window.scrollBy(0, Math.round(window.innerHeight * 0.92))', null)
  await sleep(800)
  const after = await idOf()
  return { ok: Boolean(after) && after !== before, reason: after !== before ? '' : '没能翻到下一条' }
}

async function clickState(page, sels, texts, activeHints) {
  // 读一次真实状态：优先 aria-label（「取消点赞」= 已赞），其次精确的 class 标记。
  // 注意别把裸 'active' 当已赞——很多元素都有 active 类，会误判成「已经点过」而直接跳过。
  const readState = () => evaluate(page, `(() => {
    const sels = ${JSON.stringify(sels)};
    const hints = ${JSON.stringify(activeHints)};
    const feed = document.querySelector('[data-e2e="feed-active-video"]');
    const scope = feed ? (feed.closest('[data-e2e="feed-item"]') || document) : document;
    for (const s of sels) {
      const el = scope.querySelector(s) || document.querySelector(s);
      if (!el) continue;
      const cls = String(el.className || '');
      const label = String(el.getAttribute('aria-label') || '');
      const pressed = el.getAttribute('aria-pressed') === 'true';
      const byLabel = /取消|unlike|uncollect/i.test(label);
      return { found: true, sel: s, active: pressed || byLabel || hints.some((h) => cls.includes(h)), label, cls: cls.slice(0, 120) };
    }
    return { found: false, sel: '', active: false, label: '', cls: '' };
  })()`, { found: false, sel: '', active: false, label: '', cls: '' })

  // 鼠标点有时会落在遮罩/父层上：补一次 DOM 点击，点完再验
  const domClick = (up = false) => evaluate(page, `(() => {
    const sels = ${JSON.stringify(sels)};
    const feed = document.querySelector('[data-e2e="feed-active-video"]');
    const scope = feed ? (feed.closest('[data-e2e="feed-item"]') || document) : document;
    for (const s of sels) {
      const el = scope.querySelector(s) || document.querySelector(s);
      if (!el) continue;
      const target = ${up ? "(el.closest('button') || el).parentElement || el" : "(el.closest('button') || el)"};
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    return false;
  })()`, false)

  const state = await readState()
  if (!state.found) return { ok: false, reason: '找不到按钮（可能改版）' }
  if (state.active) return { ok: true, skipped: 'already', reason: '' }
  const hit = await clickFirst(page, sels, texts)
  await sleep(700)
  let after = await readState()
  if (after.active) return { ok: true, reason: '', via: 'mouse' }

  // 兜底一：直接对元素派发 click
  if (await domClick(false)) {
    await sleep(700)
    after = await readState()
    if (after.active) return { ok: true, reason: '', via: 'dom' }
  }
  // 兜底二：点它的父元素（图标外面常包一层可点区域）
  if (await domClick(true)) {
    await sleep(700)
    after = await readState()
    if (after.active) return { ok: true, reason: '', via: 'parent' }
  }
  // 点完状态没变就是没点上或被抖音拒了，别假装成功；把现场留下来方便查
  return {
    ok: false,
    reason: '点了但状态没变（可能没点上，或被抖音拒了）',
    debug: { hit, before: { sel: state.sel, label: state.label, cls: state.cls }, after: { active: after.active, label: after.label, cls: after.cls } },
  }
}

export function like(page) {
  return clickState(page,
    ['[data-e2e="video-player-digg"]', '[data-e2e="video-like-icon"]', '[data-e2e="like-icon"]', 'button[aria-label*="点赞"]', '[aria-label*="点赞"]'],
    ['点赞'],
    ['liked', 'is-digged', 'digged'])
}

export function favorite(page) {
  return clickState(page,
    ['[data-e2e="video-player-collect"]', '[data-e2e="video-collect-icon"]', '[data-e2e="collect-icon"]', 'button[aria-label*="收藏"]', '[aria-label*="收藏"]'],
    ['收藏'],
    ['collected', 'is-collected'])
}

const FILL_JS = (text) => `(() => {
  const sels = ['[data-e2e="comment-input"]', '[contenteditable="true"]', 'textarea'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) continue;
    el.focus();
    const t = ${JSON.stringify(text)};
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const ok = document.execCommand && document.execCommand('insertText', false, t);
      if (!ok) { el.innerText = t; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    }
    return s;
  }
  return '';
})()`

/**
 * 找到输入框并在里面写字。
 * 教训：抖音评论输入框是 contenteditable，选择器经常漂移；最稳的做法是
 * 「找到视口里最靠下的那个可编辑区 → 真实点一下 → CDP Input.insertText」，
 * 不用 execCommand，也不直接改 innerText（那样按钮还是灰的）。
 */
async function fillEditor(page, text) {
  // 抖音的评论输入区默认是个占位 div（.comment-input-inner-container，
  // 里面写着「留下你的精彩评论吧」），点了才会变成可编辑区域。
  // 只点“有字的那一块”，不要点容器中心，右边是图片/@/表情图标。
  const trigger = await commentTextPoint(page)
  if (trigger) {
    await mouseClick(page, trigger.x, trigger.y)
    await sleep(700)
  }
  const rect = await commentTextPoint(page)
  if (!rect || typeof rect.x !== 'number') return ''
  // 真实点一下进入编辑态
  await mouseClick(page, rect.x, rect.y)
  await sleep(180)
  // 清空原有内容：Ctrl+A → Backspace
  await page.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }).catch(() => {})
  await sleep(60)
  await page.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).catch(() => {})
  await sleep(120)
  await page.cmd('Input.insertText', { text }).catch(() => {})
  await sleep(250)
  // 输入框是 contenteditable / textarea 都可能；确认字真的进去了，别按了 Enter 才发现是空的。
  const typed = await evaluate(page, `(() => {
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea, input')]
      .filter((el) => {
        if (el.tagName === 'INPUT' && /^(file|checkbox|radio|hidden)$/i.test(el.type || '')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 120 && r.height > 12 && r.bottom > 0 && r.top < window.innerHeight;
      });
    if (!all.length) return '';
    const bottomRight = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= window.innerWidth * 0.5 && r.top >= window.innerHeight * 0.45;
    });
    const pool = bottomRight.length ? bottomRight : all;
    pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const el = pool[0];
    return String(el.innerText || el.textContent || el.value || '');
  })()`, '')
  const needle = String(text || '').replace(/\s+/g, '').slice(0, 6)
  return typed && (!needle || String(typed).replace(/\s+/g, '').includes(needle)) ? 'editor' : ''
}

/**
 * 点「回复」之后，页面必须出现回复态：按钮变成「回复中」，或输入框上方出现引用条。
 * 只认页面上真实可见的文字，不把「输入框一直在」当成已经进入回复态。
 */
async function replyModeVisible(page, author = '') {
  return evaluate(page, `(() => {
    const who = ${JSON.stringify(String(author || ''))}.replace(/\\s+/g, ' ').trim();
    const shown = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    };
    const replyNow = [...document.querySelectorAll('button,[role="button"],span,div')].some((el) => shown(el) && (el.innerText || '').trim() === '回复中');
    const quoted = [...document.querySelectorAll('div,span,p')].some((el) => {
      if (!shown(el)) return false;
      const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!/^回复\\s*@/.test(t)) return false;
      return who ? t.includes(who) : true;
    });
    return Boolean(replyNow || quoted);
  })()`, false)
}

/**
 * 评论/回复发图：走输入框右侧图片按钮背后的隐藏 file input。
 * 2026-11-13 实测：评论 Draft.js 编辑器不会处理直接 Ctrl+V 的图片，
 * 但把同一张图塞进 `.comment-input-inner-container input[type=file]`
 * 会出现缩略图，随后用评论发送逻辑正常发出去。
 */
async function uploadImageToComment(page, file) {
  if (!file) return { ok: false, reason: '没有可用的图片路径' }
  try {
    const doc = await page.cmd('DOM.getDocument', { depth: -1 })
    const input = await page.cmd('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '.comment-input-inner-container input[type="file"], .comment-input-container input[type="file"]',
    })
    if (!input || !input.nodeId) return { ok: false, reason: '评论输入框没有图片上传入口（可能改版）' }
    await page.cmd('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [String(file)] })
    await sleep(2500)
    const hasPreview = await evaluate(page, `(() => {
      const panel = document.querySelector('.comment-input-inner-container') || document.querySelector('.comment-input-container');
      return Boolean(panel && panel.querySelector('img'));
    })()`, false)
    return hasPreview
      ? { ok: true }
      : { ok: false, reason: '图片塞进上传入口了，但评论框没有出现缩略图' }
  } catch (err) {
    return { ok: false, reason: `评论图片上传失败：${err.message}` }
  }
}

/**
 * 点评论框的发送按钮。
 * 只认语义明确的「发送/发布/评论」文字或发送 aria/data-e2e/class；
 * 找不到就返回 false，绝不按“最右侧小图标”盲点——那会点到图片按钮，弹出系统文件框。
 */
async function clickCommentSendButton(page) {
  const rect = await evaluate(page, `(() => {
    const anchor = document.querySelector('.comment-input-container') || document.querySelector('.comment-input-inner-container');
    if (!anchor) return null;
    const cands = [];
    for (const n of anchor.querySelectorAll('button,[role="button"],span,div,a')) {
      const b = n.getBoundingClientRect();
      if (b.width < 12 || b.height < 12 || b.bottom <= 0 || b.top >= window.innerHeight
        || b.left < 0 || b.right > window.innerWidth) continue;
      const t = String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      const meta = [
        n.getAttribute('aria-label') || '',
        n.getAttribute('title') || '',
        n.getAttribute('data-e2e') || '',
        String(n.className || ''),
      ].join(' ');
      const isSend = /^(发送|发布|评论|Send)$/i.test(t)
        || /发送|send/i.test(meta);
      if (!isSend) continue;
      cands.push({
        x: Math.round(b.left + b.width / 2),
        y: Math.round(b.top + b.height / 2),
        area: b.width * b.height,
        text: t,
      });
    }
    if (!cands.length) return null;
    // 优先精确的「发送」文字，再取最小面积，避免点到包住整条输入栏的外层容器。
    const exact = cands.filter((c) => /^(发送|Send)$/i.test(c.text));
    const pool = exact.length ? exact : cands;
    pool.sort((a, b) => a.area - b.area);
    return pool[0];
  })()`, null)
  if (!rect || typeof rect.x !== 'number') return false
  await mouseClick(page, rect.x, rect.y)
  return true
}

/** 验证码不是错误：用户在共享浏览器里手动过一下，评论就能发出去。
 * 这里只负责识别 + 等，绝不主动关详情或回推荐页。 */
export const CAPTCHA_JS = `(() => {
  const url = String(location.href || '');
  const urlHit = /(captcha|verify|验证码|安全验证)/i.test(url);
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= 60 && r.height >= 24 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth
      && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0.01;
  };
  const selectors = [
    'iframe[src*="captcha"]', 'iframe[src*="verify"]',
    '[class*="captcha" i]', '[id*="captcha" i]', '[class*="verify" i]', '[id*="verify" i]',
    '[data-e2e*="captcha" i]', '[data-e2e*="verify" i]',
  ];
  const selHit = selectors.some((sel) => {
    try { return [...document.querySelectorAll(sel)].some(visible); } catch { return false; }
  });
  const words = ['请完成安全验证', '请完成下方验证', '拖动滑块', '点击完成验证', '人机验证', '请输入验证码', '验证码错误', '获取验证码'];
  const textHit = [...document.querySelectorAll('div,span,p,h1,h2,h3,button')].some((el) => {
    if (!visible(el)) return false;
    const t = String(el.innerText || '').trim();
    return t.length <= 120 && words.some((w) => t.includes(w));
  });
  return { hit: Boolean(urlHit || selHit || textHit), urlHit, selHit, textHit, url };
})()`

const CAPTCHA_WAIT_MS = (() => {
  const raw = Number(process.env.FISH_COMMENT_CAPTCHA_WAIT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 10 * 60 * 1000
  return Math.max(30 * 1000, Math.min(30 * 60 * 1000, raw))
})()

/** 等用户把验证码过掉；没有验证码时立即返回。 */
async function waitForCaptcha(page, logger = null) {
  let state = await evaluate(page, CAPTCHA_JS, { hit: false })
  if (!state || !state.hit) return { ok: true, seen: false }
  const seconds = Math.round(CAPTCHA_WAIT_MS / 1000)
  logger?.warn?.(`回评论：出现验证码，停在当前页面等你处理（最多等 ${seconds} 秒；别关页面）`)
  const deadline = Date.now() + CAPTCHA_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(1000)
    state = await evaluate(page, CAPTCHA_JS, { hit: false })
    if (!state || !state.hit) {
      logger?.info?.('回评论：验证码已处理，继续发送')
      return { ok: true, seen: true }
    }
  }
  logger?.warn?.('回评论：验证码等待超时，这条先不发')
  return { ok: false, seen: true, timeout: true }
}

async function sendComment(page, dryRun, logger = null) {
  if (dryRun) return { ok: true, dryRun: true, reason: '只填入，没有点发送' }
  // 图片评论不一定有文字：发送后不能只看 innerText，否则空文字会被误判成“已发出去”。
  const editorState = () => evaluate(page, `(() => {
    const panel = document.querySelector('.comment-input-container') || document.querySelector('.comment-input-inner-container');
    const el = (panel && panel.querySelector('[contenteditable="true"]')) || document.querySelector('[contenteditable="true"]');
    if (!el) return { hasEditor: false, text: '', image: false };
    return {
      hasEditor: true,
      text: (el.innerText || '').trim(),
      image: Boolean((panel && panel.querySelector('img')) || el.querySelector('img')),
    };
  })()`, { hasEditor: false, text: '', image: false })
  // 抖音发送成功后输入框会清空。这里同时看评论列表，避免刚发出、列表还没刷新时误判；
  // 每次调用最多只点一次发送，不要“Enter 没看到反应就再点红按钮”，否则会重复评论。
  const commentState = (expectedText = '') => evaluate(page, `(() => {
    const items = [...document.querySelectorAll('[data-e2e="comment-item"], .comment-item')];
    const expected = ${JSON.stringify(String(expectedText || ''))};
    const title = [...document.querySelectorAll('div,span,h1,h2,h3')]
      .map((el) => String(el.innerText || '').trim())
      .find((t) => /^全部评论\\s*[（(]?\\s*\\d+/.test(t) && t.length <= 30);
    const m = title && title.match(/^全部评论\\s*[（(]?\\s*(\\d+)/);
    return {
      count: items.length,
      imageCount: items.reduce((n, el) => n + el.querySelectorAll('img').length, 0),
      hasText: Boolean(expected && items.some((el) => (el.innerText || '').includes(expected))),
      panelCount: m ? Number(m[1]) : 0,
    };
  })()`, { count: 0, imageCount: 0, hasText: false, panelCount: 0 })

  // 先处理上一轮遗留的验证码：验证码在时不要点发送，也不要让上层关详情。
  const preCaptcha = await waitForCaptcha(page, logger)
  if (!preCaptcha.ok) {
    return { ok: false, captcha: true, reason: '等待验证码超时，这条评论没有发出去' }
  }

  const initial = await editorState()
  const expectedText = String(initial.text || '')
  const beforeComments = await commentState(expectedText)

  /** 验证码处理完再判断：输入框消失不等于发送成功，要先等验证码关闭。 */
  const settle = async () => {
    const captcha = await waitForCaptcha(page, logger)
    if (!captcha.ok) {
      return { ok: false, captcha: true, reason: '等待验证码超时，这条评论没有发出去' }
    }
    const editor = await editorState()
    const comments = await commentState(expectedText)
    if (!editor.hasEditor || (!editor.text && !editor.image)) return { ok: true, captcha: captcha.seen }
    if (comments.count > beforeComments.count || comments.imageCount > beforeComments.imageCount || comments.hasText || comments.panelCount > beforeComments.panelCount) {
      return { ok: true, captcha: captcha.seen }
    }
    if (!captcha.seen) return { ok: false, pending: true, captcha: false }
    // 验证码刚消失时评论列表可能还没刷新；先等一拍再决定补发，避免把已经发出去的评论重复发一次。
    await sleep(1200)
    const late = await commentState(expectedText)
    if (late.count > beforeComments.count || late.imageCount > beforeComments.imageCount || late.hasText || late.panelCount > beforeComments.panelCount) {
      return { ok: true, captcha: true }
    }
    // 验证码已经解决，但输入框里还有字：说明这次发送被验证码打断了，补点一次发送。
    const clicked = await clickCommentSendButton(page)
    await sleep(1800)
    const captcha2 = await waitForCaptcha(page, logger)
    if (!captcha2.ok) {
      return { ok: false, captcha: true, reason: '等待验证码超时，这条评论没有发出去' }
    }
    const editor2 = await editorState()
    if (!editor2.hasEditor || (!editor2.text && !editor2.image)) return { ok: true, captcha: true }
    const comments2 = await commentState(expectedText)
    if (comments2.count > beforeComments.count || comments2.imageCount > beforeComments.imageCount || comments2.hasText || comments2.panelCount > beforeComments.panelCount) {
      return { ok: true, captcha: true }
    }
    return { ok: false, captcha: true, reason: clicked ? '验证码后补发仍然没发出去' : '验证码后找不到评论发送按钮' }
  }

  // 带图评论：图片缩略图出现后，服务端可能还没收完，等约 1.5 秒；只点一次红色发送按钮。
  if (initial.image) {
    await sleep(1500)
    const clicked = await clickCommentSendButton(page)
    await sleep(2200)
    const settled = await settle()
    if (settled.ok) return settled
    if (settled.pending) {
      return { ok: false, reason: clicked ? '图片评论的发送按钮点了，但没发出去' : '找不到评论发送按钮' }
    }
    return settled
  }

  // 纯文字评论：先按 Enter；只有输入框没清空、评论列表也没新增时，才补点一次发送按钮。
  await page.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }).catch(() => {})
  await sleep(1600)
  const afterEnter = await settle()
  if (afterEnter.ok) return afterEnter
  if (!afterEnter.pending) return afterEnter
  const clicked = await clickCommentSendButton(page)
  await sleep(1800)
  const afterButton = await settle()
  if (afterButton.ok) return afterButton
  if (afterButton.pending) {
    return { ok: false, reason: clicked ? '评论填好了但没发出去' : '找不到评论发送按钮' }
  }
  return afterButton
}

/** 在 @ 下拉里找目标头像卡；返回可点坐标。 */
async function findMentionRect(page, name) {
  const raw = await evaluate(page, `(() => {
    const target = ${JSON.stringify(name)};
    const editors = [...document.querySelectorAll('[contenteditable="true"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width >= 80 && x.r.height >= 16 && x.r.bottom > 0 && x.r.top < window.innerHeight && x.r.left >= 0 && x.r.left + Math.min(x.r.width, 80) <= window.innerWidth);
    const boxes = [...document.querySelectorAll('.comment-input-inner-container')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width >= 120 && x.r.height >= 20 && x.r.bottom > 0 && x.r.top < window.innerHeight && x.r.left >= 0 && x.r.left + Math.min(x.r.width, 100) <= window.innerWidth);
    if (!editors.length || !boxes.length) return null;
    editors.sort((a, b) => b.r.top - a.r.top);
    boxes.sort((a, b) => b.r.top - a.r.top);
    const editor = editors[0].el;
    const ref = editor.getBoundingClientRect();
    const out = [];
    for (const n of document.querySelectorAll('div,span,li')) {
      const t = (n.innerText || '').trim().replace(/^@/, '').trim();
      // 只认和主人名字完全一致的卡片；名字相近的「思维读书」之类不能点错人
      if (!t || t !== target) continue;
      // @ 下拉本身会挂在评论输入容器里，只排除编辑器和里面的查询文字，不能把整个输入容器都排除
      if (editor.contains(n)) continue;
      const r = n.getBoundingClientRect();
      // 头像卡是输入框上方一块完整的卡片；评论区的同名文字太窄/太扁，排除
      if (r.width < 40 || r.width > 180) continue;
      if (r.height < 40 || r.height > 100) continue;
      // 抖音评论页有两种布局：候选卡可能在输入框上方，也可能在下方。
      // 两种都要接受；仍限制在输入框附近，避免点到评论区里同名的作者文字。
      if (r.top < ref.top - 500 || r.top > ref.bottom + 500) continue;
      if (r.left < ref.left - 500 || r.left > ref.right + 80) continue;
      out.push({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        l: r.left,
        t: r.top,
        r: r.right,
        b: r.bottom,
      });
    }
    return out;
  })()`, [])
  if (!Array.isArray(raw) || !raw.length) return null
  // 同一张卡的外层/内层/文字节点会互相重叠；先合并成一张卡，再判断是否真有多个同名候选
  raw.sort((a, b) => (b.w * b.h) - (a.w * a.h))
  const cards = []
  for (const c of raw) {
    const same = cards.find((u) => {
      const iw = Math.min(u.r, c.r) - Math.max(u.l, c.l)
      const ih = Math.min(u.b, c.b) - Math.max(u.t, c.t)
      return iw > 0 && ih > 0 && iw * ih >= Math.min(u.w * u.h, c.w * c.h) * 0.5
    })
    if (!same) cards.push(c)
  }
  if (cards.length > 1) return { ambiguous: true, count: cards.length }
  return cards[0]
}

/** 选不上时清掉输入框里的 @ 查询词，别把半截内容留在下一条评论里。 */
async function clearCommentQuery(page) {
  await page.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }).catch(() => {})
  await sleep(60)
  await page.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).catch(() => {})
  await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).catch(() => {})
  await sleep(120)
}

/** 在评论框里 @ 一个人：输入 @，点下拉里的头像卡，再确认真的插入了 mention 实体。 */
async function fillMention(page, name) {
  await page.cmd('Input.insertText', { text: '@' }).catch(() => {})
  await sleep(900)
  let rect = await findMentionRect(page, name)
  if (!rect || rect.ambiguous) {
    // 下拉没出目标、或同名候选不唯一时，再输入名字过滤一次
    await page.cmd('Input.insertText', { text: name }).catch(() => {})
    await sleep(1600)
    rect = await findMentionRect(page, name)
  }
  if (rect && rect.ambiguous) {
    await clearCommentQuery(page)
    return { ok: false, reason: `@${name} 有 ${rect.count} 个同名头像，无法确认哪个是主人，这条没有发` }
  }
  if (!rect || typeof rect.x !== 'number') {
    await clearCommentQuery(page)
    return { ok: false, reason: `@${name} 没在列表里选上` }
  }
  await mouseClick(page, rect.x, rect.y)
  await sleep(900)
  // 点完必须看到抖音的 mention 实体；只有“@名字”纯文本不算成功
  const inserted = await evaluate(page, `(() => {
    const editor = [...document.querySelectorAll('[contenteditable="true"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width >= 80 && x.r.height >= 16 && x.r.bottom > 0 && x.r.top < window.innerHeight)
      .sort((a, b) => b.r.top - a.r.top)[0];
    if (!editor) return false;
    return [...editor.el.querySelectorAll('.douyin_mention_word')]
      .some((n) => (n.innerText || '').includes(${JSON.stringify(name)}));
  })()`, false)
  if (!inserted) {
    await clearCommentQuery(page)
    return { ok: false, reason: `@${name} 点了，但没有插入真正的 mention 实体，这条没有发` }
  }
  return { ok: true }
}

/** 面板表情别名：模型说“笑哭/赞/委屈”，也要能在抖音面板里找到对应标签。 */
const EMOJI_ALIASES = {
  微笑: ['微笑', 'smile'],
  笑: ['微笑', '偷笑', '笑哭', '大笑', '呲牙', 'smile', 'laugh'],
  开心: ['开心', '微笑', '大笑', '呲牙', 'happy', 'smile'],
  笑哭: ['笑哭', '大笑', '呲牙', '破涕为笑', 'laughcry', 'laugh', 'cry'],
  大笑: ['大笑', '笑哭', '呲牙', 'laugh'],
  偷笑: ['偷笑', '捂嘴笑', '笑哭', 'giggle'],
  捂脸: ['捂脸', '捂脸笑', '无语', 'facepalm'],
  点赞: ['点赞', '赞', '强', 'like', 'digg', 'thumb'],
  赞: ['点赞', '赞', '强', 'like', 'digg', 'thumb'],
  爱心: ['爱心', '比心', '喜欢', 'heart', 'love'],
  比心: ['比心', '爱心', 'heart'],
  委屈: ['委屈', '快哭了', '流泪', '可怜', 'sad', 'cry'],
  难过: ['难过', '委屈', '快哭了', '流泪', 'sad', 'cry'],
  惊讶: ['惊讶', '吃惊', '目瞪口呆', 'surprise', 'shock'],
  无语: ['无语', '翻白眼', '汗', 'speechless', 'sweat'],
  生气: ['生气', '发怒', '怒', 'angry', 'rage'],
  抱拳: ['抱拳', '拱手', '谢谢', 'respect', 'thanks'],
  谢谢: ['抱拳', '拱手', '谢谢', '感谢', 'thanks'],
  挥手: ['挥手', '再见', '拜拜', 'wave', 'bye'],
  再见: ['挥手', '再见', '拜拜', 'wave', 'bye'],
  ok: ['ok', '好的', '赞', 'okay', 'good'],
  好: ['ok', '好的', '赞', 'okay', 'good'],
}

function normEmojiLabel(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[\s[\]【】()（）]/g, '')
    .replace(/表情|emoji/g, '')
}

/**
 * 从面板可点击项里挑一个和 wanted 对得上的表情。
 * 找不到就返回 null：绝不退回“第一个”，否则又会永远点微笑。
 */
export function pickPanelEmojiCandidate(items = [], wanted = '') {
  const w = normEmojiLabel(wanted)
  if (!w) return null
  const usable = (Array.isArray(items) ? items : []).filter((x) => x && normEmojiLabel(x.label))
  const exact = usable.find((x) => normEmojiLabel(x.label) === w)
  if (exact) return exact
  const contains = usable.find((x) => normEmojiLabel(x.label).includes(w) || w.includes(normEmojiLabel(x.label)))
  if (contains) return contains
  const aliases = EMOJI_ALIASES[w] || EMOJI_ALIASES[String(wanted || '').trim()] || []
  for (const alias of aliases) {
    const a = normEmojiLabel(alias)
    const hit = usable.find((x) => normEmojiLabel(x.label).includes(a) || a.includes(normEmojiLabel(x.label)))
    if (hit) return hit
  }
  return null
}

/** 在评论里插一个指定表情：打开面板后按标签找，找不到就不点。 */
async function addEmoji(page, wanted = '') {
  if (!normEmojiLabel(wanted)) return { ok: false, reason: '没有指定要哪个面板表情' }
  const icons = await evaluate(page, `(() => {
    const a = document.querySelector('.comment-input-container') || document.querySelector('.comment-input-inner-container');
    if (!a) return [];
    const out = [];
    for (const n of a.querySelectorAll('span,button,div,i,a')) {
      const b = n.getBoundingClientRect();
      if (b.width < 20 || b.width > 50 || b.height < 20 || b.height > 50
        || b.bottom <= 0 || b.top >= window.innerHeight) continue;
      const text = String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      const meta = [
        n.getAttribute('aria-label') || '',
        n.getAttribute('title') || '',
        n.getAttribute('data-e2e') || '',
        String(n.className || ''),
      ].join(' ');
      // 发送按钮不是表情按钮；图片/上传入口也不能点，避免系统文件选择框。
      if (/^(发送|发布|评论|Send)$/i.test(text) || /发送|send/i.test(meta)) continue;
      if (/图片|image|photo|upload|file/i.test(meta + ' ' + text)) continue;
      out.push({
        x: Math.round(b.left + b.width / 2),
        y: Math.round(b.top + b.height / 2),
        left: Math.round(b.left),
        text,
        meta,
      });
    }
    out.sort((a, b) => b.left - a.left);
    return out;
  })()`, [])
  if (!icons.length) return { ok: false, reason: '找不到评论表情按钮' }
  // 优先 aria/title/data-e2e 明确写着「表情/emoji」的图标；否则取最右侧的非发送图标。
  const emojiIcon = icons.find((x) => /表情|emoji/i.test(x.meta)) || icons[0]
  await mouseClick(page, emojiIcon.x, emojiIcon.y)
  await sleep(1200)
  const items = await evaluate(page, `(() => {
    const seen = new Set();
    const out = [];
    for (const sel of ['[class*="emoji"] img', '[class*="Emoji"] img']) {
      for (const n of document.querySelectorAll(sel)) {
        const img = n.tagName === 'IMG' ? n : n.querySelector('img');
        if (!img || seen.has(img)) continue;
        seen.add(img);
        const r = img.getBoundingClientRect();
        if (r.width < 16 || r.height < 16 || r.width > 80 || r.height > 80) continue;
        const label = String(
          n.getAttribute('alt') || n.getAttribute('title') || n.getAttribute('aria-label') ||
          img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('aria-label') ||
          n.getAttribute('data-name') || img.getAttribute('data-name') || img.getAttribute('data-emoji') ||
          (n.parentElement ? (n.parentElement.getAttribute('title') || n.parentElement.getAttribute('aria-label')) : '') ||
          n.innerText || img.innerText || ''
        ).trim() || String(img.currentSrc || img.src || '').split('/').pop().replace(/[?#].*$/, '').replace(/\.[a-z0-9]+$/i, '');
        out.push({
          label,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          src: img.currentSrc || img.src || '',
        });
      }
    }
    return out;
  })()`, [])
  const chosen = pickPanelEmojiCandidate(items, wanted)
  if (!chosen) {
    // 没找到就用同一个表情按钮把面板收回去；绝不再按“第二个图标”盲点，
    // 那个位置在不同布局下可能是图片上传入口。
    try { await mouseClick(page, emojiIcon.x, emojiIcon.y) } catch {}
    await sleep(300)
    return { ok: false, reason: `面板里没找到「${wanted}」这个表情，没有乱点` }
  }
  await mouseClick(page, chosen.x, chosen.y)
  await sleep(800)
  return { ok: true, label: chosen.label || wanted }
}

/** 在视频下发一条评论；mention 传名字就 @ 他，emoji 传表情名就带一个，image 传本地图就贴一张图。 */
export async function postComment(page, text, { dryRun = false, mention = '', emoji = '', image = '', expectVideoId = '' } = {}) {
  // 发之前再确认一次页面没被抖音自己翻走：评论必须落在它读到的那条视频上。
  if (expectVideoId) {
    const current = await currentVideoId(page)
    if (!current || current !== String(expectVideoId)) {
      return { ok: false, reason: '当前视频已经不是要评论的那条了，这条没有发' }
    }
  }
  const open = await openComments(page)
  if (!open.ok) return { ok: false, reason: open.reason }
  // 打开评论区可能花了近一秒，期间页面仍可能被抖音自己翻走。
  if (expectVideoId) {
    const current = await currentVideoId(page)
    if (!current || current !== String(expectVideoId)) {
      return { ok: false, reason: '打开评论区时页面已经换了，这条评论没有发' }
    }
  }
  // 只点激活输入框，不清空（@ 已经插进去了要保住）
  const box = await commentInputRect(page)
  if (!box || typeof box.x !== 'number') return { ok: false, reason: '找不到评论输入框（可能改版）' }
  await mouseClick(page, box.x, box.y)
  await sleep(600)
  let mentioned = false
  if (mention) {
    const m = await fillMention(page, mention)
    if (!m.ok) return { ok: false, reason: m.reason }
    mentioned = true
  }
  const body = text ? (mentioned ? ` ${text}` : text) : ''
  if (body) { await page.cmd('Input.insertText', { text: body }).catch(() => {}) }
  await sleep(400)
  let withImage = false
  if (image) {
    // 评论图片走输入框右侧图片按钮的上传入口；直接 Ctrl+V 在 2026-11-13 实测不会插入。
    const uploaded = await uploadImageToComment(page, image)
    if (!uploaded.ok) return { ok: false, reason: uploaded.reason }
    withImage = true
  }
  let withEmoji = false
  let emojiReason = ''
  // 图和面板表情不同时上：一条评论最多一个表达层
  if (emoji && !withImage) {
    const picked = await addEmoji(page, emoji === true ? '微笑' : String(emoji || ''))
    if (picked.ok) withEmoji = picked.label
    else emojiReason = picked.reason || ''
  }
  await sleep(250)
  // 填字、选 @、挑表情都可能花几秒；按下发送前最后再核对一次页面。
  if (expectVideoId) {
    const current = await currentVideoId(page)
    if (!current || current !== String(expectVideoId)) {
      return { ok: false, reason: '发送前页面已经换了，这条评论没有发' }
    }
  }
  const sent = await sendComment(page, dryRun)
  return { ...sent, mentioned, emoji: withEmoji, emojiReason, image: withImage }
}

/** 回复某条评论：按「作者 + 文本」定位，找不到就不猜；可带文字表情或本地图片。 */
export async function replyToComment(page, target, text, { dryRun = false, image = '', emoji = '', expectVideoId = '', logger = null } = {}) {
  // 回复也要绑定视频：目标评论只存在于读到它的那条视频里，页面换了就不猜。
  if (expectVideoId) {
    const current = await currentVideoId(page)
    if (!current || current !== String(expectVideoId)) {
      return { ok: false, reason: '要回复的那条视频已经换了，这条回复没有发' }
    }
  }
  const open = await openComments(page)
  if (!open.ok) {
    // 真实详情页的评论项没有稳定选择器，但右侧只要已经有「回复」按钮，
    // 说明面板其实开着；这里不再被 openComments 的旧判据挡死。
    const hasReplyButtons = await evaluate(page, `(() => {
      const right = window.innerWidth * 0.55;
      return [...document.querySelectorAll('button,[role="button"],span,div')].some((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.top < window.innerHeight
          && r.left >= right && /^(回复|回复中|Reply)$/.test((el.innerText || '').trim());
      });
    })()`, false)
    if (!hasReplyButtons) return { ok: false, reason: open.reason }
  }
  // 同上：回复目标只在读到它的那条视频里存在。
  if (expectVideoId) {
    const current = await currentVideoId(page)
    if (!current || current !== String(expectVideoId)) {
      return { ok: false, reason: '打开评论区时页面已经换了，这条回复没有发' }
    }
  }
  // 详情页的评论面板有时先出容器、评论项晚半拍；已经有「回复」按钮就不用等。
  const replyButtonsReady = await evaluate(page, `(() => {
    const right = window.innerWidth * 0.55;
    return [...document.querySelectorAll('button,[role="button"],span,div')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.top < window.innerHeight
        && r.left >= right && /^(回复|回复中|Reply)$/.test((el.innerText || '').trim());
    });
  })()`, false)
  if (!replyButtonsReady) {
    for (let i = 0; i < 6; i++) {
      const has = await evaluate(page, `Boolean(document.querySelector('[data-e2e="comment-item"], .comment-item'))`, false)
      if (has) break
      await sleep(500)
    }
  }
  const rect = await evaluate(page, `(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const items = [...document.querySelectorAll('[data-e2e="comment-item"], .comment-item')];
    const author = norm(${JSON.stringify(String(target && target.author || ''))});
    const text = norm(${JSON.stringify(String(target && target.text || ''))});
    const textKey = text.slice(0, 12);
    const allOf = (el) => norm(el.innerText || el.textContent || '');
    let btn = null;
    let matchedBy = '';
    if (items.length) {
      const byAuthor = author ? items.filter((el) => allOf(el).includes(author)) : [];
      const byText = textKey ? items.filter((el) => allOf(el).includes(textKey)) : [];
      // 通知里点进来的评论通常在顶部高亮；正文是表情时读不到文字，只能靠作者。
      const item = byAuthor.find((el) => textKey && allOf(el).includes(textKey))
        || (byText.length === 1 ? byText[0] : null)
        || (byAuthor.length ? byAuthor[0] : null)
        || (byText.length ? byText[0] : null);
      if (item) {
        const buttons = [...item.querySelectorAll('button,[role="button"],span,div')];
        btn = buttons.find((b) => /^(回复|Reply)$/.test((b.innerText || '').trim())) || null;
        matchedBy = byAuthor.length ? 'author' : 'text';
      }
    }
    // 兜底：当前页面 class 是构建哈希，不保证 comment-item 一定在。
    // 从右侧评论面板里的「回复」按钮往上找上下文，按作者/正文匹配。
    if (!btn) {
      const cands = [];
      for (const b of document.querySelectorAll('button,[role="button"],span,div')) {
        if (!/^(回复|Reply)$/.test((b.innerText || '').trim())) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.left < window.innerWidth * 0.55) continue;
        let ctx = '';
        let p = b;
        for (let i = 0; i < 6 && p; i++, p = p.parentElement) ctx += ' ' + allOf(p);
        cands.push({ b, ctx, area: r.width * r.height });
      }
      cands.sort((a, b) => a.area - b.area);
      const hit = (author && textKey && cands.find((x) => x.ctx.includes(author) && x.ctx.includes(textKey)))
        || (author && cands.find((x) => x.ctx.includes(author)))
        || (textKey && cands.find((x) => x.ctx.includes(textKey)))
        || (cands.length === 1 ? cands[0] : null);
      if (hit) {
        btn = hit.b;
        matchedBy = 'fallback';
      }
    }
    if (!btn) return null;
    // 目标评论可能在面板底部、被输入区或浮层盖住；先滚到中间再取坐标。
    btn.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = btn.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const at = document.elementFromPoint(x, y);
    const clickable = Boolean(at && (at === btn || btn.contains(at)));
    return { x, y, matchedBy, clickable };
  })()`, null)
  if (!rect || typeof rect.x !== 'number') return { ok: false, reason: '找不到那条评论的「回复」按钮' }
  if (rect.clickable === false) return { ok: false, reason: '「回复」按钮被输入区或浮层挡住，没有点' }
  await sleep(250)
  await mouseClick(page, rect.x, rect.y)
  await sleep(550)
  let entered = await replyModeVisible(page, target && target.author)
  if (!entered) {
    await sleep(450)
    entered = await replyModeVisible(page, target && target.author)
  }
  if (!entered) {
    // 第一下可能落在高亮/透明层上；重新按同一位置补一次，补完仍然看不到回复态就明确失败，
    // 不再继续往一个没进入回复态的页面里塞字。
    await mouseClick(page, rect.x, rect.y)
    await sleep(650)
    entered = await replyModeVisible(page, target && target.author)
  }
  if (!entered) return { ok: false, reason: '点了「回复」但没进入回复状态' }
  const wantsText = Boolean(String(text || '').trim())
  if (wantsText) {
    const filled = await fillEditor(page, text)
    if (!filled) return { ok: false, reason: '找不到回复输入框，或文字没写进去' }
    await sleep(250)
  }
  let withEmoji = false
  let emojiReason = ''
  // 图和面板表情不同时上：一条回复最多一个表达层；优先用图。
  if (emoji && !image) {
    const picked = await addEmoji(page, emoji === true ? '微笑' : String(emoji || ''))
    if (picked.ok) withEmoji = picked.label
    else emojiReason = picked.reason || ''
  }
  let withImage = false
  if (image) {
    const uploaded = await uploadImageToComment(page, image)
    if (!uploaded.ok) return { ok: false, reason: uploaded.reason }
    withImage = true
  }
  if (expectVideoId) {
    const current = await currentVideoId(page)
    if (!current || current !== String(expectVideoId)) {
      return { ok: false, reason: '发送前页面已经换了，这条回复没有发' }
    }
  }
  const sent = await sendComment(page, dryRun, logger)
  return { ...sent, image: withImage, emoji: withEmoji, emojiReason }
}

/** 关注作者。已经关注过就跳过，不重复点。 */
export async function follow(page) {
  // 推荐页没有文字按钮，关注入口是头像旁边的小加号（feed-follow-icon）
  const plus = await clickFirst(page, ['[data-e2e="feed-follow-icon"]'], [])
  if (plus) {
    await sleep(400)
    return { ok: true, reason: '' }
  }
  const state = await evaluate(page, `(() => {
    const sels = ['[data-e2e="video-author-follow"]', '[data-e2e="user-follow"]', 'button[aria-label*="关注"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el || el.offsetParent === null) continue;
      const text = (el.innerText || el.textContent || '').trim();
      const label = String(el.getAttribute('aria-label') || '');
      if (/已关注|互相关注|following/i.test(text) || /已关注/.test(label)) return { found: true, active: true, sel: s };
      if (/关注|follow/i.test(text) || /关注/.test(label)) return { found: true, active: false, sel: s };
    }
    return { found: false, active: false, sel: '' };
  })()`, { found: false, active: false, sel: '' })
  if (!state.found) return { ok: false, reason: '找不到关注按钮（可能在作者主页或已改版）' }
  if (state.active) return { ok: true, skipped: 'already', reason: '' }
  const hit = await clickFirst(page, [state.sel], [])
  if (!hit) return { ok: false, reason: '关注按钮点不动' }
  await sleep(400)
  return { ok: true, reason: '' }
}

/** 从首页切到「推荐」。新版抖音默认停在「精选」，推荐入口在左侧导航（文字就是「推荐」）。 */
export async function openRecommend(page) {
  const hasNav = () => evaluate(page, `(() => [...document.querySelectorAll('a[href*="recommend"]')].some((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 }))()`, false)
  const onVideo = () => evaluate(page, `Boolean(document.querySelector('[data-e2e="feed-active-video"]'))`, false)
  const clickNav = () => evaluate(page, `(() => {
    const clickable = (n) => {
      if (!n || n.offsetParent === null) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const textOf = (n) => (n.innerText || n.textContent || '').trim();
    const nodes = [...document.querySelectorAll(
      '[role="tab"],[data-e2e*="tab"],a,button,[role="link"],nav *,header *,aside *,li,span,div'
    )];
    const hits = nodes.filter((n) => {
      if (textOf(n) !== '推荐') return false;
      if (!clickable(n)) return false;
      const r = n.getBoundingClientRect();
      const topTab = r.top < 240 && r.width < 200;
      const sideNav = r.left < 260 && r.width < 260 && r.height < 90;
      return topTab || sideNav;
    });
    if (!hits.length) return null;
    // 点最小的那个，避免点到包住整块导航的容器
    hits.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    const r = hits[0].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, null).then(async (rect) => {
    if (!rect || typeof rect.x !== 'number') return false
    await mouseClick(page, rect.x, rect.y)
    return true
  })

  // 页面可能还没加载：等左侧导航出现，最多 20 秒；在别的页面（搜索/主页）时先回首页
  let navReady = false
  for (let i = 0; i < 40; i++) {
    if (await hasNav()) { navReady = true; break }
    await sleep(500)
  }
  if (!navReady) {
    await page.cmd('Page.navigate', { url: 'https://www.douyin.com/' }).catch(() => {})
    for (let i = 0; i < 40; i++) {
      if (await hasNav()) break
      await sleep(500)
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await clickNav())) break
    // 点完要等推荐页的全屏播放器挂上来，最多 12 秒
    for (let i = 0; i < 24; i++) {
      await sleep(500)
      if (await onVideo()) return { ok: true, reason: '' }
    }
  }
  return { ok: false, reason: '没能切到「推荐」' }
}

/** 当前视频的播放状态：围观时按视频真实时长等它看完，而不是硬睡固定秒数。 */
export async function playbackState(page) {
  const v = await evaluate(page, `(() => {
    // 推荐页 DOM 里预加载了多个 video，必须锁在正在播的那一条上
    const feed = document.querySelector('[data-e2e="feed-active-video"]');
    const inFeed = feed ? (feed.tagName === 'VIDEO' ? feed : feed.querySelector('video')) : null;
    const v = inFeed || document.querySelector('video');
    if (!v) return { found: false };
    return {
      found: true,
      paused: v.paused === true,
      ended: v.ended === true,
      currentTime: Number(v.currentTime) || 0,
      duration: Number(v.duration) || 0,
    };
  })()`, { found: false })
  return v && typeof v === 'object' ? v : { found: false }
}

/** 只读当前视频 id，用来判断页面是不是自己滑走了。 */
export async function currentVideoId(page) {
  const id = await evaluate(page, ACTIVE_VIDEO_ID_JS, '')
  return String(id || '')
}

// 分享入口在视频右侧：搜索框、最近联系人、每位联系人右侧一个「分享」按钮。
// 这里只做页面动作；附言不在分享面板里（实测没有输入框），由值班服务端再走私信补发。
const SHARE_ICON_SELS = ['[data-e2e="video-share-icon-container"]', '[data-e2e="video-share-icon"]', '[data-e2e="video-player-share"]']
// 分享面板没有稳定的 class/data-e2e 名（实测是随机类名），只能按可见结构识别：
// 同时包含「分享给朋友」文字、可见搜索框和若干「分享」按钮的最小元素。
const SHARE_PANEL_FINDER_JS = `(() => {
  const visiblePanel = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth;
  };
  const visibleControl = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth;
  };
  const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const norm = (s) => String(s || '').replace(/\\s+/g, '').replace(/^@+/, '');
  const candidates = [];
  for (const el of document.querySelectorAll('div, section, form, [role="dialog"], [role="list"]')) {
    if (!visiblePanel(el) || !text(el).includes('分享给朋友')) continue;
    const inputs = [...el.querySelectorAll('input')].filter(visibleControl);
    if (!inputs.length) continue;
    const buttons = [...el.querySelectorAll('button, [role="button"], a, div, span')]
      .filter(visibleControl)
      .filter((b) => norm(b.innerText || b.textContent) === '分享' || norm(b.getAttribute('aria-label')) === '分享');
    if (!buttons.length) continue;
    const r = el.getBoundingClientRect();
    candidates.push({ el, area: r.width * r.height });
  }
  candidates.sort((a, b) => a.area - b.area);
  return candidates[0] ? candidates[0].el : null;
})()`
const SHARE_PANEL_JS = `(() => {
  const panel = ${SHARE_PANEL_FINDER_JS};
  return { ok: Boolean(panel) };
})()`
const SHARE_BUTTON_JS = (ownerName) => `(() => {
  const target = String(${JSON.stringify(String(ownerName || ''))}).trim().replace(/^@+/, '').replace(/\\s+/g, '');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth;
  };
  const norm = (s) => String(s || '').replace(/\\s+/g, '').replace(/^@+/, '');
  const firstLine = (el) => {
    const lines = String(el.innerText || el.textContent || '').split('\\n').map((x) => x.trim()).filter(Boolean);
    return lines[0] || '';
  };
  const panel = ${SHARE_PANEL_FINDER_JS};
  if (!panel) return { ok: false, reason: '分享面板没有打开' };
  const buttons = [...panel.querySelectorAll('button, [role="button"], a, div, span')]
    .filter(visible)
    .filter((b) => norm(b.innerText || b.textContent) === '分享' || norm(b.getAttribute('aria-label')) === '分享');
  const matches = [];
  for (const b of buttons) {
    let p = b.parentElement;
    for (let depth = 0; p && depth < 7; depth += 1, p = p.parentElement) {
      const line = norm(firstLine(p));
      if (line === target) {
        matches.push({ button: b, row: p });
        break;
      }
      if (p === panel) break;
    }
  }
  if (matches.length > 1) return { ok: false, ambiguous: true, reason: '分享面板里有多个同名联系人，不能猜' };
  if (matches.length === 1) {
    const r = matches[0].button.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), name: target };
  }
  // 最近联系人里没有主人时，用面板顶部的搜索框精确找一次；找不到也不退回第一个。
  const input = [...panel.querySelectorAll('input')].find(visible);
  if (input) {
    const r = input.getBoundingClientRect();
    return { ok: false, needSearch: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), reason: '主人不在最近联系人里' };
  }
  return { ok: false, reason: '分享面板里找不到主人' };
})()`

/** 只移动鼠标，不点击：分享入口靠 hover 弹层，直接点不会开。 */
export async function mouseHover(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.max(0, x - 24), y: Math.max(0, y - 18), button: 'none', clickCount: 0 }).catch(() => {})
  await sleep(60)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }).catch(() => {})
}

async function shareIconRect(page) {
  return evaluate(page, `(() => {
    const sels = ${JSON.stringify(SHARE_ICON_SELS)};
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
    }
    return null;
  })()`, null)
}

async function sharePanelOpen(page) {
  const r = await evaluate(page, SHARE_PANEL_JS, { ok: false })
  return Boolean(r && r.ok)
}

/** 在已打开的分享面板里按昵称找到主人那一行的「分享」按钮。 */
async function ownerShareButton(page, ownerName) {
  return evaluate(page, SHARE_BUTTON_JS(ownerName), { ok: false })
}

async function typeShareSearch(page, rect, name) {
  if (!rect || typeof rect.x !== 'number') return false
  await mouseClick(page, rect.x, rect.y)
  await sleep(180)
  await page.cmd('Input.insertText', { text: String(name || '').trim() }).catch(() => {})
  await sleep(900)
  return true
}

/**
 * 分享当前视频给主人：鼠标悬停分享图标 → 等面板 → 精确找昵称 → 点该行右侧「分享」。
 * 不随机、不退回第一个联系人、不点群聊；找不到主人就失败。
 * 面板里没有文字输入框，附言由 duty-server 另走主人私信补发。
 */
export async function forwardToOwner(page, ownerName) {
  const target = String(ownerName || '').trim().replace(/^@+/, '')
  if (!target) return { ok: false, reason: '没配主人昵称，不能分享' }

  let panelReady = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const icon = await shareIconRect(page)
    if (!icon) return { ok: false, reason: '找不到分享图标（可能在视频详情页之外）' }
    await mouseHover(page, icon.x, icon.y)
    await sleep(900)
    panelReady = await sharePanelOpen(page)
    if (panelReady) break
    await sleep(500)
  }
  if (!panelReady) return { ok: false, reason: '悬停分享图标后没有弹出「分享给朋友」面板' }

  let hit = await ownerShareButton(page, target)
  if (hit && hit.needSearch) {
    await typeShareSearch(page, hit, target)
    hit = await ownerShareButton(page, target)
  }
  if (!hit || !hit.ok) return { ok: false, reason: (hit && hit.reason) || `分享面板里找不到「${target}」` }

  await mouseClick(page, hit.x, hit.y)
  await sleep(1500)
  // 面板收起，或页面给出「已分享 / 分享成功」反馈，才算真的发出去。
  const closed = !(await sharePanelOpen(page))
  const toast = await evaluate(page, `(() => {
    const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return /分享成功|已分享|发送成功|已经分享/.test(t);
  })()`, false)
  if (!closed && !toast) {
    return { ok: false, reason: '点了主人右侧的分享按钮，但没有看到分享完成反馈' }
  }
  return { ok: true, reason: '', to: target }
}

/** 私信：从当前视频点作者进入主页 → 私信 → 输入 → 发送。 */
export async function sendDm(page, name, text, { dryRun = false } = {}) {
  const profile = await clickFirst(page, ['[data-e2e="video-author-name"]', '[data-e2e="user-name"]'], [])
  if (!profile) return { ok: false, reason: '点不到作者主页' }
  await sleep(900)
  const dm = await clickFirst(page, ['[data-e2e="user-dm"]'], ['私信'])
  if (!dm) return { ok: false, reason: '作者主页上找不到「私信」' }
  await sleep(700)
  const filled = await fillEditor(page, text)
  if (!filled) return { ok: false, reason: '找不到私信输入框' }
  if (dryRun) return { ok: true, dryRun: true, reason: '已填入，没有发送' }
  const sent = await clickFirst(page, ['[data-e2e="msg-send"]'], ['发送'])
  if (!sent) return { ok: false, reason: '找不到发送按钮' }
  await sleep(600)
  return { ok: true, reason: '' }
}

/** 打开指定视频页（执行待确认动作前用）。 */
export async function openVideo(page, url) {
  if (!url) return { ok: false, reason: '缺少视频链接' }
  await page.cmd('Page.navigate', { url }).catch(() => {})
  await sleep(2200)
  return { ok: true, reason: '' }
}

/** 点左侧导航里某个可见入口（按文字或链接找）。 */
async function clickNav(page, text, hrefPart) {
  const rect = await evaluate(page, `(() => {
    const visible = (n) => {
      if (!n || n.offsetParent === null) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const text = ${JSON.stringify(text)};
    const hrefPart = ${JSON.stringify(hrefPart || '')};
    const nodes = [...document.querySelectorAll('a,button,[role="tab"],[role="link"],nav *,aside *,header *,li,span,div')];
    const hit = nodes.find((n) => {
      if (!visible(n)) return false;
      const r = n.getBoundingClientRect();
      if (r.left > 300) return false;
      if (hrefPart && n.getAttribute && (n.getAttribute('href') || '').includes(hrefPart)) return true;
      return (n.innerText || '').trim() === text;
    });
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, null)
  if (!rect || typeof rect.x !== 'number') return false
  await mouseClick(page, rect.x, rect.y)
  return true
}

/**
 * 打开任意页面：recommend / following / me / search / video / url。
 * 这是「自由活动」的基础——不是只能一条条刷推荐。
 */
export async function openPage(page, kind = 'recommend', options = {}) {
  const target = String(kind || '').toLowerCase()
  if (target === 'url') {
    const url = String(options.url || '').trim()
    if (!url || !/^https?:\/\/([a-z0-9-]+\.)*douyin\.com\//i.test(url)) return { ok: false, reason: '只接受抖音域名下的链接' }
    await page.cmd('Page.navigate', { url }).catch(() => {})
    await sleep(2500)
    return { ok: true, page: 'url', url }
  }
  if (target === 'video') {
    const id = String(options.id || '').trim()
    if (!/^\d{6,}$/.test(id)) return { ok: false, reason: '视频 id 不对' }
    await page.cmd('Page.navigate', { url: `https://www.douyin.com/video/${id}` }).catch(() => {})
    await sleep(2500)
    return { ok: true, page: 'video', id }
  }
  if (target === 'search') {
    const q = String(options.q || '').trim()
    if (!q) return { ok: false, reason: '没给搜索词' }
    // 网页版搜索走自己的路由，先尝试搜索框，失败再退回 /search/<词>
    const typed = await evaluate(page, `(() => {
      const el = document.querySelector('[data-e2e="searchbar-input"] input, [data-e2e="searchbar-input"], input[type="search"], input[placeholder*="搜索"]');
      if (!el) return false;
      el.focus();
      return true;
    })()`, false)
    if (typed) {
      await evaluate(page, `(() => {
        const el = document.querySelector('[data-e2e="searchbar-input"] input, [data-e2e="searchbar-input"], input[type="search"], input[placeholder*="搜索"]');
        if (!el) return false;
        const q = ${JSON.stringify(q)};
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, q);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`, false)
      await sleep(3500)
      const url = await evaluate(page, 'location.href', '')
      if (String(url).includes('search')) return { ok: true, page: 'search', q, url: String(url) }
    }
    const url = `https://www.douyin.com/search/${encodeURIComponent(q)}`
    await page.cmd('Page.navigate', { url }).catch(() => {})
    await sleep(3000)
    return { ok: true, page: 'search', q, url }
  }
  if (target === 'me') {
    const clicked = await clickNav(page, '我的', '/user/self')
    if (!clicked) {
      await page.cmd('Page.navigate', { url: 'https://www.douyin.com/user/self' }).catch(() => {})
    }
    await sleep(3000)
    return { ok: true, page: 'me', reason: clicked ? '' : '直接打开了我的主页地址' }
  }
  if (target === 'following') {
    const clicked = await clickNav(page, '关注', '')
    await sleep(3000)
    return { ok: Boolean(clicked), page: 'following', reason: clicked ? '' : '找不到「关注」入口' }
  }
  const rec = await openRecommend(page)
  return { ...rec, page: 'recommend' }
}

/**
 * 读自己的账号资料：昵称 / 抖音号 / 签名 / 关注 / 粉丝 / 获赞。
 * 用可见文本解析，不依赖被混淆的类名。
 */
export async function readSelf(page) {
  const pathOf = () => evaluate(page, 'String(location.pathname || "")', '')
  const readCard = () => evaluate(page, `(() => {
    const n = document.querySelector('[data-e2e="user-info"]');
    return n ? (n.innerText || '') : '';
  })()`, '')
  const waitCard = async (rounds) => {
    for (let i = 0; i < rounds; i++) {
      const t = await readCard()
      if (t && t.trim()) return t
      await sleep(500)
    }
    return ''
  }

  let text = ''
  if (String(await pathOf()).startsWith('/user/self')) {
    text = await waitCard(20)
  } else {
    await clickNav(page, '我的', '/user/self')
    text = await waitCard(16)
  }
  // 路由慢了就直开地址再来一次（实测直接 navigate 比点击 SPA 路由更稳）
  if (!text) {
    await page.cmd('Page.navigate', { url: 'https://www.douyin.com/user/self' }).catch(() => {})
    text = await waitCard(24)
  }
  const body = String(text || '')
  if (!body.trim()) return { ok: false, reason: '没能读到自己的主页（可能没登录或页面没加载出来）' }
  const lines = body.split('\n').map((x) => x.trim()).filter(Boolean)
  const numFor = (label) => {
    const i = lines.indexOf(label)
    if (i >= 0 && lines[i + 1] && /^\d+$/.test(lines[i + 1])) return Number(lines[i + 1])
    const m = body.match(new RegExp(label + '\\s*(\\d+)'))
    return m ? Number(m[1]) : null
  }
  const idMatch = body.match(/抖音号[：:]\s*([^\s]+)/)
  const idIdx = lines.findIndex((l) => l.startsWith('抖音号'))
  // 签名在「抖音号」下一行；以前用「第一条不像标签的行」，会错抓成昵称
  const signature = idIdx >= 0 && lines[idIdx + 1] && !/^\d+$/.test(lines[idIdx + 1]) ? lines[idIdx + 1] : ''
  // 数字有时不在资料卡的 innerText 里，单独读三个统计元素
  const statNum = async (e2e) => {
    const t = String(await evaluate(page, `(() => { const n = document.querySelector('[data-e2e="${e2e}"]'); return n ? (n.innerText || '') : '' })()`, '')).trim()
    const m = t.match(/(\d+)/)
    return m ? Number(m[1]) : null
  }
  return {
    ok: true,
    nickname: lines[0] || '',
    douyinId: idMatch ? idMatch[1] : '',
    signature,
    following: numFor('关注') ?? await statNum('user-info-follow'),
    fans: numFor('粉丝') ?? await statNum('user-info-fans'),
    likes: numFor('获赞') ?? await statNum('user-info-like'),
    url: await evaluate(page, 'location.href', ''),
  }
}

/**
 * 改自己的昵称 / 签名。
 * 入口是昵称旁边的铅笔图标（点击后弹「编辑资料」：头像 / 名字 / 简介 / 保存）。
 * 头像上传留到「它的形象」那一步再做；这一步只改文字。
 */
export async function updateSelf(page, { nickname, signature } = {}) {
  const name = String(nickname || '').trim()
  const bio = String(signature || '').trim()
  if (!name && !bio) return { ok: false, reason: '没有要改的内容' }

  // 必须在自己的主页上，才有那支铅笔
  if (!(await evaluate(page, 'String(location.pathname || "").startsWith("/user/self")', false))) {
    await page.cmd('Page.navigate', { url: 'https://www.douyin.com/user/self' }).catch(() => {})
    await sleep(3000)
  }
  // 等资料卡挂上来
  for (let i = 0; i < 20; i++) {
    if (await evaluate(page, 'Boolean(document.querySelector("[data-e2e=\\"user-info\\"]"))', false)) break
    await sleep(500)
  }

  const opened = await evaluate(page, `(() => {
    const info = document.querySelector('[data-e2e="user-info"]');
    if (!info) return null;
    // 铅笔是资料卡里最小的那个 svg（24×24），外面包着可点的 span
    const svg = [...info.querySelectorAll('svg')].find((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.width <= 32 && r.height <= 32;
    });
    if (!svg) return null;
    const target = svg.closest('button,[role="button"],a') || svg.parentElement;
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, null)
  if (!opened || typeof opened.x !== 'number') return { ok: false, reason: '找不到昵称旁的编辑铅笔' }
  await mouseClick(page, opened.x, opened.y)

  // 等弹窗里的昵称输入框
  let dialogReady = false
  for (let i = 0; i < 25; i++) {
    await sleep(300)
    dialogReady = await evaluate(page, `(() => {
      return [...document.querySelectorAll('input')].some((n) => /记得填写昵称/.test(n.placeholder || '') && n.offsetParent !== null);
    })()`, false)
    if (dialogReady) break
  }
  if (!dialogReady) return { ok: false, reason: '「编辑资料」弹窗没弹出来' }

  const filled = await evaluate(page, `(() => {
    const dlg = [...document.querySelectorAll('div')].find((d) => {
      const t = (d.innerText || '').trim();
      return t.startsWith('编辑资料') && d.querySelector('input[placeholder="记得填写昵称"]');
    }) || document;
    const nameEl = dlg.querySelector('input[placeholder="记得填写昵称"]');
    // 简介是 Draft.js 富文本框（contenteditable），不是 textarea
    const bioEl = dlg.querySelector('[contenteditable="true"].public-DraftEditor-content, [contenteditable="true"], .public-DraftEditor-content');
    const setInput = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setRich = (el, v) => {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, v);
      return true;
    };
    const name = ${JSON.stringify(name)};
    const bio = ${JSON.stringify(bio)};
    const out = { hadName: Boolean(nameEl), hadBio: Boolean(bioEl), name: null, bio: null };
    if (name && nameEl) { setInput(nameEl, name); out.name = true; }
    else if (name) out.name = false;
    if (bio && bioEl) { out.bio = setRich(bioEl, bio); }
    else if (bio) out.bio = false;
    return out;
  })()`, null)
  if (filled && filled.name === false) return { ok: false, reason: '弹窗里找不到昵称输入框' }
  if (filled && filled.bio === false) return { ok: false, reason: '弹窗里找不到简介输入框' }
  await sleep(600)

  const clicked = await evaluate(page, `(() => {
    const dlg = [...document.querySelectorAll('div')].find((d) => {
      const t = (d.innerText || '').trim();
      return t.startsWith('编辑资料') && d.querySelector('input[placeholder="记得填写昵称"]');
    }) || document;
    const btn = [...dlg.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '保存');
    if (!btn) return { err: 'no-button' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(btn.className || ''))) return { err: 'disabled' };
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, null)
  if (!clicked || clicked.err) return { ok: false, reason: clicked && clicked.err === 'disabled' ? '保存按钮是灰的（内容可能没变化或被校验拦住）' : '没找到保存按钮' }
  await mouseClick(page, clicked.x, clicked.y)

  // 等弹窗消失
  let closed = false
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    closed = await evaluate(page, `(() => ![...document.querySelectorAll('input')].some((n) => /记得填写昵称/.test(n.placeholder || '') && n.offsetParent !== null))()`, false)
    if (closed) break
  }
  if (!closed) return { ok: false, reason: '点了保存但弹窗没关，可能没保存成功' }

  const after = await readSelf(page)
  const changed = []
  if (name && after.ok && after.nickname === name) changed.push('昵称')
  if (bio && after.ok && after.signature === bio) changed.push('签名')
  return {
    ok: true,
    changed,
    self: after.ok ? { nickname: after.nickname, signature: after.signature, douyinId: after.douyinId } : null,
    note: changed.length ? '' : '保存后回读和写入值不完全一致，可能被平台审核或长度限制改了',
  }
}
