// ============================================================
// 嘴瓢与玩梗（让文字别那么一板一眼）
//
// 真人打字有两个特征：偶尔打错一个字；时不时夹一个网络用语。
// 这两个都不能靠提示词保证（模型要么不犯，要么一次犯一串），所以放代码里，
// 用很低的概率，并且严格避开链接、@、话题标签、数字和很短的句子。
//
// 边界：
//   - 一条最多一个梗、最多错一个字；
//   - 打错只换同音字，不改语义、不动专有名词；
//   - 梗库只用通用网络词，不碰有争议的、不碰脏话。
// ============================================================

import { informalize, randomMeme } from './corpus.js'

/** 同音/近音错字对：只改一个字，改完还是能被看懂。 */
const TYPO_MAP = [
  ['在', '再'], ['再', '在'], ['的', '得'], ['得', '的'], ['那', '哪'], ['哪', '那'],
  ['已', '以'], ['像', '象'], ['做', '作'], ['座', '坐'], ['带', '戴'], ['戴', '带'],
  ['塌', '踏'], ['踏', '塌'], ['须', '需'], ['需', '须'], ['捡', '拣'], ['拣', '捡'],
]

/** 网络用语，按情绪分组。每条都很短，能直接当尾巴用。 */
const MEMES = {
  amuse: ['离谱', '好家伙', '我嘞个豆', '绝了', '笑死'],
  down: ['麻了', '有点破防', '难绷', '算了算了'],
  cheer: ['爽了', '舒服了', '爱了'],
  tease: ['典', '就这', '急了急了', '这很难评'],
  agree: ['确实', '有道理', '懂的都懂'],
  surprise: ['啊？', '惊了', '真的假的'],
}

const VIBE_WORDS = [
  ['down', /烦|累|麻|无语|难受|不想|算了|唉/],
  ['amuse', /笑|哈哈|离谱|好玩|有意思/],
  ['surprise', /啊|诶|居然|真的|不会吧/],
  ['tease', /就这|菜|急了|典/],
  ['cheer', /好耶|开心|爽|喜欢/],
]

function pick(list, rng) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
}

/** 从文本里猜现在的情绪，猜不出就中性（不加梗）。 */
export function vibeOf(text) {
  const s = String(text || '')
  for (const [vibe, re] of VIBE_WORDS) if (re.test(s)) return vibe
  return ''
}

