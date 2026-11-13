// ============================================================
// 心情判断（学 dsh-feiyu-mood 的精华）：
//   每轮聊完，用 DSH 自己的模型判一次「这一轮它心情往哪走」，
//   把涨跌写回 decision（状态变量 + 情感层 PAD），并记一条原因。
//
//   - 不是关键词硬猜，是模型读这一轮真实对话；
//   - 不拖回合：turn-stopping 里只启动异步判断，不 await；
//   - 同一次变化只说一次：判完写 reason，下一轮再判；
//   - 每个会话至少隔 5 分钟才判一次，省钱。
// ============================================================

const MIN_GAP_MS = 5 * 60_000
const MAX_LINES = 6
const MAX_TEXT = 500

function textOf(message) {
  if (!message) return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
}

export function attachMoodJudge(ctx, { logger = console, decision, llm, defaultModel } = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {}
  if (!decision || typeof decision.applyMood !== 'function') return () => {}
  const buckets = new Map()
  const MIN_GAP = MIN_GAP_MS

  function bucketOf(id) {
    if (!buckets.has(id)) {
      // 长期运行会攒下很多会话 id；超过上限就丢掉最旧的一批，别让内存慢慢涨
      if (buckets.size >= 200) {
        const drop = [...buckets.keys()].slice(0, 50)
        for (const key of drop) buckets.delete(key)
      }
      buckets.set(id, { lines: [], lastJudgeAt: 0, judging: false })
    }
    return buckets.get(id)
  }

  function onSessionEvent(session, event) {
    try {
      if (!session || !event || !event.type) return
      const st = bucketOf(session.id)
      let role = ''
      if (event.type === 'user/message') role = 'user'
      else if (event.type === 'assistant/message') role = 'assistant'
      else return
      // 两种事件的 data 形状不一样（以本机会话日志为准）：
      //   user/message      → data 就是消息 { content, role, ... }
      //   assistant/message → data = { turn, step, message, usage }
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const text = textOf(data.message || data)
      if (!text) return
      st.lines.push({ role, text })
      if (st.lines.length > MAX_LINES) st.lines = st.lines.slice(-MAX_LINES)
    } catch { /* 收集失败不影响对话 */ }
  }

  function onTurnStopping(payload) {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const st = bucketOf(agent.id)
      const now = Date.now()
      if (st.judging) return
      if (now - st.lastJudgeAt < MIN_GAP) return
      if (!st.lines.some((l) => l.role === 'user')) return
      st.judging = true
      st.lastJudgeAt = now
      judge(st.lines)
        .then((result) => {
          if (!result) return
          const r = decision.applyMood(result)
          if (r && r.ok) {
            logger.info?.(`心情判断：${r.reason}（心情 ${r.delta.mood >= 0 ? '+' : ''}${r.delta.mood} → ${r.mood}，精力 ${r.delta.energy >= 0 ? '+' : ''}${r.delta.energy} → ${r.energy}）`)
          }
        })
        .catch((err) => logger.warn?.(`心情判断失败：${err.message}`))
        .finally(() => { st.judging = false })
    } catch (err) {
      logger.warn?.(`心情判断启动失败：${err.message}`)
    }
  }

  async function judge(lines) {
    if (!llm || !defaultModel) return null
    let sel = null
    try { sel = defaultModel.currentSelection?.() } catch { sel = null }
    if (!sel || !sel.provider || !sel.model) return null
    const transcript = lines
      .map((l) => `${l.role === 'user' ? '对方' : '它'}：${l.text}`)
      .join('\n')
    const prompt = [
      '你是情绪判定器。读下面这一轮对话，判断「它」这一轮心情往哪走。',
      '只输出一行 JSON，不要解释：',
      '{"moodDelta":整数-15到15,"energyDelta":整数-10到10,"reason":"不超过40字","confidence":0到1}',
      'moodDelta 正=变开心，负=变低落；energyDelta 正=更有精神，负=更累。',
      '幅度按这个来，别走极端：',
      '- 日常档 -1 到 -3：随口喊累、说困、卡住了、被顶了一句、活儿没做成、疼一下。这种小波动才是最多的。',
      '- 明显档 -4 到 -7：真受委屈、被凶、连着几天没睡好、事情砸了。',
      '- 很重档 -8 到 -10：重大失望、家里出事这类。',
      '- 对方只是说「吃了」「睡了」「报平安」：0 到 +1，大多数给 0，那不是好事也不是坏事。',
      '- 真没什么事的时候别硬凑负分。',
      'reason 怎么写：两段式，全用过去式。',
      '第一段：对方这轮具体做了什么、说了什么（要有画面，别写「关心我」这种抽象话）。',
      '第二段：它当时怎么应的（心里的反应，也是过去式）。',
      '不许写「此刻」「现在」「一直」「还」这种把状态延伸到现在的说法，那是这一轮的事，不是长期状态。',
      '不许替对方补细节，只写这一轮真出现过的动作和信息。',
      '对话：',
      transcript,
    ].join('\n')
    let text = ''
    for await (const chunk of llm.stream({
      provider: sel.provider,
      model: sel.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 140,
      temperature: 0.3,
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (text.length > 800) break
    }
    const matched = text.match(/\{[\s\S]*\}/)
    if (!matched) return null
    const parsed = JSON.parse(matched[0])
    const moodDelta = Math.max(-15, Math.min(15, Math.round(Number(parsed.moodDelta) || 0)))
    const energyDelta = Math.max(-10, Math.min(10, Math.round(Number(parsed.energyDelta) || 0)))
    if (!moodDelta && !energyDelta) return null
    return {
      moodDelta,
      energyDelta,
      reason: String(parsed.reason || '').slice(0, 60),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    }
  }

  const offEvent = ctx.on('session/event', onSessionEvent)
  const offTurn = ctx.on('agent/turn-stopping', onTurnStopping)
  return () => {
    try { offEvent?.() } catch { /* 已清理 */ }
    try { offTurn?.() } catch { /* 已清理 */ }
  }
}
