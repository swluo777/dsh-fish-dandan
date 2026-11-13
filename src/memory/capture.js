// ============================================================
// 对话内容自动进记忆：闸门 + 宿主 payload 防御式提取
//
// 借鉴（只借机制与数值，不复制代码）：
//   - Yuuyuko-uu/dsh-fish-memory「一天最多 8 条、装好即默认开启」
//   - menglimi/astrbot_plugin_memory_companion 2.2.0 断言闸门
//     （转述他人 / 角色扮演台词 / 临时状态 / 未兑现打算 一律不写）
//
// 全部是纯函数，不碰存储、不碰网络，可单测、可复现。
// 注意：宿主 pre-step 的 payload 结构不公开，extractUserText 只做
// 多路径试探；拿不到就静默跳过，绝不猜测、绝不把工具输出当成用户的话。
// ============================================================

/** 值得长期记住的信号：命中任一才有资格入库。 */
export const CAPTURE_SIGNALS = [
  /记住|记一下|别忘了|别忘|帮我记|要记得/,
  /约定|说好了|答应|承诺|下次|以后|我们说好/,
  /第一次|头一回|最开始|初次/,
  /^我叫|^我的名字|叫我.{1,12}就好|叫我/,
  /(?:我|俺|本人).{0,4}(?:喜欢|讨厌|不喜欢|偏好|习惯|过敏|不能|受不了)|^(?:喜欢|讨厌|受不了)/,
  /生日|纪念日|纪念日|周年/,
  /重要|千万|一定要|务必/,
]

/** 明确不该写进长期记忆：转述、假设、没兑现的打算、临时状态。 */
export const CAPTURE_EXCLUDES = [
  /^(他说|她说|他们说|据说|听说|有人说|网上说|别人说)/,
  /假如|如果|要是|万一|假设|比如说|举个例子/,
  /打算|准备|可能会|也许会|以后再说|改天|回头再/,
  /^(现在|刚才|此刻|刚刚).{0,6}(在|正在)/,
  /^(好的|嗯|哦|收到|明白|了解|谢谢|辛苦了|哈哈哈)[。！!~～\s]*$/,
  /```|<[a-z][\s\S]*>/i,
]

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim()

/**
 * 判断一句话值不值得记。
 * @param {string} text
 * @param {{ quotaLeft?: number, minLength?: number, maxLength?: number }} [options]
 * @returns {{ ok: boolean, reason: string, importance: number }}
 */
export function shouldCapture(text, { quotaLeft = 8, minLength = 8, maxLength = 300 } = {}) {
  const s = clean(text)
  if (!s) return { ok: false, reason: '空内容', importance: 0 }
  if (quotaLeft <= 0) return { ok: false, reason: '今日配额已用完', importance: 0 }
  if (s.length < minLength) return { ok: false, reason: '太短', importance: 0 }
  if (s.length > maxLength) return { ok: false, reason: '太长（像整段文章）', importance: 0 }
  if (/^【|^\s*\[系统|^system:/i.test(s)) return { ok: false, reason: '像是注入内容', importance: 0 }
  for (const re of CAPTURE_EXCLUDES) {
    if (re.test(s)) return { ok: false, reason: '转述/假设/临时状态/客套', importance: 0 }
  }
  if (!CAPTURE_SIGNALS.some((re) => re.test(s))) {
    return { ok: false, reason: '没有值得长期记住的信息', importance: 0 }
  }
  // 命中越多信号越重要，交给记忆层已有的 autoImportance 再做二次判断
  const hits = CAPTURE_SIGNALS.filter((re) => re.test(s)).length
  return {
    ok: true,
    reason: '命中长期信息信号',
    importance: Math.min(8, 5 + hits),
  }
}

/**
 * 从宿主事件 payload 里防御式地取「用户这一轮说的话」。
 * 结构不公开，因此只认明确的文本形状；任何不确定都返回空串。
 */
export function extractUserText(payload) {
  if (typeof payload === 'string') return clean(payload).slice(0, 2000)
  if (!payload || typeof payload !== 'object') return ''

  const candidates = [
    payload.userMessage,
    payload.currentUserMessage,
    payload.input?.text,
    payload.message?.content,
    payload.content,
    payload.text,
    payload.agent?.session?.lastUserMessage,
    Array.isArray(payload.messages) ? payload.messages[payload.messages.length - 1]?.content : null,
  ]
  for (const raw of candidates) {
    const text = textFrom(raw)
    if (text) return text.slice(0, 2000)
  }
  return ''
}

function textFrom(raw) {
  if (typeof raw === 'string') return clean(raw)
  if (Array.isArray(raw)) {
    // 多模态 content 数组只取文本段
    return raw.map(textFrom).filter(Boolean).join(' ').trim()
  }
  if (raw && typeof raw === 'object') {
    if (typeof raw.text === 'string') return clean(raw.text)
    if (raw.type === 'text' && typeof raw.content === 'string') return clean(raw.content)
    // 只接受明确标成 user 的消息，避免把助手回复/工具输出记成用户的话
    if (raw.role === 'user') return textFrom(raw.content ?? raw.text)
  }
  return ''
}
