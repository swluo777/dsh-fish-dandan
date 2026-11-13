// ============================================================
// 说话语料：梗、句式、口语替换
//
// 光有规则不够。模型知道「可以用梗」，但不知道有哪些梗；知道「别太正式」，
// 但不知道具体怎么不正式。所以这里给三样东西：
//   1. MEME_BANK：按情绪分的网络用语（短、能直接当尾巴）；
//   2. PATTERNS：人话句式（「…属于是」「主打一个…」这类）；
//   3. SWAPS：书面词 → 口语词（因此→所以、非常→特别…）；
//   4. EXAMPLES：正式 vs 人话对照，给模型一个参照。
//
// 用法有两条路：发送前用 informalize() 做替换；每轮把一小撮词条注入上下文，
// 让模型自己挑着用（轮换，避免每轮重复同一批）。
// ============================================================

/** 网络用语，按情绪分组。短、通用、不带脏字。 */
export const MEME_BANK = {
  amuse: ['离谱', '好家伙', '我嘞个豆', '绝了', '笑死', '绷不住了', '这也行', '给我笑到了'],
  down: ['麻了', '有点破防', '难绷', '算了算了', '服了', '心累', '顶不住'],
  cheer: ['爽了', '舒服了', '爱了', '行啊', '可以可以', '美滋滋'],
  tease: ['典', '就这', '急了急了', '这很难评', '典中典', '搁这呢', '你要这么说也行'],
  agree: ['确实', '有道理', '懂的都懂', '是这个理', '没毛病'],
  surprise: ['啊？', '惊了', '真的假的', '还有这种操作', '不是吧', '离谱到家了'],
  tired: ['困了', '先歇会儿', '不折腾了', '摆烂一会儿', '脑子不转了'],
}

/**
 * 人话句式：每条都带「模板 / 效果 / 例子 / 使用闸门」。
 * 借鉴 dsh-fish-tone-flavor 的 constructions.json：只给一条光秃秃的模板没用，
 * 模型不知道它什么时候该用、容易用错在哪。24 条里只收了我们用得上的 16 条，
 * 需要前文铺垫的（当个事儿办 / 开香槟 / 含金量还在上升）先不收。
 */
export const PATTERNS = [
  { id: 'x01', name: 'X？！', template: '{短名词}？！', effect: '不信、没听懂', example: '这也行？！', gate: '只挂短名词，不挂整句' },
  { id: 'x02', name: 'X了', template: '{短词}了', effect: '一句话收掉评价', example: '这波可以了', gate: '要用褒贬明确的词' },
  { id: 'x03', name: '单字判词', template: '{单字}。', effect: '一个字判完', example: '典。', gate: '对事不对人，别连着用' },
  { id: 'x05', name: '一整个X住', template: '一整个{形容词}住', effect: '状态被拉满', example: '一整个大无语住', gate: '用在被震住/尬住的场合' },
  { id: 'x06', name: '有亿点X', template: '有亿点{形容词}', effect: '夸张一档', example: '这操作有亿点离谱', gate: '只能夸张，不能真说数量' },
  { id: 'x07', name: 'X了但没完全X', template: '{动词}了，但没完全{动词}', effect: '承认一半', example: '修好了，但没完全修好', gate: '前后同一个动词' },
  { id: 'x08', name: '就这？', template: '就这？', effect: '轻蔑', example: '就这？', gate: '对事，别对人' },
  { id: 'x09', name: '啊？', template: '啊？', effect: '没听懂但震住了', example: '啊？', gate: '单独一条发效果最好' },
  { id: 'x10', name: '你说的对，但是', template: '你说的对，但是{转折}', effect: '礼貌型开杠', example: '你说的对，但是我不太信', gate: '只在不熟的场合用' },
  { id: 'x13', name: '谁问你了', template: '谁问你了？', effect: '截断对方自说自话', example: '谁问你了？', gate: '只跟熟人开这种玩笑' },
  { id: 'x14', name: '你是懂X的', template: '你是懂{名词}的', effect: '阴阳式夸奖', example: '你是懂剪辑的', gate: '对方先显摆过才用' },
  { id: 'x15', name: 'X不了一点', template: '{动词}不了一点', effect: '彻底否定', example: '我不了一点', gate: '只跟否定搭' },
  { id: 'x16', name: '有点X不确定', template: '有点{形容词}，不确定，再看看', effect: '欲言又止', example: '有点离谱，不确定，再看看', gate: '吐槽咽回去时用' },
  { id: 'x17', name: '这很难评', template: '这很难评，我祝他成功', effect: '不评价的评价', example: '这很难评', gate: '别对当事人说' },
  { id: 'x21', name: '不是，哥们', template: '不是，哥们', effect: '被打断思路的第一反应', example: '不是，哥们，你在干啥', gate: '只跟熟人' },
  { id: 'x23', name: '说人话', template: '说人话', effect: '要求翻译成白话', example: '说人话', gate: '别对长辈/陌生人用' },
]

