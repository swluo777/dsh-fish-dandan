// ============================================================
// 私信出站账本：值班主动发、监听被动回，都往这里记一笔。
//
// 为什么需要它：
//   - 监听轮询收件箱时，会话列表的「最后一条」会变成我们自己刚发出去的话；
//   - 如果不过滤，监听会把自己的回复当成新私信，再回一遍，甚至无限循环；
//   - 值班和监听是两个进程/两条链路，必须共用一个落盘账本，不能各记各的内存。
//
// 记录只保留最近 10 分钟、最多 200 条；只用于「这条预览是不是我们自己刚说的」，
// 不参与任何内容生成，也不当作对话上下文。
// ============================================================

import { fromRoot } from '../../utils/paths.js'
import { appendJsonl, readJsonl } from '../../utils/json.js'

const TTL_MS = 10 * 60_000
const MAX_ROWS = 200

function normalize(text) {
  return String(text || '')
    .replace(/[\u200b-\u200f\s]+/g, ' ')
    .trim()
}

export function createOutboundLog({ path = fromRoot('data/state/douyin-outbound.jsonl'), now = () => Date.now() } = {}) {
  function read() {
    const cutoff = now() - TTL_MS
    return readJsonl(path)
      .filter((r) => r && typeof r === 'object' && Number(r.at) >= cutoff)
      .slice(-MAX_ROWS)
  }

  function record(name, text) {
    const who = String(name || '').trim()
    const body = normalize(text)
    if (!who || !body) return false
    try {
      // 追加一行，两个进程同时写也不会互相覆盖；读的时候再按时间过滤
      appendJsonl(path, { name: who, text: body.slice(0, 300), at: now() })
      return true
    } catch {
      return false
    }
  }

  /**
   * 这条收件箱预览是不是我们自己刚发出去的。
   * 只按名字 + 文本前缀匹配，宁可漏判也不要把对方真消息误吞。
   * 监听侧拿到 false 才入队；拿不准时由调用方自己决定要不要再看会话。
   */
  function isEcho(name, preview) {
    const who = String(name || '').trim()
    const text = normalize(preview)
    if (!who || !text) return false
    for (const row of read()) {
      if (row.name !== who) continue
      const sent = normalize(row.text)
      if (!sent) continue
      // 短句只认完全相等，避免对方说「好」「在吗」时被误吞；长句才按前缀兜住截断的预览
      if (text === sent) return true
      if (sent.length >= 12 && text.includes(sent.slice(0, 24))) return true
    }
    return false
  }

  return { record, isEcho, read }
}
