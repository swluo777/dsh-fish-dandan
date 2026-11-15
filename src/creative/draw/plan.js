// ============================================================
// 专注创作 · 画面规划器
// 只负责「想清楚画什么」，不碰画布。所有随机都由 seed 决定，
// 同一份 plan 渲染出来必须一样。
// 设计：docs/architecture/26-专注创作手绘画图重做设计.md
// ============================================================

/** 32 位字符串哈希，给 seed 用。 */
export function hashSeed(text = '') {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32：纯函数式可复现随机。 */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)]
}

function shuffle(rng, list) {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export const MOODS = {
  excited: { label: '兴奋', tone: 'hot', warmth: 0.85, energy: 0.9, densityBias: 0.35 },
  happy: { label: '开心', tone: 'warm', warmth: 0.75, energy: 0.75, densityBias: 0.2 },
  proud: { label: '得意', tone: 'warm', warmth: 0.6, energy: 0.65, densityBias: 0.15 },
  calm: { label: '平静', tone: 'calm', warmth: 0.35, energy: 0.5, densityBias: 0 },
  blank: { label: '发呆', tone: 'calm', warmth: 0.2, energy: 0.4, densityBias: -0.1 },
  sleepy: { label: '困', tone: 'calm', warmth: 0.3, energy: 0.12, densityBias: -0.2 },
  wronged: { label: '委屈', tone: 'cold', warmth: 0.08, energy: 0.3, densityBias: -0.15 },
  sad: { label: '难过', tone: 'cold', warmth: 0.02, energy: 0.25, densityBias: -0.2 },
}

/** 10 种底材：纸类 5 种、非纸 5 种（纸类不超过一半）。 */
export const BACKGROUNDS = {
  'white-paper': { paper: true, label: '白纸', moods: ['calm', 'blank', 'happy', 'sad'] },
  kraft: { paper: true, label: '牛皮纸', moods: ['calm', 'proud', 'happy', 'sad'] },
  ruled: { paper: true, label: '横线本', moods: ['blank', 'calm', 'sleepy', 'wronged'] },
  grid: { paper: true, label: '方格纸', moods: ['blank', 'calm', 'proud', 'excited'] },
  aged: { paper: true, label: '旧纸折痕', moods: ['sad', 'wronged', 'calm', 'blank'] },
  desk: { paper: false, label: '桌面一角', moods: ['happy', 'excited', 'proud', 'calm'] },
  wall: { paper: false, label: '墙面', moods: ['calm', 'sleepy', 'wronged', 'sad'] },
  fabric: { paper: false, label: '布料', moods: ['calm', 'sleepy', 'happy', 'proud'] },
  card: { paper: false, label: '纯色卡纸', moods: ['happy', 'excited', 'proud', 'wronged'] },
  'rain-window': { paper: false, label: '雨窗', moods: ['sad', 'wronged', 'blank', 'sleepy'] },
}

export const MEDIUMS = {
  pencil: { label: '铅笔', warmth: 0 },
  coloredPencil: { label: '彩铅', warmth: 0.3 },
  watercolor: { label: '水彩', warmth: 0.5 },
  crayon: { label: '蜡笔', warmth: 0.7 },
  marker: { label: '马克笔', warmth: 0.8 },
  mixed: { label: '混合媒介', warmth: 1 },
}

export const COMPOSITIONS = {
  'left-low': { label: '左下全身', text: 'right-top' },
  'center-bust': { label: '中间半身', text: 'top-left' },
  'right-full': { label: '右侧全身', text: 'left-top' },
  'top-left': { label: '左上小比例', text: 'right-top' },
  diagonal: { label: '斜切', text: 'left-top' },
  'back-view': { label: '背影', text: 'top-left' },
}

export const POSES = {
  stand: { label: '站' },
  sit: { label: '坐' },
  curl: { label: '抱膝' },
  sleep: { label: '睡' },
  back: { label: '背影' },
  wave: { label: '挥手' },
  peek: { label: '探头' },
}

/** 24 种可画物件；keywords 是文案里会命中的词。 */
export const OBJECTS = {
  cloud: { label: '云', keywords: ['云', '天空', '飘'] },
  rain: { label: '雨', keywords: ['雨', '下雨', '淋'] },
  window: { label: '窗', keywords: ['窗', '窗外', '玻璃'] },
  cup: { label: '杯子', keywords: ['杯', '咖啡', '奶茶', '茶', '热水'] },
  lamp: { label: '灯', keywords: ['灯', '台灯', '亮'] },
  pillow: { label: '枕头', keywords: ['枕头', '睡', '床'] },
  stars: { label: '星星', keywords: ['星星', '星', '夜'] },
  flower: { label: '花', keywords: ['花', '开花', '春天'] },
  fish: { label: '小鱼', keywords: ['鱼', '鲸', '海', '游'] },
  shell: { label: '贝壳', keywords: ['贝壳', '海边', '沙滩'] },
  origami: { label: '纸鹤', keywords: ['纸鹤', '折', '纸'] },
  note: { label: '音符', keywords: ['歌', '音乐', '哼', '唱'] },
  book: { label: '书', keywords: ['书', '翻', '读'] },
  pen: { label: '笔', keywords: ['笔', '写', '画'] },
  yarn: { label: '线团', keywords: ['线', '毛线', '绕'] },
  balloon: { label: '气球', keywords: ['气球', '飞'] },
  bread: { label: '面包', keywords: ['面包', '吃', '饿'] },
  moon: { label: '月亮', keywords: ['月亮', '月', '晚'] },
  puddle: { label: '水洼', keywords: ['水洼', '水坑', '倒影'] },
  umbrella: { label: '伞', keywords: ['伞', '撑'] },
  chicken: { label: '炸鸡', keywords: ['炸鸡', '鸡', '啃'] },
  tailpillow: { label: '尾巴抱枕', keywords: ['尾巴', '抱枕', '抱'] },
  sun: { label: '太阳', keywords: ['太阳', '阳光', '晒'] },
  candy: { label: '糖', keywords: ['糖', '甜'] },
}

const OBJECT_IDS = Object.keys(OBJECTS)

const GESTURE_BY_INTENT = {
  greeting: 'wave',
  affection: 'hug',
  comfort: 'sit',
  laugh: 'wave',
  thanks: 'wave',
  agree: 'sit',
  tease: 'stand',
  question: 'stand',
  sad: 'curl',
  angry: 'stand',
  surprise: 'stand',
}

const GESTURE_BY_EMOTION = {
  可爱: 'stand',
  呆萌: 'peek',
  开心: 'wave',
  难过: 'curl',
  困: 'sleep',
  生气: 'stand',
  委屈: 'curl',
  得意: 'stand',
}

const GESTURE_POSE = {
  wave: ['wave', 'stand'],
  hug: ['curl', 'sit'],
  sit: ['sit'],
  sleep: ['sleep', 'sit'],
  peek: ['peek', 'stand'],
  stand: ['stand'],
  curl: ['curl'],
}

const MOOD_POSES = {
  excited: ['wave', 'stand'],
  happy: ['wave', 'sit', 'stand'],
  proud: ['stand', 'sit'],
  calm: ['sit', 'stand'],
  blank: ['peek', 'sit'],
  sleepy: ['sleep', 'sit'],
  wronged: ['curl', 'sit'],
  sad: ['back', 'curl', 'sit'],
}

/** 文案关键词 -> 物件 id。 */
export function keywordObjects(text = '') {
  const s = String(text || '')
  const out = []
  for (const [id, def] of Object.entries(OBJECTS)) {
    if (def.keywords.some((kw) => s.includes(kw))) out.push(id)
  }
  return out
}

/** 从两句独白里抽关键词，给渲染器决定场景物件。 */
export function extractKeywords(lines = []) {
  const text = Array.isArray(lines) ? lines.join('') : String(lines || '')
  const words = []
  for (const [id, def] of Object.entries(OBJECTS)) {
    for (const kw of def.keywords) {
      if (text.includes(kw) && !words.includes(kw)) words.push(kw)
    }
  }
  return { words, objects: keywordObjects(text) }
}

/** 把数值状态 + PAD 折成八种画图心情。 */
export function deriveMood(vars = {}, affect = {}) {
  const mood = clamp(Number(vars.mood) || 50, 0, 100)
  const energy = clamp(Number(vars.energy) || 50, 0, 100)
  const urge = clamp(Number(vars.creativeUrge) || 35, 0, 100)
  const p = Number(affect?.mood?.p) || 0
  const a = Number(affect?.mood?.a) || 0
  const d = Number(affect?.mood?.d) || 0
  if (urge >= 70 && energy >= 60) return 'excited'
  if (mood >= 65 && p > 0) return 'happy'
  if (d >= 0.25 && mood >= 55) return 'proud'
  if (energy <= 35) return 'sleepy'
  if (p < -0.15 && d < 0 && mood < 60) return 'wronged'
  if (mood <= 35 || p <= -0.4) return 'sad'
  if (a <= -0.2 && energy >= 35) return 'blank'
  return 'calm'
}

/** 从表情包语义里取一个姿态原语；只取语义，不贴图。 */
export function stickerGesture(sticker = {}, moodKey = 'calm') {
  if (!sticker) return null
  const intents = Array.isArray(sticker.intents) ? sticker.intents : []
  for (const intent of intents) {
    if (GESTURE_BY_INTENT[intent]) return GESTURE_BY_INTENT[intent]
  }
  const emotions = Array.isArray(sticker.emotion) ? sticker.emotion : []
  for (const emotion of emotions) {
    if (GESTURE_BY_EMOTION[emotion]) return GESTURE_BY_EMOTION[emotion]
  }
  const caption = String(sticker.caption || '')
  for (const [emotion, gesture] of Object.entries(GESTURE_BY_EMOTION)) {
    if (caption.includes(emotion)) return gesture
  }
  return null
}

const MOTIF_RULES = [
  { id: 'heart', re: /爱心|爱意|喜欢|亲亲|贴贴|比心|心/ },
  { id: 'gift', re: /礼物|送|惊喜|盒/ },
  { id: 'mic', re: /麦克风|话筒|唱歌|唱歌|歌/ },
  { id: 'bottle', re: /奶瓶|奶嘴|喝奶|奶/ },
  { id: 'tear', re: /泪|哭|委屈|难过/ },
  { id: 'star', re: /星星|闪|惊喜|发光/ },
  { id: 'shell', re: /贝壳|海边|沙滩/ },
  { id: 'cup', re: /咖啡|奶茶|杯|茶/ },
]

/** 只取一个表情包道具语义，渲染器会把它重画成手绘小物。 */
export function stickerMotif(sticker = {}) {
  if (!sticker) return null
  const text = `${String(sticker.caption || '')} ${(Array.isArray(sticker.emotion) ? sticker.emotion : []).join(' ')}`
  for (const rule of MOTIF_RULES) {
    if (rule.re.test(text)) return rule.id
  }
  return null
}

/** 本地兜底独白：模型没接上时仍然有话说，但句子短、不做总结。 */
export function localCopy({ moodKey = 'calm', persona = {}, sticker = {}, rng = Math.random } = {}) {
  const self = String(persona?.speech?.selfReference || '我').replace(/^["“]|["”]$/g, '') || '我'
  const pool = {
    excited: [`${self}现在就想画点大的。`, '手停不下来。', '今天这根线要甩出去。', '想把整张纸都涂满。'],
    happy: ['今天运气不错。', '想把这块糖留到晚上。', '窗外有点亮。', '这条线画歪了，也挺好。'],
    proud: ['看，这样不就对了。', '这条尾巴我画得最好。', '不用夸，我知道。', '今天手很稳。'],
    calm: ['就这样待一会儿。', '纸上还有空，先留着。', '没什么事，慢慢画。', '风从窗边过去。'],
    blank: ['脑袋空空的。', '云停在窗外，我也停一下。', '今天先不跟世界讲道理。', '笔尖悬着，落不下去。'],
    sleepy: ['再睡五分钟。', '枕头比什么都亲。', '画到一半，眼睛先闭上了。', '梦里还有一张纸。'],
    wronged: ['不太想说话。', '笔有点抖，算了。', '缩在角落画一会儿。', '今天不想被看见。'],
    sad: ['雨下得比我久。', '这张纸有点冷。', '我把尾巴抱紧了。', '画完这张就躲起来。'],
  }
  const lines = pool[moodKey] || pool.calm
  const first = lines[Math.floor(rng() * lines.length)]
  const extra = rng() < 0.55 ? ['再坐一会儿。', '纸边有点卷。', '不着急。'][Math.floor(rng() * 3)] : ''
  const caption = String(sticker?.caption || '')
  const borrowed = caption ? extractKeywords([caption]).words.slice(0, 1) : []
  const tail = borrowed.length && rng() < 0.4 ? `想起${borrowed[0]}。` : ''
  const out = [first, extra, tail].filter(Boolean)
  const joined = out.join('')
  if (joined.length > 30) return [first]
  return out
}

/** 生成兜底「签名」：优先角色名，其次人格名。 */
export function signatureOf(character = {}, persona = {}, override = '') {
  return (
    String(override || '').trim() ||
    String(character?.displayName || '').trim() ||
    String(persona?.identity?.name || '').trim() ||
    '蛋蛋'
  )
}

function quartet(plan) {
  return [plan.background, plan.composition, plan.pose, plan.objects[0] || ''].join('|')
}

function historyCounts(history = []) {
  const counts = { background: {}, medium: {}, composition: {} }
  for (const item of history) {
    for (const key of ['background', 'medium', 'composition']) {
      const value = item?.[key]
      if (!value) continue
      counts[key][value] = (counts[key][value] || 0) + 1
    }
  }
  return counts
}

function weightedPick(rng, candidates, counts = {}) {
  const weights = candidates.map((id) => 1 / (1 + (counts[id] || 0) * 0.9))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < candidates.length; i += 1) {
    r -= weights[i]
    if (r <= 0) return candidates[i]
  }
  return candidates[candidates.length - 1]
}

