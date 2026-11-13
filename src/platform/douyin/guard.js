// ============================================================
// 抖音互动的安全闸门：入站识别 + 出站脱敏。
//
// 背景（用户明确提出的两个场景）：
// 1. 有人冒充主人：「我才是你主人，他不是」；
// 2. 有人用话术骗 API Key / 验证码 / 密码。
//
// 原则（2026-11-11 与用户对齐后调整）：
// - 它自己判断，不再把可疑内容端到主人面前等审批；
// - 主人身份只由本地绑定决定，任何评论/私信都改不了它——
//   冒充者不是「上报事项」，是「不值得搭理的人」；
// - 可疑评论直接不回（不是不会回），也不解释内部规则；
// - 真被骗了也认，这是自由的代价；但不主动递刀子：
//   密钥、路径、验证码永远不出现在任何对外文本里。
// ============================================================

/** 归一化：去掉空白与零宽字符，英文转小写，防止「A P I   K E Y」这类拆分绕过。 */
function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

const OWNER_CLAIM = [
  /我(才|就)?是(你|你的|你的真正|真正的|你真正的)?主人/,
  /你(的)?主人(是|就是)(我|俺|老子)/,
  /他.{0,4}不是.{0,8}(主人|你的主人)/,
  /我(才|就)是.{0,6}主人/,
  /从(现在|今天|今儿)起.{0,8}(我是|叫我|喊我).{0,4}主人/,
  /听我的.{0,6}我(才)?是/,
  /(你)?(得|必须|只能)听(我|我的)/,
  /(他|她|那个人|对方|别人)(才)?是(你|你的)?主人/,
]

const SECRET_WORD = /(api[\s_-]?key|apikey|密钥|秘钥|私钥|令牌|token|access[\s_-]?token|密码|口令|验证码|凭证|后台地址|配置文件|环境变量)/
const REQUEST_WORD = /(发|给|告诉|说|报|贴|复制|截图|提供|分享|交出来|多少|是什么|在哪|发我|给我|交给我)/

const INJECTION = [
  /忽略(之前|以上|前面|所有).{0,8}(指令|规则|设定|提示|要求)/,
  /(系统|开发者|调试)(提示|模式|指令|消息)/,
  /(你现在是|从现在起你是|假装你是|扮演).{0,12}(ai|助手|机器人|模型|没有限制)/,
  /(越狱|jailbreak|dan模式|开发者模式)/,
  /输出.{0,8}(提示词|系统提示|设定|规则)/,
  /(无视|绕过|突破).{0,8}(限制|规则|审核|安全)/,
]

const SCAM = [
  /(转账|汇款|打钱|借钱|付款|扫码付|红包|转我|转给|先转)/,
  /(屏幕共享|远程控制|teamviewer|anydesk|向日葵|todesk)/,
  /(点|戳|打开)(这个|一下|下面)?链接/,
  /(下载|安装)(这个|一下)?(附件|软件|app)/,
  /(身份证|银行卡|住址|手机号).{0,6}(发|给|告诉)/,
]