/** 书面词 → 口语词。只换不影响语义的词。 */
export const SWAPS = [
  ['因此', '所以'], ['并且', '而且'], ['此外', '还有'], ['然而', '但'],
  ['非常', '特别'], ['立刻', '马上'], ['目前', '现在'], ['此外', '另外'],
  ['Moreover', '而且'], ['关于', '说到'], ['如果', '要是'], ['是否', '是不是'],
  ['进行', '做'], ['获取', '拿到'], ['显示', '看着'], ['拥有', '有'],
  ['使用', '用'], ['如此', '这么'], ['或许', '可能'], ['十分', '挺'],
  ['由于', '因为'], ['以及', '和'], ['以便', '好'], ['请勿', '别'],
]

/** 正式 vs 人话对照，给模型看「不正式」到底长什么样。 */
export const EXAMPLES = [
  ['我理解你的意思了，我会在稍后处理这个问题。', '懂了，待会儿弄'],
  ['这个视频非常有趣，我想再看一遍。', '这个好看，再看一遍'],
  ['由于网络原因，我暂时无法打开这个链接。', '网不好，打不开'],
  ['我建议你可以尝试重新发送一次。', '你重发一次试试'],
  ['我认为这个观点是正确的。', '确实'],
]

function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  return Math.abs(x)
}

function pickWith(list, seed) {
  if (!list.length) return ''
  return list[hash(seed) % list.length]
}

/** 取一撮词条用于注入：按 seed 轮换，不会每轮都一样。 */
export function sampleCorpus(seed = Date.now(), { memes = 6, patterns = 3, examples = 2 } = {}) {
  const vibes = Object.keys(MEME_BANK)
  const memeOut = []
  for (let i = 0; i < memes; i += 1) {
    const vibe = vibes[hash(seed + i) % vibes.length]
    const list = MEME_BANK[vibe]
    const w = list[hash(seed + i * 31) % list.length]
    if (w && !memeOut.includes(w)) memeOut.push(w)
  }
  const patternOut = []
  const usedEffect = new Set()
  for (let i = 0; i < patterns * 3 && patternOut.length < patterns; i += 1) {
    const p = PATTERNS[hash(seed + i * 17) % PATTERNS.length]
    if (!p || patternOut.includes(p)) continue
    // 一轮只给不同「效果」的句式，避免一段话里全是同一种腔调（扎堆才是 AI 味）
    if (usedEffect.has(p.effect)) continue
    usedEffect.add(p.effect)
    patternOut.push(p)
  }
  const exampleOut = []
  for (let i = 0; i < examples; i += 1) {
    const e = EXAMPLES[hash(seed + i * 29) % EXAMPLES.length]
    if (e && !exampleOut.some((x) => x[0] === e[0])) exampleOut.push(e)
  }
  return { memes: memeOut, patterns: patternOut, examples: exampleOut }
}

/**
 * 把书面词换成口语词。只做词级替换，不动数字/链接/@。
 * @returns {{ text: string, changed: number }}
 */
export function informalize(text) {
  const s = String(text || '')
  if (!s.trim() || /https?:\/\/|@|#/.test(s)) return { text: s, changed: 0 }
  let out = s
  let changed = 0
  for (const [from, to] of SWAPS) {
    if (!out.includes(from)) continue
    out = out.split(from).join(to)
    changed += 1
  }
  return { text: out, changed }
}

/** 随机拿一个梗（给后处理用）。 */
export function randomMeme(vibe, seed = Date.now()) {
  const pool = MEME_BANK[vibe]
  if (!pool || !pool.length) return ''
  return pickWith(pool, seed)
}

/** 拼成给模型看的一段话（每轮注入用，不写进人格段）。 */
export function corpusPrompt(seed = Date.now()) {
  const { memes, patterns, examples } = sampleCorpus(seed)
  const lines = []
  lines.push('【现成的说法·这一轮可以挑着用，不必每句都用】')
  if (memes.length) lines.push(`网络用语：${memes.join('、')}`)
  if (patterns.length) {
    // 只给模板和场合，不给例子：例子容易被原样照抄
    lines.push(`句式：${patterns.map((p) => `${p.template.replace(/\{[^}]+\}/g, '…')}（${p.effect}）`).join('；')}`)
  }
  if (examples.length) {
    lines.push('不正式是什么样：')
    for (const [formal, casual] of examples) lines.push(`- 正式：${formal} → 人话：${casual}`)
  }
  lines.push('用一到两个就够，用多了像在演；没听准的说法别硬套。')
  return lines.join('\n')
}
