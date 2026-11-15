// ============================================================
// 回评论的通知入口：顶部右侧「通知」悬停浮层
// ------------------------------------------------------------
// 2026-11 的真实页面不是点开一个固定消息面板，而是：
//   鼠标移到顶部「通知」-> 出现「互动消息」浮层 -> 移开就收起。
// 浮层里混着关注、点赞、评论；只有头像右下角带蓝色小标的是评论。
// 未读的新评论还会在头像上带一个红点。
//
// 这个模块只负责「看通知、挑评论、点文字进视频、关掉视频回推荐」，
// 不生成回复、不决定回不回；那些在 comment-listener 里做。
// ============================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function evaluate(page, expression, fallback = null) {
  try {
    const r = await page.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r && r.result ? r.result.value : fallback
  } catch {
    return fallback
  }
}

async function mouseClick(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }).catch(() => {})
  await sleep(60)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
  await sleep(45)
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
}

async function mouseMove(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }).catch(() => {})
}

const PANEL_JS = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 240 && r.height >= 180 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  };
  const cands = [];
  for (const el of document.querySelectorAll('div,aside,section')) {
    const t = (el.innerText || '').trim();
    if (!t.includes('互动消息') || !t.includes('全部消息')) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 620 || r.height > window.innerHeight) continue;
    cands.push({ el, r, area: r.width * r.height });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.area - b.area);
  const r = cands[0].r;
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
})()`

const BELL_JS = `(() => {
  const parseColor = (s) => {
    const m = String(s || '').match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i);
    return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
  };
  const reddish = (el) => {
    const c = parseColor(getComputedStyle(el).backgroundColor) || parseColor(getComputedStyle(el).color);
    const fill = String(el.getAttribute && (el.getAttribute('fill') || '') || '');
    const fm = fill.match(/#([0-9a-f]{6})/i);
    const fc = fm ? { r: parseInt(fm[1].slice(0,2),16), g: parseInt(fm[1].slice(2,4),16), b: parseInt(fm[1].slice(4,6),16) } : null;
    const x = c || fc;
    return Boolean(x && x.r > 175 && x.r > x.g + 60 && x.r > x.b + 60);
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < 150 && r.left > window.innerWidth * 0.45;
  };
  const cands = [];
  for (const n of document.querySelectorAll('button,a,div,span')) {
    const t = (n.innerText || '').trim();
    const label = String(n.getAttribute('aria-label') || n.getAttribute('title') || '').trim();
    if (t !== '通知' && !/^通知$/.test(label)) continue;
    if (!visible(n)) continue;
    const r = n.getBoundingClientRect();
    // 取面积最小的那个：图标按钮本身，不是整条顶栏
    if (r.width > 220 || r.height > 80) continue;
    cands.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), area: r.width * r.height, el: n, r });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.area - b.area);
  const bell = cands[0];
  // 未读红点可能在铃铛按钮内部，也可能挂在按钮外层容器上；只在铃铛附近找，
  // 避免把页面别处的红点误当成通知。真实页面是铃铛右上角的 8x8 红点。
  let unread = false;
  let dot = null;
  const near = (b) => {
    const r = bell.r;
    return b.left >= r.left - 20 && b.right <= r.right + 20
      && b.top >= r.top - 20 && b.bottom <= r.bottom + 20;
  };
  let scope = bell.el;
  for (let i = 0; i < 4 && scope; i++, scope = scope.parentElement) {
    for (const n of scope.querySelectorAll('div,span,i,svg,circle')) {
      const b = n.getBoundingClientRect();
      if (b.width < 4 || b.width > 18 || b.height < 4 || b.height > 18) continue;
      if (!near(b) || !reddish(n)) continue;
      unread = true;
      dot = { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) };
      break;
    }
    if (unread) break;
  }
  return { x: bell.x, y: bell.y, w: bell.w, h: bell.h, unread, dot };
})()`

/**
 * 读顶部「通知」入口的未读红点。面板打开时平台可能暂时不显示新通知的红点，
 * 所以正常轮询必须先让鼠标离开、浮层收起，再用这个函数判断。
 */
export async function readBell(page) {
  let bell = await evaluate(page, BELL_JS, null)
  if (!bell) {
    // 顶栏可能还在挂载；等两拍再找一次
    await sleep(1200)
    bell = await evaluate(page, BELL_JS, null)
  }
  if (!bell || typeof bell.x !== 'number') return null
  return bell
}

/**
 * 悬停打开互动消息浮层。返回浮层矩形；打不开就返回原因。
 * 不点击「通知」：点它进的是完整消息中心，不是这里的互动消息浮层。
 */
export async function openNotificationPanel(page) {
  const panel = await evaluate(page, PANEL_JS, null)
  if (panel) return { ok: true, panel, alreadyOpen: true }
  const bell = await readBell(page)
  if (!bell) return { ok: false, reason: '顶栏上找不到「通知」入口' }
  for (let i = 0; i < 3; i++) {
    await mouseMove(page, bell.x, bell.y)
    await sleep(900)
    const now = await evaluate(page, PANEL_JS, null)
    if (now) return { ok: true, panel: now, bell }
  }
  return { ok: false, reason: '鼠标移到「通知」后，互动消息浮层没有出现', bell }
}

/** 鼠标移开，让悬停浮层自己收起。 */
export async function closeNotificationPanel(page) {
  await mouseMove(page, 2, 2)
  await sleep(500)
}

const ROWS_JS = `(() => {
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const parseColor = (s) => {
    const m = String(s || '').match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i);
    return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
  };
  const blueish = (el) => {
    const c = parseColor(getComputedStyle(el).backgroundColor) || parseColor(getComputedStyle(el).color);
    const fill = String(el.getAttribute && (el.getAttribute('fill') || '') || '');
    const fm = fill.match(/#([0-9a-f]{6})/i);
    const fc = fm ? { r: parseInt(fm[1].slice(0,2),16), g: parseInt(fm[1].slice(2,4),16), b: parseInt(fm[1].slice(4,6),16) } : null;
    const x = c || fc;
    return Boolean(x && x.b > 110 && x.b > x.r + 30 && x.b > x.g + 5);
  };
  const reddish = (el) => {
    const c = parseColor(getComputedStyle(el).backgroundColor) || parseColor(getComputedStyle(el).color);
    const fill = String(el.getAttribute && (el.getAttribute('fill') || '') || '');
    const fm = fill.match(/#([0-9a-f]{6})/i);
    const fc = fm ? { r: parseInt(fm[1].slice(0,2),16), g: parseInt(fm[1].slice(2,4),16), b: parseInt(fm[1].slice(4,6),16) } : null;
    const x = c || fc;
    return Boolean(x && x.r > 175 && x.r > x.g + 60 && x.r > x.b + 60);
  };
  const commentish = (el) => {
    // 真实评论小标是深色底 + 渐变 SVG（fill: url(#commentIcon_svg__paint0_linear...)），
    // 不是纯蓝色背景，所以不能只看 background/color。
    const fill = String(el.getAttribute && (el.getAttribute('fill') || '') || '');
    const id = String(el.id || '');
    const cls = String(el.getAttribute && (el.getAttribute('class') || '') || '');
    return /comment/i.test(fill) || /comment/i.test(id) || /comment/i.test(cls);
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  };
  const panel = (() => {
    const cands = [];
    for (const el of document.querySelectorAll('div,aside,section')) {
      const t = (el.innerText || '').trim();
      if (!t.includes('互动消息') || !t.includes('全部消息')) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 240 || r.width > 620 || r.height < 180 || r.height > window.innerHeight) continue;
      cands.push({ el, r, area: r.width * r.height });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.area - b.area);
    return cands[0].el;
  })();
  if (!panel) return { ok: false, reason: '互动消息浮层不在页面上', rows: [] };
  const pr = panel.getBoundingClientRect();
  const typeRe = /(评论了你的作品|回复了你的评论|评论了你|回复了你|评论了你的视频|回复了你的视频)/;
  const timeRe = /(刚刚|\\d{1,2}:\\d{2}|\\d+\\s*分钟前|\\d+\\s*小时前|昨天[^\\n]*|前天[^\\n]*|\\d+\\s*天前)/;
  const rawRows = [];
  for (const el of panel.querySelectorAll('div,li,article')) {
    const text = norm(el.innerText);
    if (!typeRe.test(text)) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < pr.width * 0.62 || r.width > pr.width + 8) continue;
    if (r.height < 50 || r.height > 190) continue;
    // 整条通知必须带着左边的头像；只有文字的子容器会在后面把蓝标/红点丢掉。
    const hasAvatar = [...el.querySelectorAll('img,div')].some((n) => {
      const b = n.getBoundingClientRect();
      if (b.width < 28 || b.width > 62 || b.height < 28 || b.height > 62) return false;
      if (b.left >= r.left + 90) return false;
      if (n.tagName === 'IMG') return true;
      const bg = getComputedStyle(n).backgroundImage || '';
      return /url\\(/.test(bg);
    });
    if (!hasAvatar) continue;
    rawRows.push({ el, r, area: r.width * r.height, top: r.top });
  }
  rawRows.sort((a, b) => b.area - a.area);
  const rows = [];
  for (const c of rawRows) {
    if (rows.some((x) => Math.abs(x.top - c.top) < 12)) continue;
    rows.push(c);
  }
  rows.sort((a, b) => a.top - b.top);
  const out = [];
  for (const { el, r } of rows.slice(0, 10)) {
    const rawText = String(el.innerText || '');
    const lines = rawText.split('\\n').map((s) => norm(s)).filter(Boolean);
    const typeLine = lines.find((s) => typeRe.test(s)) || '';
    const typeIndex = lines.findIndex((s) => typeRe.test(s));
    const typeText = (typeLine.match(typeRe) || [''])[0];
    const time = (typeLine.match(timeRe) || [''])[0];
    const nameLine = lines[0] || '';
    const name = nameLine.replace(/^(朋友|粉丝|互相关注)\\s*/g, '').replace(/\\s*(朋友|粉丝|互相关注)$/g, '').trim();
    const contentLines = lines.slice(0, typeIndex < 0 ? lines.length : typeIndex)
      .filter((s) => s !== nameLine)
      .filter((s) => !/^(朋友|粉丝|互相关注|作者|置顶|收起|展开)$/.test(s));
    const text = norm(contentLines.join(' ')) || '';
    const avatar = (() => {
      const nodes = [...el.querySelectorAll('img,div')].map((n) => ({ n, r: n.getBoundingClientRect() }))
        .filter((x) => x.r.width >= 28 && x.r.width <= 62 && x.r.height >= 28 && x.r.height <= 62 && x.r.left < r.left + 90)
        .filter((x) => x.n.tagName === 'IMG' || /url\\(/.test(getComputedStyle(x.n).backgroundImage || ''));
      if (!nodes.length) return null;
      nodes.sort((a, b) => a.r.left - b.r.left);
      return nodes[0];
    })();
    const avatarR = avatar ? avatar.r : null;
    const avatarAlt = avatar ? norm(avatar.n.getAttribute?.('alt') || avatar.n.getAttribute?.('title') || '') : '';
    let commentBadge = false;
    let unread = false;
    let videoThumb = '';
    for (const n of el.querySelectorAll('div,span,i,svg,img,path,circle')) {
      const b = n.getBoundingClientRect();
      if (b.width < 5 || b.height < 5) continue;
      // 真实页面的蓝标在头像右下角（深色底 + 蓝渐变图标），也可能在左下角。
      if (avatarR && b.width >= 10 && b.width <= 26 && b.height >= 10 && b.height <= 26
        && b.left <= avatarR.right + 10 && b.right >= avatarR.left - 10
        && b.top >= avatarR.top + avatarR.height * 0.38 && b.top <= avatarR.bottom + 8
        && (blueish(n) || commentish(n))) commentBadge = true;
      // 未读红点在真实页面的头像右上角，旧版在左上角；四角附近都认。
      if (avatarR && b.width >= 5 && b.width <= 18 && b.height >= 5 && b.height <= 18
        && b.left >= avatarR.left - 18 && b.right <= avatarR.right + 18
        && b.top >= avatarR.top - 18 && b.bottom <= avatarR.bottom + 8
        && reddish(n)) unread = true;
      if (n.tagName === 'IMG') {
        const src = String(n.currentSrc || n.getAttribute('src') || '');
        if (src && b.width >= 32 && b.width <= 90 && b.height >= 32 && b.height <= 90 && b.left > r.left + r.width * 0.6) videoThumb = src;
      }
    }
    // 头像的 alt 通常就是作者名；列表首行有时会把徽标带进来
    if (avatarAlt && (!name || name.length < 2)) name = avatarAlt;
    // 点文字，不点头像：在评论正文那块找可点的文本矩形
    const textRect = (() => {
      const needle = text || '[表情]';
      let best = null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = null;
      while ((node = walker.nextNode())) {
        const s = norm(node.nodeValue);
        if (!s) continue;
        if (!needle.includes(s.slice(0, 10)) && !s.includes(needle.slice(0, 10))) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const b = range.getBoundingClientRect();
        if (b.width < 10 || b.height < 8) continue;
        // 昵称也可能在头像右边，而且点昵称会进主页；评论文字一般不在 /user/ 链接里。
        if (node.parentElement && node.parentElement.closest && node.parentElement.closest('a[href*="/user/"]')) continue;
        if (avatarR && b.left < avatarR.right + 8) continue;
        if (!best || Math.abs((b.top + b.height / 2) - (r.top + r.height * 0.52)) < Math.abs((best.top + best.height / 2) - (r.top + r.height * 0.52))) {
          best = b;
        }
      }
      if (best) return { x: Math.round(best.left + best.width / 2), y: Math.round(best.top + best.height / 2) };
      return null;
    })();
    const click = textRect || {
      x: Math.round(Math.max(avatarR ? avatarR.right + 24 : r.left + 80, r.left + 70)),
      y: Math.round(r.top + r.height * 0.52),
    };
    out.push({
      name: name || avatarAlt,
      text: text.slice(0, 180),
      type: typeText,
      time,
      commentBadge,
      unread,
      videoThumb,
      row: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      click: { x: Math.round(click.x), y: Math.round(click.y) },
    });
  }
  return { ok: true, rows: out, panel: { x: Math.round(pr.left), y: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) } };
})()`

/** 读当前悬停浮层里的评论通知。默认没有浮层时先悬停。 */
export async function readNotificationComments(page, { openIfNeeded = true } = {}) {
  if (openIfNeeded) {
    const opened = await openNotificationPanel(page)
    if (!opened.ok) return { ok: false, rows: [], reason: opened.reason }
  } else {
    const panel = await evaluate(page, PANEL_JS, null)
    if (!panel) return { ok: false, rows: [], reason: '互动消息浮层不在页面上' }
  }
  const v = await evaluate(page, ROWS_JS, null)
  if (!v || typeof v !== 'object') return { ok: false, rows: [], reason: '互动消息浮层读不出结构' }
  if (!v.ok) return { ok: false, rows: [], reason: v.reason || '互动消息浮层读不出来' }
  return { ok: true, rows: Array.isArray(v.rows) ? v.rows : [], panel: v.panel || null }
}

function modalIdFromUrl(url) {
  try {
    const u = new URL(String(url || ''))
    return u.searchParams.get('modal_id') || (String(u.pathname || '').match(/\/video\/(\d+)/) || [])[1] || ''
  } catch {
    return ''
  }
}

const DETAIL_JS = `(() => {
  const m = (location.pathname || '').match(/\\/video\\/(\\d+)/);
  const modal = new URLSearchParams(location.search || '').get('modal_id') || '';
  const panel = [...document.querySelectorAll('.comment-input-inner-container, .comment-input-container, [data-e2e="comment-item"], .comment-item')].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 100 && r.height >= 16 && r.bottom > 0 && r.top < window.innerHeight;
  });
  return { videoId: (m && m[1]) || modal || '', panel: Boolean(panel), url: location.href };
})()`

/** 点一条通知的评论文字，等视频详情/评论面板出来。 */
export async function openNotificationVideo(page, item) {
  if (!item || !item.click || typeof item.click.x !== 'number') return { ok: false, reason: '这条通知没有可点的文字位置' }
  const row = item.row || {}
  // 先点正文文字；点不进去再点这条通知的正文区（仍然避开左侧头像）。
  const attempts = [item.click]
  if (typeof row.x === 'number' && typeof row.y === 'number' && typeof row.width === 'number') {
    const fallback = {
      x: Math.round(row.x + Math.max(90, row.width * 0.58)),
      y: Math.round(row.y + row.height * 0.62),
    }
    if (Math.abs(fallback.x - item.click.x) > 4 || Math.abs(fallback.y - item.click.y) > 4) attempts.push(fallback)
  }
  const beforeUrl = String(await evaluate(page, 'location.href', '') || '')
  for (let a = 0; a < attempts.length; a++) {
    const point = attempts[a]
    await mouseClick(page, point.x, point.y)
    let navigated = false
    for (let i = 0; i < 10; i++) {
      await sleep(400)
      const state = await evaluate(page, DETAIL_JS, null)
      if (state && (state.videoId || state.panel)) {
        await sleep(500)
        return { ok: true, videoId: String(state.videoId || ''), url: String(state.url || ''), attempts: a + 1, point }
      }
      const url = String(await evaluate(page, 'location.href', '') || '')
      if (url !== beforeUrl) {
        navigated = true
        break
      }
    }
    if (navigated) {
      // 页面已经跳走，但详情 DOM 可能还没挂完；先短等一下再认一次。
      // 此时绝不能再按原来的通知坐标点第二下：那个坐标在新页面上可能是别的按钮。
      await sleep(1200)
      const late = await evaluate(page, DETAIL_JS, null)
      if (late && (late.videoId || late.panel)) {
        return { ok: true, videoId: String(late.videoId || ''), url: String(late.url || ''), attempts: a + 1, point, late: true }
      }
      return { ok: false, reason: `点击后页面跳走了，但没有认出视频详情（当前 ${String(await evaluate(page, 'location.href', '') || '')}）` }
    }
    const panelStillOpen = Boolean(await evaluate(page, PANEL_JS, null))
    if (!panelStillOpen) {
      // 浮层被点击收起了，说明这一下已经触发了页面切换，不能再补点。
      // 抖音详情有时比浮层晚一截挂出来，给详情 DOM 一个短暂的收尾时间。
      await sleep(1200)
      const late = await evaluate(page, DETAIL_JS, null)
      if (late && (late.videoId || late.panel)) {
        return { ok: true, videoId: String(late.videoId || ''), url: String(late.url || ''), attempts: a + 1, point, late: true }
      }
      return { ok: false, reason: '点击后通知浮层已经收起，但没有认出视频详情' }
    }
  }
  const url = await evaluate(page, 'location.href', '')
  return { ok: false, reason: `点了评论文字，但没有进入视频详情（当前 ${String(url || '')}）` }
}

// 视频详情左上角的大圆叉。它才是真正退出详情的关闭键；
// 右上角的小叉只关评论面板，点完 URL 里还会留着 modal_id。
const LEFT_CLOSE_POINT = { x: 60, y: 62 }

function isRecommendHome(url) {
  try {
    const u = new URL(String(url || ''))
    // 带 modal_id 的根路径仍然是视频详情；只认没有详情的推荐首页，否则关详情会变成空操作。
    return /(^|\.)douyin\.com$/i.test(u.hostname)
      && (u.pathname === '/' || u.pathname === '')
      && !u.searchParams.get('modal_id')
  } catch {
    return false
  }
}

/**
 * 把标签页确定地拉回推荐首页。
 * 共享标签页的历史里可能有 about:blank，不能用 history.back() 猜；
 * 直接导航到首页，既不会退到空白页，也保证下一轮还能从顶部通知继续。
 */
export async function ensureRecommendPage(page) {
  const before = String(await evaluate(page, 'location.href', '') || '')
  if (isRecommendHome(before)) return { ok: true, url: before, navigated: false }
  await page.cmd('Page.navigate', { url: 'https://www.douyin.com/' }).catch(() => {})
  await sleep(1600)
  const after = String(await evaluate(page, 'location.href', '') || '')
  return isRecommendHome(after)
    ? { ok: true, url: after, navigated: true }
    : { ok: false, url: after, navigated: true, reason: `没能回到推荐首页（当前 ${after}）` }
}

/** 关掉视频详情，回到原来的页面；评论区/浮层也一并收起。 */
export async function closeNotificationVideo(page) {
  const before = String(await evaluate(page, 'location.href', '') || '')
  // 页面已经没有 modal_id 时不要按坐标乱点，否则可能点到左侧导航。
  if (!modalIdFromUrl(before)) {
    if (isRecommendHome(before)) return { ok: true, url: before, via: 'already-home' }
    const home = await ensureRecommendPage(page)
    await closeNotificationPanel(page)
    return home.ok
      ? { ok: true, url: home.url, via: 'no-modal-navigate' }
      : { ok: false, reason: `页面没有视频详情，也没能回到推荐首页（当前 ${home.url}）` }
  }
  // 视频详情左上角的大圆叉就是返回键，直接点这里。
  // 不再扫描右上角小叉：那个通常只关评论面板，会把页面留成 ?modal_id=...。
  await mouseClick(page, LEFT_CLOSE_POINT.x, LEFT_CLOSE_POINT.y)
  await sleep(900)
  let url = String(await evaluate(page, 'location.href', '') || '')
  if (!modalIdFromUrl(url)) {
    // 左上角大叉已经退出详情，回到它原来的页面（可能是推荐、个人页或视频页）。
    // 回评论监听下一轮会用 ensureRecommendPage 决定是否需要顶部通知入口。
    await closeNotificationPanel(page)
    return { ok: true, url, via: 'left-close' }
  }
  // 兜底：左叉没把详情关掉时，直接回推荐首页；不再猜第二个关闭键。
  // 不用 history.back()：共享标签页的历史里可能有 about:blank，退两次就退到空白页。
  const home = await ensureRecommendPage(page)
  await closeNotificationPanel(page)
  if (!home.ok) return { ok: false, reason: `关了视频详情但页面仍停在 ${home.url}` }
  return { ok: true, url: home.url, via: 'left-close-fallback' }
}

/** 当前页面的 modal_id（没有就空）。 */
export async function currentModalVideoId(page) {
  const url = await evaluate(page, 'location.href', '')
  return modalIdFromUrl(url)
}
