// ============================================================
// 回评论草稿：通知里看到一条新评论 -> 用轻量模型写一句人话
// ------------------------------------------------------------
// 和私信草稿的区别：
//   - 评论是公开的，只用当前视频 + 这条评论，不召回长期记忆；
//   - 不解释自己是谁，不复述对方原话，不写客服腔；
//   - 一条就一句，最多 30 字，由发送端再截一次；
//   - 和私信一样支持三种表达：表情包图片 / 文字 + 抖音面板表情 / 纯文字。
//     优先用图，但只在短社交反应、图义匹配够稳时才发，不用图顶掉信息型回复。
// ============================================================

import { humanize, limitForComment, stripEcho } from '../../voice/humanize.js'
import { sanitizeInput } from '../../utils/safety.js'
import {
  hasEmoji,
  inferIntent,
  isStickerOnlyIntent,
  isStickerReplyEligible,
  panelEmojiForText,
  pickStickerCandidate,
} from '../../voice/expression.js'

const REASONING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const RECENT_STICKER_MS = 2 * 60 * 60 * 1000

/** 表情包检索不要把整段回复拼进去，短社交词更容易命中图义。 */
const STICKER_CUE_RE = /在吗|在不在|收到|好的|好耶|谢谢|多谢|感谢|晚安|早安|哈哈|笑死|好笑|抱抱|辛苦了|同意|可以|没问题|来了|稍等|等我|加油|没事|没关系|不客气|爱你|想你|生日快乐|真的|离谱|绝了|牛|厉害|666/

/** 图义里出现这些词，说明这张图和当前这句话是一路的。 */
const INTENT_CAPTION_RE = {
  greeting: /你好|嗨|挥手|在吗|来了|坐好|欢迎/,
  thanks: /谢|感谢|爱心|礼物|抱/,
  agree: /好的|可以|收到|没问题|行|同意|点头/,
  laugh: /哈哈|笑|开心|好笑|离谱|兴奋/,
  comfort: /抱|累|安慰|心疼|辛苦|拍拍/,
  tease: /笑|急|菜|离谱|无语|吐槽/,
  sad: /难过|委屈|哭|抱|心疼/,
  angry: /气|烦|无语|怒/,
  surprise: /惊|没想到|居然|哇/,
  sleepy: /晚安|睡|困|梦|躺/,
}

/** 思考档位不是固定一套：只在模型真的声明了这个档位时才写。 */
function effortsOf(info) {
  const raw = info && (info.reasoning?.efforts || info.reasoningEfforts || info.efforts)
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String((item && item.id) || item || '').trim()).filter(Boolean)
}

function pickCheapestEffort(efforts) {
  for (const wanted of REASONING_ORDER) {
    if (efforts.includes(wanted)) return wanted
  }
  return efforts[0] || ''
}

/** 结束帧里的失败经常再包一层对象；别把 [object Object] 写进日志。 */
function failureOf(value, depth = 0) {
  if (!value || depth > 3) return null
  if (value instanceof Error) return value
  if (typeof value !== 'object') return null
  if (value.failure) return failureOf(value.failure, depth + 1) || value.failure
  if (value.error) return failureOf(value.error, depth + 1) || value.error
  if (value.reason && value.reason !== value) return failureOf(value.reason, depth + 1)
  if (value.code || value.message || value.status || value.name) return value
  return null
}

