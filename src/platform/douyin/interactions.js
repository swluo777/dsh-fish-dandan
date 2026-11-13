// ============================================================
// 互动消息：评论回复 / @ 我的 / 赞
//
// 私信能轮询是因为有独立收件箱列表；评论回复没有同样的清单，
// 唯一能"接住别人回我"的地方就是消息面板里的「互动消息」。
//
// 这里只做三件事：
//   1. 打开消息面板，切到「互动消息」；
//   2. 读列表（谁、说了什么、哪个视频）；
//   3. 把新条目交给值班，让它回到那条视频去回。
// 页面一改版就可能读不到，所以任何一步失败都返回原因，绝不假装成功。
// ============================================================

import { closeInbox, evalJs, openInbox } from './inbox.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

const TABS = ['互动消息', '评论和@', '评论和@我', '提到我的']

/** 打开消息面板并切到「互动消息」。 */
export async function openInteractions(page) {
  const opened = await openInbox(page)
  if (!opened) return { ok: false, reason: '打不开消息面板' }
  const hit = await evalJs(page, `(() => {
    const tabs = ${JSON.stringify(TABS)};
    const nodes = [...document.querySelectorAll('div,span,a,button,li')];
    for (const t of tabs) {
      const el = nodes.find((n) => (n.innerText || '').trim() === t);
      if (el) { el.click(); return t; }
    }
    return '';
  })()`)
  if (!hit) return { ok: false, reason: '消息面板里没找到「互动消息」入口' }
  await sleep(1200)
  return { ok: true, tab: hit }
}

/**
 * 读「互动消息」列表。返回按文本切出来的条目，交给模型自己判断哪条要回。
 * @returns {{ ok: boolean, items: Array<{text: string, at: number}>, reason?: string }}
 */
export async function readInteractions(page, { limit = 8 } = {}) {
  const opened = await openInteractions(page)
  if (!opened.ok) {
    try { await closeInbox(page) } catch { /* 忽略 */ }
    return { ok: false, items: [], reason: opened.reason }
  }
  try {
    const raw = await evalJs(page, `(() => {
      const box = document.querySelector('.imContainer') || document.body;
      const nodes = [...box.querySelectorAll('div,li')];
      // 取"有文字、不是容器壳"的最内层块，按出现顺序去重
      const out = [];
      const seen = new Set();
      for (const n of nodes) {
        const t = (n.innerText || '').trim();
        if (!t || t.length < 4 || t.length > 300) continue;
        if (n.children && n.children.length > 3) continue;
        const key = t.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= 40) break;
      }
      return out;
    })()`) || []
    const items = raw.slice(0, limit).map((text) => ({ text, at: Date.now() }))
    return { ok: true, items, tab: opened.tab }
  } catch (err) {
    return { ok: false, items: [], reason: `读互动消息失败：${err.message}` }
  } finally {
    try { await closeInbox(page) } catch { /* 忽略 */ }
  }
}

/** 条目去重用的稳定键（页面上的时间会变，只比正文）。 */
export function interactionKey(item) {
  return String((item && item.text) || '').replace(/\s+/g, ' ').slice(0, 80)
}
