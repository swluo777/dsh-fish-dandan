// ============================================================
// 第一次见面（只出现一次）
//
// 问题：新用户装好插件、直接开一个对话，模型看到的是完整人格段 + 记忆上下文，
// 但它不知道「这是第一次」，于是第一句往往是一段工整的自我介绍——最像客服的时刻。
//
// 做法：首装时落一个标记，在第一次真正开口之前注入一小段「你刚被装进来、
// 还不认识对方」的动态上下文；对方回过一轮就作废，之后再也不出现。
// 不写进人格段（那是稳定前缀，不能变），所以不影响缓存。
// ============================================================

import { ensureDirFor, fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'

const DEFAULT_PATH = 'data/state/first-meet.json'

/** 第一次开口时给的引导：短、具体、明确禁止客服腔。 */
export function firstMeetText(persona) {
  const addr = String((persona && persona.speech && persona.speech.ownerAddress) || '').trim()
  const self = String((persona && persona.speech && persona.speech.selfReference) || '我').trim() || '我'
  const callHint = addr && addr !== '你' ? `先问一句怎么称呼他（现在默认叫「${addr}」，不对就让他改）。` : '先问一句怎么称呼他。'
  return [
    '【第一次见面 · 只出现这一次】',
    `这台机器刚把${self}装进来，${self}还谁都不认识，对面这个人也没跟${self}说过话。`,
    `可以自己先开口，一两句就够：${callHint}或者说说现在最想干的事。`,
    '别做自我介绍，别列自己能干什么，别写"很高兴认识你""有什么可以帮你"这种话。',
  ].join('\n')
}

/**
 * 首次见面标记。文件坏了就当作「已经见过」，宁可少一句引导，也不反复骚扰。
 *
 * `fresh` 由调用方判断「是不是真·第一次装」（人格运行时文件此前不存在）。
 * 升级上来的老用户没有这个标记，但也不该被说「刚把本鱼装进来」，
 * 所以直接记成已见。
 *
 * @param {{ config: object, logger: object, fresh?: boolean }} deps
 */
export function createFirstMeet({ config, logger = console, fresh = true } = {}) {
  const file = fromRoot((config && config.persona && config.persona.firstMeetPath) || DEFAULT_PATH)
  let state = readJsonSafe(file, null)
  let isFresh = false

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    state = fresh
      ? { at: Date.now(), greeted: false }
      : { at: Date.now(), greeted: true, via: 'upgrade' }
    isFresh = fresh
    try {
      ensureDirFor(file)
      writeJsonAtomic(file, state)
      if (fresh) logger.info?.('首次运行：已记录第一次见面')
    } catch (err) {
      logger.warn?.(`首次见面标记写入失败：${err.message}`)
    }
  }

  function pending() {
    return Boolean(state) && state.greeted === false
  }

  function text(persona) {
    return pending() ? firstMeetText(persona) : ''
  }

  function complete(via = 'turn') {
    if (!state || state.greeted !== false) return false
    state.greeted = true
    state.greetedAt = Date.now()
    state.via = String(via).slice(0, 40)
    try {
      ensureDirFor(file)
      writeJsonAtomic(file, state)
      return true
    } catch (err) {
      logger.warn?.(`首次见面标记更新失败：${err.message}`)
      return false
    }
  }

  return { pending, text, complete, path: file, get fresh() { return isFresh } }
}
