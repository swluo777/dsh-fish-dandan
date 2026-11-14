// ============================================================
// 聊天表达浓度：把「文字表情 / 抖音面板表情 / 自定义表情包」
// 收在同一套策略里，避免各条链路各自掷骰子。
//
// 这里只做判断，不直接发消息；具体发送动作仍在平台适配器。
// ============================================================

/**
 * 三档是给用户看的，不把 0.16 / 0.15 这种数字堆到设置页。
 * sticker 是「本次本来可以靠表情包完成的回复」里的命中率，不是所有消息的比例。
 */
export const EXPRESSION_LEVELS = {
  restrained: { textEmoji: 0.14, panelEmoji: 0.12, sticker: 0.30 },
  natural: { textEmoji: 0.22, panelEmoji: 0.20, sticker: 0.50 },
  playful: { textEmoji: 0.30, panelEmoji: 0.26, sticker: 0.65 },
}

export const EXPRESSION_LABELS = {
  restrained: '克制',
  natural: '自然',
  playful: '活泼',
}

export function normalizeExpressionLevel(value) {
  return Object.prototype.hasOwnProperty.call(EXPRESSION_LEVELS, value) ? value : 'natural'
}

export function expressionProfile(level = 'natural') {
  return EXPRESSION_LEVELS[normalizeExpressionLevel(level)]
}

/** 严肃/需要认真回答的场景：不发表情包，避免把安慰、冲突、钱的事弄轻浮。 */
export function isSeriousContext(text = '') {
  const s = String(text || '')
  return /分手|吵架|吵起来|生气|难过|委屈|崩溃|自杀|不想活|去世|死了|生病|住院|手术|化疗|抑郁|焦虑|报警|起诉|律师|法院|借钱|还钱|贷款|欠款|被骗|诈骗|隐私|身份证|银行卡|密码|验证码|地址|电话|裁员|失业|被开除|被辞退/.test(s)
}

/** 短社交 cue：带问号也可能是“在吗？”这种寒暄，不等于在要信息。 */
const SOCIAL_CUE_RE = /在吗|在不在|在的|收到|好的|好耶|谢谢|多谢|感谢|晚安|早安|哈哈|笑死|好笑|抱抱|辛苦了|同意|可以|没问题|来了|稍等|等我|加油|没事|没关系|不客气|爱你|想你|生日快乐|新年快乐|节日快乐|真的|假的|离谱|绝了|牛|厉害|6|666/

/** 真的在问一件事，不是寒暄；“在吗？”这种带问号的短社交不算。 */
export function isInformationQuestion(text = '') {
  const s = String(text || '').trim()
  if (!s) return false
  if (/怎么|为什么|多少|哪里|哪儿|什么时候|能不能|可不可以|帮我|求|在哪|哪个|如何|怎么办|咋办|几点|多久|多大|多长|多远|是谁|干什么|干嘛|什么事|什么情况|有没有|是不是|对不对|好不好|行不行|可以吗|能吗|发我|教我|步骤/.test(s)) return true
  // 没有具体疑问词时，只有孤零零的问号才算“在问”；短寒暄带问号仍可发表情。
  if (/[?？]/.test(s) && !SOCIAL_CUE_RE.test(s)) return true
  return false
}

