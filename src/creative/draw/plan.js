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
  walk: { label: '走' },
  chair: { label: '坐椅' },
  floor: { label: '盘腿坐' },
  tummy: { label: '趴着' },
  hold: { label: '捧着' },
  bike: { label: '骑车' },
}

/** 40 种可画物件；role 是它默认落在场景的哪一层。keywords 是文案里会命中的词。 */
export const OBJECTS = {
  cloud: { label: '云', keywords: ['云', '天空', '飘'], role: 'sky' },
  rain: { label: '雨', keywords: ['雨', '下雨', '淋'], role: 'sky' },
  window: { label: '窗', keywords: ['窗', '窗外', '玻璃'], role: 'mid' },
  cup: { label: '杯子', keywords: ['杯', '咖啡', '奶茶', '茶', '热水'], role: 'front' },
  lamp: { label: '灯', keywords: ['灯', '台灯', '亮'], role: 'mid' },
  pillow: { label: '枕头', keywords: ['枕头', '睡', '床'], role: 'front' },
  stars: { label: '星星', keywords: ['星星', '星', '夜'], role: 'sky' },
  flower: { label: '花', keywords: ['花', '开花', '春天'], role: 'ground' },
  fish: { label: '小鱼', keywords: ['鱼', '鲸', '游'], role: 'mid' },
  shell: { label: '贝壳', keywords: ['贝壳', '沙滩'], role: 'ground' },
  origami: { label: '纸鹤', keywords: ['纸鹤', '折', '纸'], role: 'mid' },
  note: { label: '音符', keywords: ['歌', '音乐', '哼', '唱'], role: 'sky' },
  book: { label: '书', keywords: ['书', '翻', '读'], role: 'front' },
  pen: { label: '笔', keywords: ['笔', '写', '铅笔'], role: 'front' },
  yarn: { label: '线团', keywords: ['线', '毛线', '绕'], role: 'front' },
  balloon: { label: '气球', keywords: ['气球', '飞'], role: 'sky' },
  bread: { label: '面包', keywords: ['面包', '吃', '饿'], role: 'front' },
  moon: { label: '月亮', keywords: ['月亮', '月', '晚'], role: 'sky' },
  puddle: { label: '水洼', keywords: ['水洼', '水坑', '倒影'], role: 'ground' },
  umbrella: { label: '伞', keywords: ['伞', '撑'], role: 'front' },
  chicken: { label: '炸鸡', keywords: ['炸鸡', '鸡', '啃'], role: 'front' },
  tailpillow: { label: '尾巴抱枕', keywords: ['尾巴', '抱枕', '抱'], role: 'front' },
  sun: { label: '太阳', keywords: ['太阳', '阳光', '晒', '日出'], role: 'sky' },
  candy: { label: '糖', keywords: ['糖', '甜'], role: 'front' },
  house: { label: '房子', keywords: ['房子', '小屋', '屋子', '家里', '回家'], role: 'far' },
  tree: { label: '树', keywords: ['树', '树林', '树叶', '枝'], role: 'mid' },
  mountain: { label: '山', keywords: ['山', '远山', '山峰'], role: 'far' },
  grassland: { label: '草原', keywords: ['草原', '草地', '原野', '草'], role: 'ground' },
  road: { label: '小路', keywords: ['路', '小路', '道路', '远方', '走'], role: 'ground' },
  desk: { label: '桌子', keywords: ['桌子', '书桌', '课桌', '桌前', '桌'], role: 'front' },
  chair: { label: '椅子', keywords: ['椅子', '凳子', '座椅', '椅'], role: 'mid' },
  bed: { label: '床', keywords: ['床', '被子', '躺下'], role: 'front' },
  bicycle: { label: '自行车', keywords: ['自行车', '单车', '骑车', '骑行'], role: 'front' },
  sea: { label: '海', keywords: ['大海', '海面', '海浪', '浪', '海边'], role: 'ground' },
  door: { label: '门', keywords: ['门', '门口', '门外'], role: 'mid' },
  fence: { label: '栅栏', keywords: ['栅栏', '篱笆', '围栏'], role: 'mid' },
  stone: { label: '石头', keywords: ['石头', '石子', '岩石'], role: 'ground' },
  kite: { label: '风筝', keywords: ['风筝', '放风筝'], role: 'sky' },
  shelf: { label: '书架', keywords: ['书架', '架子', '书柜'], role: 'mid' },
  phone: { label: '手机', keywords: ['手机', '屏幕', '消息'], role: 'front' },
}

