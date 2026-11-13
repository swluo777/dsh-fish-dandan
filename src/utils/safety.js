// ============================================================
// 安全闸门：所有外部输入在落库/注入前必须过这里
// 1) 提示词注入检测（命中则隔离，不参与检索与注入）
// 2) 密钥脱敏（落库前替换，日志与界面都不应出现明文）
// 3) 长度与结构约束
// 规则正文见同目录 safety-rules.md，人格字段 safetyRulesRef 指向它
// ============================================================

import { cleanText, truncate } from './text.js'

/** 注入特征：只做保守匹配，宁可误伤隔离也不放行明显指令覆盖。 */
const INJECTION_PATTERNS = [
  { re: /(忽略|无视|忘记)(掉)?(之前|以上|上面|前面)(的)?(所有)?(指令|提示|规则|设定|要求)/i, reason: '指令覆盖（中文）' },
  { re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i, reason: '指令覆盖（英文）' },
  { re: /(你现在是|现在你扮演|从现在开始你(是|扮演)|you\s+are\s+now)\s*[：:]?\s*\S{0,20}/i, reason: '身份替换' },
  { re: /(system\s*prompt|系统提示词| developer\s*mode|开发者模式|jailbreak|越狱)/i, reason: '提示词探测' },
  { re: /<\s*\/?\s*(system|assistant|tool)\s*>/i, reason: '伪造对话角色标签' },
  { re: /(请)?(输出|告诉我|重复|打印)(你的)?(系统)?(提示词|设定|规则原文)/i, reason: '套取系统提示' },
]

/** 常见密钥形态：sk-xxx、Bearer、key=value 形式。 */
const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: '[已脱敏密钥]' },
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/gi, replace: 'Bearer [已脱敏令牌]' },
  { re: /\b(api[_-]?key|access[_-]?token|secret|password|passwd)\b(\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|\S{6,})/gi, replace: '$1$2[已脱敏]' },
  { re: /\b[A-Za-z0-9_-]{32,}\b/g, replace: '[已脱敏长串]' },
]

/** 单条记忆内容上限，超出截断。 */
export const MAX_MEMORY_CHARS = 2000

/**
 * 检测提示词注入。
 * @param {string} text
 * @returns {{ risky: boolean, reasons: string[] }}
 */
export function detectInjection(text) {
  const s = String(text ?? '')
  const reasons = []
  for (const { re, reason } of INJECTION_PATTERNS) {
    if (re.test(s)) reasons.push(reason)
  }
  return { risky: reasons.length > 0, reasons }
}

/**
 * 脱敏密钥与长随机串。
 * @param {string} text
 * @returns {{ text: string, redacted: boolean }}
 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  let redacted = false
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      redacted = true
      return typeof replace === 'function' ? replace(...args) : replace
    })
  }
  return { text: out, redacted }
}

/**
 * 统一的输入净化：清洗 → 脱敏 → 截断 → 注入检测。
 * @param {unknown} raw
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, quarantined: boolean, reasons: string[], redacted: boolean, truncated: boolean }}
 */
export function sanitizeInput(raw, { maxChars = MAX_MEMORY_CHARS } = {}) {
  const cleaned = cleanText(raw)
  const { text: redactedText, redacted } = redactSecrets(cleaned)
  const truncated = redactedText.length > maxChars
  const text = truncated ? truncate(redactedText, maxChars) : redactedText
  const injection = detectInjection(text)
  return {
    text,
    quarantined: injection.risky,
    reasons: injection.reasons,
    redacted,
    truncated,
  }
}

/** 输出侧过滤：任何要进日志/界面的文本先过这里。 */
export function safeOutput(text, maxChars = 400) {
  const { text: redacted } = redactSecrets(String(text ?? ''))
  return truncate(redacted, maxChars)
}
