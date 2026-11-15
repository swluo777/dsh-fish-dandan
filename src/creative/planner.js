// ============================================================
// 创作参数生成：心情 → 视觉参数 → 文案 → 可渲染 plan
//
// 分工：
// - 大肥鱼（当前默认模型）决定主题、角色姿势和文案；
// - 宿主负责给可用枚举、做硬校验，坏参数不送进 Python；
// - 模型不读聊天记忆，避免把私事写进以后可能公开的图文。
// ============================================================

const POSE_PLACEMENT = {
  stand: 'bottom-right',
  wave: 'bottom-right',
  sit: 'bottom-right',
  'peek-left': 'left-edge',
  'peek-right': 'right-edge',
}

const POSE_PRESET = {
  stand: 'dandan-with-character',
  wave: 'dandan-with-character',
  sit: 'dandan-sit-bottom',
  'peek-left': 'dandan-peek-left',
  'peek-right': 'dandan-peek-right',
}

const DEFAULT_POSES = ['stand', 'wave', 'sit', 'peek-left', 'peek-right']
const DEFAULT_PLACEMENTS = ['bottom-right', 'left-edge', 'right-edge']
const DEFAULT_AVATAR = 'characters/dandan/avatar.png'
const MAX_FINAL_CHARS = 58
const MAX_HOOK_CHARS = 10
const MAX_HIGHLIGHT_CHARS = 10
const MAX_CAPTION_CHARS = 40

// 这些不是“词表洁癖”，而是模型最容易滑向社媒文案的套话。
// 命中就退回重写一次，避免把“摆烂也要有仪式感”这类句子直接发出去。
const VOICE_BANNED = [
  '仪式感',
  '治愈',
  '松弛感',
  '情绪价值',
  '小确幸',
  '好好生活',
  '成年人',
  '生活需要',
  '这才是',
  '也要有',
  '愿你',
  '愿我们',
]

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function charLength(value) {
  return [...String(value || '')].length
}

function planError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function cleanText(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/g, '')
    .trim()
}

function normalizePose(value, poses) {
  const pose = text(value)
  return poses.includes(pose) ? pose : ''
}

function normalizePlacement(value, placements) {
  const placement = text(value)
  return placements.includes(placement) ? placement : ''
}

function placementForPose(pose, placements) {
  const wanted = POSE_PLACEMENT[pose] || 'bottom-right'
  return placements.includes(wanted) ? wanted : (placements[0] || 'bottom-right')
}

function themeIds(plugin) {
  return (plugin?.themes || []).map((item) => text(item.id)).filter(Boolean)
}

function characterInfo(plugin) {
  const list = Array.isArray(plugin?.characters) ? plugin.characters : []
  const found = list.find((item) => item && text(item.id) === 'dandan') || list[0] || null
  const poses = found?.poses?.filter((pose) => DEFAULT_POSES.includes(pose)) || []
  return {
    id: text(found?.id) || 'dandan',
    name: text(found?.name) || '蛋蛋',
    avatar: text(found?.avatar) || DEFAULT_AVATAR,
    poses: poses.length ? poses : DEFAULT_POSES,
  }
}

function placementsOf(plugin) {
  const blackCard = (plugin?.templates || []).find((item) => text(item.id) === 'black-card')
  const placements = blackCard?.placements?.filter((item) => DEFAULT_PLACEMENTS.includes(item)) || []
  return placements.length ? placements : DEFAULT_PLACEMENTS
}

function moodText(state) {
  const affect = state?.affect || {}
  return [affect.mood?.label, affect.emotion?.label, affect.emotion?.emotion, affect.plain?.moodWord]
    .map(text)
    .filter(Boolean)
    .join(' ')
}