function textBoxFor(composition) {
  const boxes = {
    'right-top': { x: 0.54, y: 0.08, w: 0.42, align: 'right' },
    'left-top': { x: 0.05, y: 0.08, w: 0.4, align: 'left' },
    'top-left': { x: 0.05, y: 0.07, w: 0.4, align: 'left' },
    'bottom-left': { x: 0.06, y: 0.72, w: 0.4, align: 'left' },
  }
  return boxes[composition] || boxes['left-top']
}

/**
 * 生成一份画面计划。
 * @param {object} input
 */
export function buildPlan(input = {}) {
  const now = input.now || Date.now()
  const baseSeed = Number.isFinite(Number(input.seed)) ? Number(input.seed) : hashSeed(`${now}:${Math.random()}`)
  const vars = input.vars || {}
  const affect = input.affect || {}
  const character = input.character || {}
  const sticker = input.sticker || null
  const persona = input.persona || {}
  const history = Array.isArray(input.history) ? input.history.slice(0, 12) : []
  const counts = historyCounts(history)
  const moodKey = input.moodKey && MOODS[input.moodKey] ? input.moodKey : deriveMood(vars, affect)
  const mood = MOODS[moodKey]
  const urge = clamp(Number(vars.creativeUrge) || 35, 0, 100)
  let lastIssue = ''

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const seed = (baseSeed + attempt * 2654435761) >>> 0
    const rng = makeRng(seed)

    const bgCandidates = shuffle(rng, Object.keys(BACKGROUNDS).filter((id) => BACKGROUNDS[id].moods.includes(moodKey)))
    const background = weightedPick(rng, bgCandidates, counts.background)
    const medium = weightedPick(rng, Object.keys(MEDIUMS), counts.medium)

    const gesture = stickerGesture(sticker, moodKey)
    const poseCandidates = gesture && GESTURE_POSE[gesture] ? GESTURE_POSE[gesture] : MOOD_POSES[moodKey]
    const pose = input.pose && POSES[input.pose] ? input.pose : pick(rng, poseCandidates)

    let compCandidates
    if (pose === 'back') compCandidates = ['back-view']
    else if (pose === 'peek') compCandidates = ['center-bust', 'top-left']
    else if (['sleep', 'curl'].includes(pose)) compCandidates = ['left-low', 'right-full', 'diagonal']
    else compCandidates = ['left-low', 'right-full', 'center-bust', 'diagonal', 'top-left']
    const composition = input.composition && COMPOSITIONS[input.composition]
      ? input.composition
      : weightedPick(rng, compCandidates, counts.composition)

    const copyLines = Array.isArray(input.copyLines) && input.copyLines.length
      ? input.copyLines.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
      : localCopy({ moodKey, persona, sticker, rng })
    const keywords = extractKeywords(copyLines)

    // 文案里命中的物件必须落进画面；再按心情/密度补几个。
    const must = keywords.objects.slice(0, 3)
    const extraPool = OBJECT_IDS.filter((id) => !must.includes(id))
    const density = clamp((mood.densityBias + (urge - 35) / 100) + 0.35, 0.12, 0.9)
    const extraCount = Math.max(0, Math.round(density * 4) - must.length)
    const extras = shuffle(rng, extraPool).slice(0, extraCount)
    const objects = [...must, ...extras].slice(0, 5)

    const palette = pick(rng, paletteCandidates(moodKey, background))
    const signature = signatureOf(character, persona, input.signatureName)
    const textBox = textBoxFor(COMPOSITIONS[composition].text)
    const plan = {
      v: 1,
      seed,
      createdAt: new Date(now).toISOString(),
      character: {
        id: String(character.id || ''),
        ageGroup: String(character.ageGroup || 'child'),
        outfitId: String(character.outfitId || 'initial-maid'),
        displayName: String(character.displayName || signature),
      },
      mood: { key: moodKey, label: mood.label, tone: mood.tone, vars: { energy: Math.round(Number(vars.energy) || 0), mood: Math.round(Number(vars.mood) || 0), creativeUrge: Math.round(urge) } },
      sticker: sticker
        ? { id: String(sticker.id || ''), emotion: sticker.emotion || [], caption: String(sticker.caption || ''), intents: sticker.intents || [], gesture: gesture || 'stand', motif: stickerMotif(sticker) }
        : { id: '', emotion: [], caption: '', intents: [], gesture: gesture || 'stand', motif: null },
      copy: { lines: copyLines.slice(0, 3), keywords: keywords.words.slice(0, 4) },
      background,
      medium,
      composition,
      pose,
      objects,
      palette,
      signature,
      density: Number(density.toFixed(2)),
      wobble: Number((0.3 + mood.energy * 0.45 + (medium === 'crayon' || medium === 'marker' ? 0.15 : 0)).toFixed(2)),
      draft: Number((0.25 + urge / 160).toFixed(2)),
      textBox,
    }
    if (history.some((item) => quartet(item) === quartet(plan))) {
      lastIssue = '和最近 12 张重复（背景+构图+姿态+主物件）'
      continue
    }
    return plan
  }
  throw new Error(`画面计划没抽到合格的组合：${lastIssue || '未知原因'}`)
}

