// ============================================================
// 人味后处理（学 dsh-fish-tone 的精华）：
//   把 AI 腔的话掰回人话一点点——删套话、破折号改逗号、偶尔挂个语气尾巴。
//   只做轻量规则改写，不改变原意；强度可配：off / light / natural。
//
// 为什么放在发送前：提示词只能"要求"像人，后处理是"保证"发出去的像人。
// ============================================================

const AI_PHRASES = [
  '作为一个AI', '作为一个人工智能', '作为AI助手', '作为AI', '作为一个人',
  '希望对你有帮助', '希望以上对你有帮助', '希望对您有帮助', '如有需要请随时告诉我', '如有疑问请随时联系',
  '需要注意的是', '值得一提的是', '总而言之', '综上所述', '总的来说', '总之',
  '在这个信息', '随着', '让我们', '首先', '其次',
]
const OPENERS = [/^(?:嗯嗯[，,]\s*)?(?:首先|其次|再次|最后|另外|此外)[，,、\s]+/, /^好的[，,]\s*/, /^当然[，,]\s*/]
const SOFT_TAILS = ['啦', '呀', '吧', '嘛', '哈']
const HESITATIONS = ['嗯，', '诶，', '那个，']

// 句首连接词：AI 腔最明显的特征之一。真人聊天很少「因为…所以…但是…」连着说。
const CONNECTOR_OPENERS = /(^|[。！？!?，,]\s*)(?:因为|所以|但是|但|不过|其实|然后|而且|并且|另外|同时|毕竟|总之|于是|因此)\s*[，,]?\s*/g

// 解释性尾巴：只砍「客服式」的收尾，不砍真正的请求或内容。
const EXPLAIN_TAILS = [
  /(?:如果|要是)(?:你|您)?(?:还)?(?:有|需要)(?:其他|别的|什么)?(?:问题|需要)[^。！？!?\n]{0,30}[。！？!?]?$/,
  /(?:随时|欢迎)(?:可以)?(?:问我|告诉我|找我|联系我)[^。！？!?\n]{0,20}[。！？!?]?$/,
  /希望(?:这|以上)?[^。！？!?\n]{0,20}(?:帮助|有用|帮到你|帮上你)[^。！？!?\n]{0,10}[。！？!?]?$/,
]

// 特指问句尾不挂「吧 / 嘛」：参考 fish-tone 的尾巴闸门，「先这样吧」可以，
// 「你干什么了吧」是病句。
const TAIL_BLOCK = /(什么|怎么|为什么|哪|谁|多少|干嘛|干啥)\s*[？?]\s*$/

function pick(list, rng) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
}

/**
 * 拆成「一条一句」的气泡：真人发消息是一条条来的，不是一整段。
 * 规则来自 dsh-feiyu 的 splitBubbles，阈值按中文聊天重新调过：
 *   - 先按句号/问号/感叹号切；太长再按逗号切（换气的地方）；
 *   - 每条最多 maxPer 字；最多 maxParts 条；碎句并回上一条；
 *   - 没有标点的长句也硬切，绝不原样甩一大段。
 */
export function splitBubbles(text, { maxPer = 18, maxParts = 4 } = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return []
  const pieces = []
  for (const sentence of raw.split(/[。！？!?…\n]+/).map((s) => s.trim()).filter(Boolean)) {
    if (sentence.length <= maxPer) { pieces.push(sentence); continue }
    let cur = ''
    for (const seg of sentence.split(/[，,；;]+/).map((s) => s.trim()).filter(Boolean)) {
      if (cur && (cur + '，' + seg).length > maxPer) { pieces.push(cur); cur = seg } else cur = cur ? cur + '，' + seg : seg
    }
    if (cur) pieces.push(cur)
  }
  const merged = []
  for (const p of pieces) {
    if (merged.length && p.length <= 4 && (merged[merged.length - 1] + p).length <= maxPer + 6) merged[merged.length - 1] += p
    else merged.push(p)
  }
  let out = merged.slice(0, maxParts)
  if (merged.length > maxParts) out[out.length - 1] = merged.slice(maxParts - 1).join('，')
  const final = []
  for (const p of out) {
    if (p.length <= maxPer + 6) { final.push(p); continue }
    for (let i = 0; i < p.length; i += maxPer) final.push(p.slice(i, i + maxPer))
  }
  return final.slice(0, maxParts)
}

