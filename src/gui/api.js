// ============================================================
// GUI 宿主半（04）
// 在 DSH 既有 web 服务上注册 /fish-dandan/api/*，不新开端口
// 只接受本机连接；所有写入复用模块层校验与安全闸门
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  buildPersonaSection,
  normalizePersona,
  PERSONA_TEXT_LIMITS,
  personaDraft,
  TRAIT_KEYS,
  TRAIT_LABELS,
  validatePersona,
} from '../persona/index.js'
import { parsePersonaCard, PERSONA_PROMPT_TEMPLATE } from '../persona/parse-card.js'
import { parseTune, applyTune } from '../persona/tune.js'
import { ensureOwnerAnchor } from '../persona/owner.js'
import { createPlatformSettings } from '../platform/settings.js'
import { fetchCommunityIndex, installPack } from '../stickers/remote.js'
import { deriveThresholds } from '../decision/affect.js'
import { safeOutput } from '../utils/safety.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { fromRoot } from '../utils/paths.js'
import { createStorageMaintenance } from '../storage/index.js'

const BASE = '/fish-dandan/api'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.join(HERE, 'web', 'index.html')
const ICON_FILE = path.join(HERE, '..', '..', 'assets', 'icon.png')

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * DSH 自己的请求门：Host / Origin 准入，再加上 dsh web 的浏览器登录检查。
 * 老宿主没有这个服务时返回 null，仍然走下面的本机 / 来源检查。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {((req: import('node:http').IncomingMessage) => number | undefined) | null}
 */
function resolveRequestGate(ctx) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  } catch {
    connection = undefined
  }
  const gate = connection?.requestRejection
  if (typeof gate !== 'function') return null
  return (req) => {
    try {
      return gate.call(connection, req)
    } catch {
      // 请求门自己出错时不能放行；按不受信任请求处理。
      return 403
    }
  }
}

/** DSH Desktop 的页面走 dsh-app:// 进程内桥接，不携带 dsh web 的登录 cookie。 */
function isDesktopHost(ctx) {
  try {
    return typeof ctx.get === 'function' && ctx.get('desktopProfiles') !== undefined
  } catch {
    return false
  }
}

function creativeFailStatus(code) {
  if (code === 'CREATIVE_STUDIO_NOT_INSTALLED') return 403
  if (code === 'CREATIVE_STUDIO_INVALID' || code === 'CREATIVE_STUDIO_UNSUPPORTED') return 409
  if (code === 'CREATIVE_STUDIO_BUSY' || code === 'CREATIVE_STUDIO_RUNTIME_NOT_READY') return 409
  if (code === 'PYTHON_NOT_FOUND' || code === 'PYTHON_VERSION_UNSUPPORTED' || code === 'PYTHON_DEPS_MISSING') return 503
  if (code === 'PIP_INSTALL_FAILED' || code === 'VENV_CREATE_FAILED') return 503
  if (code === 'LLM_UNAVAILABLE') return 503
  if (code === 'CREATIVE_BODY_TOO_LONG' || code === 'CREATIVE_COPY_INVALID' || code === 'CREATIVE_HOOK_TOO_LONG') return 422
  if (code === 'QA_FAILED') return 422
  return 500
}