/** 链接、@、话题、长文、明显要信息的问句，不拿表情包顶回答。 */
export function isStickerEligible(text = '') {
  const s = String(text || '').trim()
  // 闲聊长一点也能用图，别卡在 40 字；真正的提问/严肃场景在下面单独排除。
  if (!s || s.length > 80) return false
  if (/https?:\/\/|www\.|@|#|【|】|`/.test(s)) return false
  if (isSeriousContext(s)) return false
  if (isInformationQuestion(s)) return false
  return true
}

/** 能只靠一张图完成的短社交回复。 */
export function isStickerOnlyIntent(text = '') {
  const s = String(text || '').trim()
  if (!isStickerEligible(s)) return false
  return SOCIAL_CUE_RE.test(s)
}

/**
 * 模型草稿是不是“短社交反应”，而不是内容型回复。
 * 只有这种回复才允许被一张图替换；有信息、有步骤、有安排的一律走文字。
 * incomingKind 为 emoji/image 时，对方只发了图，按草稿是不是短反应判断。
 */
export function isStickerReplyEligible({ incoming = '', reply = '', incomingKind = 'text' } = {}) {
  const inText = String(incoming || '').trim()
  const rep = String(reply || '').trim()
  if (!rep || rep.length > 24) return false
  if (/https?:\/\/|www\.|@|#|【|】|`/.test(rep)) return false
  if (isInformationQuestion(rep)) return false
  if (isSeriousContext(inText) || isSeriousContext(rep)) return false
  const mediaIncoming = incomingKind === 'emoji' || incomingKind === 'image' || incomingKind === 'video'
  if (!mediaIncoming) {
    if (!isStickerEligible(inText)) return false
    const intent = inferIntent(inText)
    const socialIntent = ['greeting', 'thanks', 'agree', 'laugh', 'comfort', 'tease', 'sad', 'angry', 'surprise', 'sleepy'].includes(intent)
    if (!isStickerOnlyIntent(inText) && !socialIntent) return false
  }
  // 草稿里出现信息词，说明这句话不只是“哈哈/抱抱”，不要拿图顶掉。
  if (/因为|所以|但是|如果|需要|建议|记得|先|再|然后|明天|今天|几点|在哪|怎么|为什么|多少钱|帮你|给你|告诉我|确认|安排|地址|电话|身份证|银行卡|密码|验证码|发我|教我|步骤/.test(rep)) return false
  return true
}

/**
 * 统一候选门槛：caption 图 0.40，tagOnly 图 0.36；
 * top1 与 top2 太接近且不是 intent 命中，视为歧义；confidence 低时再抬门槛。
 * 返回 null 表示“这次别发图”。
 */
export function pickStickerCandidate(hits = [], { intent = '', allowTagOnly = false, minScore = 0.4, minGap = 0.03 } = {}) {
  const usable = (Array.isArray(hits) ? hits : []).filter((h) => h && h.id && (allowTagOnly || !h.tagOnly))
  const top = usable[0]
  if (!top) return null
  const score = Number(top.score) || 0
  const effective = top.tagOnly ? 0.36 : Math.max(0.4, Number(minScore) || 0)
  if (score < effective) return null
  const confidence = Number(top.confidence)
  if (Number.isFinite(confidence) && confidence < 0.45 && score < effective + 0.04) return null
  const second = usable[1]
  const intentMatched = Boolean(intent)
    && Array.isArray(top.matched)
    && top.matched.map((x) => String(x).toLowerCase()).includes(String(intent).toLowerCase())
  if (second && !intentMatched && score - (Number(second.score) || 0) < Number(minGap || 0.03)) return null
  return top
}

/** 面板表情的意图映射；没有明确情绪就返回空，绝不默认“微笑”。 */
export const PANEL_EMOJI_BY_INTENT = {
  greeting: ['挥手', '微笑'],
  thanks: ['抱拳'],
  agree: ['点赞'],
  laugh: ['笑哭'],
  comfort: ['爱心'],
  tease: ['无语', '捂脸'],
  sad: ['委屈'],
  angry: ['无语'],
  surprise: ['惊讶'],
}

const KNOWN_PANEL_EMOJI = new Set(['微笑', '笑哭', '捂脸', '点赞', '爱心', '委屈', '惊讶', '无语', '抱拳', '挥手'])

/** 接受面板名称或意图名（laugh/agree/auto 等）；映射不到返回空。 */
export function panelEmojiForIntent(intent = '') {
  const s = String(intent || '').trim()
  if (!s || s.toLowerCase() === 'auto') return ''
  const mapped = PANEL_EMOJI_BY_INTENT[s.toLowerCase()]
  if (Array.isArray(mapped) && mapped.length) return mapped[0]
  if (KNOWN_PANEL_EMOJI.has(s)) return s
  return ''
}

/** 按“我们准备发出去的这句话”的情绪选面板表情；中性句不硬配。 */
export function panelEmojiForText(text = '') {
  return panelEmojiForIntent(inferIntent(text))
}

/**
 * 表情包检索词：我们要表达的那句话优先，上下文补充；
 * 不把评论区前几条/整段线程拼进来，避免噪音稀释语义。
 */
export function buildStickerQuery({ replyText = '', incomingText = '', extra = '', max = 200 } = {}) {
  const parts = [replyText, incomingText, extra]
    .map((x) => String(x || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return parts.join(' ').trim().slice(0, Math.max(1, Number(max) || 200))
}

/** 给检索和日志用的粗略意图。 */
export function inferIntent(text = '') {
  const s = String(text || '')
  const table = [
    ['greeting', /在吗|在不在|你好|哈喽|嗨|早上好|晚上好|再见|拜拜|回见/],
    ['thanks', /谢谢|多谢|感谢|辛苦了/],
    ['sleepy', /晚安|睡了|困|睡觉/],
    ['agree', /好的|可以|行|收到|没问题|同意/],
    ['laugh', /哈哈|笑死|好笑|离谱|绝了/],
    ['sad', /难过|想哭|破防|伤心|委屈/],
    ['comfort', /累|抱抱|心疼|安慰|加班|好累|累死|忙死|撑不住/],
    ['tease', /就这|急了|菜|典|这很难评/],
    ['angry', /生气|气死|烦|无语/],
    ['surprise', /居然|真的假的|没想到|惊了/],
  ]
  for (const [intent, re] of table) if (re.test(s)) return intent
  return 'neutral'
}

/** 一段文字里是否已经有 emoji；用于避免再点面板表情。 */
export function hasEmoji(text = '') {
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(String(text || ''))
}
