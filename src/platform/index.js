// ============================================================
// 平台适配基座（05）
// 只做契约、身份、路由、限流与生命周期；具体平台在 06/07/08 实现
// 内核只认归一化消息，平台私有内容留在 raw
// ============================================================

import { createIdentityRegistry } from './identity.js'
import { createSendGate } from './router.js'

const REQUIRED_ADAPTER_METHODS = ['connect', 'disconnect', 'normalize', 'send', 'capabilities']
const CONVERSATION_KINDS = new Set(['private', 'group', 'comment', 'direct', 'unknown'])

function assertAdapter(impl) {
  if (!impl || typeof impl !== 'object') throw new Error('适配器必须是对象')
  if (typeof impl.platform !== 'string' || !impl.platform.trim()) throw new Error('适配器缺少 platform')
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof impl[method] !== 'function') throw new Error(`适配器 ${impl.platform} 缺少 ${method}()`)
  }
}

/** 校验并补齐归一化消息的默认字段。 */
export function normalizeEnvelope(platform, message) {
  const value = message && typeof message === 'object' ? message : {}
  const conversation = value.conversation && typeof value.conversation === 'object' ? value.conversation : {}
  const sender = value.sender && typeof value.sender === 'object' ? value.sender : {}
  return {
    platform,
    conversation: {
      platform,
      kind: CONVERSATION_KINDS.has(conversation.kind) ? conversation.kind : 'unknown',
      externalId: String(conversation.externalId ?? ''),
      threadId: conversation.threadId == null ? '' : String(conversation.threadId),
    },
    sender: {
      platformUserId: String(sender.platformUserId ?? ''),
      unifiedPersonId: sender.unifiedPersonId == null ? '' : String(sender.unifiedPersonId),
      displayName: sender.displayName == null ? '' : String(sender.displayName),
    },
    content: String(value.content ?? '').trim(),
    segments: Array.isArray(value.segments) ? value.segments.slice(0, 20) : [],
    nativeMessageId: value.nativeMessageId == null ? '' : String(value.nativeMessageId),
    receivedAt: Number.isFinite(value.receivedAt) ? value.receivedAt : Date.now(),
    raw: value.raw ?? null,
  }
}

/**
 * @param {{ config: object, logger: object, memory?: object, random?: Function, sleep?: Function, now?: Function }} deps
 */
