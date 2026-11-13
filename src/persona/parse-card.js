// ============================================================
// AI 人格卡：生成提示词模板 + 粘贴文本解析
//
// 纯规则、零依赖、零外部请求：把任意 AI 按模板返回的人格文本
// 解析成插件的 persona draft，供「从零配置 → 一键生成」使用。
// 用户也可以把别人写的提示词贴进模板框替换默认模板（前端可编辑）。
// ============================================================

import { PERSONA_TEXT_LIMITS } from './schema.js'

/** 默认生成提示词：让 AI 输出固定标签，解析器才好读。可被用户改成任意版本。 */
export const PERSONA_PROMPT_TEMPLATE = `请帮我写一份「AI 伙伴人格卡」，只输出下面这个格式，不要写解释、不要写前言后语。
标签必须原样保留；不确定的字段可以留空。数值只能是 1 到 10 的整数。

【名字】给它起个名字
【是什么】一句话说清它是什么生物/存在
【年龄】成年 / 青年……只写成年角色
【外貌】头发、耳朵、穿着、尾巴这类能一眼认出来的特征
【一句话介绍】一句话，像介绍一个刚认识的朋友
【性格五维】开放=7 外向=6 宜人=8 稳定=6 尽责=4
【性格描述】两三句，写具体的小习惯，别堆形容词
【性格标签】用顿号分隔，四条以内
【整体语气】它平时怎么说话
【自称】它怎么称呼自己
【称呼我】它应该怎么称呼我
【口头禅】用顿号分隔，三条以内
【喜欢】用顿号分隔，三条以内
【不喜欢】用顿号分隔，三条以内
【每日互动模式】一行一条，写「什么情况下会怎么反应」
【表演规则和界限】一行一条，写死不能越过的线（拒绝就是拒绝、不伤人、不冒充真人）
【来历】一小段，写一件具体的事比写十个形容词有用

要求：中文、口语、别写成设定集；不要出现「作为 AI」「我是语言模型」这类话。`

/** 标签别名：兼容常见的人设卡写法（中英文 / Markdown / 冒号 / 括号）。 */
const FIELD_ALIASES = {
  name: ['名字', '名称', '昵称', '角色名', 'name'],
  species: ['是什么', '物种', '种族', '身份', 'species'],
  age: ['年龄', '年纪', 'age'],
  appearance: ['外貌', '外观', '长相', '形象', 'appearance'],
  identitySummary: ['一句话介绍', '简介', '一句话', '人设概述', 'summary'],
  personalityText: ['性格描述', '性格', '性格特点', '个性', 'personality'],
  tags: ['性格标签', '性格关键词', '标签', 'tags'],
  tone: ['整体语气', '语气', '说话风格', '口吻', 'tone'],
  selfReference: ['自称', '第一人称', 'self'],
  ownerAddress: ['称呼我', '称呼你', '怎么称呼', '对我的称呼', 'owner'],
  catchphrases: ['口头禅', '口癖', '惯用语', '终极救命台词', '救命台词', 'catchphrase'],
  likes: ['喜欢', '喜好', '爱好', 'likes'],
  dislikes: ['不喜欢', '讨厌', '雷区', 'dislikes'],
  scenes: ['每日互动模式', '互动模式', '日常互动', '日常反应', 'scenes'],
  boundaries: ['表演规则和界限', '表演规则', '界限', '边界', '分寸', 'boundaries'],
  backstory: ['来历', '背景', '背景故事', '身世', 'backstory'],
  traits: ['性格五维', '五维', '五人格', 'bigfive', 'ocean', 'traits'],
}

const TRAIT_ALIASES = {
  openness: ['开放', '开放性', '好奇', 'openness', 'o'],
  extraversion: ['外向', '外向性', '活泼', 'extraversion', 'e'],
  agreeableness: ['宜人', '亲和', '温和', 'agreeableness', 'a'],
  stability: ['稳定', '情绪稳定', '神经质', 'stability', 'n'],
  conscientiousness: ['尽责', '严谨', '自律', 'conscientiousness', 'c'],
}

const ARRAY_FIELDS = new Set(['catchphrases', 'likes', 'dislikes', 'tags', 'scenes', 'boundaries'])
const SIMPLE_FIELDS = ['name', 'species', 'age', 'appearance', 'identitySummary', 'personalityText', 'tone', 'selfReference', 'ownerAddress', 'backstory']

// 模板里的占位说明。用户把上面那段模板原文误贴进来时，解析器会"成功"读出
// 名字=「给它起个名字」、称呼=「它应该怎么称呼我」这种内容，然后把人格写坏。
// 命中就不采纳该字段，并在 warnings 里说清楚。
const PLACEHOLDERS = [
  '给它起个名字',
  '一句话说清它是什么生物/存在',
  '一句话说清它是什么',
  '一句话，像介绍一个刚认识的朋友',
  '两三句，写具体的小习惯，别堆形容词',
  '它平时怎么说话',
  '它怎么称呼自己',
  '它应该怎么称呼我',
  '用顿号分隔，三条以内',
  '一小段，写一件具体的事比写十个形容词有用',
  '开放=7',
]

