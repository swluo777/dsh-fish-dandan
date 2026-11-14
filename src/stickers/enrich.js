// ============================================================
// 表情包图义补全：看图读字 → 一句话含义 + 情绪/意图/避用场景。
//
// 只做「给索引补语义卡」，不碰图片本身；结果写回 index.json。
// 用当前宿主的多模态模型；模型不支持图片时由调用方降级处理。
// ============================================================

import fs from 'node:fs'

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const REASONING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 思考档位不是固定一套：有的路由只给 low/high/max，硬写 off 会在发请求前
 * 被宿主以 UNSUPPORTED_REASONING_EFFORT 拒绝。这里只选模型真有的最低档。
 */
function effortsOf(info) {
  const raw = info && (info.reasoning?.efforts || info.reasoningEfforts || info.efforts)
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item && item.id || item || '').trim()).filter(Boolean)
}

function pickCheapestEffort(efforts) {
  for (const wanted of REASONING_ORDER) {
    if (efforts.includes(wanted)) return wanted
  }
  return efforts[0] || ''
}

function budgetForEffort(effort) {
  if (effort === 'off') return 900
  if (effort === 'minimal' || effort === 'low') return 2400
  // 没有档位信息，或路由只有 medium/high/max：预算要留得下思考 + 正文。
  return 6000
}

/** 结束帧里的原因/失败经常再包一层对象；别再把 [object Object] 写给用户看。 */
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

function clamp01(value, fallback = 0.5) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
}

function textList(value, limit = 8) {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x || '').trim()).filter(Boolean).map((x) => x.slice(0, 24)).slice(0, limit)
}

function extractJson(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

/**
 * 返回一个 captioner(record, { signal }) 函数：
 * record 至少带 id/file/ext；返回 { caption, emotion, intents, avoid, confidence }。
 * signal 用来在用户点「停止」时中断正在跑的模型调用。
 */
export function createStickerCaptioner({ llm, attachments, defaultModel, logger = console } = {}) {
  let modelInfoCache = null

  async function modelInfoFor(sel) {
    const key = `${sel.provider}/${sel.model}`
    if (modelInfoCache && modelInfoCache.key === key) return modelInfoCache.promise
    const promise = (async () => {
      if (!llm || typeof llm.resolveModelInfo !== 'function') return null
      try {
        return await llm.resolveModelInfo(sel.provider, sel.model)
      } catch (err) {
        logger.debug?.(`表情包图义读取模型能力失败：${err.message}`)
        return null
      }
    })()
    modelInfoCache = { key, promise }
    return promise
  }

  return async function captionSticker(record, { signal } = {}) {
    if (!llm || typeof llm.stream !== 'function') throw new Error('没有可用的模型服务')
    if (!defaultModel || typeof defaultModel.currentSelection !== 'function') throw new Error('没有默认模型选择')
    const sel = defaultModel.currentSelection()
    if (!sel || !sel.provider || !sel.model) throw new Error('当前没有选中的模型')
    if (!record || !record.file) throw new Error('表情包文件不存在')
    if (signal && signal.aborted) {
      const err = new Error('已停止')
      err.name = 'AbortError'
      err.code = 'ABORTED'
      throw err
    }

    const mime = MIME[record.ext] || 'image/jpeg'
    const data = await fs.promises.readFile(record.file)
    if (!attachments || typeof attachments.saveImage !== 'function') throw new Error('没有可用的图片附件服务')
    const attachment = await attachments.saveImage({
      data,
      mediaType: mime,
      name: `${record.id || 'sticker'}${record.ext ? `.${record.ext}` : ''}`,
    })
    if (!attachment || !attachment.attachmentId) throw new Error('图片附件没有生成有效引用')
    const prompt = [
      '你是聊天表情包标注器。看这张图，不要猜无关内容。',
      '1. 如果图上有文字，先如实读出文字；',
      '2. 用一句不超过 46 字的中文，写这张图本身在表达什么、适合什么聊天场景；',
      '3. emotion 给 1-3 个中文情绪词；intents 从 greeting/thanks/agree/laugh/comfort/tease/surprise/sad/angry/affection/neutral 里选；avoid 写不适合的场景，例如 serious/question/spam；',
      '4. 不确定就降低 confidence，不要编造。',
      '只输出 JSON，不要 markdown：',
      '{"caption":"...","emotion":["..."],"intents":["..."],"avoid":["..."],"confidence":0.0}',
    ].join('\n')

    const info = await modelInfoFor(sel)
    const efforts = effortsOf(info)
    const reasoningEffort = pickCheapestEffort(efforts)
    const maxTokens = budgetForEffort(reasoningEffort)
    logger.debug?.(`表情包图义调用：${sel.provider}/${sel.model}，思考档位 ${reasoningEffort || '未指定'}，maxTokens ${maxTokens}，可用档位 ${efforts.join('/') || '未知'}`)

    let text = ''
    let failure = null
    let finishReason = ''
    const request = {
      provider: sel.provider,
      model: sel.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment },
        ],
      }],
      maxTokens,
      temperature: 0.2,
      ...(signal ? { signal } : {}),
    }
    // 只在模型真的声明了这个档位时才写，避免发请求前就被判 unsupported。
    if (reasoningEffort) request.reasoningEffort = reasoningEffort

    try {
      for await (const chunk of llm.stream(request)) {
        if (!chunk) continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish') {
          finishReason = describeReason(chunk.reason ?? chunk.finishReason ?? '')
          failure = failureOf(chunk.reason) || failureOf(chunk.finishReason) || chunk.failure || null
          if (chunk.kind === 'aborted' || chunk.reason?.kind === 'aborted') {
            const err = new Error('已停止')
            err.name = 'AbortError'
            err.code = 'ABORTED'
            throw err
          }
          if (chunk.kind === 'error' && !failure) {
            failure = { code: 'MODEL_ERROR', message: '模型调用出错' }
          }
        }
        if (text.length > 600) break
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORTED' || err?.code === 'ABORT_ERR') throw err
      throw new Error(`模型调用失败：${describeReason(err)}`)
    }

    if (failure) {
      const code = String(failure.code || failure.name || '').trim()
      const reason = String(failure.message || failure.code || failure.name || '未知错误').slice(0, 160)
      throw new Error(`模型调用失败${code && code !== reason ? `（${code}）` : ''}：${reason}`)
    }

    const parsed = extractJson(text)
    if (!parsed) {
      const hint = finishReason && finishReason !== 'stop' ? `（结束原因：${finishReason}）` : ''
      throw new Error(`模型没有返回可解析的 JSON${hint}`)
    }
    const caption = String(parsed.caption || '').trim().slice(0, 80)
    if (!caption) throw new Error('模型返回的 caption 是空的')
    return {
      caption,
      emotion: textList(parsed.emotion, 3),
      intents: textList(parsed.intents, 8),
      avoid: textList(parsed.avoid, 8),
      confidence: clamp01(parsed.confidence, 0.6),
    }
  }
}