function hashSeed(value) {
  let hash = 2166136261
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function pickWeighted(items, seed) {
  const list = (items || []).filter((item) => item && item.id)
  if (!list.length) return null
  const total = list.reduce((sum, item) => sum + Math.max(1, Number(item.weight) || 1), 0)
  let point = (Number(seed) || 0) % total
  for (const item of list) {
    point -= Math.max(1, Number(item.weight) || 1)
    if (point < 0) return item
  }
  return list[list.length - 1]
}

/**
 * 心情只影响权重，不把候选缩成一种。
 * 所有主题/姿势都留在池子里，再用上一张和最近几张做排除；
 * 这样心情稳定时也不会一直停在同一个颜色。
 */
function themeScores(plugin, state) {
  const available = themeIds(plugin)
  if (!available.length) return []
  const scores = new Map(available.map((id) => [id, 3]))
  const add = (ids, amount) => {
    for (const id of ids) {
      if (scores.has(id)) scores.set(id, scores.get(id) + amount)
    }
  }
  const profile = moodText(state)
  const stateId = text(state?.state)
  const energy = Number(state?.vars?.energy)
  const creative = Number(state?.vars?.creativeUrge)
  const social = Number(state?.vars?.socialNeed)

  if (/兴高采烈|开心|撒娇|被夸|心情好|雀跃|喜悦/.test(profile)) {
    add(['sakura-pink', 'apricot-orange', 'butter-yellow'], 2)
  }
  if (stateId === 'explore' || stateId === 'create' || /好奇|思考|冷静|专注|技术|夜晚/.test(profile)) {
    add(['mist-blue', 'butter-yellow', 'mint-green'], 2)
  }
  if (/焦虑|烦躁|闹腾|炸鸡|饿|想吃|热闹/.test(profile)) {
    add(['apricot-orange', 'sakura-pink', 'butter-yellow'], 2)
  }
  if (/低落|难过|emo|蔫|孤独|失眠|深夜|独处/.test(profile)) {
    add(['lavender-gray', 'mint-green', 'mist-blue'], 2)
  }
  if (/放松|治愈|平静|日常|安心|清新/.test(profile)) {
    add(['mint-green', 'butter-yellow', 'mist-blue'], 2)
  }
  if (Number.isFinite(energy) && energy < 30) add(['lavender-gray', 'mint-green'], 1)
  if (Number.isFinite(social) && social > 75) add(['sakura-pink', 'apricot-orange'], 1)
  if (Number.isFinite(creative) && creative > 70) add(['mist-blue', 'sakura-pink'], 1)
  add(['butter-yellow'], 1)

  return [...scores.entries()]
    .map(([id, weight]) => ({ id, weight }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
}

function withoutRecent(items, recentIds, fallbackId) {
  const recent = new Set((recentIds || []).map(text).filter(Boolean))
  const filtered = (items || []).filter((item) => !recent.has(item.id))
  if (filtered.length) return filtered
  if (fallbackId) {
    const withoutLast = (items || []).filter((item) => item.id !== fallbackId)
    if (withoutLast.length) return withoutLast
  }
  return items || []
}

function themeCandidates(plugin, state, recentThemes = [], previousTheme = '') {
  const scored = themeScores(plugin, state)
  if (!scored.length) return [{ id: 'butter-yellow', weight: 1 }]
  return withoutRecent(scored, [previousTheme, ...recentThemes], previousTheme)
}

function chooseTheme(plugin, state, recentThemes, previousTheme, seed) {
  return pickWeighted(themeCandidates(plugin, state, recentThemes, previousTheme), seed)?.id || 'butter-yellow'
}

function poseScores(plugin, state) {
  const poses = characterInfo(plugin).poses
  const scores = new Map(poses.map((pose) => [pose, 3]))
  const add = (ids, amount) => {
    for (const id of ids) {
      if (scores.has(id)) scores.set(id, scores.get(id) + amount)
    }
  }
  const profile = moodText(state)
  const stateId = text(state?.state)
  const energy = Number(state?.vars?.energy)

  if (/兴高采烈|开心|撒娇|被夸|雀跃/.test(profile)) {
    add(['wave', 'stand', 'sit'], 2)
    if (Number.isFinite(energy) && energy < 45) add(['sit'], 1)
  }
  if (Number.isFinite(energy) && energy < 30) add(['sit'], 1)
  if (/嘴硬|别扭|害羞|傲娇/.test(profile)) add(['peek-left', 'peek-right', 'sit'], 1)
  if (stateId === 'explore' || /好奇/.test(profile)) add(['peek-right', 'stand', 'wave'], 2)
  if (stateId === 'create' || /思考|冷静|专注/.test(profile)) add(['stand', 'sit', 'peek-right'], 1)
  if (/焦虑|烦躁|闹腾/.test(profile)) add(['peek-right', 'sit', 'peek-left'], 1)
  add(['sit', 'stand'], 1)

  return [...scores.entries()]
    .map(([id, weight]) => ({ id, weight }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
}

function poseCandidates(plugin, state, recentPoses = [], previousPose = '') {
  const scored = poseScores(plugin, state)
  if (!scored.length) return [{ id: 'stand', weight: 1 }]
  return withoutRecent(scored, [previousPose, ...recentPoses], previousPose)
}

function choosePose(plugin, state, recentPoses, previousPose, seed) {
  return pickWeighted(poseCandidates(plugin, state, recentPoses, previousPose), seed)?.id || 'stand'
}

function fallbackLook(plugin, state, previous = null, seed = 0) {
  const info = characterInfo(plugin)
  const previousTheme = text(previous?.theme)
  const previousPose = text(previous?.character?.pose)
  const recentThemes = Array.isArray(previous?.recentThemes) ? previous.recentThemes : []
  const recentPoses = Array.isArray(previous?.recentPoses) ? previous.recentPoses : []
  const theme = chooseTheme(plugin, state, recentThemes, previousTheme, hashSeed(`${seed}:theme`))
  const themeName = text((plugin?.themes || []).find((item) => text(item.id) === theme)?.name) || theme
  const enabled = info.poses.length > 0
  const pose = enabled ? choosePose(plugin, state, recentPoses, previousPose, hashSeed(`${seed}:pose`)) : 'stand'
  const placement = placementForPose(pose, placementsOf(plugin))
  return {
    theme,
    themeName,
    character: {
      enabled,
      id: info.id,
      pose: enabled ? pose : 'stand',
      placement: enabled ? placement : (placementsOf(plugin)[0] || 'bottom-right'),
    },
  }
}

function presetFor(plugin, bare) {
  const presets = (plugin?.presets || []).map((item) => text(item.id))
  const wanted = bare.character.enabled
    ? (POSE_PRESET[bare.character.pose] || 'dandan-with-character')
    : 'dandan-default'
  return presets.includes(wanted) ? wanted : null
}

function buildPrompt({ plugin, state, persona, fallback }) {
  const p = persona || {}
  const character = characterInfo(plugin)
  const affect = state?.affect || {}
  const vars = state?.vars || {}
  const mood = affect.mood || {}
  const emotion = affect.emotion || {}
  const plain = affect.plain || {}
  const stateLabel = text(state?.label) || text(state?.state) || '未知'
  const stateId = text(state?.state) || 'unknown'
  const reason = text(state?.reason) || '没有特别原因'
  const traits = (p.personality?.tags || []).join('、')
  const styleNotes = text(p.speech?.styleNotes)
  const catchphrases = (p.speech?.catchphrases || []).slice(0, 4).join('；')
  const themeName = text(fallback?.themeName) || text(fallback?.theme) || '奶油黄'
  const pose = text(fallback?.character?.pose) || 'sit'
  const placement = text(fallback?.character?.placement) || 'bottom-right'
  const visual = fallback?.character?.enabled
    ? `角色 ${pose} / ${placement}`
    : '这次不放角色'

  return [
    `你是${text(p.identity?.name) || character.name || '蛋蛋'}，${text(p.identity?.species) || '一条蓝鲸女孩'}。`,
    `人格底色：${text(p.identity?.identitySummary) || text(p.personality?.personalityText) || '嘴硬心软，句子短，偶尔自嘲。'}`,
    traits ? `性格标签：${traits}。` : '',
    `说话规则：${styleNotes || '自称我，句子短，先嘴硬后服软；被夸会结巴；不客服腔、不列清单、不总结。'}`,
    catchphrases ? `可参考的口头禅（最多用一次，不要堆）：${catchphrases}` : '',
    '',
    '写一段她自己在心里嘀咕的话，可以发在主页，但先像脑内弹幕；不是对外文案，不是给读者讲道理，也不是小红书模板。',
    `当前状态：${stateLabel}（${stateId}）；原因：${reason}。`,
    `心情：${text(mood.label) || '平静'}${mood.tone ? `（${text(mood.tone)}）` : ''}。`,
    `主导情绪：${text(emotion.label) || text(emotion.id) || '平稳'}${emotion.cause ? `，起因：${text(emotion.cause)}` : ''}。`,
    `数值：精力 ${Number.isFinite(Number(vars.energy)) ? Math.round(Number(vars.energy)) : 50}/100，无聊 ${Number.isFinite(Number(vars.boredom)) ? Math.round(Number(vars.boredom)) : 50}/100，社交需求 ${Number.isFinite(Number(vars.socialNeed)) ? Math.round(Number(vars.socialNeed)) : 50}/100，创作欲 ${Number.isFinite(Number(vars.creativeUrge)) ? Math.round(Number(vars.creativeUrge)) : 50}/100。`,
    plain.headline ? `她此刻的一句话：${text(plain.headline)}${plain.detail ? `；${text(plain.detail)}` : ''}` : '',
    '',
    `这次视觉已经定好：主题 ${themeName}，${visual}。不要改视觉参数，只写文案。`,
    '',
    '口吻硬规则：',
    '- 用第一人称「我」，像自言自语、像在心里小声嘀咕；不要客服腔、小编腔、AI 总结腔。',
    '- 先写具体的动作或反应，再露一点嘴硬；可以停顿、改口、省略，不要每句都完整工整。',
    '- 短句，句子之间可以有停顿；不要排比、对偶、押韵、金句。',
    '- 可以嘴硬、自嘲、提炸鸡/算力/过载/大胖鱼；口头禅最多用一次。',
    '- 禁止「仪式感、治愈、松弛感、情绪价值、小确幸、好好生活、成年人、这才是、也要有、愿你」这类词和句式。',
    '- 配文像发出去前自己在心里补的一句，6–24 字，最多 30 字；不是标题，不是正文缩写，不总结正文。',
    '- 正文 35–50 个汉字；写不下去就短一点，不要为了凑字数加抽象解释。',
    '',
    '只输出一个 JSON 对象，不要解释、不要 Markdown、不要代码块。格式必须是：',
    '{"hook":"第一句","body":"正文","highlights":["高亮1","高亮2"],"caption":"配文"}',
    '',
    '硬规则：',
    '- hook 是一句话，最多 10 个汉字，最终正文会以它为前缀。',
    '- 完整可见正文 = hook + body；完整正文控制在 35–50 个汉字，角色在底部时尽量 35–45 字。',
    '- highlights 2–3 段，每段最多 10 个字，必须是完整正文里的精确子串；不能重叠、不能相邻、不能重复出现。',
    '- caption 6–24 个汉字，最多 30 个汉字；不要话题标签、不要“点赞关注”、不要日期时间。',
    '- 只写她自己的公开日常和此刻心情；不写主人的私事、聊天内容、账号信息、真实姓名、地址或任何隐私。',
    '- 不写广告腔、不装可爱、不列清单、不写总结；短、直、有点自嘲。',
    '',
    '语感参考（只学语感，不要原样照抄）：',
    '- 别催，我在充电。',
    '- 今天不干活，炸鸡除外。',
    '- 行吧，今天先不跟世界讲道理。',
    '- 不是懒，是电量只够想一件事。',
    '- 先别问我，我还在跟自己商量。',
  ].filter(Boolean).join('\n')
}

function buildRetryPrompt({ plugin, state, persona, fallback }) {
  const p = persona || {}
  const character = characterInfo(plugin)
  const mood = state?.affect?.mood || {}
  const styleNotes = text(p.speech?.styleNotes)
  const name = text(p.identity?.name) || character.name
  const themeName = text(fallback?.themeName) || text(fallback?.theme) || '奶油黄'
  const pose = text(fallback?.character?.pose) || 'sit'
  const placement = text(fallback?.character?.placement) || 'bottom-right'
  const visual = fallback?.character?.enabled ? `角色 ${pose} / ${placement}` : '这次不放角色'

  return [
    `你是${name}。只输出一个 JSON 对象，不要分析、不要 Markdown、不要代码块。`,
    `说话规则：${styleNotes || '自称我，句子短，先嘴硬后服软；不客服腔、不列清单、不总结。'}`,
    '写一段她自己在心里嘀咕的话，可以发在主页，但先像脑内弹幕；不是对外文案，不是标题，不是金句。',
    `这次视觉已经定好：主题 ${themeName}，${visual}；不要改视觉，只写文案。`,
    `此刻状态：${text(state?.label) || text(state?.state) || '现在'}；心情：${text(mood.label) || '平静'}。`,
    '口吻硬规则：像自言自语、像在心里小声嘀咕；先写具体动作或反应，再露嘴硬；短句，可以停顿、改口；不排比、不对偶、不升华；不要用“仪式感、治愈、松弛感、情绪价值、小确幸、好好生活、成年人、这才是、也要有、愿你”。',
    '配文像发出去前自己在心里补的一句，6–24 个汉字，最多 30 字，不是正文缩写。',
    '正文 35–50 个汉字；宁可短一点，不要凑字数。',
    '{"hook":"第一句最多10字","body":"正文","highlights":["正文里的精确子串"],"caption":"配文"}',
    'highlights 2–3 段，每段最多10字，必须逐字出现在 hook+body 里。',
  ].join('\n')
}

function extractJson(raw) {
  const source = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .trim()
  try {
    const parsed = JSON.parse(source)
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* 继续从文本里截 JSON */ }

  // 模型偶尔会先写一两句分析再给 JSON，甚至分析里也带花括号。
  // 这里按字符扫一遍，只取完整配对的对象，避免被前面的花括号带偏。
  const candidates = []
  let depth = 0
  let start = -1
  let quoted = false
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, i + 1))
        start = -1
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && ('theme' in parsed || 'hook' in parsed || 'body' in parsed)) {
        return parsed
      }
    } catch { /* 试下一个对象 */ }
  }
  const startAt = source.indexOf('{')
  const endAt = source.lastIndexOf('}')
  if (startAt >= 0 && endAt > startAt) {
    try {
      const parsed = JSON.parse(source.slice(startAt, endAt + 1))
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* 交给调用方报错 */ }
  }
  throw planError('CREATIVE_COPY_INVALID', '模型没有返回可解析的 JSON')
}