export function createPlatforms({ config, logger, memory, random, sleep, now }) {
  const adapters = new Map()
  const identity = createIdentityRegistry({ config, logger })
  const gate = createSendGate({ config, logger, random, sleep, now })

  /** 注册一个平台适配器，返回注销函数。 */
  function defineAdapter(impl) {
    assertAdapter(impl)
    const platform = impl.platform.trim()
    if (adapters.has(platform)) throw new Error(`平台 ${platform} 已经注册过适配器`)
    adapters.set(platform, impl)
    logger.info(`平台适配器已注册：${platform}（能力：${impl.capabilities().join('、') || '无'}）`)
    return () => {
      adapters.delete(platform)
      try {
        impl.disconnect()
      } catch (err) {
        logger.warn(`适配器 ${platform} 注销失败：${err.message}`)
      }
    }
  }

  function getAdapter(platform) {
    return adapters.get(platform) ?? null
  }

  function listCapabilities() {
    return [...adapters.entries()].map(([platform, impl]) => ({ platform, capabilities: impl.capabilities() }))
  }

  function requireAdapter(platform) {
    const adapter = adapters.get(platform)
    if (!adapter) {
      const error = new Error(`没有注册平台适配器：${platform}`)
      error.code = 'ADAPTER_MISSING'
      throw error
    }
    return adapter
  }

  /**
   * 平台事件进入内核：归一化 → 身份识别 → 记忆 → 返回归一化消息。
   * 具体平台适配器负责在收到原始事件后调用这里。
   */
  async function routeIncoming(platform, event) {
    const adapter = requireAdapter(platform)
    const normalized = normalizeEnvelope(platform, adapter.normalize(event))
    if (!normalized.sender.platformUserId) throw new Error('归一化消息缺少 sender.platformUserId')
    if (!normalized.content && !normalized.segments.length) throw new Error('归一化消息没有内容')

    const person = identity.resolve(platform, normalized.sender.platformUserId)
    normalized.sender.unifiedPersonId = person.id

    const isGroup = normalized.conversation.kind === 'group'
    memory?.recordEvent?.(
      {
        content: `[${platform}/${normalized.conversation.kind}] ${normalized.sender.displayName || person.name || normalized.sender.platformUserId}：${normalized.content}`,
        importance: isGroup ? 4 : 6,
        tags: [platform, normalized.conversation.kind],
        person: person.id,
        platform,
        summary: normalized.content.slice(0, 60),
      },
      `platform:${platform}`,
    )
    logger.info(`入站：${platform}/${normalized.conversation.kind} ${person.id}（${normalized.content.length} 字）`)
    return normalized
  }

  /**
   * 内核回复发往平台：闸门 → 适配器发送 → 记忆。
   * @param {{ platform: string, kind: string, externalId: string, threadId?: string }} conv
   * @param {{ text: string } | string} message
   * @param {{ approved?: boolean, requiresApproval?: boolean }} [options]
   */
  async function routeOutgoing(conv, message, options = {}) {
    const platform = conv?.platform
    const adapter = requireAdapter(platform)
    const payload = typeof message === 'string' ? { text: message } : { ...(message || {}) }
    if (!payload.text || !String(payload.text).trim()) return { ok: false, code: 'EMPTY', reason: '消息内容为空' }

    const verdict = await gate.check(platform, options)
    if (!verdict.ok) return verdict

    try {
      const result = await adapter.send(conv, { ...payload, text: String(payload.text) })
      // 记忆写入失败不能改变发送结果：以前它和发送共用一个 try，写记忆失败会被当成发送失败，上层重试就会重复发
      try {
        memory?.recordEvent?.(
          {
            content: `[${platform}/发出] ${payload.text}`,
            importance: 4,
            tags: [platform, 'outgoing'],
            person: conv.personId || '',
            platform,
            summary: payload.text.slice(0, 60),
          },
          `platform:${platform}:out`,
        )
      } catch (err) {
        logger.warn(`出站记忆写入失败（消息已发出）：${err.message}`)
      }
      logger.info(`出站：${platform}/${conv.kind} ${verdict.delay}ms 后发送（${payload.text.length} 字）`)
      return { ok: true, ...result }
    } catch (err) {
      logger.warn(`出站失败 ${platform}：${err.message}`)
      return { ok: false, code: 'SEND_FAILED', reason: err.message }
    }
  }

  /** 行为计划的兜底执行：没有具体平台时诚实说明，不假装完成。 */
  async function execute(plan, options = {}) {
    if (!config.platforms.enabled) return { ok: false, reason: '平台总开关未开启（platforms.enabled）' }
    if (!plan || typeof plan !== 'object') return { ok: false, reason: '缺少行为计划' }
    if (!plan.conversation) {
      return { ok: false, reason: '05 基座没有具体平台；这类行为要等 06/07 适配器接入后执行' }
    }
    return routeOutgoing(plan.conversation, { text: plan.text }, options)
  }

  /** 挂载连接生命周期；卸载时断开所有适配器并释放各自资源（定时器、观察窗）。 */
  function attach(ctx) {
    const enabled = config.platforms.enabled
    if (!enabled) {
      logger.info('平台适配总开关未开启（platforms.enabled=false）；登录、刷流等本地能力仍可用')
    }
    return ctx.effect(() => {
      if (enabled) {
        for (const [platform, adapter] of adapters) {
          try {
            const result = adapter.connect()
            if (result && typeof result.catch === 'function') {
              result.catch((err) => logger.warn(`适配器 ${platform} 连接失败：${err.message}`))
            }
          } catch (err) {
            logger.warn(`适配器 ${platform} 连接失败：${err.message}`)
          }
        }
        logger.info(`平台适配已启动：${[...adapters.keys()].join('、') || '（没有注册适配器）'}`)
      }
      return () => {
        for (const [platform, adapter] of adapters) {
          try {
            adapter.disconnect()
          } catch (err) {
            logger.warn(`适配器 ${platform} 断开失败：${err.message}`)
          }
          // 释放适配器自己的资源：刷流定时器、围观窗口等
          try {
            if (typeof adapter.dispose === 'function') adapter.dispose()
          } catch (err) {
            logger.warn(`适配器 ${platform} 资源释放失败：${err.message}`)
          }
        }
        logger.info('平台适配已停止')
      }
    }, 'fish-dandan:platforms')
  }

  /**
   * 平台规划目录：抖音 / B站 / QQ 在网页平台页永远三卡并列，做抖音不会挡住其它。
   * 适配器注册后对应目录项自动从 planned 转 ready；目录之外的注册（如 QQ 扩展对接）
   * 追加在列表尾部。state: ready=已接入 / planned=规划中 / extensible=只留扩展口。
   */
  const PLATFORM_CATALOG = [
    { id: 'douyin', label: '抖音', phase: '06 · 建设中', defaultState: 'planned',
      note: '已接入：登录、逐条刷流、按心情自己决定点不点赞/说不说话；不需要逐条确认，做过什么都在流水账里。' },
    { id: 'bilibili', label: 'B站', phase: 'P4 · 规划中', defaultState: 'planned',
      note: '还没做。以后会跟抖音用同一套脾气和记忆。' },
    { id: 'qq', label: 'QQ', phase: 'P5 · 扩展口', defaultState: 'extensible',
      note: '还没做，只留了扩展口。' },
  ]

  function status() {
    const rows = PLATFORM_CATALOG.map((cat) => {
      const adapter = adapters.get(cat.id)
      return {
        id: cat.id,
        name: cat.label,
        enabled: Boolean(adapter),
        status: adapter
          ? (typeof adapter.status === 'function' ? adapter.status() : 'ready')
          : (cat.defaultState || 'planned'),
        phase: cat.phase,
        detail: adapter ? (adapter.detail || cat.note) : cat.note,
        capabilities: adapter ? adapter.capabilities() : [],
      }
    })
    for (const [platform, adapter] of adapters.entries()) {
      if (PLATFORM_CATALOG.some((c) => c.id === platform)) continue
      rows.push({
        id: platform,
        name: adapter.name || platform,
        enabled: true,
        status: typeof adapter.status === 'function' ? adapter.status() : 'registered',
        phase: '自定义扩展',
        detail: adapter.detail || '',
        capabilities: adapter.capabilities(),
      })
    }
    return rows
  }

  return {
    defineAdapter,
    getAdapter,
    listCapabilities,
    routeIncoming,
    routeOutgoing,
    resolveIdentity: (platform, userId) => identity.resolve(platform, userId),
    mergeIdentity: (from, to) => identity.merge(from, to),
    linkIdentity: (platform, userId, personId) => identity.link(platform, userId, personId),
    listIdentities: () => identity.list(),
    execute,
    attach,
    status,
    gate,
  }
}