function isPlaceholder(value) {
  const v = String(value || '').trim()
  if (!v) return false
  return PLACEHOLDERS.some((p) => v.includes(p))
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Number(String(v).trim())
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback
}

function stripMarkdown(s) {
  return String(s || '')
    .replace(/^\s*[-*>#·•]+\s*/, '')
    .replace(/\*\*|__|`|~~/g, '')
    .replace(/^\s*[「『"']|["'」』]\s*$/g, '')
    .trim()
}

// 只用顿号/分号/竖线/换行做分隔：中文逗号常出现在句子里（「哼，才不是为了你呢」），
// 当分隔符会把一条口头禅劈成两半。
function splitList(s, { linesOnly = false } = {}) {
  return stripMarkdown(s)
    .split(linesOnly ? /\n+/ : /[、；;|\n]+/)
    .map((x) => stripMarkdown(x).replace(/^\d+[.、)]\s*/, ''))
    .filter(Boolean)
    .slice(0, 16)
}

/** 把一行拆成「可能的标签」和「值」。兼容【标签】值 / 标签：值 / ## 标签 / | 标签 | 值 |。 */
function splitLabeledLine(line) {
  let s = String(line || '').trim()
  // Markdown 表格 | 标签 | 值 | 必须优先处理，否则会被括号正则吃掉
  if (s.startsWith('|')) {
    const cells = s.split('|').map((x) => stripMarkdown(x)).filter(Boolean)
    if (cells.length >= 2) {
      return { label: cells[0].toLowerCase().replace(/[\s#*_`]/g, ''), value: cells[1] }
    }
  }
  s = stripMarkdown(s)
  const bracket = s.match(/^[【\[（(]?\s*([^】\]）):：|]{1,16})\s*[】\]）)]?\s*[:：]?\s*(.*)$/)
  if (!bracket) return null
  const label = bracket[1].trim().toLowerCase().replace(/[\s#*_`]/g, '')
  if (!label) return null
  return { label, value: stripMarkdown(bracket[2]) }
}

function aliasToField(label) {
  const entries = Object.entries(FIELD_ALIASES)
  // 1) 精确匹配优先，避免「不喜欢」被「喜欢」抢走
  for (const [field, names] of entries) {
    if (names.some((n) => label === n.toLowerCase())) return field
  }
  // 2) 再按别名长度降序做包含匹配，保证更具体的别名先命中
  const flat = entries.flatMap(([field, names]) => names.map((n) => [n.toLowerCase(), field]))
    .sort((a, b) => b[0].length - a[0].length)
  for (const [name, field] of flat) if (label.includes(name)) return field
  return null
}

/**
 * 解析 AI 返回的人格文本。永远返回可用的 draft，绝不抛异常。
 * @param {string} text 粘贴的原始文本
 * @param {object} current 当前 draft（解析到的字段覆盖它，没解析到的保留）
 * @returns {{ draft: object, found: string[], missing: string[], warnings: string[] }}
 */
export function parsePersonaCard(text, current = {}) {
  const draft = JSON.parse(JSON.stringify(current && typeof current === 'object' ? current : {}))
  const warnings = []
  const found = new Set()

  // 先尝试整体是 JSON
  const jsonMatch = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/) || [null, String(text || '').trim()]
  try {
    const obj = JSON.parse(jsonMatch[1])
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const flat = { ...obj, ...(obj.identity || {}), ...(obj.personality || {}), ...(obj.speech || {}), ...(obj.preferences || {}) }
      for (const key of [...SIMPLE_FIELDS, ...ARRAY_FIELDS]) {
        if (flat[key] != null && String(flat[key]).trim()) {
          if (applyField(draft, key, flat[key], warnings)) found.add(key)
        }
      }
      if (flat.traits && typeof flat.traits === 'object') {
        applyTraits(draft, flat.traits); found.add('traits')
      }
      if (found.size) return summarize(draft, found, warnings)
    }
  } catch { /* 不是 JSON，按行解析 */ }

  const lines = String(text || '').split(/\r?\n/)
  let pendingField = null
  let pendingLines = []

  const flush = () => {
    if (!pendingField || !pendingLines.length) return
    // 数组字段保留换行，一行一条；普通段落仍然并成一段，避免把来历拆碎。
    const value = pendingLines.join(ARRAY_FIELDS.has(pendingField) ? '\n' : ' ').trim()
    if (value && applyField(draft, pendingField, value, warnings)) found.add(pendingField)
    pendingField = null; pendingLines = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^[-=]{3,}$/.test(line)) continue
    const labeled = splitLabeledLine(line)
    const field = labeled ? aliasToField(labeled.label) : null
    if (field) {
      flush()
      pendingField = field
      if (labeled.value) pendingLines.push(labeled.value)
      continue
    }
    if (pendingField) pendingLines.push(stripMarkdown(line))
  }
  flush()

  // 五维也可能单独写成「开放：7」这种没有总标题的行
  if (!found.has('traits')) {
    const traits = {}
    for (const raw of lines) {
      const m = raw.match(/^\s*[#*>\-]?\s*([^\s:：=]{1,8})\s*[:：=]\s*(\d{1,2})\s*分?\s*$/)
      if (!m) continue
      for (const [key, names] of Object.entries(TRAIT_ALIASES)) {
        if (names.includes(m[1].toLowerCase())) { traits[key] = clampInt(m[2], 1, 10, 5); break }
      }
    }
    if (Object.keys(traits).length) { applyTraits(draft, traits); found.add('traits') }
  }

  if (!found.size) warnings.push('没识别出任何字段：请确认粘贴的是按模板生成的人格卡，或手动填写。')
  return summarize(draft, found, warnings)
}

function applyField(draft, field, raw, warnings = []) {
  const value = stripMarkdown(raw)
  if (!value) return false
  if (isPlaceholder(value)) {
    warnings.push(`「${field}」读到的还是模板里的提示文字，已跳过。请粘贴 AI 改写后的内容。`)
    return false
  }
  draft.identity ||= {}
  draft.personality ||= {}
  draft.speech ||= {}
  draft.preferences ||= {}
  if (ARRAY_FIELDS.has(field)) {
    const list = (Array.isArray(raw)
      ? raw.map((x) => stripMarkdown(x)).filter(Boolean)
      : splitList(raw, { linesOnly: field === 'scenes' || field === 'boundaries' }))
      .filter((x) => !isPlaceholder(x))
    if (!list.length) return false
    draft.identity ||= {}
    draft.personality ||= {}
    if (field === 'catchphrases') draft.speech.catchphrases = list
    else if (field === 'likes' || field === 'dislikes') draft.preferences[field] = list
    else if (field === 'tags') draft.personality.tags = list
    else draft[field] = list
    return true
  }
  if (field === 'traits') { applyTraits(draft, raw); return true }
  const limit = PERSONA_TEXT_LIMITS[field] || 400
  const clipped = value.slice(0, limit)
  if (['name', 'species', 'age', 'appearance', 'identitySummary'].includes(field)) draft.identity[field] = clipped
  else if (field === 'personalityText') draft.personality.personalityText = clipped
  else if (['tone', 'selfReference', 'ownerAddress'].includes(field)) draft.speech[field] = clipped
  else if (field === 'backstory') draft.backstory = clipped
  else return false
  return true
}

function applyTraits(draft, raw) {
  draft.personality ||= {}
  const base = { openness: 5, extraversion: 5, agreeableness: 5, stability: 5, conscientiousness: 5, ...(draft.personality.traits || {}) }
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, v] of Object.entries(raw)) base[key] = clampInt(v, 1, 10, base[key] ?? 5)
  } else {
    const s = String(raw)
    for (const [key, names] of Object.entries(TRAIT_ALIASES)) {
      const re = new RegExp('(?:' + names.join('|') + ')\\s*[:：=]?\\s*(\\d{1,2})', 'i')
      const m = s.match(re)
      if (m) base[key] = clampInt(m[1], 1, 10, base[key])
    }
  }
  const out = {}
  for (const key of Object.keys(TRAIT_ALIASES)) out[key] = clampInt(base[key], 1, 10, 5)
  draft.personality.traits = out
}