const OBJECT_IDS = Object.keys(OBJECTS)

export const SCENE_PLACES = {
  grassland: {
    label: '草原',
    backgrounds: ['card', 'white-paper', 'grid'],
    poses: ['floor', 'walk', 'stand', 'hold'],
    defaults: ['grassland', 'sun', 'house', 'tree'],
  },
  room: {
    label: '房间',
    backgrounds: ['wall', 'fabric', 'white-paper'],
    poses: ['chair', 'floor', 'sit', 'hold'],
    defaults: ['window', 'chair', 'lamp', 'shelf'],
  },
  desk: {
    label: '桌前',
    backgrounds: ['desk', 'white-paper', 'grid'],
    poses: ['chair', 'sit'],
    defaults: ['desk', 'chair', 'book', 'pen'],
  },
  bed: {
    label: '床边',
    backgrounds: ['wall', 'fabric', 'white-paper'],
    poses: ['tummy', 'sleep', 'sit'],
    defaults: ['bed', 'pillow', 'lamp'],
  },
  street: {
    label: '小路',
    backgrounds: ['card', 'white-paper', 'grid'],
    poses: ['walk', 'stand', 'bike'],
    defaults: ['road', 'house', 'tree', 'bicycle'],
  },
  beach: {
    label: '海边',
    backgrounds: ['card', 'white-paper', 'grid'],
    poses: ['floor', 'sit', 'stand'],
    defaults: ['sea', 'shell', 'sun', 'cloud'],
  },
  mountain: {
    label: '山里',
    backgrounds: ['card', 'white-paper', 'grid'],
    poses: ['walk', 'stand', 'floor'],
    defaults: ['mountain', 'grassland', 'tree', 'cloud'],
  },
  window: {
    label: '窗边',
    backgrounds: ['wall', 'rain-window', 'white-paper'],
    poses: ['stand', 'sit', 'peek', 'hold'],
    defaults: ['window', 'rain', 'cup', 'lamp'],
  },
  abstract: {
    label: '想象',
    backgrounds: ['white-paper', 'grid', 'card'],
    poses: ['hold', 'stand', 'sit', 'floor'],
    defaults: ['cloud', 'stars', 'moon', 'flower'],
  },
}

export const SCENE_PLACE_IDS = Object.keys(SCENE_PLACES)
export const ITEM_ROLES = ['sky', 'far', 'ground', 'mid', 'front']

const PLACE_BY_COPY = [
  { place: 'grassland', re: /草原|草地|原野|草/ },
  { place: 'beach', re: /海边|沙滩|海浪|大海|贝壳/ },
  { place: 'mountain', re: /山里|山峰|远山|爬山|山/ },
  { place: 'street', re: /骑车|单车|自行车|骑行|小路|路上|街道/ },
  { place: 'desk', re: /桌前|书桌|课桌|桌子|写作业/ },
  { place: 'bed', re: /床上|床边|被子|枕头|躺/ },
  { place: 'window', re: /窗外|窗边|下雨|雨窗/ },
  { place: 'grassland', re: /房子|小屋|屋子|家/ },
]

function pickPlaceByCopy(text, moodKey, rng = Math.random) {
  for (const rule of PLACE_BY_COPY) {
    if (rule.re.test(text)) return rule.place
  }
  const pool = {
    excited: ['grassland', 'street', 'beach', 'mountain'],
    happy: ['grassland', 'street', 'room', 'beach'],
    proud: ['room', 'desk', 'abstract'],
    calm: ['room', 'desk', 'window', 'grassland', 'abstract', 'street'],
    blank: ['window', 'abstract', 'room', 'mountain'],
    sleepy: ['bed', 'room', 'window'],
    wronged: ['window', 'room', 'bed'],
    sad: ['window', 'room', 'bed', 'abstract'],
  }[moodKey] || ['room', 'desk', 'window', 'grassland']
  return pool[Math.floor(rng() * pool.length)]
}

