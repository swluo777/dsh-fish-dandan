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
  return /分手|吵架|吵起来|生气|难过|委屈|崩溃|自杀|不想活|去世|死了|生病|住院|手术|化疗|抑郁|焦虑|报警|起诉|律师|法院|借钱|还钱|贷款|欠款|被骗|诈骗|隐私|身份证|银行卡|密码|验证码|地址|电话/.test(s)
}

/** 链接、@、话题、长文、明显要信息的问句，不拿表情包顶回答。 */
export function isStickerEligible(text = '') {
  const s = String(text || '').trim()
  if (!s || s.length > 40) return false
  if (/https?:\/\/|www\.|@|#|【|】|`/.test(s)) return false
  if (isSeriousContext(s)) return false
  // 真的在问一件事，不是寒暄；这类必须文字回答
  if (/[?？]|怎么|为什么|多少|哪里|哪儿|什么时候|能不能|可不可以|帮我|求/.test(s)) return false
  return true
}

/** 能只靠一张图完成的短社交回复。 */
export function isStickerOnlyIntent(text = '') {
  const s = String(text || '').trim()
  if (!isStickerEligible(s)) return false
  return /在吗|在不在|在的|收到|好的|好耶|谢谢|多谢|晚安|早安|哈哈|笑死|抱抱|辛苦了|同意|可以|没问题|来了|稍等|等我/.test(s)
}

/** 给检索和日志用的粗略意图。 */
export function inferIntent(text = '') {
  const s = String(text || '')
  const table = [
    ['greeting', /在吗|在不在|你好|哈喽|嗨|早上好|晚上好/],
    ['thanks', /谢谢|多谢|感谢|辛苦了/],
    ['sleepy', /晚安|睡了|困|睡觉/],
    ['agree', /好的|可以|行|收到|没问题|同意/],
    ['laugh', /哈哈|笑死|好笑|离谱|绝了/],
    ['comfort', /累|难过|委屈|抱抱|心疼|安慰/],
    ['tease', /就这|急了|菜|典|这很难评/],
    ['sad', /难过|想哭|破防|伤心/],
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
