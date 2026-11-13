// ============================================================
// 自然语言微调人格：一句话 -> 变更提案（只解析，不落盘）
// 设计约定：
//   - 只覆盖「结构化字段」：性格五维（1-10）+ 调度联动提案；语气、口头禅这类
//     自由文本没有可 diff 的数值，解析不到就进 unknown，提示去对应输入框改。
//   - 幅度有界：程度词映射 ±1~4，单个维度单次最多动 4 格，防止「稍微」变剧变。
//   - 保底锚：「但还是话痨」这类表达 -> 结果钳在中性线（5/6）内侧，不会调过头。
//   - 依据 Russell 环状与 OCEAN 的日常语汇映射；词表独立，方便以后加说法。
// ============================================================

/** 程度词 -> 幅度（最长优先匹配）。 */
const DEGREES = [
  ['超级', 4], ['极度', 4],
  ['一点点', 1], ['一些', 1], ['有点', 1], ['稍微', 1], ['略微', 1], ['些微', 1], ['一点', 1],
  ['太多', 3], ['特别', 3], ['非常', 3], ['比较', 2], ['挺', 2], ['蛮', 2], ['很', 2], ['太', 3],
]

/** 方向词 -> ±1（作用于「特质轴」，配合极性词的方向反转）。 */
const DIRECTIONS = [
  ['别那么', -1], ['收敛', -1], ['少', -1], ['降', -1], ['减', -1], ['低', -1], ['别', -1],
  ['多', 1], ['升', 1], ['加', 1], ['增', 1], ['更', 1], ['再', 1],
]

/** 保底锚触发词：「但还是话痨」「保持安静」这类，别调过头。 */
const ANCHOR_WORDS = ['还是', '依然', '保持', '但']

/** 抱怨句式：「太…了」-> 把该特质往中性收回，幅度至少 3。 */
const COMPLAIN_WORDS = ['太', '太多', '特别', '非常', '超级']

/**
 * 极性词表：high = 值越高越符合这个词；low = 值越低越符合。
 * 「嘴硬」是 low（宜人低）——「少嘴硬一点」就是把宜人往高调，方向由极性自动反转。
 */
const TRAIT_WORDS = {
  extraversion: {
    label: '爱说话',
    high: ['话痨', '话多', '太能说', '社牛', '黏人', '热情'],
    low: ['话少', '安静', '内向', '高冷', '社恐', '独立'],
    topics: ['话', '说话', '聊天', '唠嗑'],
  },
  openness: {
    label: '好奇心',
    high: ['好奇心', '好奇', '爱新鲜', '爱探索', '开明', '脑洞大'],
    low: ['死板', '保守', '无趣'],
  },
  agreeableness: {
    label: '好相处',
    high: ['好相处', '温和', '贴心', '嘴甜', '顺着来'],
    low: ['嘴硬', '抬杠', '强硬', '呛人', '怼'],
  },
  stability: {
    label: '情绪稳',
    high: ['稳重', '情绪稳', '淡定', '皮实', '心大'],
    low: ['敏感', '玻璃心', '情绪化', '易炸毛'],
  },
  conscientiousness: {
    label: '有条理',
    high: ['认真', '有条理', '靠谱', '勤快', '自律'],
    low: ['拖延', '散漫', '马虎', '太随性'],
  },
}

const TRAIT_KEYS = Object.keys(TRAIT_WORDS)
const HIGH_LINE = 5 // 保底锚：high 极性词的结果不低于 5（不会从话痨变成安静）
const LOW_LINE = 6 // low 极性词的结果不高于 6

/**
 * 自由文本 / 列表字段：只有说清「改成 / 加上 / 删掉」才动，避免猜。
 * 五维之外的新字段没有数值可 diff，但文本和列表可以整段替换 / 追加 / 删除。
 */
const FIELD_DEFS = [
  { path: 'identity.age', label: '年龄', words: ['年龄', '年纪'], type: 'text', limit: 40 },
  { path: 'identity.appearance', label: '外貌', words: ['外貌', '外观', '长相', '形象', '样子', '穿着'], type: 'text', limit: 300, append: true },
  { path: 'personality.tags', label: '性格标签', words: ['性格标签', '标签'], type: 'list', max: 10, itemLimit: 24, split: /[、，,；;\n]/ },
  { path: 'scenes', label: '日常反应', words: ['日常反应', '日常互动', '互动模式', '场景'], type: 'list', max: 8, itemLimit: 160, split: /[、；;\n]/ },
  { path: 'boundaries', label: '分寸与边界', words: ['边界', '底线', '分寸', '界限'], type: 'list', max: 8, itemLimit: 160, split: /[、；;\n]/ },
]