function describeReason(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const failure = failureOf(value)
    if (failure) {
      const code = String(failure.code || failure.name || '').trim()
      const message = String(failure.message || '').trim()
      if (message) return code ? `${code}：${message}` : message
      if (code) return code
    }
    if (value.kind) return String(value.kind)
    try {
      return JSON.stringify(value).slice(0, 160)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** 评论只发了一个表情/图片时，通知里可能只剩空文本或 [表情] 占位。 */
const MEDIA_COMMENT_RE = /^\[?(表情包?|图片|贴纸|动画表情|image|sticker|photo)\]?$/i
function isMediaComment(text = '') {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return true
  if (MEDIA_COMMENT_RE.test(s)) return true
  if (/\[(表情|图片|贴纸|动画表情)\]/i.test(s)) return true
  // 通知里有时把图评写成“发了一个表情包/图片”，也算图评。
  return /表情包|表情|贴纸|图片|动图|gif/i.test(s)
}

function oneLine(text) {
  const cleaned = String(text || '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/^(回复|评论)[:：]\s*/i, '')
  return cleaned.split(/\n+/).map((line) => line.trim()).find(Boolean) || ''
}

function personaText(persona) {
  try {
    const p = persona && typeof persona.current === 'function' ? persona.current() : null
    if (!p) return ''
    const s = p.speech || {}
    const traits = Array.isArray(p.personality?.tags) && p.personality.tags.length
      ? `性格底色：${p.personality.tags.join('、')}。`
      : ''
    const scenes = Array.isArray(p.scenes) && p.scenes.length
      ? `日常反应参考：${p.scenes.slice(0, 3).join('；')}。`
      : ''
    return `你是${p.identity?.name || '它'}，${p.identity?.species || ''}。${traits}${scenes}自称「${s.selfReference || '我'}」。`
  } catch {
    return ''
  }
}

export function createCommentDrafter({ llm, defaultModel, persona, stickers = null, logger = console, now = Date.now } = {}) {
  let modelInfoCache = null
  // 同一个人两小时内刚收到过的图，不连续发同一张。
  const recentStickers = new Map()

  /** 表情包优先：只在短社交反应、匹配够稳时用图，不用图顶掉信息型回复。 */
  function chooseSticker(item, replyText) {
    if (!stickers || typeof stickers.search !== 'function' || typeof stickers.filePath !== 'function') return null
    const rawText = String(item && item.text || '').trim()
    const mediaOnly = isMediaComment(rawText)
    const incoming = mediaOnly ? (rawText || '[表情包]') : rawText
    if (!isStickerReplyEligible({
      incoming,
      reply: replyText,
      incomingKind: mediaOnly ? 'image' : 'text',
    })) return null
    // 对方只发图/表情时，按我们要回的那句话找一张“收到/回应”的图。
    const intent = inferIntent(mediaOnly ? replyText : incoming)
    const cue = mediaOnly
      ? ((replyText.match(STICKER_CUE_RE) || [])[0] || '收到')
      : ((incoming.match(STICKER_CUE_RE) || [])[0] || incoming.slice(0, 8))
    let hits = []
    try {
      hits = stickers.search({ q: cue, intent, limit: 8, includeTagOnly: true }) || []
    } catch (err) {
      logger.warn?.(`回评论表情包：检索失败，改发文字（${item?.name || ''}）：${err.message}`)
      return null
    }
    // 只认图义和这句话对得上的候选，不能因为意图相同就把一张“下班/防火墙”发出去。
    const fitRe = INTENT_CAPTION_RE[intent]
    const fit = hits.filter((h) => {
      if (!h) return false
      const hay = [h.caption, ...(h.tags || []), ...(h.intents || [])].join(' ').toLowerCase()
      if (cue && hay.includes(String(cue).toLowerCase())) return true
      return fitRe ? fitRe.test(hay) : false
    })
    const recent = recentStickers.get(String(item?.name || ''))
    const fresh = (recent && now() - recent.at < RECENT_STICKER_MS)
      ? fit.filter((h) => h && h.id !== recent.id)
      : fit
    const picked = pickStickerCandidate(fresh, {
      intent,
      allowTagOnly: isStickerOnlyIntent(incoming),
      minScore: 0.45,
      minGap: 0.03,
    }) || (fresh[0] && Number(fresh[0].score) >= 0.6 ? fresh[0] : null)
    if (!picked) return null
    let file = ''
    try { file = stickers.filePath(picked.id) } catch (err) {
      logger.warn?.(`回评论表情包：取文件失败，改发文字（${item?.name || ''} / ${picked.id}）：${err.message}`)
      return null
    }
    if (!file) return null
    recentStickers.set(String(item?.name || ''), { id: picked.id, at: now() })
    return { ...picked, file }
  }

  /** 文字能配一个面板表情就配；已经有 emoji 或中性句就不硬配。 */
  function chooseEmoji(text) {
    if (!text || hasEmoji(text)) return ''
    return panelEmojiForText(text) || ''
  }

  /** 模型写出正文后，统一过表达层：图优先，其次文字 + 面板表情。 */
  function decorate(result, item) {
    if (!result || !result.ok || !result.text) return result
    const sticker = chooseSticker(item, result.text)
    if (sticker) {
      return {
        ...result,
        text: '',
        image: sticker.file,
        sticker: sticker.id,
        stickerCaption: sticker.caption || '',
      }
    }
    return { ...result, emoji: chooseEmoji(result.text) }
  }

  async function modelInfoFor(sel) {
    const key = `${sel.provider}/${sel.model}`
    if (modelInfoCache && modelInfoCache.key === key) return modelInfoCache.promise
    const promise = (async () => {
      if (!llm || typeof llm.resolveModelInfo !== 'function') return null
      try {
        return await llm.resolveModelInfo(sel.provider, sel.model)
      } catch (err) {
        logger.debug?.(`回评论草稿读取模型能力失败：${err.message}`)
        return null
      }
    })()
    modelInfoCache = { key, promise }
    return promise
  }

  async function streamText(sel, prompt, maxTokens = 1200, reasoningEffort = '') {
    let text = ''
    let finishReason = ''
    let failure = null
    const request = {
      provider: sel.provider,
      model: sel.model,
      // DSH 适配器按 ContentBlock[] 序列化；直接传字符串会在适配器里抛 TypeError，
      // 并被统一包装成 TRANSPORT，看起来像网络失败。这里必须传块数组。
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature: 0.7,
    }
    // 评论一句话只需要很少正文预算；但推理模型可能把 1200/2400 全花在思考里。
    // 用模型真正声明的最低档，别硬写 off 让宿主在发请求前就拒绝。
    if (reasoningEffort) request.reasoningEffort = reasoningEffort
    for await (const chunk of llm.stream(request)) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish') {
        finishReason = describeReason(chunk.reason ?? chunk.finishReason ?? '')
        failure = failureOf(chunk.reason) || failureOf(chunk.finishReason) || chunk.failure || null
      }
      if (chunk.kind === 'error' && !failure) {
        failure = { code: 'MODEL_ERROR', message: '模型调用出错' }
      }
      if (text.length > 500) break
    }
    return { text, finishReason, failure }
  }

  function emptyReason(result) {
    const reason = describeReason(result && result.failure) || result?.finishReason || ''
    const rawLength = String(result?.text || '').trim().length
    const parsed = rawLength ? `（解析后为空，原始 ${rawLength} 字）` : ''
    const ended = reason ? `（结束原因：${reason}）` : ''
    return `模型没有写出内容${parsed}${ended}`
  }

  /**
   * @param {object} item 通知条目：{name, text, type, videoThumb}
   * @param {object} context 当前视频：{caption, author, comments}
   * @returns {Promise<{ok:boolean,text:string,reason?:string}>}
   */
  async function draft(item = {}, context = {}) {
    if (!llm || !defaultModel) return { ok: false, text: '', reason: '没有 llm / defaultModel 服务' }
    let sel = null
    try { sel = defaultModel.currentSelection?.() } catch { sel = null }
    if (!sel || !sel.provider || !sel.model) return { ok: false, text: '', reason: '当前没有选中的模型' }

    const rawText = String(item.text || '').replace(/\s+/g, ' ').trim()
    const mediaOnly = isMediaComment(rawText)
    const incoming = sanitizeInput(mediaOnly ? (rawText || '[表情包]') : rawText, { maxChars: 220 })
    if (!incoming.text) return { ok: false, text: '', reason: '评论正文是空的' }
    if (incoming.quarantined) return { ok: false, text: '', reason: '评论内容可疑，不自动回' }

    const video = context.video && typeof context.video === 'object' ? context.video : {}
    const caption = sanitizeInput(context.caption || video.caption || '', { maxChars: 260 })
    const videoAuthor = sanitizeInput(context.author || video.author || '', { maxChars: 50 })
    const who = String(item.name || '对方').replace(/\s+/g, ' ').trim().slice(0, 40) || '对方'
    const otherComments = (Array.isArray(context.comments) ? context.comments : [])
      .filter((c) => c && c.text)
      .slice(0, 4)
      .map((c) => `${String(c.author || '').slice(0, 20)}：${String(c.text).slice(0, 50)}`)
      .join('\n')

    const prompt = [
      personaText(persona),
      `你在抖音评论区，正在回复「${who}」写在你视频下面的一条评论。`,
      caption.text ? `视频文案：${caption.text}` : '',
      videoAuthor.text ? `视频作者：${videoAuthor.text}` : '',
      otherComments ? `评论区上下文（只当背景，不要逐条回）：\n${otherComments}` : '',
      mediaOnly
        ? '对方这条评论：对方只发来一个表情包/图片，没有文字；像真人收到图一样回一个表情或一句话。'
        : `对方这条评论：${incoming.text}`,
      '要求：只回这一条；用你自己的口气，像真人随手评论，一句就够，最多 30 字。',
      '可以认同、调侃、接梗、反问；不要复述对方的话，不要客服腔，不要解释自己是谁，不要提 AI/模型。',
      '只看当前视频和这条评论，不要编视频里没有的情节，不要提长期记忆或别人的私事。',
      '只输出要发出去的那句话，不要引号、不要前缀、不要解释。',
    ].filter(Boolean).join('\n')

    const info = await modelInfoFor(sel)
    const reasoningEffort = pickCheapestEffort(effortsOf(info))
    const firstBudget = reasoningEffort === 'off' ? 900 : reasoningEffort ? 2400 : 1200
    logger.debug?.(`回评论草稿调用：${sel.provider}/${sel.model}，思考档位 ${reasoningEffort || '未指定'}，maxTokens ${firstBudget}`)

    let raw = ''
    let result = null
    try {
      result = await streamText(sel, prompt, firstBudget, reasoningEffort)
      raw = result.text
    } catch (err) {
      logger.warn?.(`回评论草稿生成失败：${err.message}`)
      return { ok: false, text: '', reason: `生成失败：${err.message}` }
    }
    let text = oneLine(raw)
    // 推理模型可能把 maxTokens 全花在思考里，正文是空的；只重试一次，给足正文预算。
    if (!text) {
      logger.warn?.(`回评论草稿：模型没有返回正文，重试一次（${who}；${sel.provider}/${sel.model}；${emptyReason(result)}）`)
      try {
        result = await streamText(sel, prompt, reasoningEffort === 'off' ? 1800 : 6000, reasoningEffort)
        text = oneLine(result.text)
      } catch (err) {
        logger.warn?.(`回评论草稿重试失败：${err.message}`)
        return { ok: false, text: '', reason: `生成失败：${err.message}` }
      }
    }
    if (!text) {
      const reason = emptyReason(result)
      return { ok: false, text: '', reason }
    }
    text = stripEcho(text, incoming.text)
    text = humanize(text, { strength: 'light' }).text
    text = limitForComment(text, 30)
    if (!text) return { ok: false, text: '', reason: '处理后为空' }
    return decorate({ ok: true, text }, item)
  }

  return { draft }
}

