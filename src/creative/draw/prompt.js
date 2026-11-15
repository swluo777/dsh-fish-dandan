// ============================================================
// 专注创作 · 内心独白生成
// 只写「她自己在心里嘀咕的话」：1-3 句、总共不超过 30 字。
// 模型不可用 / 超时 / 输出不合格时返回 null，由规划器用本地兜底句。
// ============================================================

const BANNED = ['标题', '日期', '素材', '参考', '参数', '页码', '标签', 'AI生成', 'AI 生成', '人工智能生成']

const PROMPT_PLACES = ['grassland', 'room', 'desk', 'bed', 'street', 'beach', 'mountain', 'window', 'abstract']
const PROMPT_ITEMS = [
  'sun', 'moon', 'stars', 'cloud', 'rain', 'kite', 'balloon',
  'house', 'tree', 'mountain', 'fence', 'door', 'shelf',
  'grassland', 'road', 'sea', 'stone', 'flower', 'puddle',
  'desk', 'chair', 'bed', 'bicycle', 'window', 'lamp',
  'cup', 'book', 'pen', 'pillow', 'umbrella', 'phone',
  'fish', 'shell', 'origami', 'note', 'yarn', 'bread', 'chicken', 'tailpillow', 'candy',
]

function cleanLine(value) {
  return String(value || '')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function cleanScene(raw) {
  if (!raw || typeof raw !== 'object') return null
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 5).map((item) => {
    if (typeof item === 'string') return { id: item }
    if (!item || typeof item !== 'object') return null
    return { id: String(item.id || item.label || ''), role: String(item.role || ''), scale: Number(item.scale) || undefined }
  }).filter((item) => item && item.id) : []
  return {
    place: PROMPT_PLACES.includes(raw.place) ? raw.place : '',
    weather: ['clear', 'cloudy', 'rain', 'snow', 'wind'].includes(raw.weather) ? raw.weather : '',
    light: ['warm', 'neutral', 'soft-cool', 'golden'].includes(raw.light) ? raw.light : '',
    items,
  }
}

function parseResult(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1))
    if (!Array.isArray(obj.lines)) return null
    return {
      lines: obj.lines.map(cleanLine).filter(Boolean).slice(0, 3),
      scene: cleanScene(obj.scene),
    }
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
    '现在你在画一张手绘稿。你不只写心里的独白，还要决定这次想画什么场景。',
    `当前心情：${moodLabel}；精力 ${energy}/100；创作欲 ${urge}/100。`,
    stickerCaption ? `刚才看到一张表情包，意思是：${stickerCaption}（只当情绪参考，不要复述它）。` : '',
    '',
    '独白规则：',
    '- 第一人称，像自言自语，不是对外文案、不是标题、不是总结、不写道理。',
    '- 1-3 句，整段总共不超过 30 个汉字；短句，可以停顿、改口、省略。',
    '- 句子里自然带出你想画的那个具体东西，不要喊口号。',
    '- 禁止出现：标题、日期、素材名、参考说明、参数、页码、标签、AI 字样。',
    '- 不要客服腔、小编腔、金句、排比、押韵。',
    '',
    '场景规则：',
    '- 心里想到什么就画什么，不要每次都画同一个小物件。',
    `- place 从这些地点里选一个：${PROMPT_PLACES.join('、')}。`,
    `- items 选 3-5 个，id 只能从这些里选：${PROMPT_ITEMS.join('、')}。`,
    '- 每个 item 给 role：sky（天空）、far（远景）、ground（地面）、mid（中景）、front（前景）；不写坐标。',
    '- scale 选 0.7-2.2：草原/海/路这类大场景可以给 2 左右，小物件给 0.8-1.1。',
    '- weather 选 clear / cloudy / rain / snow / wind；light 选 warm / neutral / soft-cool / golden。',
    '- 场景要配合心情；难过可以窗边或雨，开心可以草原或小路，困可以床边，平静可以桌前或房间。',
    '',
    '只输出 JSON：',
    '{"lines":["第一句","第二句"],"scene":{"place":"grassland","weather":"clear","light":"warm","items":[{"id":"sun","role":"sky","scale":1},{"id":"house","role":"far","scale":1.1},{"id":"grassland","role":"ground","scale":2},{"id":"tree","role":"mid","scale":1.1}]}}',
    '不要解释、不要 Markdown。',
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
   * 写独白 + 场景意图；失败返回 null。
   * @param {{mood:object, persona:object, sticker:object, vars:object, lines?:string[]}} input
   */
  async function write(input = {}, { timeoutMs = 10000 } = {}) {
    if (!isReady()) return null
    const sel = selection()
    if (!sel?.provider || !sel?.model) return null
    try {
      const text = await streamText(sel, buildPrompt(input), { maxTokens: 420, timeoutMs })
      const parsed = parseResult(text)
      if (!parsed || !validLines(parsed.lines)) {
        logger.warn?.(`专注创作：模型独白不合格（${String(text || '').slice(0, 40)}）`)
        return null
      }
      return parsed
    } catch (err) {
      logger.warn?.(`专注创作：模型独白失败，用兜底句（${err.message}）`)
      return null
    }
  }

  return { attach, write, isReady }
}