function normalizeItemId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (OBJECTS[raw]) return raw
  const lower = raw.toLowerCase()
  for (const [id, def] of Object.entries(OBJECTS)) {
    if (def.label === raw || def.label.includes(raw) || raw.includes(def.label)) return id
  }
  const aliases = {
    house: ['房子', '小屋', '屋子', '家'], tree: ['树', '树林'], mountain: ['山', '远山'],
    grassland: ['草原', '草地', '原野'], road: ['路', '小路'], desk: ['桌子', '书桌'],
    chair: ['椅子', '凳子'], bed: ['床', '被子'], bicycle: ['自行车', '单车'],
    sea: ['海', '大海'], door: ['门'], fence: ['栅栏', '篱笆'], stone: ['石头'],
    kite: ['风筝'], shelf: ['书架', '书柜'], phone: ['手机'],
  }
  for (const [id, words] of Object.entries(aliases)) {
    if (words.some((word) => raw.includes(word) || lower.includes(word))) return id
  }
  return ''
}

function defaultRole(id) {
  const role = OBJECTS[id]?.role
  return ITEM_ROLES.includes(role) ? role : 'mid'
}

function sceneItemsFromIds(ids, rng) {
  return ids
    .map((id) => normalizeItemId(id))
    .filter(Boolean)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .slice(0, 5)
    .map((id) => ({ id, role: defaultRole(id), scale: Number((0.9 + rng() * 0.25).toFixed(2)) }))
}

/** 没有模型场景意图时的本地兜底：从独白里读「想画什么」。 */
export function sceneFromCopy({ copyLines = [], moodKey = 'calm', rng = Math.random } = {}) {
  const text = Array.isArray(copyLines) ? copyLines.join('') : String(copyLines || '')
  const place = pickPlaceByCopy(text, moodKey, rng)
  const keywordHits = keywordObjects(text)
  const def = SCENE_PLACES[place]
  const base = keywordHits.length ? keywordHits : def.defaults
  const merged = [...base, ...def.defaults]
  return {
    v: 5,
    place,
    weather: /雨|淋/.test(text) ? 'rain' : /雪/.test(text) ? 'snow' : /风/.test(text) ? 'wind' : 'clear',
    light: ['sad', 'wronged', 'sleepy'].includes(moodKey) ? 'soft-cool' : ['happy', 'excited'].includes(moodKey) ? 'warm' : 'neutral',
    items: sceneItemsFromIds(merged, rng),
    source: 'local',
  }
}

