// ============================================================
// 人格模块（01）
// 职责：加载/校验/回退核心人格，生成稳定锚点文本，注册到系统提示词
// 边界：不做记忆、不做状态机、不允许模型运行时自改人格
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, readJsonl, readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { fromRoot, ensureDirFor } from '../utils/paths.js'
import { safeOutput } from '../utils/safety.js'
import { buildPersonaSection, diffPersona, FALLBACK_PERSONA, normalizePersona, validatePersona } from './schema.js'

export { buildPersonaSection, diffPersona, normalizePersona, validatePersona, TRAIT_KEYS, TRAIT_LABELS } from './schema.js'

/** 人格在系统提示词里的段落名，全局唯一。 */
export const PERSONA_SECTION_NAME = 'fish-dandan:persona'

function resolvePath(value) {
  return path.isAbsolute(value) ? value : fromRoot(value)
}

/**
 * 创建人格存储。首次运行时从模板复制；任何损坏都回退到模板/内置常量，绝不抛穿。
 * @param {{ config: object, logger: object }} deps
 */
export function createPersonaStore({ config, logger }) {
  const corePath = resolvePath(config.persona.corePath)
  const templatePath = resolvePath(config.persona.templatePath)
  const auditPath = resolvePath(config.persona.auditPath)
  let cached = null
  let source = 'unknown'

  function readTemplate() {
    const raw = readJsonSafe(templatePath, null, (err) => {
      logger.warn(`人格模板读取失败：${err.message}`)
    })
    if (!raw) {
      logger.warn('人格模板不可用，使用内置兜底人格')
      return { persona: normalizePersona(FALLBACK_PERSONA).persona, source: 'builtin' }
    }
    const { persona, issues } = normalizePersona(raw)
    for (const issue of issues) logger.warn(`人格模板校验：${issue}`)
    return { persona, source: 'template' }
  }

  function load() {
    if (cached) return cached

    // 1) 运行时文件优先
    const raw = readJsonSafe(corePath, null, (err) => {
      logger.warn(`核心人格读取失败，回退模板：${err.message}`)
    })
    if (raw) {
      const check = validatePersona(raw)
      const { persona, issues } = normalizePersona(raw)
      if (!check.ok) {
        logger.warn(`核心人格不合法（${check.issues.join('；')}），本次回退模板，不改写文件`)
        const tpl = readTemplate()
        cached = tpl.persona
        source = `${tpl.source}(fallback)`
        return cached
      }
      for (const issue of issues) logger.warn(`核心人格规范化：${issue}`)
      cached = persona
      source = 'runtime'
      return cached
    }

    // 2) 文件存在但解析失败：回退模板，但不覆盖用户文件
    if (fs.existsSync(corePath)) {
      logger.warn('核心人格文件存在但无法解析，本次使用模板，不改写原文件')
      const tpl = readTemplate()
      cached = tpl.persona
      source = `${tpl.source}(corrupt)`
      return cached
    }

    // 3) 首次运行：从模板复制
    const tpl = readTemplate()
    try {
      ensureDirFor(corePath)
      writeJsonAtomic(corePath, tpl.persona)
      logger.info(`首次运行，已从模板生成核心人格：${corePath}`)
    } catch (err) {
      logger.warn(`核心人格写入失败（继续使用内存人格）：${err.message}`)
    }
    cached = tpl.persona
    source = tpl.source
    return cached
  }

  function current() {
    return load()
  }

  /**
   * 受控写入：只接受面板/接口传入的草稿，模型运行时无法调用。
   * @param {unknown} draft
   * @param {{ actor?: string }} [meta]
   */
  function save(draft, meta = {}) {
    const check = validatePersona(draft)
    if (!check.ok) {
      const err = new Error(`人格校验失败：${check.issues.join('；')}`)
      err.code = 'PERSONA_INVALID'
      throw err
    }
    const { persona, issues } = normalizePersona(draft)
    const before = current()
    const changed = diffPersona(before, persona)

    writeJsonAtomic(corePath, persona)
    cached = persona
    source = 'runtime'

    try {
      appendJsonl(auditPath, {
        at: Date.now(),
        actor: meta.actor || 'panel',
        action: 'persona.save',
        changed,
        before: snapshotForAudit(before, changed),
        after: snapshotForAudit(persona, changed),
      })
    } catch (err) {
      logger.warn(`人格审计写入失败：${err.message}`)
    }

    for (const issue of issues) logger.warn(`人格规范化：${issue}`)
    logger.info(`人格已更新，字段：${changed.join('、') || '（无变化）'}`)
    return { persona, changed }
  }

  function audit(limit = 50) {
    const rows = readJsonl(auditPath, (err) => logger.warn(`人格审计读取失败：${err.message}`))
    return rows.slice(-Math.max(1, limit)).reverse()
  }

  /** 面板用的摘要，避免把整份人格塞进列表响应。 */
  function summary() {
    const p = current()
    return {
      name: p.identity.name,
      species: p.identity.species,
      identitySummary: p.identity.identitySummary,
      tone: p.speech.tone,
      selfReference: p.speech.selfReference,
      ownerAddress: p.speech.ownerAddress,
      traits: { ...p.personality.traits },
      source,
    }
  }

  function paths() {
    return { corePath, templatePath, auditPath }
  }

  return { load, current, save, audit, summary, paths, get source() { return source } }
}

function snapshotForAudit(persona, changed) {
  const out = {}
  for (const field of changed) {
    const value = field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), persona)
    out[field] = typeof value === 'string' ? safeOutput(value, 120) : value
  }
  return out
}

/**
 * 把人格注册进系统提示词。文本是函数，每次组装重新求值，
 * 因此面板保存后下一步即生效，且不需要重新注册。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ store: ReturnType<typeof createPersonaStore>, config: object, memory?: object, logger: object }} deps
 */
export function attachPersona(ctx, { store, config, memory, logger }) {
  const section = ctx.systemPrompt.section({
    name: PERSONA_SECTION_NAME,
    order: config.persona.sectionOrder,
    text: () => buildPersonaSection(store.current(), memory?.getEvolvedTraits?.()),
  })
  logger.info(`人格段已注册（order=${config.persona.sectionOrder}）`)
  return section
}


/** 给面板的完整草稿（去掉运行时字段）。 */
export function personaDraft(store) {
  const p = store.current()
  return {
    identity: { ...p.identity },
    personality: {
      traits: { ...p.personality.traits },
      tags: [...(p.personality.tags || [])],
      personalityText: p.personality.personalityText,
    },
    speech: { ...p.speech, catchphrases: [...p.speech.catchphrases] },
    preferences: { likes: [...p.preferences.likes], dislikes: [...p.preferences.dislikes] },
    scenes: [...(p.scenes || [])],
    boundaries: [...(p.boundaries || [])],
    backstory: p.backstory,
    safety: { ...p.safety },
  }
}

// 长度上限的单一来源在 schema.js；这里 re-export 给 GUI 使用
export { PERSONA_TEXT_LIMITS } from './schema.js'