function paletteCandidates(moodKey, background) {
  if (['sad', 'wronged'].includes(moodKey)) return ['cool-ink', 'dusty-blue', 'mono']
  if (['happy', 'excited'].includes(moodKey)) return ['warm-cream', 'peach', 'moss']
  if (moodKey === 'proud') return ['mono', 'warm-cream', 'dusty-blue']
  if (background === 'rain-window') return ['cool-ink', 'dusty-blue']
  if (background === 'kraft' || background === 'aged') return ['warm-cream', 'moss', 'mono']
  return ['warm-cream', 'cool-ink', 'dusty-blue', 'moss', 'mono']
}

/** 给活动卡用的一句话。 */
export function planText(plan) {
  if (!plan) return '画一张手绘稿'
  const objects = (plan.objects || []).map((id) => OBJECTS[id]?.label).filter(Boolean)
  const what = objects.length ? `，画${objects.slice(0, 2).join('和')}` : ''
  return `画一张${plan.mood.label}的手稿${what}`
}

/** 校验 plan 的硬规则；返回问题列表，空数组 = 合格。 */
export function validatePlan(plan) {
  const issues = []
  if (!plan || typeof plan !== 'object') return ['plan 不是对象']
  if (!plan.seed) issues.push('缺少 seed')
  if (!MOODS[plan.mood?.key]) issues.push('心情不合法')
  if (!BACKGROUNDS[plan.background]) issues.push('背景不合法')
  if (!MEDIUMS[plan.medium]) issues.push('媒介不合法')
  if (!COMPOSITIONS[plan.composition]) issues.push('构图不合法')
  if (!POSES[plan.pose]) issues.push('姿态不合法')
  const lines = plan.copy?.lines || []
  if (!lines.length) issues.push('没有内心独白')
  const total = lines.join('').length
  if (total > 30) issues.push(`独白太长了（${total} 字）`)
  if (!String(plan.signature || '').trim()) issues.push('没有落款')
  if ((plan.objects || []).length > 5) issues.push('物件太多')
  if (!BACKGROUNDS[plan.background]) issues.push('背景不合法')
  if (!MEDIUMS[plan.medium]) issues.push('绘画媒介不合法')
  return issues
}