/** 把模型返回的 scene 意图收成可渲染的结构；模型只出意图，不出坐标。 */
export function normalizeScene(rawScene, context = {}) {
  const rng = context.rng || Math.random
  const fallback = sceneFromCopy({
    copyLines: context.copyLines || [],
    moodKey: context.moodKey || 'calm',
    rng,
  })
  const raw = rawScene && typeof rawScene === 'object' ? rawScene : {}
  const place = SCENE_PLACES[raw.place] ? raw.place : fallback.place
  const def = SCENE_PLACES[place]
  const items = []
  if (Array.isArray(raw.items)) {
    for (const item of raw.items.slice(0, 6)) {
      const id = normalizeItemId(typeof item === 'string' ? item : item?.id || item?.label)
      if (!id || items.some((x) => x.id === id)) continue
      const role = ITEM_ROLES.includes(item?.role) ? item.role : defaultRole(id)
      const scale = Math.max(0.6, Math.min(2.6, Number(item?.scale) || 0.95))
      items.push({ id, role, scale: Number(scale.toFixed(2)) })
    }
  }
  const hasIntentItems = items.length >= 3
  if (!items.length) {
    const defaults = rawScene ? sceneItemsFromIds(def.defaults, rng) : fallback.items
    items.push(...defaults)
  } else if (!hasIntentItems) {
    for (const item of sceneItemsFromIds(def.defaults, rng)) {
      if (items.length >= 5) break
      if (!items.some((x) => x.id === item.id)) items.push(item)
    }
  }
  if (!hasIntentItems) {
    // 只有本地兜底/弱场景意图时，才让文案关键词额外补物件；
    // 模型已经给出 3-5 个场景物件时，不再用关键词把地点主物件挤掉。
    const keywordHits = keywordObjects((context.copyLines || []).join(''))
    for (const id of keywordHits) {
      if (items.length >= 5) break
      if (!items.some((x) => x.id === id)) items.push({ id, role: defaultRole(id), scale: 1 })
    }
  } else {
    // 模型场景已经成立时只补“大件”场景词（房子/树/山/草原/路……），
    // 不补纸片、尾巴、杯子这类小物，避免把地点主物件挤掉。
    const bigSceneIds = ['house', 'tree', 'mountain', 'grassland', 'road', 'desk', 'chair', 'bed', 'bicycle', 'sea', 'door', 'fence', 'stone', 'kite', 'shelf', 'phone']
    const keywordHits = keywordObjects((context.copyLines || []).join(''))
    for (const id of keywordHits) {
      if (items.length >= 5) break
      if (bigSceneIds.includes(id) && !items.some((x) => x.id === id)) {
        items.push({ id, role: defaultRole(id), scale: 1 })
        break
      }
    }
  }
  if (!items.length) items.push(...sceneItemsFromIds(def.defaults, rng))
  return {
    v: 5,
    place,
    weather: ['clear', 'cloudy', 'rain', 'snow', 'wind'].includes(raw.weather) ? raw.weather : fallback.weather,
    light: ['warm', 'neutral', 'soft-cool', 'golden'].includes(raw.light) ? raw.light : fallback.light,
    items: items.slice(0, 5),
    source: rawScene ? 'model' : 'local',
  }
}

const GESTURE_BY_INTENT = {
  greeting: 'wave',
  affection: 'hold',
  comfort: 'floor',
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
  hug: ['hold', 'curl', 'sit'],
  hold: ['hold', 'stand'],
  sit: ['sit', 'chair', 'floor'],
  sleep: ['sleep', 'tummy', 'sit'],
  peek: ['peek', 'stand'],
  stand: ['stand'],
  curl: ['curl', 'floor'],
  bike: ['bike'],
  floor: ['floor', 'sit'],
}

const MOOD_POSES = {
  excited: ['wave', 'walk', 'hold', 'stand'],
  happy: ['wave', 'walk', 'floor', 'hold', 'sit', 'stand'],
  proud: ['stand', 'hold', 'sit'],
  calm: ['sit', 'floor', 'hold', 'stand'],
  blank: ['peek', 'sit', 'floor', 'hold'],
  sleepy: ['sleep', 'tummy', 'sit'],
  wronged: ['curl', 'floor', 'sit'],
  sad: ['back', 'curl', 'floor', 'sit'],
}

