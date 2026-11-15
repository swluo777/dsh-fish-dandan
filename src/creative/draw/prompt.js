// ============================================================
// 专注创作 · 内心独白生成
// 只写「她自己在心里嘀咕的话」：1-3 句、总共不超过 30 字。
// 模型不可用 / 超时 / 输出不合格时返回 null，由规划器用本地兜底句。
// ============================================================

const BANNED = ['标题', '日期', '素材', '参考', '参数', '页码', '标签', 'AI生成', 'AI 生成', '人工智能生成']

function cleanLine(value) {
  return String(value || '')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function parseLines(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1))
    if (!Array.isArray(obj.lines)) return null
    return obj.lines.map(cleanLine).filter(Boolean).slice(0, 3)
  } catch {
    return null
  }
}

function validLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 3) return false
  const total = lines.join('').length
  if (total > 30 || total < 4) return false
  if (lines.some((line) => BANNED.some((word) => line.includes(word)))) return false
  return true
}

function buildPrompt({ mood, persona, sticker, vars, lines, seed }) {
  const p = persona || {}
  const name = String(p.identity?.name || '蛋蛋')
  const species = String(p.identity?.species || '一条蓝鲸女孩')
  const style = String(p.speech?.styleNotes || '句子短，先嘴硬后服软，不客服腔、不列清单、不总结。')
  const moodLabel = mood?.label || '平静'
  const stickerCaption = String(sticker?.caption || '').slice(0, 60)
  const energy = Math.round(Number(vars?.energy) || 50)
  const urge = Math.round(Number(vars?.creativeUrge) || 35)
  return [
    `你是${name}，${species}。`,
    `说话规则：${style}`,
    '',
    '现在你在画一张手绘稿，要在纸面上写一句或两句自己心里的话。',
    `当前心情：${moodLabel}；精力 ${energy}/100；创作欲 ${urge}/100。`,
    stickerCaption ? `刚才看到一张表情包，意思是：${stickerCaption}（只当情绪参考，不要复述它）。` : '',
    '',
    '规则：',
    '- 第一人称，像自言自语，不是对外文案、不是标题、不是总结、不写道理。',
    '- 1-3 句，整段总共不超过 30 个汉字；短句，可以停顿、改口、省略。',
    '- 可以提到一个具体的小东西（云、雨、窗、杯子、灯、枕头、星星、花、鱼、贝壳、纸鹤、音符、书、笔、线团、气球、面包、月亮、水洼、伞、炸鸡、尾巴、太阳、糖），让画面有东西可画。',
    '- 禁止出现：标题、日期、素材名、参考说明、参数、页码、标签、AI 字样。',
    '- 不要客服腔、小编腔、金句、排比、押韵。',
    '',
    '只输出 JSON：{"lines":["第一句","第二句"]}，不要解释、不要 Markdown。',
    lines && lines.length ? `（上一版是：${lines.join(' / ')}，可以改得更像这一次）` : '',
  ].filter(Boolean).join('\n')
}

export function createCopyWriter({ logger = console } = {}) {
  let llm = null
  let defaultModel = null

  function attach({ llm: nextLlm, defaultModel: nextModel } = {}) {
    llm = nextLlm || null
    defaultModel = nextModel || null
    if (isReady()) logger.info?.('专注创作：独白模型已接上')
    else logger.warn?.('专注创作：独白模型没接上，会用本地兜底句')
  }

  function isReady() {
    return Boolean(llm && typeof llm.stream === 'function' && defaultModel)
  }

  function selection() {
    try { return defaultModel?.currentSelection?.() || null } catch { return null }
  }

  /** 带超时的流式取字；超时就把已经拿到的部分返回。 */
  async function streamText(sel, prompt, { maxTokens = 220, timeoutMs = 8000 } = {}) {
    let out = ''
    const started = Date.now()
    const request = {
      provider: sel.provider,
      model: sel.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature: 0.9,
    }
    for await (const chunk of llm.stream(request)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      if (out.length > 2000) break
      if (Date.now() - started > timeoutMs) break
    }
    return out
  }

  /**
   * 写独白；失败返回 null。
   * @param {{mood:object, persona:object, sticker:object, vars:object, lines?:string[]}} input
   */
  async function write(input = {}, { timeoutMs = 8000 } = {}) {
    if (!isReady()) return null
    const sel = selection()
    if (!sel?.provider || !sel?.model) return null
    try {
      const text = await streamText(sel, buildPrompt(input), { timeoutMs })
      const lines = parseLines(text)
      if (!validLines(lines)) {
        logger.warn?.(`专注创作：模型独白不合格（${String(text || '').slice(0, 40)}）`)
        return null
      }
      return lines
    } catch (err) {
      logger.warn?.(`专注创作：模型独白失败，用兜底句（${err.message}）`)
      return null
    }
  }

  return { attach, write, isReady }
}