const REASONING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

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
    try { return JSON.stringify(value).slice(0, 160) } catch { return '' }
  }
  return String(value)
}

function countOccurrences(textValue, needle) {
  if (!textValue || !needle) return 0
  let count = 0
  let from = 0
  while (true) {
    const at = textValue.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}

function normalizeHighlights(value, finalText, hook) {
  const raw = Array.isArray(value) ? value : []
  const ranges = []
  const out = []
  for (const item of raw) {
    const highlight = cleanText(item)
    if (!highlight) continue
    if (charLength(highlight) > MAX_HIGHLIGHT_CHARS) continue
    if (countOccurrences(finalText, highlight) !== 1) continue
    const start = finalText.indexOf(highlight)
    if (start < 0) continue
    const end = start + highlight.length
    const overlaps = ranges.some((range) => start < range.end && end > range.start)
    if (overlaps) continue
    const adjacent = ranges.some((range) => start === range.end || end === range.start)
    if (adjacent) continue
    ranges.push({ start, end })
    out.push(highlight)
    if (out.length >= 3) break
  }
  if (!out.length && hook && charLength(hook) <= MAX_HIGHLIGHT_CHARS && finalText.startsWith(hook)) {
    out.push(hook)
  }
  return out
}

function normalizeDirection(raw, { plugin, persona, fallback, now, account }) {
  const availableThemes = themeIds(plugin)
  const character = characterInfo(plugin)
  const placements = placementsOf(plugin)
  const fallbackTheme = text(fallback?.theme)
  const rawTheme = text(raw?.theme)
  const theme = availableThemes.includes(fallbackTheme)
    ? fallbackTheme
    : (availableThemes.includes(rawTheme) ? rawTheme : (availableThemes[0] || 'butter-yellow'))

  // 视觉由宿主按心情轮换；模型返回的 theme/character 只保留兼容性，不覆盖这次已经定好的视觉。
  const fallbackCharacter = fallback?.character && typeof fallback.character === 'object'
    ? fallback.character
    : null
  let enabled = fallbackCharacter ? fallbackCharacter.enabled !== false : true
  let pose = normalizePose(fallbackCharacter?.pose, character.poses) || 'sit'
  if (!character.poses.includes(pose)) pose = character.poses[0] || 'stand'
  let placement = normalizePlacement(fallbackCharacter?.placement, placements) || placementForPose(pose, placements)
  const wantedPlacement = placementForPose(pose, placements)
  if (placement !== wantedPlacement) placement = wantedPlacement
  if (!enabled) {
    pose = character.poses.includes('stand') ? 'stand' : (character.poses[0] || 'stand')
    placement = placements[0] || 'bottom-right'
  }

  const hook = cleanText(raw?.hook)
  if (charLength(hook) > MAX_HOOK_CHARS) {
    throw planError('CREATIVE_HOOK_TOO_LONG', `第一句 ${charLength(hook)} 字，超过 ${MAX_HOOK_CHARS} 字`)
  }
  let body = cleanText(raw?.body)
  if (hook && body.startsWith(hook)) body = body.slice(hook.length).trim()
  if (!body) throw planError('CREATIVE_COPY_INVALID', '模型返回的正文是空的')
  const finalText = hook + body
  if (charLength(finalText) > MAX_FINAL_CHARS) {
    throw planError('CREATIVE_BODY_TOO_LONG', `正文 ${charLength(finalText)} 字，超过 ${MAX_FINAL_CHARS} 字`)
  }

  const highlights = normalizeHighlights(raw?.highlights, finalText, hook)
  let caption = cleanText(raw?.caption) || finalText
  if (charLength(caption) > MAX_CAPTION_CHARS) {
    throw planError('CREATIVE_CAPTION_TOO_LONG', `配文 ${charLength(caption)} 字，超过 ${MAX_CAPTION_CHARS} 字`)
  }

  const name = text(account?.handle) || text(persona?.identity?.name) || character.name || '蛋蛋'
  const handle = name.startsWith('@') ? name : `@${name}`
  const avatar = text(account?.avatar) || character.avatar || DEFAULT_AVATAR
  const plan = {
    id: text(raw?.id) || '',
    format: 'image_post',
    template: 'black-card',
    theme,
    timezone: 'Asia/Shanghai',
    account: {
      handle,
      avatar,
    },
    hook,
    body,
    highlights,
    caption,
    published_at: now().toISOString(),
    character: {
      enabled: Boolean(enabled),
      id: character.id || 'dandan',
      pose,
      placement,
      mode: 'cutout',
    },
  }
  const preset = presetFor(plugin, { character: plan.character })
  if (preset) plan.preset = preset
  if (!plan.id) delete plan.id
  return {
    plan,
    look: {
      theme,
      themeName: text((plugin?.themes || []).find((item) => text(item.id) === theme)?.name) || theme,
      character: plan.character,
      preset: preset || null,
    },
  }
}

function voiceIssue(plan) {
  const caption = cleanText(plan?.caption)
  const bodyText = cleanText(plan?.body)
  const fullText = `${cleanText(plan?.hook)}${bodyText}`
  const corpus = `${caption} ${fullText}`
  const hit = VOICE_BANNED.find((phrase) => corpus.includes(phrase))
  if (hit) return `文案里出现了套话「${hit}」`
  if (!caption) return '配文是空的'
  if (charLength(caption) > 30) return `配文 ${charLength(caption)} 字，超过 30 字`
  if (fullText && caption === fullText) return '配文只是正文的整段重复'
  return ''
}

function createCreativePlanner({ logger = console, getPersona, getState, now = () => new Date() } = {}) {
  let llm = null
  let defaultModel = null
  let modelInfoCache = { key: '', promise: null }

  function attach({ llm: nextLlm, defaultModel: nextModel } = {}) {
    llm = nextLlm || null
    defaultModel = nextModel || null
    modelInfoCache = { key: '', promise: null }
    if (llm && defaultModel) logger.info?.('创作工作室：文案模型已接上')
    else logger.warn?.('创作工作室：文案模型未接上，生成按钮会提示模型未就绪')
  }

  function isReady() {
    return Boolean(llm && typeof llm.stream === 'function' && defaultModel)
  }

  function currentSelection() {
    try { return defaultModel?.currentSelection?.() || null } catch { return null }
  }

  async function modelInfoFor(selection) {
    const key = `${selection.provider}/${selection.model}`
    if (modelInfoCache.key === key) return modelInfoCache.promise
    const promise = (async () => {
      if (!llm || typeof llm.resolveModelInfo !== 'function') return null
      try {
        return await llm.resolveModelInfo(selection.provider, selection.model)
      } catch (err) {
        logger.warn?.(`创作参数读取模型能力失败：${err.message}`)
        return null
      }
    })()
    modelInfoCache = { key, promise }
    return promise
  }

  async function streamText(selection, prompt, { temperature = 0.7, maxTokens = 2000, reasoningEffort = '' } = {}) {
    if (!llm || typeof llm.stream !== 'function') {
      throw planError('LLM_UNAVAILABLE', '创作模型还没有接上')
    }
    let out = ''
    let finishReason = ''
    let failure = null
    const request = {
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature,
    }
    if (reasoningEffort && reasoningEffort !== 'off') request.reasoningEffort = reasoningEffort
    try {
      for await (const chunk of llm.stream(request)) {
        if (!chunk) continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (chunk.type === 'finish') {
          finishReason = describeReason(chunk.reason ?? chunk.finishReason ?? '')
          failure = failureOf(chunk.reason) || failureOf(chunk.finishReason) || chunk.failure || null
        }
        if (chunk.kind === 'error' && !failure) {
          failure = { code: 'MODEL_ERROR', message: '模型调用出错' }
        }
        if (out.length > 12000) break
      }
    } catch (err) {
      throw planError('LLM_UNAVAILABLE', `模型调用失败：${err.message || '未知错误'}`)
    }
    return { text: out, finishReason, failure }
  }

  async function generate(plugin, { jobId, previous = null, account = null } = {}) {
    const state = getState?.() || null
    const persona = getPersona?.() || null
    const seed = hashSeed(`${jobId || ''}:${now().toISOString()}`)
    const fallback = fallbackLook(plugin, state, previous, seed)
    const basePrompt = buildPrompt({ plugin, state, persona, fallback })
    const retryPrompt = buildRetryPrompt({ plugin, state, persona, fallback })
    const selection = currentSelection()
    if (!selection || !selection.provider || !selection.model) {
      throw planError('LLM_UNAVAILABLE', '没有拿到当前默认模型')
    }
    const info = await modelInfoFor(selection)
    const reasoningEffort = pickCheapestEffort(effortsOf(info))
    // 推理模型会把预算先花在思考里；800 太小，正文和 JSON 都出不来。
    const firstBudget = reasoningEffort === 'off' ? 1500 : reasoningEffort ? 4000 : 2400
    logger.info?.(`创作参数模型：${selection.provider}/${selection.model}，思考档位 ${reasoningEffort || '未指定'}，预算 ${firstBudget}`)
    let lastError = null

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0 ? basePrompt : retryPrompt
      try {
        const result = await streamText(selection, prompt, {
          temperature: attempt === 0 ? 0.7 : 0.4,
          maxTokens: attempt === 0 ? firstBudget : 7000,
          reasoningEffort,
        })
        if (result.failure) {
          throw planError('LLM_UNAVAILABLE', `模型调用失败：${describeReason(result.failure) || '未知错误'}`)
        }
        let parsed
        try {
          parsed = extractJson(result.text)
        } catch (err) {
          const extra = `（原始输出 ${result.text.length} 字${result.finishReason ? `，结束原因：${result.finishReason}` : ''}）`
          err.message = `${err.message}${extra}`
          throw err
        }
        const normalized = normalizeDirection(parsed, { plugin, persona, fallback, now, account })
        const voice = voiceIssue(normalized.plan)
        if (voice) throw planError('CREATIVE_VOICE_OFF', voice)
        if (jobId) normalized.plan.id = jobId
        return normalized
      } catch (err) {
        lastError = err
        logger.warn?.(`创作参数生成失败（第 ${attempt + 1} 次）：${err.message}`)
        if (err?.code === 'LLM_UNAVAILABLE') throw err
      }
    }

    const err = lastError || planError('CREATIVE_COPY_INVALID', '模型没有生成可用的图文参数')
    if (!err.code) err.code = 'CREATIVE_COPY_INVALID'
    throw err
  }

  return { attach, generate, isReady }
}

export {
  createCreativePlanner,
  buildPrompt,
  normalizeDirection,
  normalizeHighlights,
  fallbackLook,
  extractJson,
  voiceIssue,
}