/** 评论/回复限长：超了就在最后一个标点处截断，不留半句话。 */
export function limitForComment(text, max = 30) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf(','))
  return (at >= max * 0.5 ? cut.slice(0, at) : cut).trim()
}

/** 去掉「复述对方的话」的开头：AI 爱把问题重复一遍再答。 */
export function stripEcho(text, echoOf, { minOverlap = 6 } = {}) {
  const s = String(text || '').trim()
  const other = String(echoOf || '').trim().replace(/[。！？!?，,、\s]+$/, '')
  if (!s || !other || other.length < minOverlap) return s
  // 只有「整段原话」被原样放在开头才算复述；只是开头几个字一样的不算
  if (!s.startsWith(other)) return s
  const rest = s.slice(other.length).replace(/^[，,。！？!?、\s]+/, '')
  return rest
}


/**
 * 人味改写。
 * @param {string} text 原文
 * @param {{ strength?: 'off'|'light'|'natural', rng?: () => number }} [opts]
 * @returns {{ text: string, stats: { removed: number, added: number, uselessRatio: number, strength: string } }}
 */
export function humanize(text, { strength = 'light', rng = Math.random } = {}) {
  const original = String(text == null ? '' : text)
  if (strength === 'off' || !original.trim()) {
    return { text: original, stats: { removed: 0, added: 0, uselessRatio: 0, strength: 'off' } }
  }
  let out = original
  let removed = 0

  // 1) 破折号不是人说话的方式
  out = out.replace(/——+/g, '，')

  // 2) 去掉 markdown 装饰（对外文字不需要）
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')

  // 3) 删 AI 套话短语
  for (const phrase of AI_PHRASES) {
    if (!out.includes(phrase)) continue
    const next = out.replaceAll(phrase, '')
    removed += out.length - next.length
    out = next
  }

  // 4) 删开头连接词（真人不会"首先"）
  for (const re of OPENERS) {
    const before = out.length
    out = out.replace(re, '')
    removed += before - out.length
  }

  // 4.5) 句首连接词：因为/所以/但是/其实/然后……连着说就是 AI 腔
  const beforeConn = out.length
  out = out.replace(CONNECTOR_OPENERS, '$1')
  removed += beforeConn - out.length

  // 4.6) 解释性尾巴：像说明书的那半句直接砍掉
  for (const re of EXPLAIN_TAILS) {
    const before = out.length
    out = out.replace(re, '')
    removed += before - out.length
  }

  // 5) 收拾删除后的连续标点/空白
  out = out
    .replace(/^[，,、\s]+/, '')
    .replace(/[，,]{2,}/g, '，')
    .replace(/[。]{2,}/g, '。')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!out) return { text: original, stats: { removed: 0, added: 0, uselessRatio: 0, strength } }

  let added = 0
  // 6) 犹豫半秒：句首偶尔"嗯，"
  if (strength === 'natural' && out.length > 6 && !/^[嗯诶那个]/.test(out) && rng() < 0.25) {
    const hesit = pick(HESITATIONS, rng)
    out = hesit + out
    added += hesit.length
  }

  // 7) 句子太"齐"时，给小尾巴挂一下（给最后一个短句加语气词）
  const tailChance = strength === 'natural' ? 0.45 : 0.18
  if (out.length <= 60 && /。$/.test(out) && !TAIL_BLOCK.test(out) && rng() < tailChance) {
    const tail = pick(SOFT_TAILS, rng)
    out = out.replace(/。$/, tail + '。')
    added += 1
  }

  // 8) 无用度：删掉的字 / 原文字数
  const uselessRatio = original.length ? Math.round((removed / original.length) * 100) / 100 : 0
  return { text: out, stats: { removed, added, uselessRatio, strength } }
}