function scenePoseCandidates(scene, moodKey, gesture) {
  const def = SCENE_PLACES[scene.place] || SCENE_PLACES.room
  const ids = new Set((scene.items || []).map((item) => item.id))
  if (ids.has('bicycle') || def.poses.includes('bike')) return ['bike']
  if (ids.has('bed') || scene.place === 'bed') return ['tummy', 'sleep', 'sit']
  if (ids.has('desk') || ids.has('chair') || scene.place === 'desk') return ['chair', 'sit']
  if (gesture && GESTURE_POSE[gesture]) {
    const gesturePoses = GESTURE_POSE[gesture].filter((pose) => POSES[pose])
    if (gesturePoses.length) return gesturePoses
  }
  const moodPoses = MOOD_POSES[moodKey] || []
  const intersect = def.poses.filter((pose) => moodPoses.includes(pose))
  return intersect.length ? intersect : def.poses
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

    const copyLines = Array.isArray(input.copyLines) && input.copyLines.length
      ? input.copyLines.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
      : localCopy({ moodKey, persona, sticker, rng })
    const keywords = extractKeywords(copyLines)
    const scene = normalizeScene(input.scene || input.sceneIntent || null, { copyLines, moodKey, rng })

    const allBg = Object.keys(BACKGROUNDS).filter((id) => BACKGROUNDS[id].moods.includes(moodKey))
    const bgCandidates = shuffle(rng, allBg)
    const background = weightedPick(rng, bgCandidates, counts.background)
    const medium = weightedPick(rng, Object.keys(MEDIUMS), counts.medium)

    const gesture = stickerGesture(sticker, moodKey)
    const poseCandidates = scenePoseCandidates(scene, moodKey, gesture)
    const pose = input.pose && POSES[input.pose] ? input.pose : pick(rng, poseCandidates)
    if (pose === 'bike') scene.items = scene.items.filter((item) => item.id !== 'bicycle')

    let compCandidates
    if (pose === 'back') compCandidates = ['back-view']
    else if (pose === 'peek') compCandidates = ['center-bust', 'top-left']
    else if (['sleep', 'curl', 'tummy', 'bike'].includes(pose)) compCandidates = ['left-low', 'right-full', 'diagonal']
    else compCandidates = ['left-low', 'right-full', 'center-bust', 'diagonal', 'top-left']
    const composition = input.composition && COMPOSITIONS[input.composition]
      ? input.composition
      : weightedPick(rng, compCandidates, counts.composition)

    // 文案里命中的物件必须落进画面；再按心情/创作欲控制场景密度。
    const must = keywords.objects
    const density = clamp((mood.densityBias + (urge - 35) / 100) + 0.35, 0.12, 0.9)
    const maxItems = Math.max(2, Math.min(5, Math.round(2 + density * 3)))
    if (scene.items.length > maxItems) {
      const anchors = {
        grassland: ['grassland', 'sun'],
        room: ['window', 'chair'],
        desk: ['desk', 'chair'],
        bed: ['bed', 'pillow'],
        street: ['road', 'house'],
        beach: ['sea', 'shell'],
        mountain: ['mountain', 'grassland'],
        window: ['window', 'rain'],
        abstract: ['stars', 'cloud'],
      }[scene.place] || []
      const anchorItems = scene.items.filter((item) => anchors.includes(item.id))
      const mustItems = scene.items.filter((item) => must.includes(item.id))
      const keep = [...anchorItems, ...mustItems].filter((item, i, arr) => arr.findIndex((x) => x.id === item.id) === i)
      const rest = shuffle(rng, scene.items.filter((item) => !keep.some((x) => x.id === item.id)))
      scene.items = [...keep, ...rest].slice(0, maxItems)
      // 尽量保住天空/地面各一层，避免画面只剩一堆小物件。
      for (const role of ['sky', 'ground']) {
        if (scene.items.some((item) => item.role === role)) continue
        const candidate = rest.find((item) => item.role === role)
        if (candidate && scene.items.length >= maxItems) {
          const dropAt = scene.items.map((item, i) => ({ item, i })).reverse().find(({ item }) => !must.includes(item.id) && !anchors.includes(item.id))
          if (dropAt) scene.items[dropAt.i] = candidate
        }
      }
    }
    const objects = scene.items.map((item) => item.id).slice(0, 5)

    const palette = pick(rng, paletteCandidates(moodKey, background))
    const signature = signatureOf(character, persona, input.signatureName)
    const textBox = textBoxFor(COMPOSITIONS[composition].text)
    const plan = {
      v: 5,
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
      scene,
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
  const place = SCENE_PLACES[plan.scene?.place]?.label
  const where = place ? `，在${place}` : ''
  return `画一张${plan.mood.label}的手稿${where}${what}`
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
  if (!SCENE_PLACES[plan.scene?.place]) issues.push('场景地点不合法')
  if (!Array.isArray(plan.scene?.items) || !plan.scene.items.length) issues.push('场景没有物件')
  if ((plan.scene?.items || []).length > 5) issues.push('场景物件太多')
  for (const item of plan.scene?.items || []) {
    if (!OBJECTS[item.id]) issues.push(`未知场景物件：${item.id}`)
    if (!ITEM_ROLES.includes(item.role)) issues.push(`未知场景层级：${item.role}`)
  }
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