const SET_VERBS = ['改成', '改为', '换成', '设为', '设成', '写成', '调成', '变成', '是', '：', ':']
const ADD_VERBS = ['加上', '加', '增加', '添加', '添上', '添', '补充', '追加']
const DEL_VERBS = ['删掉', '删除', '去掉', '移除', '删']
const COUNT_WORDS = '(?:一条|一个|1条|1个|几项|几条)?'

function escapeRe(word) {
  return String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function verbAlt(words) {
  return [...words].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
}

const SET_ALT = verbAlt(SET_VERBS)
const ADD_ALT = verbAlt(ADD_VERBS)
const DEL_ALT = verbAlt(DEL_VERBS)

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}

/** 去掉首尾引号与句末标点；列表项里的逗号保留（日常反应常常是一整句）。 */
function cleanValue(raw) {
  return String(raw || '').trim()
    .replace(/^[“”"'「」『』]+/, '')
    .replace(/[“”"'「」『』]+$/, '')
    .replace(/[。！!？?；;，,、]+$/, '')
    .trim()
}

function splitItems(raw, re) {
  return String(raw).split(re).map(cleanValue).filter(Boolean)
}

/** 解析年龄 / 外貌 / 标签 / 日常反应 / 边界这类字段变更；没有明确动词就不猜。 */
function parseFieldChanges(input, persona) {
  const changes = []
  const unknown = []
  if (!persona) return { changes, unknown }

  for (const def of FIELD_DEFS) {
    const words = verbAlt(def.words)
    if (!new RegExp(`(?:${words})`).test(input)) continue
    const current = getPath(persona, def.path)

    if (def.type === 'text') {
      const from = String(current || '')
      const replaceRe = new RegExp(`(?:${words})\\s*(?:${SET_ALT})\\s*(.+)$`, 's')
      const appendRe = new RegExp(`(?:${words})(?:${ADD_ALT})\\s*[：:，,]?\\s*(.+)$`, 's')
      const m = input.match(replaceRe)
      const a = def.append ? input.match(appendRe) : null
      let to = ''
      let reason = ''
      if (m) {
        to = cleanValue(m[1])
        reason = `把「${def.label}」从「${from || '空'}」改成「${to}」`
      } else if (a) {
        const value = cleanValue(a[1])
        const sep = from && !/[；;，,、]$/.test(from) ? '；' : ''
        to = from ? from + sep + value : value
        reason = `在「${def.label}」后面加上「${value}」`
      }
      if (!to) {
        unknown.push(`听出在说「${def.label}」，但没看出要怎么改；试试「${def.label}改成…」`)
        continue
      }
      const clipped = to.length > def.limit
      to = to.slice(0, def.limit)
      if (to === from) {
        unknown.push(`「${def.label}」没有变化，还是「${from || '空'}」`)
        continue
      }
      changes.push({
        kind: 'text', path: def.path, label: def.label, from, to,
        reason: reason + (clipped ? `（超过 ${def.limit} 字，保存时截断）` : ''),
      })
      continue
    }

    const from = Array.isArray(current) ? current.filter((x) => typeof x === 'string') : []
    const deleteA = input.match(new RegExp(`(?:${DEL_ALT})\\s*(?:${COUNT_WORDS})?(?:${words})\\s*[：:，,]?\\s*(.+)$`, 's'))
    const deleteB = input.match(new RegExp(`(?:${words})(?:里|中)?(?:的)?\\s*(.+?)\\s*(?:${DEL_ALT})$`, 's'))
    const deleteC = input.match(new RegExp(`(?:${words})(?:${DEL_ALT})\\s*[：:，,]?\\s*(.+)$`, 's'))
    const addA = input.match(new RegExp(`(?:${ADD_ALT})\\s*(?:${COUNT_WORDS})?(?:${words})\\s*[：:，,]?\\s*(.+)$`, 's'))
    const addB = input.match(new RegExp(`(?:${words})(?:里|中)?(?:${ADD_ALT})\\s*[：:，,]?\\s*(.+)$`, 's'))
    const replace = input.match(new RegExp(`(?:${words})\\s*(?:${SET_ALT})\\s*(.+)$`, 's'))
    const del = deleteA || deleteB || deleteC
    const add = addA || addB

    if (del) {
      const items = [...new Set(splitItems(del[1], def.split))]
      const removed = items.filter((x) => from.includes(x))
      if (!removed.length) {
        unknown.push(`想从「${def.label}」里删，但没找到这几条：${items.join('、') || '（空）'}`)
        continue
      }
      const to = from.filter((x) => !items.includes(x))
      changes.push({
        kind: 'list-remove', path: def.path, label: def.label, from, to, items: removed,
        reason: `从「${def.label}」删掉：${removed.join('、')}`,
      })
      continue
    }

    if (add) {
      let items = [...new Set(splitItems(add[1], def.split))]
      if (!items.length) {
        unknown.push(`听出要往「${def.label}」里加，但没说要加什么`)
        continue
      }
      const clipped = items.some((x) => x.length > def.itemLimit)
      items = items.map((x) => x.slice(0, def.itemLimit))
      const added = items.filter((x) => !from.includes(x))
      if (!added.length) {
        unknown.push(`「${def.label}」里已经有这几条了：${items.join('、')}`)
        continue
      }
      const to = [...from, ...added].slice(0, def.max)
      const dropped = from.length + added.length > def.max
      changes.push({
        kind: 'list-add', path: def.path, label: def.label, from, to, items: added,
        reason: `往「${def.label}」加：${added.join('、')}` +
          (clipped ? '（单条太长，保存时截断）' : '') +
          (dropped ? `（超过 ${def.max} 条上限，只留前 ${def.max} 条）` : ''),
      })
      continue
    }

    if (replace) {
      let items = [...new Set(splitItems(replace[1], def.split))]
      const clipped = items.some((x) => x.length > def.itemLimit)
      items = items.map((x) => x.slice(0, def.itemLimit))
      const to = items.slice(0, def.max)
      if (!to.length) {
        unknown.push(`「${def.label}」要换成什么？没读到内容`)
        continue
      }
      if (JSON.stringify(to) === JSON.stringify(from)) {
        unknown.push(`「${def.label}」没有变化`)
        continue
      }
      changes.push({
        kind: 'list-replace', path: def.path, label: def.label, from, to,
        reason: `把「${def.label}」换成 ${to.length} 条：${to.join('、')}` +
          (clipped ? '（单条太长，保存时截断）' : '') +
          (items.length > def.max ? `（超过 ${def.max} 条上限，只留前 ${def.max} 条）` : ''),
      })
      continue
    }

    unknown.push(`听出在说「${def.label}」，但没看出要怎么改；试试「${def.label}改成…」或「${def.label}加上…」`)
  }

  return { changes, unknown }
}

function clampTrait(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 5
  return Math.max(1, Math.min(10, n))
}

/** 把文本按词表切成 token 流；未匹配的字符忽略（由 unknown 兜底提示）。 */
function scan(text) {
  const entries = []
  for (const [key, def] of Object.entries(TRAIT_WORDS)) {
    for (const w of def.high) entries.push({ word: w, type: 'polarity', key, sign: 1 })
    for (const w of def.low) entries.push({ word: w, type: 'polarity', key, sign: -1 })
    for (const w of def.topics || []) entries.push({ word: w, type: 'topic', key, sign: 1 })
  }
  for (const [w, v] of DEGREES) entries.push({ word: w, type: 'degree', value: v })
  for (const [w, v] of DIRECTIONS) entries.push({ word: w, type: 'direction', value: v })
  for (const w of ANCHOR_WORDS) entries.push({ word: w, type: 'anchor' })
  for (const w of ['刷屏', '消息太多', '发太多', '发很多条']) entries.push({ word: w, type: 'spam' })
  // 最长优先，避免「好奇心」被「好奇」抢走、「别那么」被「别」抢走
  entries.sort((a, b) => b.word.length - a.word.length)

  const tokens = []
  let i = 0
  while (i < text.length) {
    let hit = null
    for (const e of entries) {
      if (text.startsWith(e.word, i)) { hit = e; break }
    }
    if (hit) {
      tokens.push({ ...hit, pos: i })
      i += hit.word.length
    } else {
      i += 1
    }
  }
  return tokens
}

/**
 * 解析一句话，产出性格变更提案。
 * @param {string} text  用户的一句话
 * @param {object} traits 当前五维 { openness..conscientiousness }
 * @param {object} [persona] 当前完整人格草稿；传了才能改年龄/外貌/列表字段
 * @returns {{ changes: Array, unknown: string[], wantsLessChatter: boolean }}
 *   changes: 性格 { kind:'trait', key, label, from, to, delta, reason, anchor }
 *            文本 { kind:'text', path, label, from, to, reason }
 *            列表 { kind:'list-add'|'list-remove'|'list-replace', path, label, from, to, items, reason }
 *   unknown: 没听懂 / 调不动的说明（前端原样展示，不猜）
 */
export function parseTune(text, traits = {}, persona = null) {
  const input = String(text || '').slice(0, 200)
  const tokens = scan(input)
  const unknown = []
  const changes = []
  let wantsLessChatter = /刷屏|消息太多|发太多|发很多条/.test(input)

  // 按维度聚合：方向 = 显式方向词 > 抱怨句式 > 极性默认诉求；幅度取最大程度词
  for (const key of TRAIT_KEYS) {
    const mine = tokens.filter((t) => t.key === key)
    if (!mine.length) continue
    const def = TRAIT_WORDS[key]
    const current = clampTrait(traits[key])

    const dirTokens = tokens.filter((t) => t.type === 'direction')
    // 程度词只有贴近特质词（前后 2 字）才归它，防止前半句的「很」串到后半句
    const near = (t) => mine.some((m) => Math.abs(m.pos - t.pos) <= m.word.length + 2)
    const myDegrees = tokens.filter((t) => t.type === 'degree' && near(t))
    const complain = tokens.some((t) => t.type === 'degree' && COMPLAIN_WORDS.includes(t.word) && near(t))

    let sign = 0 // +1 调高维度，-1 调低
    let source = ''
    const explicit = dirTokens.find((d) => mine.some((m) => Math.abs(m.pos - d.pos) <= m.word.length + 3))
    if (explicit) {
      // 极性词自带方向反转：「嘴硬少一点」= 宜人 +1
      const polar = mine.find((m) => m.type === 'polarity')
      const base = polar ? polar.sign : 1
      sign = explicit.value * base
      source = `「${explicit.word}」`
    } else if (complain) {
      // 抱怨 = 往这个词的反方向收：「太吵了」调低，「太安静了」调高。
      // 以前无条件 -1，会把「太安静了」也调低（审计发现）。
      const polar = mine.find((m) => m.type === 'polarity')
      sign = polar ? -polar.sign : -1
      source = '「太…了」'
    } else {
      const polar = mine.find((m) => m.type === 'polarity')
      if (polar) {
        sign = polar.sign
        source = `想更「${polar.word}」`
      }
    }
    if (sign === 0) {
      unknown.push(`提到「${mine[0].word}」，但没看出想往哪边调——加个「多一点 / 少一点」试试`)
      continue
    }

    const amp = Math.max(1, ...myDegrees.map((d) => d.value), 1)
    const delta = sign * amp
    let to = clampTrait(current + delta)
    let anchor = ''
    // 保底锚：「还是/保持 + 极性词」-> 不越过中性线
    const anchorToken = tokens.find((t) => t.type === 'anchor' && mine.some((m) => m.type === 'polarity' && m.pos > t.pos && m.pos - t.pos <= t.word.length + 6))
    if (anchorToken) {
      const polar = mine.find((m) => m.type === 'polarity')
      if (polar && polar.sign === 1 && to <= HIGH_LINE) { to = HIGH_LINE; anchor = `「${anchorToken.word}${polar.word}」保底不低于 ${HIGH_LINE}，不会一下子变安静` }
      if (polar && polar.sign === -1 && to >= LOW_LINE) { to = LOW_LINE; anchor = `「${anchorToken.word}${polar.word}」保底不高于 ${LOW_LINE}` }
    }
    if (to === current) {
      unknown.push(`${def.label}已经是 ${current}/10，这个说法调不动了`)
      continue
    }
    const degreeWord = myDegrees.sort((a, b) => b.value - a.value)[0]?.word || '一点'
    changes.push({
      kind: 'trait',
      key,
      label: def.label,
      from: current,
      to,
      delta: to - current,
      reason: `${source}${sign > 0 ? '+' : '−'}${Math.abs(to - current)}（${degreeWord}）${anchor ? '；' + anchor : ''}`,
      anchor: Boolean(anchor),
    })
    if (key === 'extraversion' && to < current) wantsLessChatter = true
  }

  // 有 spam 词但没解析到任何外向变更：至少把方向告诉用户
  if (wantsLessChatter && !changes.some((c) => c.key === 'extraversion')) {
    unknown.push('想让它少说话，但没听出该动哪个性格——试试「话少一点」或「别那么话痨」')
  }
  // 自由文本 / 列表字段：年龄、外貌、标签、日常反应、边界
  const field = parseFieldChanges(input, persona)
  unknown.push(...field.unknown)
  if (!tokens.length && !field.changes.length && !field.unknown.length) {
    unknown.push('这句话里没认出想调的东西；能调五维（话痨程度、好奇心、好相处、情绪稳、有条理），也能说「年龄改成 28」「外貌改成…」「标签加上…」「加一条日常反应…」「删掉边界…」；或者直接在下面表单改。')
  }
  return { changes: [...changes, ...field.changes], unknown, wantsLessChatter }
}

/** 供预览使用：解析后的新五维。 */
export function applyTune(traits, changes) {
  const next = { ...traits }
  for (const c of changes) if (c.kind === 'trait') next[c.key] = c.to
  return next
}