/** 能不能在这个文本上动手脚（链接/@/话题/数字/太短都不碰）。 */
function isSafe(text) {
  const s = String(text || '')
  if (s.length < 6 || s.length > 60) return false
  if (/https?:\/\/|www\.|@|#|【|】|`/.test(s)) return false
  return true
}

/**
 * 偶尔打错一个字。
 * @returns {{ text: string, changed: boolean }}
 */
export function maybeTypo(text, { rng = Math.random, chance = 0.045 } = {}) {
  const s = String(text || '')
  if (!isSafe(s) || rng() >= chance) return { text: s, changed: false }
  // 从随机位置往后找第一个「能换同音字」的位置，找不到就不改
  const start = Math.floor(rng() * s.length)
  for (let offset = 0; offset < s.length; offset += 1) {
    const i = (start + offset) % s.length
    const ch = s[i]
    const pair = TYPO_MAP.find(([from]) => from === ch)
    if (!pair) continue
    // 别改句尾，也别改叠字（看着像故意的）
    if (i >= s.length - 1) continue
    if (s[i - 1] === ch || s[i + 1] === ch) continue
    const out = s.slice(0, i) + pair[1] + s.slice(i + 1)
    return { text: out, changed: true }
  }
  return { text: s, changed: false }
}

/**
 * 偶尔夹一个网络用语。
 * @returns {{ text: string, changed: boolean, meme?: string }}
 */
export function maybeMeme(text, { rng = Math.random, chance = 0.12, vibe = '' } = {}) {
  const s = String(text || '')
  if (!isSafe(s) || rng() >= chance) return { text: s, changed: false }
  if (!vibe) return { text: s, changed: false }
  const meme = randomMeme(vibe, Math.floor(rng() * 1e6))
  if (!meme || s.includes(meme)) return { text: s, changed: false }
  // 挂在句尾，别打断原来的话
  const joined = /[。！？!?…]$/.test(s) ? s.replace(/[。！？!?…]+$/, `，${meme}`) : `${s}，${meme}`
  return { text: joined, changed: true, meme }
}

/**
 * 表情不是随机贴纸：先看这句话现在是什么情绪，再从对应的小组里挑。
 * 这样「好笑」「无语」「安慰」不会互相串味；没有明显情绪时用中性组兜底。
 */
const EMOJI_BY_VIBE = {
  amuse: ['😂', '🤣', '😆'],
  down: ['🥺', '😮‍💨', '😔'],
  cheer: ['😊', '✨', '💙'],
  tease: ['😏', '😜', '🙃'],
  agree: ['👍', '👌', '✅'],
  surprise: ['😮', '😲', '❓'],
  shy: ['😳', '🫣', '🙈'],
  angry: ['😤', '😅'],
  sleepy: ['😴', '🌙'],
  thanks: ['🙏', '💙'],
  greeting: ['👋', '😊'],
  neutral: ['🙂', '😌'],
}

const EMOJI_HINTS = [
  ['thanks', /谢谢|多谢|感谢|麻烦了|辛苦了/],
  ['sleepy', /晚安|睡了|困|睡觉|熬夜/],
  ['greeting', /在吗|在不在|早上好|晚上好|你好|哈喽|嗨/],
  ['shy', /害羞|不好意思|脸红|别夸|羞/],
  ['agree', /好的|可以|行|没问题|收到|同意|说得对/],
  ['angry', /气死|生气|烦死|无语|离谱|过分/],
  ['cheer', /好耶|开心|喜欢|太棒|真好|舒服/],
  ['down', /累|难过|难受|委屈|想哭|破防|算了/],
  ['amuse', /笑死|哈哈|好笑|有意思|绝了/],
  ['surprise', /居然|真的假的|没想到|惊了|啊？/],
  ['tease', /就这|急了|菜|典|这很难评/],
]

const HAS_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

/** 返回文本里最明显的情绪；纯陈述返回空。 */
function emojiVibe(text) {
  const s = String(text || '')
  for (const [vibe, re] of EMOJI_HINTS) if (re.test(s)) return vibe
  return ''
}

/** 按文本情绪选一个语义合适的 emoji；挑不出来就返回空。 */
export function emojiForText(text, { rng = Math.random, vibe } = {}) {
  const v = vibe === undefined ? emojiVibe(text) : vibe
  // 没有明显情绪时用中性表情兜底；有情绪时只在对应小组里挑，避免「难过还发笑哭」
  const list = EMOJI_BY_VIBE[v] || EMOJI_BY_VIBE.neutral
  if (!list || !list.length) return ''
  return pick(list, rng)
}

/**
 * 偶尔带一个 emoji（真人发消息的常见动作）。
 * 已经有表情、太长、带链接/@ 的都不加，一条最多一个。
 */
export function maybeEmoji(text, { rng = Math.random, chance = 0.22, vibe } = {}) {
  const s = String(text || '')
  // 表情比错字安全得多：短句也能带（真人经常就回一个表情），只避开链接/账号/话题标签
  if (s.length < 2 || /https?:\/\/|www\.|@|#/.test(s)) return { text: s, changed: false }
  if (rng() >= chance) return { text: s, changed: false }
  if (HAS_EMOJI.test(s)) return { text: s, changed: false }
  const emoji = emojiForText(s, { rng, vibe })
  if (!emoji) return { text: s, changed: false }
  const joined = /[。！？!?…]$/.test(s) ? s.replace(/[。！？!?…]+$/, ` ${emoji}`) : `${s} ${emoji}`
  return { text: joined, changed: true, emoji }
}

/** 两个都试一下：先错字，再梗（各自独立概率，但一条最多各一次）。 */
export function applyFlavor(text, { rng = Math.random, typoChance = 0.045, memeChance = 0.12, emojiChance = 0.22, vibe } = {}) {
  const v = vibe === undefined ? vibeOf(text) : vibe
  // 先把书面词换成口语（因此→所以、非常→特别），这一步不随机，是确定性的
  const inf = informalize(text)
  const t = maybeTypo(inf.text, { rng, chance: typoChance })
  const m = maybeMeme(t.text, { rng, chance: memeChance, vibe: v })
  const e = maybeEmoji(m.text, { rng, chance: emojiChance, vibe: v || undefined })
  return { text: e.text, typo: t.changed, meme: m.meme || '', emoji: e.emoji || '', informal: inf.changed }
}
