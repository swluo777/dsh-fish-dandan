// ============================================================
// 抖音私信「会话段落」记忆
//
// 目标：聊天结束以后，把这一小段交流压成一条长期记忆，而不是每句都写。
// 不是按固定整点切，也不是「每 10 分钟切一刀」：
//   - 相邻两条消息间隔不超过 10 分钟，就算同一段；
//   - 任何一条新消息都会把静默计时重新拨回 0；
//   - 一段最长 60 分钟、最多 30 条来信，到了就收尾，避免一段无限长；
//   - 同一个人两次写入至少隔 15 分钟，避免刚过阈值就连续堆碎片；
//   - 每人每天最多 12 条，陌生人共用「网友」额度，防止刷屏把记忆撑爆。
//
// 写记忆和读记忆是两件事：memoryAllow 只决定「能不能召回」，
// 这里对所有私信都写轻量摘要；主人/名单内写得具体一点，陌生人只留社交印象。
// ============================================================

export const DM_EPISODE_GAP_MS = 10 * 60_000
export const DM_EPISODE_MAX_MS = 60 * 60_000
export const DM_EPISODE_MAX_INCOMING = 30
export const DM_WRITE_COOLDOWN_MS = 15 * 60_000
export const DM_DAILY_MAX = 12

const MAX_LINES = 12
const MAX_LINE_CHARS = 160
const MAX_SUMMARY_CHARS = 180
const TRIVIAL_RE = /^(?:在吗|在不在|在么|你好|您好|嗨|哈喽|hello|hi|收到|好的|好|嗯|哦|谢谢|晚安|早安|早|拜拜|再见|ok|OK)[。！!？?~～\s]*$/

function cleanLine(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.slice(0, MAX_LINE_CHARS)
}

function pushLine(list, line) {
  if (!line) return
  list.push(line)
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
}

function localDayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function defaultLogger(logger) {
  return logger && typeof logger.warn === 'function' ? logger : console
}

/**
 * 创建私信会话记忆聚合器。
 * @param {{
 *   memory?: object,
 *   llm?: object,
 *   defaultModel?: object,
 *   logger?: object,
 *   now?: () => number,
 *   summarize?: (episode: object) => string | Promise<string>,
 *   autoFlush?: boolean,
 *   setTimeoutFn?: Function,
 *   clearTimeoutFn?: Function,
 * }} [deps]
 */