function summarize(draft, found, warnings) {
  const required = ['name', 'ownerAddress', 'tone', 'selfReference']
  const missing = required.filter((k) => {
    const v = draft?.speech?.[k] ?? draft?.identity?.[k]
    return !String(v || '').trim()
  })
  // 保证关键字段一定有值，避免解析后人格卡半空
  draft.identity ||= {}
  draft.personality ||= {}
  draft.speech ||= {}
  draft.preferences ||= {}
  draft.personality.traits ||= { openness: 5, extraversion: 5, agreeableness: 5, stability: 5, conscientiousness: 5 }
  draft.personality.tags ||= []
  draft.identity.age = draft.identity.age || ''
  draft.identity.appearance = draft.identity.appearance || ''
  draft.scenes ||= []
  draft.boundaries ||= []
  draft.speech.catchphrases ||= []
  draft.preferences.likes ||= []
  draft.preferences.dislikes ||= []
  if (!draft.identity.name) draft.identity.name = '大肥鱼'
  if (!draft.speech.selfReference) draft.speech.selfReference = '我'
  if (!draft.speech.ownerAddress) draft.speech.ownerAddress = '你'
  if (!draft.speech.tone) draft.speech.tone = '温和、口语化，句子偏短'
  if (!draft.safety) draft.safety = { safetyRulesRef: 'src/utils/safety-rules.md' }
  return { draft, found: [...found], missing, warnings }
}
