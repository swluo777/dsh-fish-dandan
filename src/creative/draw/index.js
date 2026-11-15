// ============================================================
// 专注创作 · 画图工作室（Node 侧编排）
// 规划 → 写页面 → 本地服务 → 共享浏览器截图 → 落盘 + 台账。
// 不依赖任何第三方包，也不读项目外的素材目录。
// ============================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fromRoot, ensureDirFor } from '../../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'
import { buildPlan, deriveMood, localCopy, MOODS, planText, validatePlan, OBJECTS } from './plan.js'
import { createCopyWriter } from './prompt.js'
import { startDrawServer, buildPageHtml, drawAssetsPaths } from './server.js'

const MOOD_STICKER_WORDS = {
  excited: ['开心', '兴奋', '可爱', '得意'],
  happy: ['开心', '可爱', '呆萌', '喜欢'],
  proud: ['得意', '自信', '可爱'],
  calm: ['平静', '呆萌', '可爱'],
  blank: ['呆萌', '发呆', '可爱'],
  sleepy: ['困', '睡觉', '疲惫'],
  wronged: ['委屈', '难过', '哭'],
  sad: ['难过', '伤心', '哭'],
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function stamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickDesktop(config) {
  const configured = String(config?.decision?.draw?.desktopDir || '').trim()
  if (configured) return fromRoot(configured)
  const home = os.homedir()
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, '桌面'),
  ]
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir } catch { /* 继续找 */ }
  }
  return home
}

function pickCharacter(characters, fallbackName = '蛋蛋') {
  const empty = { id: '', ageGroup: 'child', outfitId: 'initial-maid', displayName: fallbackName }
  try {
    const state = characters?.state?.()
    if (!state) return empty
    const items = Array.isArray(state.items) ? state.items : []
    const primary = items.find((item) => item.id === state.primaryImageId) || items.find((item) => item.isPrimary) || items[0]
    return {
      id: String(primary?.id || state.primaryImageId || ''),
      ageGroup: String(primary?.ageGroup || 'child'),
      outfitId: String(primary?.outfitId || 'initial-maid'),
      displayName: String(state.character?.displayName || primary?.title || fallbackName),
    }
  } catch {
    return empty
  }
}

function pickSticker(stickers, moodKey, wantedId) {
  try {
    if (wantedId && typeof stickers?.get === 'function') {
      const one = stickers.get(String(wantedId))
      if (one) return one
    }
    if (!stickers || typeof stickers.list !== 'function') return null
    const list = stickers.list({ limit: 300 })?.items || []
    if (!list.length) return null
    const words = MOOD_STICKER_WORDS[moodKey] || []
    const scored = list.map((item) => {
      const text = [...(item.emotion || []), ...(item.intents || []), String(item.caption || '')].join(' ')
      let score = 0
      for (const word of words) score += text.includes(word) ? 0.35 : 0
      if (item.lastUsedAt) score -= 0.03
      score += (item.confidence || 0) * 0.05
      return { item, score }
    })
    scored.sort((a, b) => b.score - a.score)
    // 不永远拿同一张：在前 6 张里按使用次数轻量随机
    const top = scored.slice(0, 6)
    const total = top.reduce((sum, s) => sum + (s.score || 0.01), 0)
    let r = Math.random() * total
    for (const s of top) {
      r -= s.score || 0.01
      if (r <= 0) return s.item
    }
    return top[0]?.item || list[0]
  } catch {
    return null
  }
}

function readHistory(indexPath) {
  const raw = readJsonSafe(indexPath, [], null)
  return Array.isArray(raw) ? raw : []
}

function trimHtml(outDir, keep) {
  try {
    const files = fs.readdirSync(outDir).filter((f) => /^draw-\d{8}-\d{6}\.html$/.test(f))
    const sorted = files.map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const item of sorted.slice(Math.max(1, keep))) {
      try { fs.rmSync(path.join(outDir, item.f), { force: true }) } catch { /* 忽略 */ }
    }
  } catch { /* 目录还不存在就算了 */ }
}

async function waitReady(page, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const r = await page.cmd('Runtime.evaluate', {
      expression: 'JSON.stringify({ ready: Boolean(window.__ready), error: String(window.__error || "") })',
      returnByValue: true,
    })
    const text = r?.result?.value
    if (text) {
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* 继续等 */ }
      if (parsed?.error) throw new Error(`画图页报错：${parsed.error}`)
      if (parsed?.ready) return true
    }
    await sleep(180)
  }
  throw new Error('画图页在限定时间内没有准备好')
}