function sendCreativeError(res, err, fallbackCode, fallbackMessage) {
  const code = err?.code || fallbackCode
  return fail(res, creativeFailStatus(code), code, err?.message || fallbackMessage)
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLoopbackAddress(address) {
  if (!address) return false
  return LOOPBACK.test(address)
}

/** Host 头必须是本机名：否则恶意域名解析到 127.0.0.1（DNS rebinding）就能冒充同源。 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false
  try {
    const url = new URL(`http://${hostHeader}`)
    return LOCAL_HOSTNAMES.has(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackOrigin(origin, hostHeader, { allowRemote = false } = {}) {
  // 先校验 Host：这一步挡住 DNS rebinding（恶意域名解析到 127.0.0.1 时 Host 是那个域名）
  const hostOk = hostHeader ? isLoopbackHost(hostHeader) : true
  if (!origin) return hostOk
  try {
    const url = new URL(origin)
    // 桌面端页面来自 file:// 或应用自有协议，页面本身由宿主加载，视为可信
    if (url.protocol === 'file:' || url.protocol === 'dsh-app:' || url.protocol === 'app:') return true
    if (LOCAL_HOSTNAMES.has(url.hostname)) return true
    // 同源请求：本机 Host 放行；非本机 Host 只有显式允许远程访问时才放行
    if (hostHeader && url.host === hostHeader) return hostOk || allowRemote
    return false
  } catch {
    return false
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let aborted = false
    const chunks = []
    req.on('data', (chunk) => {
      if (aborted) return
      size += chunk.length
      if (size > limit) {
        aborted = true
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BODY_INVALID' }))
      }
    })
    req.on('error', reject)
  })
}

function queryOf(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function publicMemory(record) {
  return {
    id: record.id,
    tier: record.tier,
    content: record.content,
    summary: record.summary,
    importance: record.importance,
    pinned: record.pinned,
    person: record.person,
    tags: record.tags,
    createdAt: record.createdAt,
    accessCount: record.accessCount,
    strength: Number((record.strength ?? 1).toFixed(3)),
    score: record.score,
    quarantine: record.quarantine,
    flags: record.flags,
  }
}

/**
 * 构建所有 API handler（与 HTTP 解耦，便于单测）。
 * @param {{ config: object, logger: object, persona: object, memory: object, decision: object }} deps
 */
export function createHandlers({ config, logger, persona, memory, decision, platforms, stickers, painter, characters, creativeStudio, storage, getUiUrl, actionRunner }) {
  const limit = config.gui.maxBodyBytes
  const wizardPath = fromRoot(config.gui.wizardPath)
  const platformSettings = createPlatformSettings({ config, logger })
  const storageMaintenance = storage || createStorageMaintenance({
    logger,
    getCreativeStudio: () => creativeStudio,
  })
  // 远程表情包索引：5 分钟缓存，避免前端反复点就反复打 GitHub
  let remoteIndexCache = { at: 0, data: null }
  // 整包下载任务：异步跑，前端轮询进度
  const installJobs = new Map()
  // 形象资源包下载任务：与表情包分开，避免状态混在一起
  const characterJobs = new Map()

  function publicCharacterJob(job) {
    if (!job) return null
    return {
      id: job.id,
      packId: job.packId,
      status: job.status,
      filesDone: job.filesDone,
      filesTotal: job.filesTotal,
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      speedBps: job.speedBps,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }
  }

  function activeCharacterJob(packId) {
    for (const job of characterJobs.values()) {
      if (job.packId === packId && job.status === 'running') return job
    }
    return null
  }

  function pruneCharacterJobs() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const [id, job] of characterJobs) {
      if (job.status !== 'running' && job.finishedAt && Date.parse(job.finishedAt) < cutoff) characterJobs.delete(id)
    }
  }

  function startCharacterJob(packId) {
    if (!characters) throw Object.assign(new Error('形象库未初始化'), { code: 'CHARACTERS_MISSING' })
    const existing = activeCharacterJob(packId)
    if (existing) return existing
    pruneCharacterJobs()
    const packInfo = characters.packById(packId)
    const job = {
      id: randomUUID(),
      packId,
      status: 'running',
      filesDone: 0,
      filesTotal: Number(packInfo?.fileCount) || 0,
      bytesDone: 0,
      bytesTotal: Number(packInfo?.totalBytes) || 0,
      speedBps: 0,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastAt: Date.now(),
      lastBytes: 0,
    }
    characterJobs.set(job.id, job)

    const tick = (progress) => {
      const now = Date.now()
      job.filesDone = Number(progress?.filesDone) || 0
      job.filesTotal = Number(progress?.filesTotal) || 0
      job.bytesDone = Number(progress?.bytesDone) || 0
      job.bytesTotal = Number(progress?.bytesTotal) || 0
      const elapsed = (now - job.lastAt) / 1000
      if (elapsed >= 0.5) {
        job.speedBps = Math.max(0, Math.round((job.bytesDone - job.lastBytes) / elapsed))
        job.lastAt = now
        job.lastBytes = job.bytesDone
      }
    }

    characters.installPack(packId, { onProgress: tick })
      .then(() => {
        job.status = 'done'
        job.finishedAt = new Date().toISOString()
        job.speedBps = 0
        job.filesDone = job.filesTotal || job.filesDone
        job.bytesDone = job.bytesTotal || job.bytesDone
        logger.info(`形象资源包下载完成：${packId}`)
      })
      .catch((err) => {
        job.status = 'failed'
        job.error = err.message
        job.finishedAt = new Date().toISOString()
        job.speedBps = 0
        logger.warn(`形象资源包下载失败：${packId}：${err.message}`)
      })
    return job
  }
  // 平台设置由 duty 在启动一轮时读取；不再把设置推给旧 browse 脚本。

  /** 运行时人格是否已和出厂模板不同（粗判：名字 / 一句话身份 / 来历任一不同）。 */
  function personaConfigured() {
    try {
      const draft = personaDraft(persona)
      const tpl = JSON.parse(fs.readFileSync(fromRoot(config.persona.templatePath), 'utf8'))
      return draft.identity.name !== tpl.identity.name
        || draft.identity.identitySummary !== tpl.identity.identitySummary
        || (draft.backstory || '') !== (tpl.backstory || '')
    } catch {
      return false
    }
  }

  /**
   * 向导完成标记：存 data/state/wizard.json，随其它状态一起留在本机、不入库。
   * 首次读取（文件不存在）时做一次自动补记：人格已被改过的老用户视为已完成，
   * 避免升级后向导退回第 1 步——这正是「关掉再打开就还原」问题的补丁。
   */
  function loadWizardState() {
    const saved = readJsonSafe(wizardPath, null, (err) => logger.warn(`向导状态读取失败：${err.message}`))
    if (saved && typeof saved.done === 'boolean') return { done: saved.done }
    const state = { done: personaConfigured() }
    try {
      writeJsonAtomic(wizardPath, state)
    } catch (err) {
      logger.warn(`向导状态写入失败：${err.message}`)
    }
    return state
  }

  function saveWizardState(done) {
    const state = { done: Boolean(done), updatedAt: Date.now() }
    try {
      writeJsonAtomic(wizardPath, state)
    } catch (err) {
      logger.warn(`向导状态写入失败：${err.message}`)
    }
    return state
  }

  function uiUrl() {
    try {
      return typeof getUiUrl === 'function' ? getUiUrl() : null
    } catch {
      return null
    }
  }

  const handlers = {
    '/wizard': async (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...loadWizardState() })
      if (req.method === 'PUT') {
        const body = await readBody(req, limit)
        if (!body || typeof body.done !== 'boolean') return fail(res, 400, 'BODY_INVALID', 'done 必须是布尔值')
        return sendJson(res, 200, { ok: true, ...saveWizardState(body.done) })
      }
      return fail(res, 405, 'METHOD', '只支持 GET / PUT')
    },

    '/overview': async (req, res) => {
      const d = decision.getInternalState()
      const stats = memory.stats()
      sendJson(res, 200, {
        ok: true,
        generatedAt: Date.now(),
        uiUrl: uiUrl(),
        persona: persona.summary(),
        memory: stats,
        decision: {
          state: d.state,
          label: d.label,
          vars: d.vars,
          since: d.since,
          reason: d.reason,
          lastAction: d.lastAction,
          scheduler: d.scheduler,
          override: d.override,
          pending: d.pending,
        },
        // ALMA 三层：性格 / 心情(PAD) / 情绪 / 影响因素 / 趋势历史
        affect: d.affect ?? null,
        // 首装引导要用：卡片和首页据此提示「还没配置」
        wizard: loadWizardState(),
        platforms: platforms?.status?.() ?? [],
        safety: { quarantined: stats.quarantined, rulesRef: persona.current().safety.safetyRulesRef },
        limits: { traits: TRAIT_KEYS, traitLabels: TRAIT_LABELS, text: PERSONA_TEXT_LIMITS },
      })
    },

    '/persona/tune': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body || typeof body.text !== 'string' || !body.text.trim()) return fail(res, 400, 'BODY_INVALID', '先说一句想怎么调')
      const draft = personaDraft(persona)
      const traits = { ...draft.personality.traits }
      const parsed = parseTune(body.text.slice(0, 200), traits, draft)
      // 联动预告：性格阈值由五维派生，改性格后这些线自动移动（只展示，不新增参数）
      const nextTraits = applyTune(traits, parsed.changes)
      const before = deriveThresholds(traits)
      const after = deriveThresholds(nextTraits)
      const LINK_LABELS = { explore: '觉得无聊的线', social: '想找人的线', create: '手痒的线', sleep: '撑不住的线' }
      const linkages = Object.keys(LINK_LABELS)
        .filter((k) => Number.isFinite(before[k]) && Number.isFinite(after[k]) && Math.round(after[k]) !== Math.round(before[k]))
        .map((k) => ({ key: k, label: LINK_LABELS[k], from: Math.round(before[k]), to: Math.round(after[k]), note: '性格改了它会自动跟着变，不用单独保存' }))
      // 可选调度提案：只在「想让它少说话」时给出，前端默认不勾，由用户决定
      const optional = []
      if (parsed.wantsLessChatter && decision) {
        const sched = decision.getInternalState().scheduler || {}
        const budget = Math.max(0, Math.round(Number(sched.dailyBudget ?? 8) || 0))
        const minutes = Math.round(Math.max(0, Number(sched.minIdleMs ?? 45 * 60000) || 0) / 60000)
        if (budget > 0) optional.push({ kind: 'schedule', key: 'dailyBudget', label: '每日唤醒预算', from: budget, to: Math.max(0, budget - 2), note: '一天最多主动醒几次；接到抖音 / QQ 后刷屏主要靠它压' })
        if (minutes < 1440) optional.push({ kind: 'schedule', key: 'minIdleMin', label: '最小空闲（分钟）', from: minutes, to: Math.min(1440, minutes + 15), note: '两次主动行为至少隔这么久' })
      }
      return sendJson(res, 200, { ok: true, changes: parsed.changes, linkages, optional, unknown: parsed.unknown, newTraits: nextTraits })
    },

    '/persona': async (req, res) => {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true, draft: personaDraft(persona), summary: persona.summary(),
          limits: PERSONA_TEXT_LIMITS, template: PERSONA_PROMPT_TEMPLATE,
        })
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, limit)
        if (!body || typeof body.draft !== 'object') return fail(res, 400, 'BODY_INVALID', '缺少 draft')
        try {
          const result = persona.save(body.draft, { actor: 'panel' })
          // 称呼变了，主人锚点跟着换（旧锚点归档，不留两条打架）
          try { ensureOwnerAnchor(memory, persona.current(), { logger }) } catch { /* 记忆不可用时忽略 */ }
          // 人格改过就等于「认识过了」：否则向导完成态与人格页永远对不上
          try { saveWizardState(true) } catch { /* 写不了标记也不挡保存 */ }
          return sendJson(res, 200, { ok: true, changed: result.changed, summary: persona.summary() })
        } catch (err) {
          if (err.code === 'PERSONA_INVALID') return fail(res, 400, 'PERSONA_INVALID', err.message)
          logger.error(`人格保存失败：${err.message}`)
          return fail(res, 500, 'SAVE_FAILED', '保存失败，详情见日志')
        }
      }
      return fail(res, 405, 'METHOD', '只支持 GET / PUT')
    },

    '/persona/parse': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body || typeof body.text !== 'string') return fail(res, 400, 'BODY_INVALID', '缺少 text')
      const result = parsePersonaCard(body.text.slice(0, 8000), personaDraft(persona))
      return sendJson(res, 200, { ok: true, ...result })
    },

    '/persona/preview': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body || typeof body.draft !== 'object') return fail(res, 400, 'BODY_INVALID', '缺少 draft')
      const check = validatePersona(body.draft)
      const { persona: normalized, issues } = normalizePersona(body.draft)
      let evolved = null
      try {
        evolved = memory.getEvolvedTraits()
      } catch {
        evolved = null
      }
      sendJson(res, 200, {
        ok: true,
        valid: check.ok,
        problems: check.issues,
        issues,
        text: buildPersonaSection(normalized, evolved),
      })
    },

    // ---- 表情包库：跨平台共享；库本身不内置任何素材 ----
    '/stickers': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const params = queryOf(req)
      const q = (params.get('q') || '').slice(0, 60)
      const pageSize = Math.min(100, Math.max(1, Math.round(Number(params.get('limit')) || 60)))
      const offset = Math.max(0, Math.round(Number(params.get('offset')) || 0))
      const result = stickers.list({ q, limit: pageSize, offset })
      return sendJson(res, 200, { ok: true, q, offset, limit: pageSize, ...result, stats: stickers.stats() })
    },

    '/stickers/enrich': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
        return fail(res, 405, 'METHOD', '只支持 GET / POST / DELETE')
      }
      // GET 只读进度；POST 把缺图义的图排进后台队列，立即返回，不在请求里等模型；DELETE 中途停止。
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, stats: stickers.stats() })
      if (req.method === 'DELETE') {
        const stopped = typeof stickers.stopCaptioning === 'function'
          ? stickers.stopCaptioning()
          : { stopped: 0, active: 0 }
        return sendJson(res, 200, { ok: true, ...stopped, stats: stickers.stats() })
      }
      const result = stickers.enrichMissing({ limit: 0 })
      return sendJson(res, 200, { ok: true, ...result, stats: stickers.stats() })
    },

    '/stickers/file': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD', '只支持 GET')
      const id = (queryOf(req).get('id') || '').slice(0, 40)
      const file = stickers.filePath(id)
      if (!file) return fail(res, 404, 'NOT_FOUND', '这张表情不在库里')
      const buf = fs.readFileSync(file)
      res.writeHead(200, {
        'content-type': stickers.mimeOf(id),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-length': buf.length,
      })
      if (req.method === 'HEAD') res.end()
      else res.end(buf)
    },

    '/stickers/upload': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      // 图片 base64 会到几 MB，单独放宽一点；仍然只允许本机回环 + 可信来源
      const body = await readBody(req, Math.max(limit, 12 * 1024 * 1024))
      if (!body || typeof body !== 'object') return fail(res, 400, 'BODY_INVALID', '请求体不合法')
      try {
        const result = await stickers.upload({
          dataBase64: body.dataBase64, name: body.name,
          tags: body.tags, emotion: body.emotion, caption: body.caption, packId: body.packId,
        })
        return sendJson(res, 200, { ok: true, ...result, stats: stickers.stats() })
      } catch (err) {
        return fail(res, 400, 'STICKER_INVALID', err.message)
      }
    },

    '/stickers/import': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.url) return fail(res, 400, 'BODY_INVALID', '缺少 url')
      try {
        const result = await stickers.importUrl(body.url, {
          tags: body.tags, emotion: body.emotion, caption: body.caption, packId: body.packId, license: body.license,
        })
        return sendJson(res, 200, { ok: true, ...result, stats: stickers.stats() })
      } catch (err) {
        return fail(res, 400, 'STICKER_IMPORT_FAILED', err.message)
      }
    },

    '/stickers/meta': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.id) return fail(res, 400, 'BODY_INVALID', '缺少 id')
      const result = stickers.updateMeta(body.id, {
        caption: body.caption,
        tags: body.tags,
        emotion: body.emotion,
        intents: body.intents,
        avoid: body.avoid,
        confidence: body.confidence,
      })
      if (!result.ok) return fail(res, 404, 'NOT_FOUND', result.reason || '不在库里')
      return sendJson(res, 200, { ok: true, ...result, stats: stickers.stats() })
    },

    '/stickers/delete': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.id) return fail(res, 400, 'BODY_INVALID', '缺少 id')
      const result = stickers.remove(body.id)
      if (!result.ok) return fail(res, 404, 'NOT_FOUND', result.reason || '不在库里')
      return sendJson(res, 200, { ok: true, ...result, stats: stickers.stats() })
    },

    // ---- 远程表情包：从 AstrBot 社区索引整包安装 ----
    '/stickers/remote': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const params = queryOf(req)
      const customUrl = (params.get('url') || '').slice(0, 500)
      const refresh = params.get('refresh') === '1'
      try {
        let index
        if (!customUrl && !refresh && remoteIndexCache.data && Date.now() - remoteIndexCache.at < 5 * 60_000) {
          index = remoteIndexCache.data
        } else {
          index = await fetchCommunityIndex(customUrl ? { url: customUrl } : {})
          if (!customUrl) remoteIndexCache = { at: Date.now(), data: index }
        }
        // 合并本地已装状态：界面上直接标「已安装 · N 张」
        const local = new Map((stickers.stats().packsList || []).map((p) => [p.id, p]))
        const packs = index.packs.map((p) => {
          const hit = local.get(p.id)
          return {
            ...p,
            installed: Boolean(hit),
            installedCount: hit ? hit.count : 0,
            installedAt: hit ? hit.installedAt : null,
          }
        })
        return sendJson(res, 200, { ok: true, cached: Boolean(!customUrl && remoteIndexCache.data && Date.now() - remoteIndexCache.at < 5 * 60_000), ...index, packs, stats: stickers.stats() })
      } catch (err) {
        return fail(res, 502, 'INDEX_FAILED', `拉取远程索引失败：${err.message}`)
      }
    },

    '/stickers/install': async (req, res) => {
      if (!stickers) return fail(res, 409, 'STICKERS_UNAVAILABLE', '表情包库没初始化')
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.repo) return fail(res, 400, 'BODY_INVALID', '缺少 repo（owner/repo）')
      const repo = String(body.repo)
      const ref = String(body.ref || 'main')
      const subpath = String(body.subpath || '.')
      const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const job = {
        id: jobId, repo, ref, subpath, status: 'running',
        startedAt: Date.now(), finishedAt: null, done: 0, total: 0,
        added: 0, duplicate: 0, skipped: 0, error: '', pack: null,
      }
      installJobs.set(jobId, job)
      // 只留最近 20 个任务，避免内存里一直堆
      if (installJobs.size > 20) {
        for (const key of installJobs.keys()) {
          if (key !== jobId) { installJobs.delete(key); if (installJobs.size <= 20) break }
        }
      }
      installPack({
        repo, ref, subpath, library: stickers, logger,
        onProgress: (p) => Object.assign(job, {
          done: p.done, total: p.total, added: p.added, duplicate: p.duplicate, skipped: p.skipped,
        }),
      }).then((r) => {
        Object.assign(job, {
          status: 'done', finishedAt: Date.now(), added: r.added, duplicate: r.duplicate,
          skipped: r.skipped, total: r.total, pack: r.pack,
        })
        logger.info(`表情包安装完成：${repo} 新增 ${r.added}，重复 ${r.duplicate}，跳过 ${r.skipped}`)
      }).catch((err) => {
        Object.assign(job, { status: 'failed', finishedAt: Date.now(), error: err.message })
        logger.warn(`整包安装失败 ${repo}：${err.message}`)
      })
      return sendJson(res, 200, { ok: true, jobId, job })
    },

    '/stickers/install/status': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const id = (queryOf(req).get('id') || '').slice(0, 80)
      const job = installJobs.get(id)
      if (!job) return fail(res, 404, 'NOT_FOUND', '这个下载任务不存在（可能已完成并被清理）')
      return sendJson(res, 200, { ok: true, job, stats: stickers ? stickers.stats() : null })
    },

    '/stickers/install/jobs': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      return sendJson(res, 200, { ok: true, jobs: [...installJobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10) })
    },

    '/platform/settings': async (req, res) => {
      if (!platformSettings) return fail(res, 409, 'UNAVAILABLE', '平台设置存储未初始化')
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, settings: platformSettings.get() })
      if (req.method === 'PUT') {
        const body = await readBody(req, limit)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'BODY_INVALID', '请求体要是对象')
        try {
          const settings = platformSettings.patch(body)
          // 私信监听跟着开关走：开=开共享浏览器里的监听标签页，关=只关这个标签
          try { platforms?.getAdapter?.('douyin')?.inbox?.apply?.('settings') } catch { /* 忽略 */ }
          // 回评论同样只动自己的标签页，不和私信监听共用一个 kind
          try { await platforms?.getAdapter?.('douyin')?.comments?.apply?.('settings') } catch { /* 忽略 */ }
          return sendJson(res, 200, { ok: true, settings })
        } catch (err) {
          logger.warn(`平台设置保存失败：${err.message}`)
          return fail(res, 500, 'SAVE_FAILED', '设置没能保存到本机文件')
        }
      }
      return fail(res, 405, 'METHOD', '只支持 GET / PUT')
    },

    // 它做过什么：只读流水账，没有审批语义
    '/platforms/douyin/journal': async (req, res) => {
      const j = platforms?.getAdapter?.('douyin')?.journal
      if (!j) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const limit = Math.min(200, Math.max(1, Math.round(Number(queryOf(req).get('limit')) || 40)))
      return sendJson(res, 200, { ok: true, items: j.list(limit), counts: j.counts() })
    },

    // 操作手册：每个动作在哪、怎么点、备用方案（每次值班前注入给它的提示词）
    '/platforms/douyin/playbook': async (req, res) => {
      const file = fromRoot('prompts/douyin-playbook.md')
      if (req.method === 'GET') {
        try {
          const text = fs.readFileSync(file, 'utf8')
          return sendJson(res, 200, { ok: true, text, path: 'prompts/douyin-playbook.md' })
        } catch (err) {
          return fail(res, 500, 'READ_FAILED', err.message)
        }
      }
      if (req.method === 'POST') {
        const body = await readBody(req, limit)
        const text = String(body?.text ?? '')
        if (!text.trim()) return fail(res, 400, 'BODY_INVALID', '内容不能为空')
        if (text.length > 30000) return fail(res, 400, 'TOO_LONG', '太长了（上限 3 万字）')
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, text, 'utf8')
          return sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8') })
        } catch (err) {
          return fail(res, 500, 'WRITE_FAILED', err.message)
        }
      }
      return fail(res, 405, 'METHOD', '只支持 GET / POST')
    },
    // 值班剧本：像 agent-md 那样，把它的行为准则做成可见可改的 Markdown
    '/platforms/douyin/guidelines': async (req, res) => {
      const file = fromRoot('prompts/douyin-duty.md')
      if (req.method === 'GET') {
        try {
          const text = fs.readFileSync(file, 'utf8')
          return sendJson(res, 200, { ok: true, text, path: 'prompts/douyin-duty.md' })
        } catch (err) {
          return fail(res, 500, 'READ_FAILED', err.message)
        }
      }
      if (req.method === 'POST') {
        const body = await readBody(req, limit)
        const text = String(body?.text ?? '')
        if (!text.trim()) return fail(res, 400, 'BODY_INVALID', '内容不能为空')
        if (text.length > 20000) return fail(res, 400, 'TOO_LONG', '太长了（上限 2 万字）')
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, text, 'utf8')
          return sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8') })
        } catch (err) {
          return fail(res, 500, 'WRITE_FAILED', err.message)
        }
      }
      return fail(res, 405, 'METHOD', '只支持 GET / POST')
    },

    // 私信监听：收件箱列表与监听状态（被动回复归监听，值班不读这个队列）
    '/platforms/douyin/inbox': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const inbox = platforms?.getAdapter?.('douyin')?.inbox
      if (!inbox) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      try {
        return sendJson(res, 200, { ok: true, ...inbox.snapshot() })
      } catch (err) {
        return fail(res, 500, 'INBOX_FAILED', err.message)
      }
    },

    // 批准 / 忽略一条待回复私信
    '/platforms/douyin/inbox/decide': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const inbox = platforms?.getAdapter?.('douyin')?.inbox
      if (!inbox) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      const body = await readBody(req, limit)
      const id = String(body?.id || '').slice(0, 80)
      const status = body?.status === 'approved' ? 'approved' : body?.status === 'ignored' ? 'ignored' : ''
      if (!id || !status) return fail(res, 400, 'BODY_INVALID', '需要 id 和 status（approved / ignored）')
      const ok = inbox.decide(id, status)
      if (!ok) return fail(res, 404, 'NOT_FOUND', '队列里没有这条私信')
      return sendJson(res, 200, { ok: true, ...inbox.snapshot() })
    },

    '/platforms/douyin/listen': async (req, res) => {
      const adapter = platforms?.getAdapter?.('douyin')
      const inbox = adapter?.inbox
      if (!inbox) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...inbox.snapshot() })
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 GET / POST')
      const body = await readBody(req, limit)
      const patch = {}
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
      if (typeof body?.autoReply === 'boolean') patch.autoReply = body.autoReply
      // 旧 scope 接口保留兼容，但后端现在固定所有人自动回，不再做排队。
      if (body?.scope === 'all' || body?.scope === 'owner') patch.scope = body.scope
      if (Array.isArray(body?.memoryAllow)) patch.memoryAllow = body.memoryAllow
      if (typeof body?.ownerName === 'string') patch.ownerName = body.ownerName.slice(0, 40)
      if (typeof body?.ownerId === 'string') patch.ownerId = body.ownerId.slice(0, 40)
      if (body?.intervalSec !== undefined) patch.intervalSec = Math.max(3, Math.min(600, Number(body.intervalSec) || 3))
      if (typeof body?.showWindow === 'boolean') patch.showWindow = body.showWindow
      if (!Object.keys(patch).length) return fail(res, 400, 'BODY_INVALID', '没有要改的项')
      try {
        platformSettings.patch({ douyin: { listen: patch } })
      } catch (err) {
        return fail(res, 500, 'SAVE_FAILED', `设置没存下来：${err.message}`)
      }
      const applied = inbox.apply?.('toggle') || { ok: true }
      return sendJson(res, 200, { ok: true, applied, ...inbox.snapshot() })
    },

    '/platforms/douyin/comments': async (req, res) => {
      const adapter = platforms?.getAdapter?.('douyin')
      const comments = adapter?.comments
      if (!comments) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...comments.snapshot() })
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 GET / POST')
      const body = await readBody(req, limit)
      if (typeof body?.enabled !== 'boolean') return fail(res, 400, 'BODY_INVALID', '需要 enabled（true / false）')
      try {
        platformSettings.patch({ douyin: { comments: { enabled: body.enabled } } })
      } catch (err) {
        return fail(res, 500, 'SAVE_FAILED', `设置没存下来：${err.message}`)
      }
      const applied = await comments.apply?.('toggle') || { ok: true }
      return sendJson(res, 200, { ok: true, applied, ...comments.snapshot() })
    },

    '/platforms/douyin/browse': async (req, res) => {
      const adapter = platforms?.getAdapter?.('douyin')
      if (!adapter || typeof adapter.startRound !== 'function' || typeof adapter.roundSnapshot !== 'function') {
        return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      }
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...adapter.roundSnapshot() })
      if (req.method === 'POST') {
        const r = actionRunner
          ? actionRunner.start('explore', { trigger: 'manual' })
          : adapter.startRound('manual', { task: 'explore', owner: 'manual' })
        return sendJson(res, 200, {
          ok: true,
          started: r.ok,
          reason: r.reason || '',
          activity: r.activity || actionRunner?.snapshot?.() || null,
          ...adapter.roundSnapshot(),
        })
      }
      return fail(res, 405, 'METHOD', '只支持 GET / POST')
    },

    '/platforms/douyin/browse/stop': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const adapter = platforms?.getAdapter?.('douyin')
      if (!adapter || typeof adapter.stopRound !== 'function' || typeof adapter.roundSnapshot !== 'function') {
        return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      }
      const r = actionRunner && ['explore', 'social'].includes(actionRunner.snapshot?.()?.kind)
        ? await actionRunner.stop('manual')
        : adapter.stopRound('manual')
      return sendJson(res, 200, {
        ok: true,
        stopped: r.ok,
        reason: r.reason || '',
        activity: actionRunner?.snapshot?.() || null,
        ...adapter.roundSnapshot(),
      })
    },

    '/platforms/douyin/cancel': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const flow = platforms?.getAdapter?.('douyin')?.login
      if (!flow) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      return sendJson(res, 200, { ok: true, ...(flow.cancel ? flow.cancel() : flow.snapshot()) })
    },

    '/platforms/douyin/session': async (req, res) => {
      const snap = platforms?.getAdapter?.('douyin')?.login?.snapshot?.()
        ?? { phase: 'idle', exists: false, status: 'planned', detail: '适配器未注册' }
      return sendJson(res, 200, { ok: true, ...snap })
    },

    '/platforms/douyin/login': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const flow = platforms?.getAdapter?.('douyin')?.login
      if (!flow) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      const snap = flow.start()
      return sendJson(res, 200, { ok: true, ...snap })
    },

    '/platforms/douyin/logout': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const flow = platforms?.getAdapter?.('douyin')?.login
      if (!flow) return fail(res, 409, 'ADAPTER_MISSING', '抖音适配器未注册')
      await flow.logout()
      return sendJson(res, 200, { ok: true, ...flow.snapshot() })
    },

    '/platforms': async (req, res) => {
      sendJson(res, 200, {
        ok: true,
        enabled: config.platforms.enabled,
        items: platforms?.status?.() ?? [],
      })
    },

    '/decision/action': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      const kind = String(body?.kind || '').trim()
      if (!['explore', 'social', 'create'].includes(kind)) {
        return fail(res, 400, 'ACTION_INVALID', '动作只能是 explore / social / create')
      }
      if (!actionRunner || typeof actionRunner.start !== 'function') {
        return fail(res, 409, 'NO_RUNNER', '行为执行器未注册')
      }
      let result
      try {
        // 手动触发是主人明确下令：不经过策略三档，也不占自动调度的单类次数。
        result = actionRunner.start(kind, { trigger: 'manual' })
      } catch (err) {
        logger.warn(`手动触发 ${kind} 失败：${err.message}`)
        return fail(res, 500, 'EXECUTE_FAILED', err.message)
      }
      return sendJson(res, 200, {
        ok: true,
        kind,
        started: Boolean(result?.ok),
        reason: result?.reason || '',
        activity: result?.activity || actionRunner.snapshot?.() || null,
        state: decision.getInternalState(),
      })
    },

    '/pending/approve': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.id) return fail(res, 400, 'BODY_INVALID', '缺少 id')
      const item = decision.takePending(String(body.id))
      if (!item) return fail(res, 404, 'NOT_FOUND', '这条待确认动作已经不存在')
      let result
      try {
        // 新计划带具体 executor / payload：交给 ActionRunner，真正去刷、去聊或去画。
        if (actionRunner && item.plan?.executor) {
          result = actionRunner.start(item.plan.kind, { trigger: 'approval', pending: item })
        } else {
          result = await platforms.execute(item.plan, { approved: true })
        }
      } catch (err) {
        // 执行抛错时放回队列：以前是直接丢掉，用户以为点了、其实没了
        try { decision.restorePending?.(item) } catch { /* 忽略 */ }
        logger.warn(`待确认动作执行失败，已放回队列：${err.message}`)
        return fail(res, 500, 'EXECUTE_FAILED', '执行失败，动作已放回队列')
      }
      // 启动失败（权限没开、适配器没起来）也要把卡片放回去，别让主人以为它去做了。
      if (result && result.ok === false) {
        try { decision.restorePending?.(item) } catch { /* 忽略 */ }
      }
      try {
        memory.recordEvent(
          {
            content: `人工确认执行「${item.plan?.text ?? item.label}」：${result.ok ? '已启动' : `未执行（${result.reason || '未知原因'}）`}`,
            importance: 4,
            tags: ['decision', 'approval', item.state].filter(Boolean),
            summary: item.label,
          },
          'gui:approve',
        )
      } catch (err) {
        logger.warn(`执行结果写入记忆失败：${err.message}`)
      }
      sendJson(res, 200, { ok: true, result, item: { id: item.id, label: item.label } })
    },

    '/pending/ignore': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.id) return fail(res, 400, 'BODY_INVALID', '缺少 id')
      const r = decision.ignorePending(String(body.id))
      if (!r.ok) return fail(res, 404, 'NOT_FOUND', r.reason || '这条待确认动作已经不存在')
      return sendJson(res, 200, { ok: true })
    },

    '/decision/policy': async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'PUT') return fail(res, 405, 'METHOD', '只支持 POST / PUT')
      const body = await readBody(req, limit)
      if (!body || typeof body !== 'object') return fail(res, 400, 'BODY_INVALID', '缺少策略')
      const r = decision.updatePolicy(body)
      if (!r.ok) return fail(res, 400, 'POLICY_INVALID', r.reason || '策略值不合法')
      return sendJson(res, 200, { ok: true, ...r, state: decision.getInternalState() })
    },

    '/decision/activity/stop': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!actionRunner) {
        const adapter = platforms?.getAdapter?.('douyin')
        if (adapter?.stopRound) {
          const r = adapter.stopRound('gui')
          return sendJson(res, 200, { ok: true, stopped: r.ok, reason: r.reason || '', activity: null })
        }
        return fail(res, 409, 'NO_RUNNER', '行为执行器未注册')
      }
      const r = await actionRunner.stop('gui')
      return sendJson(res, 200, { ok: true, stopped: r.ok, reason: r.reason || '', activity: actionRunner.snapshot(), state: decision.getInternalState() })
    },

    // 创作插件（dandan-creative-studio）：发现、本地登记、运行环境与图文渲染。
    // 自动发布目前只负责用共享浏览器打开创作者中心；上传、填文案和点发布还没接。
    '/creative-studio': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      if (!creativeStudio || typeof creativeStudio.status !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      try {
        return sendJson(res, 200, { ok: true, ...creativeStudio.status() })
      } catch (err) {
        logger.warn(`创作插件状态读取失败：${err.message}`)
        return fail(res, 500, 'CREATIVE_STUDIO_STATUS_FAILED', '创作插件状态读取失败，详情见日志')
      }
    },

    // 发布身份：昵称与头像只影响作品左上角，不写入插件目录。
    '/creative-studio/account': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.saveAccount !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      const body = await readBody(req, limit)
      try {
        const result = creativeStudio.saveAccount(body?.handle)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        logger.warn(`发布身份保存失败：${err?.code || 'UNKNOWN'} ${err?.message || err}`)
        return sendCreativeError(res, err, 'ACCOUNT_SAVE_FAILED', '发布身份保存失败')
      }
    },

    '/creative-studio/account-avatar': async (req, res) => {
      if (!creativeStudio || typeof creativeStudio.accountAvatarFile !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = creativeStudio.accountAvatarFile()
        if (!file) return fail(res, 404, 'NOT_FOUND', '还没有设置发布头像')
        let buf
        try { buf = fs.readFileSync(file) } catch (err) {
          logger.warn(`发布头像读取失败：${err.message}`)
          return fail(res, 404, 'NOT_FOUND', '发布头像暂时读不出来')
        }
        res.writeHead(200, {
          'content-type': creativeStudio.accountAvatarMime?.() || 'image/png',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-length': buf.length,
        })
        if (req.method === 'HEAD') res.end()
        else res.end(buf)
        return
      }
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 GET/HEAD/POST')
      if (typeof creativeStudio.saveAvatar !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      let body
      try {
        body = await readBody(req, Math.max(limit, 96 * 1024 * 1024))
      } catch (err) {
        if (err?.code === 'BODY_TOO_LARGE') return fail(res, 413, 'BODY_TOO_LARGE', '头像太大，换一张小一点的图')
        throw err
      }
      try {
        const result = creativeStudio.saveAvatar(body?.dataBase64)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const status = err?.code === 'AVATAR_TOO_LARGE' ? 413 : 400
        return fail(res, status, err?.code || 'AVATAR_SAVE_FAILED', err.message || '发布头像保存失败')
      }
    },

    // 只扫描本机 Python 版本和路径；不下载、不安装、不执行插件代码。
    '/creative-studio/detect-python': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.detectPython !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      try {
        const detection = await creativeStudio.detectPython()
        return sendJson(res, 200, { ok: true, detection })
      } catch (err) {
        logger.warn(`Python 检测失败：${err?.code || 'UNKNOWN'} ${err?.message || err}`)
        return sendCreativeError(res, err, 'PYTHON_DETECT_FAILED', 'Python 检测失败')
      }
    },

    // 本地安装只登记目录，不复制文件、不改原项目、不执行插件代码。
    '/creative-studio/install-local': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.installLocal !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      const body = await readBody(req, limit)
      try {
        const result = creativeStudio.installLocal(String(body?.path || '').slice(0, 1024))
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const code = err?.code || 'LOCAL_INSTALL_FAILED'
        return fail(res, 400, code, err.message || '本地安装失败')
      }
    },

    // 从 GitHub 浅克隆到平台插件目录；只拉代码，不执行仓库里的代码。
    '/creative-studio/install-github': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.installGithub !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      let clientGone = false
      const cancelIfClientGone = () => {
        if (clientGone) return
        clientGone = true
        try { creativeStudio.cancelGithubInstall?.() } catch { /* 已结束或尚未开始 */ }
      }
      req.on('aborted', cancelIfClientGone)
      res.on('close', () => {
        if (!res.writableEnded) cancelIfClientGone()
      })
      const body = await readBody(req, limit)
      try {
        const result = await creativeStudio.installGithub(String(body?.repository || body?.url || '').slice(0, 2048))
        if (res.destroyed) return
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        if (res.destroyed) return
        const code = err?.code || 'GITHUB_INSTALL_FAILED'
        return fail(res, 400, code, err.message || 'GitHub 安装失败')
      }
    },

    // 取消正在进行的 GitHub 拉取；只清临时目录，不碰已有安装。
    '/creative-studio/install-cancel': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.cancelGithubInstall !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      try {
        const result = creativeStudio.cancelGithubInstall()
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const code = err?.code || 'INSTALL_CANCEL_FAILED'
        return fail(res, 400, code, err.message || '取消安装失败')
      }
    },

    // 卸载当前插件：本地版只删登记，GitHub 版删平台管理的副本。
    '/creative-studio/uninstall': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.uninstall !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      try {
        const result = creativeStudio.uninstall()
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const code = err?.code || 'UNINSTALL_FAILED'
        return fail(res, 400, code, err.message || '卸载失败')
      }
    },

    // 为插件准备隔离的 Python venv；只在用户点击后执行，不在状态查询时装依赖。
    '/creative-studio/prepare-runtime': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.prepareRuntime !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      try {
        const result = await creativeStudio.prepareRuntime()
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        return sendCreativeError(res, err, 'RUNTIME_PREPARE_FAILED', '依赖安装失败')
      }
    },

    // 调试入口：只打开创作者中心上传页，不上传、不填文案、不点发布。
    // 页面上的「自动发布」已改走下面的完整接口；这里保留给排查浏览器/登录。
    '/creative-studio/publish-browser': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const browser = platforms?.getAdapter?.('douyin')?.publishBrowser
      if (!browser || typeof browser.open !== 'function') {
        return fail(res, 409, 'DOUYIN_BROWSER_MISSING', '抖音共享浏览器还没准备好')
      }
      try {
        const result = await browser.open()
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        logger.warn(`打开抖音创作者中心失败：${err.message}`)
        return fail(res, 500, 'PUBLISH_BROWSER_FAILED', '没能打开抖音创作者中心，确认浏览器和登录态正常')
      }
    },

    // 完整自动发布：当前作品图 → 发布图文 → 标题/正文 → 推荐第一首音乐 → 发布。
    // 失败时浏览器不关，停在哪一步就留给用户检查。
    '/creative-studio/publish-image-post': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const browser = platforms?.getAdapter?.('douyin')?.publishBrowser
      if (!browser || typeof browser.publish !== 'function') {
        return fail(res, 409, 'DOUYIN_BROWSER_MISSING', '抖音共享浏览器还没准备好')
      }
      if (!creativeStudio || typeof creativeStudio.publication !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      let payload
      try {
        payload = creativeStudio.publication()
      } catch (err) {
        const code = err?.code || 'CREATIVE_NO_WORK'
        return fail(res, 409, code, err.message || '当前没有作品，先做一张图文')
      }
      try {
        const result = await browser.publish({
          imagePath: payload.imagePath,
          title: payload.title,
          body: payload.body,
          music: 'recommended',
          visibility: 'public',
          extraRoots: [payload.outputDir],
        })
        return sendJson(res, 200, {
          ok: true,
          url: result.url || '',
          reviewing: Boolean(result.reviewing),
          music: result.music || '',
          images: result.images || 1,
          seconds: result.seconds || 0,
        })
      } catch (err) {
        logger.warn(`自动发布失败：${err.message}`)
        return fail(res, 502, 'PUBLISH_FAILED', err.message || '发布没有完成，去浏览器里看停在哪一步')
      }
    },

    // 按蛋蛋当前心情生成一张图文；只渲染，不进入发布队列。
    '/creative-studio/render-image-post': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!creativeStudio || typeof creativeStudio.renderImagePost !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      try {
        const result = await creativeStudio.renderImagePost()
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        return sendCreativeError(res, err, 'CREATIVE_STUDIO_RENDER_FAILED', '图文生成失败')
      }
    },

    // 只读创作工作室返回的、最近一次结果的图片；不按宿主导出目录去猜。
    '/creative-studio/file': async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD', '只支持 GET/HEAD')
      const job = String(queryOf(req).get('job') || '').trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(job) || job === '.' || job === '..') {
        return fail(res, 400, 'BAD_JOB', 'job 不是合法的任务 ID')
      }
      if (!creativeStudio || typeof creativeStudio.imageFor !== 'function') {
        return fail(res, 409, 'CREATIVE_STUDIO_MISSING', '创作插件宿主接口未初始化')
      }
      const file = creativeStudio.imageFor(job)
      if (!file) return fail(res, 404, 'NOT_FOUND', '这张图不在创作工作室的结果里')
      let buf
      try { buf = fs.readFileSync(file) } catch (err) {
        logger.warn(`创作图文读取失败：${err.message}`)
        return fail(res, 404, 'NOT_FOUND', '这张图暂时读不出来')
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-length': buf.length,
      })
      if (req.method === 'HEAD') res.end()
      else res.end(buf)
    },

    // 豆包桌面版做图：开关打开才允许操作本机豆包
    '/image/status': async (req, res) => {
      if (!painter) return fail(res, 409, 'PAINTER_MISSING', '生图适配器未注册')
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      try {
        return sendJson(res, 200, { ok: true, ...(await painter.status()) })
      } catch (err) {
        return fail(res, 500, 'STATUS_FAILED', err.message)
      }
    },

    '/image/paint': async (req, res) => {
      if (!painter) return fail(res, 409, 'PAINTER_MISSING', '生图适配器未注册')
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      const prompt = String(body?.prompt || '').trim().slice(0, 500)
      if (!prompt) return fail(res, 400, 'BODY_INVALID', '缺少 prompt')
      const refPath = String(body?.refPath || '').trim().slice(0, 500)
      try {
        const r = await painter.paint({ prompt, refPath })
        return sendJson(res, 200, { ok: Boolean(r.ok), ...r })
      } catch (err) {
        return fail(res, 500, 'PAINT_FAILED', err.message)
      }
    },

    '/image/list': async (req, res) => {
      if (!painter) return fail(res, 409, 'PAINTER_MISSING', '生图适配器未注册')
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const n = Math.min(50, Math.max(1, Math.round(Number(queryOf(req).get('limit')) || 12)))
      const base = path.resolve(painter.imagesDir || 'data/images')
      const items = painter.list(n).map((it) => ({
        name: path.relative(base, it.file).replace(/\\/g, '/'),
        at: it.at,
      }))
      return sendJson(res, 200, { ok: true, items })
    },

    // 最近画过的图：只允许读 data/images 里面的文件
    '/image/file': async (req, res) => {
      if (!painter) return fail(res, 409, 'PAINTER_MISSING', '生图适配器未注册')
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD', '只支持 GET')
      const name = (queryOf(req).get('name') || '').slice(0, 300)
      if (!name || name.includes('..') || path.isAbsolute(name) || /[\\:]/.test(name)) {
        return fail(res, 400, 'PATH_INVALID', '文件名不合法')
      }
      const base = path.resolve(painter.imagesDir || 'data/images')
      const file = path.resolve(base, name)
      if (!file.startsWith(base + path.sep)) return fail(res, 403, 'FORBIDDEN', '只能看画图目录里的图')
      let buf
      try {
        buf = fs.readFileSync(file)
      } catch {
        return fail(res, 404, 'NOT_FOUND', '这张图不在了')
      }
      res.writeHead(200, {
        'content-type': /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
        'content-length': buf.length,
      })
      if (req.method === 'HEAD') res.end()
      else res.end(buf)
    },

    // ==========================================================
    // 形象库：缩略图永远可看；原图只有本机安装完成才可读
    // ==========================================================

    '/characters': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const data = characters.state()
      if (data.pack) data.pack.activeJob = publicCharacterJob(activeCharacterJob(data.pack.id))
      return sendJson(res, 200, data)
    },

    '/characters/packs': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const packs = characters.listPacks().map((pack) => ({
        ...pack,
        activeJob: publicCharacterJob(activeCharacterJob(pack.id)),
      }))
      return sendJson(res, 200, { ok: true, packs })
    },

    '/characters/packs/install': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const body = await readBody(req, limit)
      const packId = String(body?.packId || 'dandan-initial').trim().slice(0, 64)
      if (!characters.packById(packId)) return fail(res, 404, 'PACK_NOT_FOUND', '没有这个资源包')
      const job = startCharacterJob(packId)
      return sendJson(res, 202, { ok: true, jobId: job.id, job: publicCharacterJob(job) })
    },

    '/characters/packs/status': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      const id = (queryOf(req).get('id') || '').trim()
      if (!id) return fail(res, 400, 'BODY_INVALID', '缺少任务 id')
      const job = characterJobs.get(id)
      if (!job) return fail(res, 404, 'JOB_NOT_FOUND', '下载任务不存在或已过期')
      return sendJson(res, 200, { ok: true, job: publicCharacterJob(job) })
    },

    '/characters/packs/remove': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const body = await readBody(req, limit)
      const packId = String(body?.packId || 'dandan-initial').trim().slice(0, 64)
      const active = activeCharacterJob(packId)
      if (active) return fail(res, 409, 'PACK_BUSY', '资源包正在下载，先等下载完成')
      try {
        const data = await characters.removePack(packId)
        return sendJson(res, 200, data)
      } catch (err) {
        if (err?.code === 'PACK_LOCKED') return fail(res, 409, 'PACK_LOCKED', err.message)
        throw err
      }
    },

    '/characters/primary': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const body = await readBody(req, limit)
      const id = String(body?.id || '').trim().slice(0, 80)
      if (!id) return fail(res, 400, 'BODY_INVALID', '缺少形象 id')
      const data = characters.setPrimary(id)
      return sendJson(res, 200, data)
    },

    '/characters/upload': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      // 图片走 base64 JSON；服务端保留 64MB 的本地安全线，避免超大图拖垮内存。
      let body
      try {
        body = await readBody(req, Math.max(limit, 96 * 1024 * 1024))
      } catch (err) {
        if (err?.code === 'BODY_TOO_LARGE') return fail(res, 413, 'BODY_TOO_LARGE', '图片太大，换一张小一点的图')
        throw err
      }
      if (!body || typeof body !== 'object') return fail(res, 400, 'BODY_INVALID', '请求体不合法')
      try {
        const result = await characters.upload({
          dataBase64: body.dataBase64,
          thumbBase64: body.thumbBase64,
          name: body.name,
          title: body.title,
          ageGroup: body.ageGroup,
          outfitId: body.outfitId,
          outfitLabel: body.outfitLabel,
          tags: body.tags,
          width: body.width,
          height: body.height,
        })
        return sendJson(res, 200, {
          ok: true,
          ...result.state,
          itemId: result.item?.id || null,
        })
      } catch (err) {
        const status = err?.code === 'UPLOAD_TOO_LARGE' ? 413 : 400
        return fail(res, status, err?.code || 'UPLOAD_INVALID', err.message)
      }
    },

    '/characters/delete': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const body = await readBody(req, limit)
      const id = String(body?.id || '').trim().slice(0, 80)
      if (!id) return fail(res, 400, 'BODY_INVALID', '缺少形象 id')
      try {
        const data = await characters.removeUpload(id)
        return sendJson(res, 200, data)
      } catch (err) {
        if (err?.code === 'UPLOAD_NOT_FOUND') return fail(res, 404, 'UPLOAD_NOT_FOUND', err.message)
        if (err?.code === 'BUILTIN_READONLY') return fail(res, 403, 'BUILTIN_READONLY', err.message)
        if (err?.code === 'PACK_LOCKED') return fail(res, 409, 'UPLOAD_LOCKED', err.message)
        return fail(res, 400, err?.code || 'UPLOAD_DELETE_FAILED', err.message)
      }
    },

    '/characters/thumb': async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD', '只支持 GET')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const id = (queryOf(req).get('id') || '').trim().slice(0, 80)
      const file = characters.thumbnailPath(id)
      if (!file) return fail(res, 404, 'NOT_FOUND', '没有这张缩略图')
      let stat
      try { stat = fs.statSync(file) } catch { return fail(res, 404, 'NOT_FOUND', '缩略图文件缺失') }
      if (!stat.isFile()) return fail(res, 404, 'NOT_FOUND', '缩略图不是文件')
      res.writeHead(200, {
        'content-type': characters.mimeOf(file),
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-length': stat.size,
      })
      if (req.method === 'HEAD') return res.end()
      const stream = fs.createReadStream(file)
      stream.on('error', () => { try { res.destroy() } catch { /* 连接已断 */ } })
      res.on('close', () => { try { stream.destroy() } catch { /* 已关闭 */ } })
      stream.pipe(res)
    },

    '/characters/file': async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD', '只支持 GET')
      if (!characters) return fail(res, 409, 'CHARACTERS_MISSING', '形象库未初始化')
      const id = (queryOf(req).get('id') || '').trim().slice(0, 80)
      const file = characters.fullImagePath(id)
      if (!file) return fail(res, 409, 'PACK_NOT_INSTALLED', '原图资源包还没下载')
      let stat
      try { stat = fs.statSync(file) } catch { return fail(res, 404, 'NOT_FOUND', '原图文件缺失') }
      if (!stat.isFile()) return fail(res, 404, 'NOT_FOUND', '原图不是文件')
      const name = path.basename(file)
      res.writeHead(200, {
        'content-type': characters.mimeOf(file),
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-length': stat.size,
        'content-disposition': `${queryOf(req).get('download') ? 'attachment' : 'inline'}; filename="${name}"`,
      })
      if (req.method === 'HEAD') return res.end()
      const stream = fs.createReadStream(file)
      stream.on('error', () => { try { res.destroy() } catch { /* 连接已断 */ } })
      res.on('close', () => { try { stream.destroy() } catch { /* 已关闭 */ } })
      stream.pipe(res)
    },

    '/storage': async (req, res) => {
      if (req.method !== 'GET') return fail(res, 405, 'METHOD', '只支持 GET')
      try {
        const data = await storageMaintenance.summary()
        return sendJson(res, 200, { ok: true, ...data })
      } catch (err) {
        logger.warn(`存储扫描失败：${err.message}`)
        return fail(res, 500, 'STORAGE_SCAN_FAILED', '存储占用读取失败，详情见日志')
      }
    },

    '/storage/cleanup': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      try {
        const result = await storageMaintenance.clean({ targets: body?.targets })
        return sendJson(res, 200, { ok: true, ...result, partial: Boolean(result.errors?.length) })
      } catch (err) {
        if (err?.code === 'TARGETS_INVALID') return fail(res, 400, 'TARGETS_INVALID', err.message)
        if (err?.code === 'CREATIVE_BUSY') return fail(res, 409, 'CREATIVE_BUSY', err.message)
        logger.warn(`存储清理失败：${err.message}`)
        return fail(res, 500, 'STORAGE_CLEAN_FAILED', '清理失败，详情见日志')
      }
    },

    '/memory': async (req, res) => {
      const params = queryOf(req)
      const tier = params.get('tier') || undefined
      const q = (params.get('q') || '').slice(0, 200)
      const limitN = Math.min(100, Math.max(1, Math.round(Number(params.get('limit')) || 20)))
      const offset = Math.max(0, Math.round(Number(params.get('offset')) || 0))
      let items
      let total
      if (q) {
        // 搜索走相关度排序，最多能取 100 条：总数按实际命中算，页面标注「约」
        const found = memory.recall(q, { tier, limit: 100, reinforce: false })
        total = found.length
        items = found.slice(offset, offset + limitN)
      } else {
        total = memory.count({ tier })
        items = memory.list({ tier, limit: limitN, offset, includeQuarantined: true })
      }
      const pageCount = Math.max(1, Math.ceil(total / limitN))
      sendJson(res, 200, {
        ok: true, query: q, offset, limit: limitN, total, pageCount,
        approximate: Boolean(q),
        items: items.map(publicMemory), stats: memory.stats(),
      })
    },

    '/memory/pin': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.id) return fail(res, 400, 'BODY_INVALID', '缺少 id')
      try {
        if (body.pinned === false) memory.unpin(body.id)
        else memory.pinAnchor(body.id)
        return sendJson(res, 200, { ok: true, stats: memory.stats() })
      } catch (err) {
        return fail(res, 404, 'NOT_FOUND', err.message)
      }
    },

    '/memory/archive': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      if (!body?.id) return fail(res, 400, 'BODY_INVALID', '缺少 id')
      try {
        memory.archive(body.id, 'panel')
        return sendJson(res, 200, { ok: true, stats: memory.stats() })
      } catch (err) {
        return fail(res, 404, 'NOT_FOUND', err.message)
      }
    },

    '/memory/review': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      try {
        const result = await memory.dailyReview({ force: true })
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        logger.error(`手动复盘失败：${err.message}`)
        return fail(res, 500, 'REVIEW_FAILED', '复盘失败，详情见日志')
      }
    },

    '/audit': async (req, res) => {
      const limitN = Math.min(100, Math.max(1, Math.round(Number(queryOf(req).get('limit')) || 30)))
      sendJson(res, 200, {
        ok: true,
        memory: memory.auditLog(limitN).map((row) => ({ ...row, detail: safeOutput(row.detail, 200) })),
        persona: persona.audit(limitN),
      })
    },

    '/decision': async (req, res) => {
      sendJson(res, 200, { ok: true, ...decision.getInternalState() })
    },

    '/decision/nudge': async (req, res) => {
      if (req.method !== 'POST') return fail(res, 405, 'METHOD', '只支持 POST')
      const body = await readBody(req, limit)
      try {
        if (body?.action === 'clear') {
          decision.clearNudge()
          return sendJson(res, 200, { ok: true, cleared: true })
        }
        const ttlMs = Number(body?.ttlMinutes ? body.ttlMinutes * 60_000 : 30 * 60_000)
        const result = decision.nudge(body?.action, { ttlMs })
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        return fail(res, 400, 'NUDGE_INVALID', err.message)
      }
    },

    '/decision/scheduler': async (req, res) => {
      if (req.method !== 'PUT') return fail(res, 405, 'METHOD', '只支持 PUT')
      const body = await readBody(req, limit)
      const result = decision.updateScheduler(body ?? {})
      sendJson(res, 200, { ok: true, ...result, scheduler: decision.getInternalState().scheduler })
    },
  }

  return handlers
}