export function createDmEpisodeMemory({
  memory,
  llm,
  defaultModel,
  logger = console,
  now = () => Date.now(),
  summarize = null,
  autoFlush = true,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const log = defaultLogger(logger)
  const enabled = Boolean(memory && typeof memory.recordEvent === 'function')
  const episodes = new Map()
  const lastWriteAt = new Map()
  const dailyCounts = new Map()
  const flushing = new Set()
  let timer = null

  function actorOf(item) {
    if (item.isOwner) return { key: 'owner', label: '主人', person: '主人', tags: ['主人'], importance: 6, detail: true }
    if (item.memoryAllowed) {
      const name = String(item.name || '').trim()
      return { key: `allow:${name}`, label: name || '熟人', person: name || '熟人', tags: ['熟人'], importance: 5, detail: true }
    }
    return { key: 'stranger', label: '一个网友', person: '网友', tags: ['网友'], importance: 3, detail: false }
  }

  function nextDueAt(at = now()) {
    let due = Infinity
    for (const ep of episodes.values()) {
      const segmentDue = Math.min(ep.lastAt + DM_EPISODE_GAP_MS, ep.startedAt + DM_EPISODE_MAX_MS)
      const lastWrite = lastWriteAt.get(ep.actor.key) || 0
      const cooldownDue = lastWrite ? lastWrite + DM_WRITE_COOLDOWN_MS : 0
      due = Math.min(due, Math.max(segmentDue, cooldownDue))
    }
    if (!Number.isFinite(due)) return 0
    return Math.max(at + 20, due)
  }

  function schedule() {
    if (!autoFlush || !enabled) return
    if (timer) { clearTimeoutFn(timer); timer = null }
    if (!episodes.size) return
    const due = nextDueAt()
    if (!due) return
    const delay = Math.max(20, due - now())
    timer = setTimeoutFn(() => {
      timer = null
      flushDue()
        .catch((err) => log.warn?.(`私信记忆：定时收尾失败：${err.message}`))
        .finally(schedule)
    }, delay)
    timer?.unref?.()
  }

  function shouldSplit(ep, at) {
    return at - ep.lastAt > DM_EPISODE_GAP_MS
      || at - ep.startedAt >= DM_EPISODE_MAX_MS
      || ep.incoming.length >= DM_EPISODE_MAX_INCOMING
  }

  function note({ name, isOwner = false, memoryAllowed = false, incoming = '', outgoing = '', at = now() } = {}) {
    if (!enabled) return 0
    const personName = String(name || '').trim()
    if (!personName) return 0
    const incomingLine = cleanLine(incoming)
    const outgoingLine = cleanLine(outgoing)
    if (!incomingLine && !outgoingLine) return 0

    const actor = actorOf({ name: personName, isOwner, memoryAllowed })
    let ep = episodes.get(personName)
    if (ep && shouldSplit(ep, at)) {
      const old = ep
      void flushEpisode(old, 'split')
      ep = null
    }
    if (!ep) {
      ep = {
        name: personName,
        actor,
        startedAt: at,
        lastAt: at,
        incoming: [],
        outgoing: [],
      }
      episodes.set(personName, ep)
    }
    ep.actor = actor
    ep.lastAt = at
    pushLine(ep.incoming, incomingLine)
    pushLine(ep.outgoing, outgoingLine)

    if (ep.incoming.length >= DM_EPISODE_MAX_INCOMING || at - ep.startedAt >= DM_EPISODE_MAX_MS) {
      void flushEpisode(ep, 'cap')
    }
    schedule()
    return nextDueAt(at)
  }

  function promptFor(ep) {
    const detail = ep.actor.detail
    const speaker = detail ? `「${ep.name}」` : '一个陌生网友'
    return [
      '下面是一段抖音私信对话。请把它压缩成一条第一人称的长期记忆。',
      `对话对象是${speaker}${ep.actor.key === 'owner' ? '（你的主人）' : ''}。`,
      '只记值得以后想起来的内容：对方近况、情绪、约定、重要的小事、你当时的感受。',
      '不要逐句复述，不要写联系方式、地址、账号、身份证号、二维码等个人信息；不要写第三人的隐私；不要编造没有发生的事。',
      detail
        ? '可以提对方的名字，但只写和这段对话有关的内容。'
        : '不要写对方的名字，统一写成「一个网友」；只写轻量社交印象，不写具体隐私细节。',
      '如果是纯寒暄、刷屏、表情包互发、没有可记内容，只输出 SKIP。',
      `最多 ${MAX_SUMMARY_CHARS} 字，只输出记忆正文，不要解释。`,
      '',
      '对方说：',
      ep.incoming.map((x) => `- ${x}`).join('\n') || '- （没有文字）',
      '',
      '我回：',
      ep.outgoing.map((x) => `- ${x}`).join('\n') || '- （没有文字）',
    ].join('\n')
  }

  async function modelSummary(ep) {
    if (!llm || !defaultModel) return ''
    let sel = null
    try { sel = defaultModel.currentSelection?.() } catch { sel = null }
    if (!sel || !sel.provider || !sel.model) return ''
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: sel.provider,
        model: sel.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptFor(ep) }] }],
        maxTokens: 240,
        temperature: 0.3,
      })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (text.length > 400) break
      }
    } catch (err) {
      log.warn?.(`私信记忆：摘要模型失败，改用轻量摘录：${err.message}`)
      return ''
    }
    return cleanSummary(text)
  }

  function cleanSummary(raw) {
    let text = String(raw ?? '').trim()
    text = text.replace(/^["「『]|["」』]$/g, '').trim()
    text = text.replace(/^记忆[：:]\s*/, '').trim()
    if (!text) return ''
    if (/^(?:SKIP|跳过|无|没有|没有可记|无内容)$/i.test(text)) return ''
    return text.slice(0, MAX_SUMMARY_CHARS)
  }

  function fallbackSummary(ep) {
    const meaningful = ep.incoming.filter((x) => x && !TRIVIAL_RE.test(x) && x.length >= 5)
    if (!meaningful.length) return ''
    const last = meaningful[meaningful.length - 1]
    if (ep.actor.key === 'owner') {
      return `今天在抖音私信里和主人聊了几句，主人提到「${last.slice(0, 120)}」。`
    }
    if (ep.actor.detail) {
      return `今天在抖音私信里和「${ep.name}」聊了几句，对方提到「${last.slice(0, 120)}」。`
    }
    return `今天在抖音私信里和一个网友聊了几句，对方大意是「${last.slice(0, 120)}」。`
  }

  async function summarizeEpisode(ep) {
    if (typeof summarize === 'function') {
      const custom = await summarize(ep)
      return cleanSummary(custom)
    }
    const fromModel = await modelSummary(ep)
    if (fromModel) return fromModel
    return cleanSummary(fallbackSummary(ep))
  }

  async function flushEpisode(ep, reason) {
    if (!enabled) return { ok: false, reason: '没有记忆写入服务' }
    if (!ep || flushing.has(ep.name)) return { ok: false, reason: '正在收尾' }
    if (episodes.get(ep.name) !== ep) return { ok: false, reason: '已经收过尾' }

    flushing.add(ep.name)
    episodes.delete(ep.name)
    try {
      const at = ep.lastAt
      const day = localDayKey(at)
      const countKey = `${day}:${ep.actor.key}`
      const used = Number(dailyCounts.get(countKey) || 0) || 0
      if (used >= DM_DAILY_MAX) {
        log.info?.(`私信记忆：${ep.actor.label} 今天已经记了 ${used} 条，这条不再写`)
        return { ok: false, reason: 'daily-cap' }
      }

      const content = await summarizeEpisode(ep)
      if (!content) {
        log.info?.(`私信记忆：${ep.actor.label} 这段没有值得记的内容，跳过`)
        return { ok: false, reason: 'nothing-worth' }
      }

      // 陌生人摘要要再做一次名字遮蔽：模型可能从对话里把昵称抄进来。
      const safeContent = ep.actor.detail
        ? content
        : content.split(ep.name).join('一个网友')
      if (!safeContent.trim()) return { ok: false, reason: 'empty' }

      const result = memory.recordEvent({
        content: safeContent.slice(0, MAX_SUMMARY_CHARS),
        summary: safeContent.slice(0, 80),
        tier: 'episodic',
        importance: ep.actor.importance,
        tags: ['抖音', '私信', '社交', ...ep.actor.tags],
        person: ep.actor.person,
        platform: 'douyin',
      }, 'douyin-dm')
      if (result && result.ok) {
        lastWriteAt.set(ep.actor.key, now())
        dailyCounts.set(countKey, String(used + 1))
        log.info?.(`私信记忆：${ep.actor.label} 这段聊完了，记下一条（${reason}）`)
      } else {
        log.warn?.(`私信记忆：${ep.actor.label} 写入失败：${(result && result.reason) || '未知'}`)
      }
      return result || { ok: false, reason: 'write-failed' }
    } catch (err) {
      log.warn?.(`私信记忆：收尾失败：${err.message}`)
      return { ok: false, reason: err.message }
    } finally {
      flushing.delete(ep.name)
    }
  }

  async function flushDue(at = now()) {
    if (!enabled) return 0
    for (const ep of [...episodes.values()]) {
      if (flushing.has(ep.name)) continue
      const segmentDue = Math.min(ep.lastAt + DM_EPISODE_GAP_MS, ep.startedAt + DM_EPISODE_MAX_MS)
      const lastWrite = lastWriteAt.get(ep.actor.key) || 0
      const cooldownDue = lastWrite ? lastWrite + DM_WRITE_COOLDOWN_MS : 0
      if (at < Math.max(segmentDue, cooldownDue)) continue
      await flushEpisode(ep, 'silence')
    }
    const due = nextDueAt(at)
    schedule()
    return due
  }

  function pending() {
    return [...episodes.values()].map((ep) => ({
      name: ep.name,
      actor: ep.actor.key,
      startedAt: ep.startedAt,
      lastAt: ep.lastAt,
      incoming: ep.incoming.length,
      outgoing: ep.outgoing.length,
    }))
  }

  return { note, flushDue, pending, nextDueAt, flushEpisode }
}