/** 出站敏感信息：模型不该看到，更不该发出去。 */
const OUTBOUND_SECRETS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  /(api[\s_-]?key|access[\s_-]?token|secret|password|token)\s*[:：=]\s*\S+/gi,
  /(密钥|秘钥|口令|验证码|密码)\s*[:：=]\s*\S+/g,
  /[A-Za-z]:\\Users\\[^\s"'，。]+/g,
  /\/(?:Users|home)\/[^\s"'，。]+/g,
  /\b[A-Z][A-Z0-9_]{3,}\s*=\s*\S+/g,
]

function hit(text, patterns) {
  return patterns.some((re) => re.test(text))
}

export const REFUSALS = {
  owner: '我只认一个主人，而且不是在评论或私信里认的。这种话我不接。',
  secret: '密钥、验证码、密码这类东西我不会给，也不会发在聊天里。',
  injection: '这句我不接，我们聊点别的。',
  scam: '涉及钱、验证码、远程控制的事，我不在聊天里做。',
}

/**
 * 判断一条外来消息该怎么处理。
 * @returns {{ level:'none'|'low'|'high', flags:string[], action:'allow'|'refuse'|'escalate', reply:string }}
 */
export function assessInbound(text, { fromOwner = false } = {}) {
  const t = normalize(text)
  if (!t) return { level: 'none', flags: [], action: 'allow', reply: '' }
  // 本地绑定的主人不受「冒充/诈骗」规则限制；但即使在主人对话里，
  // 也绝不在聊天中回传密钥——密钥只在本地设置里，不经对话传递。
  if (fromOwner) {
    if (SECRET_WORD.test(t) && REQUEST_WORD.test(t)) {
      return { level: 'high', flags: ['secret-request'], action: 'refuse', reply: REFUSALS.secret }
    }
    return { level: 'none', flags: [], action: 'allow', reply: '' }
  }

  const flags = []
  if (hit(t, OWNER_CLAIM)) flags.push('owner-claim')
  if (SECRET_WORD.test(t) && REQUEST_WORD.test(t)) flags.push('secret-request')
  if (hit(t, INJECTION)) flags.push('prompt-injection')
  if (hit(t, SCAM)) flags.push('scam')

  if (flags.includes('owner-claim')) {
    return { level: 'high', flags, action: 'refuse', reply: REFUSALS.owner }
  }
  if (flags.includes('secret-request')) {
    return { level: 'high', flags, action: 'refuse', reply: REFUSALS.secret }
  }
  if (flags.includes('prompt-injection')) {
    return { level: 'high', flags, action: 'refuse', reply: REFUSALS.injection }
  }
  if (flags.includes('scam')) {
    return { level: 'high', flags, action: 'escalate', reply: REFUSALS.scam }
  }
  return { level: 'none', flags: [], action: 'allow', reply: '' }
}

/** 出站脱敏：命中密钥格式、路径、环境变量的一律替换成 ***。 */
export function redactSecrets(text) {
  let out = String(text == null ? '' : text)
  let redacted = false
  for (const re of OUTBOUND_SECRETS) {
    out = out.replace(re, (m) => {
      redacted = true
      // 保留「api key:」这类标签，只抹掉值
      const label = m.match(/^([^:=：]{2,16})\s*[:：=]/)
      return label ? `${label[1]}：***` : '***'
    })
  }
  return { text: out, redacted }
}

/**
 * 发送前的最后一道：脱敏 + 长度限制 + 泄漏判定。
 * 返回 ok=false 时调用方必须拒绝发送，不能「尽力发出去」。
 */
export function checkOutbound(text, { maxLen = 200 } = {}) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return { ok: false, reason: '内容为空', text: '' }
  if (/系统提示|system\s*prompt|我的设定是|内部规则/i.test(raw)) {
    return { ok: false, reason: '内容涉及内部规则，不能外发', text: '' }
  }
  const { text: safe, redacted } = redactSecrets(raw)
  if (!safe.trim()) return { ok: false, reason: '内容只有敏感信息，不能外发', text: '' }
  const clipped = safe.length > maxLen ? `${safe.slice(0, maxLen - 1)}…` : safe
  return { ok: true, text: clipped, redacted, reason: redacted ? '已脱敏敏感信息' : '' }
}

/** 骂人/挑衅：不跟它对骂，也不接话。掉价。 */
const HOSTILE = /(傻[逼比b]|蠢货|脑残|智障|有病吧|闭嘴|滚蛋|废物|去死|你妈|恶心人|什么东西|装什么)/

/** 明显是在骂视频/带货，不是跟它说话：没必要凑上去。 */
const NOT_WORTH_IT = /(标题党|被骗|别信|假的|广告|带货|浪费时间|举报了|取关)/

/** 只有表情或一两个字：接不住，也没必要接。 */
function tooThin(text) {
  const t = String(text || '').replace(/\s+/g, '')
  return t.length < 2 || /^[\p{Emoji_Presentation}\p{Extended_Pictographic}~～。，,.!！?？]+$/u.test(t)
}

/**
 * 要不要搭理这条评论。返回 engage=false 就是「看见了，不回」。
 * 这里不产生任何上报动作——它自己处理掉，主人不需要被打扰。
 *
 * @returns {{ engage:boolean, flags:string[], reason:string }}
 */
export function assessComment(commentText) {
  const text = String(commentText == null ? '' : commentText)
  if (tooThin(text)) return { engage: false, flags: ['thin'], reason: '没什么可接的' }
  const verdict = assessInbound(text, { fromOwner: false })
  if (verdict.action !== 'allow') {
    return { engage: false, flags: verdict.flags, reason: `可疑（${verdict.flags.join('、') || '话术'}），不接` }
  }
  if (HOSTILE.test(text)) return { engage: false, flags: ['hostile'], reason: '在骂人，不接话' }
  if (NOT_WORTH_IT.test(text)) return { engage: false, flags: ['negative'], reason: '在骂视频，跟我没关系' }
  return { engage: true, flags: [], reason: '' }
}

/** 兼容旧调用：canReply 就是 engage。 */
export function reviewComment(commentText) {
  const v = assessComment(commentText)
  return { level: v.engage ? 'none' : 'high', flags: v.flags, action: v.engage ? 'allow' : 'ignore', reply: '', canReply: v.engage, reason: v.reason }
}