/**
 * 把 handler 注册到 DSH 的 web 服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 */
export function registerGui(ctx, deps) {
  const { config, logger } = deps
  if (!config.gui.enabled) {
    logger.info('GUI 接口已关闭（gui.enabled=false）')
    return () => {}
  }
  // Web 端先过 DSH 自己的 Host / Origin 与登录门；Desktop 的 dsh-app:// 进程内桥接
  // 不带 dsh web 的登录 cookie，继续由下面的本机 / 来源检查负责。
  const requestGate = isDesktopHost(ctx) ? null : resolveRequestGate(ctx)
  const handlers = createHandlers({
    ...deps,
    getUiUrl: () => `${ctx.webServer.getOrigin()}${config.gui.uiPath}`,
  })

  let uiCache = null
  let iconCache = null

  function renderUiHtml() {
    const mtimeMs = fs.statSync(UI_FILE).mtimeMs
    if (!uiCache || uiCache.mtimeMs !== mtimeMs) {
      uiCache = {
        mtimeMs,
        html: fs.readFileSync(UI_FILE, 'utf8')
          .replaceAll('__API_BASE__', config.gui.basePath)
          .replaceAll('__UI_PATH__', config.gui.uiPath),
      }
    }
    return uiCache.html
  }

  function readIconBuffer() {
    const mtimeMs = fs.statSync(ICON_FILE).mtimeMs
    if (!iconCache || iconCache.mtimeMs !== mtimeMs) {
      iconCache = { mtimeMs, buf: fs.readFileSync(ICON_FILE) }
    }
    return iconCache.buf
  }

  const serveUi = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    let html
    try {
      html = renderUiHtml()
    } catch (err) {
      logger.error(`网页版设置页读取失败：${err.message}`)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('网页版设置页文件缺失')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      // 双保险：老浏览器认 X-Frame-Options，新浏览器认 frame-ancestors
      'content-security-policy': "frame-ancestors 'none'",
      'content-length': Buffer.byteLength(html),
    })
    if (req.method === 'HEAD') res.end()
    else res.end(html)
  }

  /** 网页里的鱼标走同一个本地 web 服务，不引外链、不上传任何素材。 */
  const serveIcon = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    let buf
    try {
      buf = readIconBuffer()
    } catch (err) {
      logger.error(`网页图标读取失败：${err.message}`)
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('图标缺失')
      return
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': buf.length,
    })
    if (req.method === 'HEAD') res.end()
    else res.end(buf)
  }

  const routes = Object.entries(handlers).map(([suffix, handler]) => [`${BASE}${suffix}`, handler])
  routes.push([config.gui.uiPath, serveUi])
  routes.push([`${config.gui.uiPath}/icon.png`, serveIcon])

  const disposers = []

  for (const [route, handler] of routes) {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: route,
      handler: async (req, res) => {
        try {
          if (requestGate) {
            const rejection = requestGate(req)
            if (rejection !== undefined) {
              const status = rejection === 401 ? 401 : 403
              logger.warn(`DSH 访问检查拒绝 GUI 请求：${status} ${req.method} ${route}`)
              return fail(res, status, status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', status === 401
                ? '需要先登录 DSH，再从 DSH 启动时打印的地址重新打开'
                : '请求未通过 DSH 的 Host / Origin 检查')
            }
          }
          // 没有 socket 地址说明请求来自宿主进程内桥接（桌面端），视为本机
          const address = req.socket?.remoteAddress
          if (!config.gui.allowRemote && address && !isLoopbackAddress(address)) {
            logger.warn(`拒绝非本机访问：${address}`)
            return fail(res, 403, 'FORBIDDEN', '只允许本机访问')
          }
          if (!isLoopbackOrigin(req.headers?.origin, req.headers?.host, { allowRemote: config.gui.allowRemote })) {
            return fail(res, 403, 'FORBIDDEN', '来源不合法')
          }
          await handler(req, res)
        } catch (err) {
          if (err?.code === 'BODY_TOO_LARGE') return fail(res, 413, 'BODY_TOO_LARGE', '请求体过大')
          if (err?.code === 'BODY_INVALID') return fail(res, 400, 'BODY_INVALID', '请求体不是合法 JSON')
          logger.error(`GUI 接口异常 ${route}：${err.message}`)
          if (!res.headersSent) fail(res, 500, 'INTERNAL', '内部错误，详情见日志')
          else res.end()
        }
      },
    }))
  }

  logger.info(`GUI 接口已注册 ${Object.keys(handlers).length} 条（${BASE}/*），网页版：${config.gui.uiPath}`)
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {
        logger.warn(`GUI 路由卸载失败：${err.message}`)
      }
    }
  }
}

export { BASE as GUI_BASE, isLoopbackAddress, isLoopbackOrigin }