/**
 * @param {{
 *   config: object,
 *   logger: object,
 *   getState: () => object,
 *   getPersona: () => object,
 *   getCharacters: () => object,
 *   getStickers: () => object,
 *   getHub: () => object,
 * }} deps
 */
export function createDrawStudio({ config, logger = console, getState, getPersona, getCharacters, getStickers, getHub } = {}) {
  const drawCfg = () => config?.decision?.draw || {}
  const copyWriter = createCopyWriter({ logger })

  function currentSnapshot() {
    let state = null
    try { state = getState?.() || null } catch { state = null }
    let persona = null
    try { persona = getPersona?.() || null } catch { persona = null }
    return { state, persona }
  }

  /** 给「询问」策略和活动卡用的静态预览，不写文件、不开浏览器。 */
  function preview({ trigger = 'state' } = {}) {
    if (drawCfg().enabled === false) {
      return {
        text: '专注创作已在设置里关闭',
        detail: '画图开关当前是关闭的；要画的话，先到配置里把 decision.draw.enabled 打开。',
        plan: null,
        payload: { disabled: true },
      }
    }
    try {
      const { state, persona } = currentSnapshot()
      const vars = state?.vars || {}
      const affect = state?.affect || {}
      const moodKey = deriveMood(vars, affect)
      const character = pickCharacter(getCharacters?.(), persona?.identity?.name || '蛋蛋')
      const sticker = pickSticker(getStickers?.(), moodKey, drawCfg().stickerId)
      const plan = buildPlan({
        now: Date.now(),
        seed: Date.now(),
        vars,
        affect,
        character,
        sticker,
        persona,
        signatureName: drawCfg().signatureName,
        history: readHistory(fromRoot(drawCfg().outDir || 'data/creative') + '/draw-index.json'),
      })
      return {
        text: planText(plan),
        detail: `${planText(plan)}。${plan.copy.lines.join('')}`,
        plan,
        payload: { mood: moodKey, stickerId: plan.sticker.id, background: plan.background, medium: plan.medium },
      }
    } catch (err) {
      logger.warn?.(`专注创作预览失败：${err.message}`)
      return {
        text: '画一张手绘图放桌面',
        detail: '它会用当前心情和表情包，画一张手绘稿放到桌面。',
        plan: null,
        payload: {},
      }
    }
  }

  /**
   * 真正画一张。
   * @param {{ trigger?: string, onProgress?: (text:string)=>void, isCancelled?: ()=>boolean }} opts
   */
  async function draw({ trigger = 'state', onProgress, isCancelled, plan: fixedPlan = null } = {}) {
    const started = Date.now()
    const cfg = drawCfg()
    if (cfg.enabled === false) return { ok: false, reason: '专注创作已关闭' }
    const width = Number(cfg.width) || 1080
    const height = Number(cfg.height) || 1440
    const outDir = fromRoot(cfg.outDir || 'data/creative')
    const history = readHistory(path.join(outDir, 'draw-index.json'))
    const { state, persona } = currentSnapshot()
    const vars = state?.vars || {}
    const affect = state?.affect || {}
    const moodKey = deriveMood(vars, affect)
    const mood = MOODS[moodKey]
    const character = pickCharacter(getCharacters?.(), persona?.identity?.name || '蛋蛋')
    const sticker = pickSticker(getStickers?.(), moodKey, cfg.stickerId)
    const cancelled = () => Boolean(isCancelled?.())
    const check = () => {
      if (cancelled()) {
        const err = new Error('已取消')
        err.code = 'CANCELLED'
        throw err
      }
    }
    const say = (text) => { try { onProgress?.(text) } catch { /* 忽略 */ } }

    let plan = null
    if (fixedPlan && typeof fixedPlan === 'object') {
      plan = { ...fixedPlan, width, height }
      say('正在按已确认的画面铺纸…')
    } else {
      say('正在想这次画什么…')
      const seed = Number(cfg.seed) || ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0)
      let copyLines = null
      try {
        copyLines = await copyWriter.write(
          { mood, persona, sticker, vars, seed },
          { timeoutMs: Number(cfg.modelTimeoutMs) || 8000 },
        )
      } catch (err) {
        logger.warn?.(`专注创作写独白失败：${err.message}`)
      }
      check()
      if (!copyLines) copyLines = localCopy({ moodKey, persona, sticker })

      try {
        plan = buildPlan({
          now: Date.now(),
          seed,
          vars,
          affect,
          character,
          sticker,
          persona,
          copyLines,
          signatureName: cfg.signatureName,
          history,
        })
      } catch (err) {
        return { ok: false, reason: `画面计划没出来：${err.message}` }
      }
      plan.width = width
      plan.height = height
    }
    const issues = validatePlan(plan)
    if (issues.length) return { ok: false, reason: `画面计划不合格：${issues.join('；')}` }
    logger.info?.(`专注创作计划：seed=${plan.seed} mood=${plan.mood.key} bg=${plan.background} medium=${plan.medium} comp=${plan.composition} pose=${plan.pose} objs=${plan.objects.join(',')}`)

    say('正在铺纸、起稿…')
    const pageHtml = buildPageHtml(plan)
    const date = new Date()
    const tag = stamp(date)
    ensureDirFor(path.join(outDir, 'x'))
    const htmlPath = path.join(outDir, `draw-${tag}.html`)
    fs.writeFileSync(htmlPath, pageHtml, 'utf8')

    let server = null
    let page = null
    try {
      check()
      const assets = drawAssetsPaths()
      server = await startDrawServer({ pageHtml, rendererPath: assets.rendererPath, fontPath: assets.fontPath, spriteDir: assets.spriteDir, logger })
      check()
      const hub = getHub?.()
      if (!hub || typeof hub.openTab !== 'function') throw new Error('共享浏览器没有准备好，画不了')
      page = await hub.openTab('draw', server.url, { bringToFront: false })
      if (!page) throw new Error('共享浏览器没有打开画图页')
      await page.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      check()
      say('正在上色、写字…')
      await waitReady(page, Number(cfg.screenshotTimeoutMs) || 12000)
      check()
      const shot = await page.cmd('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })
      if (!shot?.data) throw new Error('截图没有返回数据')
      const png = Buffer.from(shot.data, 'base64')
      if (!png.length) throw new Error('截图是空的')
      check()

      const desktop = pickDesktop(config)
      const fileName = `大肥鱼创作-${tag}-${plan.mood.key}.png`
      const pngPath = path.join(desktop, fileName)
      fs.writeFileSync(pngPath, png)

      trimHtml(outDir, Number(cfg.keepHtml) || 30)
      const record = {
        at: Date.now(),
        trigger,
        seed: plan.seed,
        mood: plan.mood.key,
        background: plan.background,
        medium: plan.medium,
        composition: plan.composition,
        pose: plan.pose,
        objects: plan.objects,
        copy: plan.copy,
        png: pngPath,
        html: htmlPath,
        ms: Date.now() - started,
        plan,
      }
      const next = [record, ...history].slice(0, Math.max(10, Number(cfg.keepIndex) || 60))
      writeJsonAtomic(path.join(outDir, 'draw-index.json'), next)
      logger.info?.(`专注创作完成：${pngPath}（${record.ms}ms）`)
      return { ok: true, pngPath, htmlPath, plan, ms: record.ms }
    } catch (err) {
      if (err?.code !== 'CANCELLED') logger.warn?.(`专注创作失败：${err.message}`)
      try { if (fs.existsSync(htmlPath)) fs.rmSync(htmlPath, { force: true }) } catch { /* 忽略 */ }
      return { ok: false, reason: err?.code === 'CANCELLED' ? '已经停下' : err.message, cancelled: err?.code === 'CANCELLED' }
    } finally {
      try { if (page && server) await getHub()?.closeTab?.('draw') } catch { /* 忽略 */ }
      try { if (page && (!getHub()?.closeTab)) await page.cmd('Page.close') } catch { /* 忽略 */ }
      try { if (server) await server.close() } catch { /* 忽略 */ }
    }
  }

  function setGenerator({ llm, defaultModel } = {}) {
    copyWriter.attach({ llm, defaultModel })
  }

  return { preview, draw, setGenerator, copyWriter }
}

export { MOODS, OBJECTS }
