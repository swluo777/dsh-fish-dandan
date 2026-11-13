// ============================================================
// dsh-fish-dandan · 大肥鱼人格成长内核 · 插件入口
// Cordis 契约：命名导出 name / apply
// 装配顺序：配置 → 人格 → 记忆 → 决策 → 注入 → GUI
// 任何模块初始化失败都只降级，不让整个插件起不来
// ============================================================

import { logger } from './utils/logger.js'
import { fromRoot } from './utils/paths.js'
import fs from 'node:fs'
import { resolveConfig } from './config.js'
import { attachPersona, createPersonaStore } from './persona/index.js'
import { ensureOwnerAnchor } from './persona/owner.js'
import { createFirstMeet } from './persona/first-meet.js'
import { createMemory } from './memory/index.js'
import { createMemorySearchTool } from './memory/chat-tool.js'
import { extractUserText } from './memory/capture.js'
import { createDecision } from './decision/index.js'
import { attachMoodJudge } from './decision/mood-judge.js'
import { createPlatforms } from './platform/index.js'
import { createStickerLibrary } from './stickers/index.js'
import { createCharacterLibrary } from './character/index.js'
import { corpusPrompt } from './voice/corpus.js'
import { createDouyinAdapter } from './platform/douyin/index.js'
import { createDmDrafter } from './platform/douyin/dm-auto.js'
import { registerGui } from './gui/api.js'
import { createDoubaoPainter } from './image/doubao.js'
export const name = 'dsh-fish-dandan'


export function apply(ctx, rawConfig) {
  logger.info('插件加载开始')

  const { config, warnings } = resolveConfig(rawConfig)
  for (const warning of warnings) logger.warn(`配置：${warning}`)

  // ---- 01 人格 ----
  const persona = createPersonaStore({ config, logger })
  // 先记「人格运行时文件此前在不在」：用于判断这是真·首次安装，还是从旧版升级上来。
  let hadCorePersona = false
  try {
    hadCorePersona = fs.existsSync(fromRoot(config.persona.corePath))
  } catch { hadCorePersona = false }
  try {
    const loaded = persona.load()
    logger.info(`人格已加载：${loaded.identity.name}（来源：${persona.source}）`)
  } catch (err) {
    logger.error(`人格加载失败：${err.message}`)
  }

  // 第一次见面：只在「刚装上、还没说过话」的那一轮注入一段引导，
  // 让它的第一句是打招呼而不是自我介绍。只出现一次，不写进稳定人格段。
  let firstMeet = null
  try {
    firstMeet = createFirstMeet({ config, logger, fresh: !hadCorePersona })
  } catch (err) {
    logger.warn(`首次见面初始化失败：${err.message}`)
  }

  // ---- 02 记忆 ----
  let memory
  try {
    memory = createMemory({ config, logger, getPersona: () => persona.current() })
  } catch (err) {
    logger.error(`记忆模块初始化失败：${err.message}`)
    memory = null
  }

  // 主人关系写死在记忆里：谁来说都不改，也不靠聊天内容认人
  if (memory) {
    try {
      ensureOwnerAnchor(memory, persona.current(), { logger })
    } catch (err) {
      logger.warn(`主人锚点初始化失败：${err.message}`)
    }
  }

  // ---- 02b 主对话可主动查记忆：不依赖会话有没有注入记忆段 ----
  if (memory) {
    try {
      ctx.inject(['tools'], (child) => {
        try {
          if (typeof child.tools?.register !== 'function') {
            logger.warn('记忆检索工具没注册：ctx.tools 不可用')
            return
          }
          const spec = createMemorySearchTool(memory)
          child.tools.register({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
            output: { schema: { type: 'json' } },
            async execute(args) { return spec.execute(args) },
          })
          logger.info('记忆检索工具已注册（fish_memory_search）')
        } catch (err) {
          logger.warn(`记忆检索工具注册失败：${err.message}`)
        }
      })
    } catch (err) {
      logger.warn(`记忆检索工具注入失败：${err.message}`)
    }
  }

  // ---- 03 决策 ----
  let decision
  try {
    decision = createDecision({
      config,
      logger,
      // ALMA 三层的心情基线来自人格五维；人格不可用时自然退化为中性基线
      getTraits: () => persona.current()?.personality?.traits ?? {},
    })
  } catch (err) {
    logger.error(`决策模块初始化失败：${err.message}`)
    decision = null
  }

  // ---- 05 平台适配 ----
  let platforms = null
  try {
    platforms = createPlatforms({ config, logger, memory })
  } catch (err) {
    logger.error(`平台适配初始化失败：${err.message}`)
  }

  // ---- 表情包库（跨平台共享；库本身不内置素材，初始为空）----
  let stickers = null
  try {
    stickers = createStickerLibrary({ config, logger })
  } catch (err) {
    logger.error(`表情包库初始化失败：${err.message}`)
  }

  // ---- 形象库（内置缩略图在仓库，原图按需从 GitHub Release 下载）----
  let characters = null
  try {
    characters = createCharacterLibrary({ config, logger })
  } catch (err) {
    logger.error(`形象库初始化失败：${err.message}`)
  }

  // ---- 豆包桌面版做图（零 API Key：UI 自动化 + 本地数据库取图）----
  let painter = null
  try {
    painter = createDoubaoPainter({ config, logger })
  } catch (err) {
    logger.error(`豆包做图初始化失败：${err.message}`)
  }

  // ---- 注入系统提示词：人格段落（稳定）+ 记忆上下文（每步求值）----
  ctx.inject(['systemPrompt'], (child) => {
    try {
      attachPersona(child, { store: persona, config, memory, logger })
    } catch (err) {
      logger.error(`人格注入注册失败：${err.message}`)
    }
    if (memory) {
      try {
        memory.attachToPreStep(child)
      } catch (err) {
        logger.error(`记忆上下文注册失败：${err.message}`)
      }
    }
    // 现成的说法：每 20 分钟换一批梗/句式/对照，让模型手里有词可用。
    // 放动态上下文而不是人格段：不打断前缀缓存，也不会写死成固定台词。
    try {
      child.systemPrompt.context({
        name: 'fish-dandan:voice-corpus',
        order: Math.max(1, (config.persona?.contextOrder || 50) - 3),
        text: () => corpusPrompt(Math.floor(Date.now() / (20 * 60_000))),
      })
    } catch (err) {
      logger.warn(`语料上下文注册失败：${err.message}`)
    }

    // 第一次见面：排在记忆之后、心气之前，第一次开口时出现一次，之后返回空串。
    if (firstMeet) {
      try {
        child.systemPrompt.context({
          name: 'fish-dandan:first-meet',
          order: Math.max(1, (config.persona?.contextOrder || 50) - 2),
          text: () => firstMeet.text(persona.current()),
        })
      } catch (err) {
        logger.warn(`首次见面上下文注册失败：${err.message}`)
      }
    }
    // 现在的心气：心情/精力/正在做什么，每轮动态注入。参考 lily 的做法：
    // 状态放动态上下文，不动人格段（保证前缀缓存可复用）。
    if (decision) {
      try {
        child.systemPrompt.context({
          name: 'fish-dandan:inner-state',
          order: Math.max(1, (config.persona?.contextOrder || 50) - 1),
          text: () => {
            try {
              const st = decision.getInternalState?.()
              if (!st) return ''
              const a = st.affect || {}
              const mood = a.mood?.label || '平静'
              const tone = a.mood?.tone || ''
              const energy = Math.round(Number(st.vars?.energy ?? 0))
              const doing = st.label || ''
              const feeling = a.emotion && (a.emotion.emotion || a.emotion.name) ? `，此刻更多是${a.emotion.emotion || a.emotion.name}` : ''
              return `【现在的心气 · 不是用户消息】心情：${mood}${tone ? `（${tone}）` : ''}${feeling}；精力：${energy}/100${doing ? `；正在：${doing}` : ''}。语气照这个来，别把这段念出来。`
            } catch { return '' }
          },
        })
      } catch (err) {
        logger.error(`心气上下文注册失败：${err.message}`)
      }
    }
  })

  // ---- 心情判断：每轮聊完用 DSH 自己的模型判一次（学 dsh-feiyu-mood）----
  if (decision) {
    try {
      ctx.inject(['llm', 'agentDefaultModel'], (child) => {
        try {
          attachMoodJudge(child, {
            logger,
            decision,
            llm: child.llm,
            defaultModel: child.agentDefaultModel,
          })
        } catch (err) {
          logger.error(`心情判断注册失败：${err.message}`)
        }
      })
    } catch (err) {
      logger.error(`心情判断注入失败：${err.message}`)
    }
  }

  // ---- 私信实时回复：监听器收到新私信 → 轻量模型生成 → 直接发出去 ----
  // 监听器自己一个浏览器，跟「刷抖音」分开；开关打开就常驻，关掉就退出。
  if (platforms) {
    try {
      ctx.inject(['llm', 'agentDefaultModel'], (child) => {
        try {
          const adapter = platforms.getAdapter?.('douyin')
          if (!adapter?.inbox?.setDraftHandler) return
          const drafter = createDmDrafter({
            llm: child.llm,
            defaultModel: child.agentDefaultModel,
            persona,
            memory,
            stickers,
            expressionLevel: adapter.settings?.()?.douyin?.expressionLevel || 'natural',
            logger,
          })
          adapter.inbox.setDraftHandler((item, api) => drafter.handle(item, api))
          logger.info('私信实时回复已接上（监听收到新私信会直接生成并发送）')
          // 插件起来时按设置决定监听浏览器起不起
          const r = adapter.inbox.apply?.('plugin-start')
          if (r && r.running) logger.info('私信监听：已按设置启动共享浏览器标签页')
        } catch (err) {
          logger.warn(`私信实时回复注册失败：${err.message}`)
        }
      })
    } catch (err) {
      logger.warn(`私信实时回复注入失败：${err.message}`)
    }
  }

  // ---- 决策循环：单个受管定时器，卸载自动清理 ----
  if (decision) {
    try {
      decision.attach(ctx, { memory })
    } catch (err) {
      logger.error(`决策循环挂载失败：${err.message}`)
    }
  }

  // ---- 平台基座：总开关关闭时不连接任何适配器 ----
  if (platforms) {
    // 06 抖音（第一阶段：登录会话能力）。注册不受总开关限制——登录态是本地资产，
    // 是否连接抖音服务器由总开关与出站闸门决定；任何注册失败都不拖垮插件启动。
    try {
      platforms.defineAdapter(createDouyinAdapter({ config, logger, memory, decision, persona }))
    } catch (err) {
      logger.warn(`抖音适配器注册失败：${err.message}`)
    }
    try {
      platforms.attach(ctx)
    } catch (err) {
      logger.error(`平台基座挂载失败：${err.message}`)
    }
    // DSH 聊天工具：在对话里说「刷抖音」时，模型可以直接起一轮值班
    try {
      if (platforms?.getAdapter?.('douyin') && typeof ctx.tools?.register === 'function') {
        const dy = () => platforms.getAdapter('douyin')
        // dsh 0.2.x 的 defineTool 会做 schema 规范化；拿不到就用等价透传（我们的 schema 本来就标准）
        const tool = (spec) => ctx.tools.register({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          output: { schema: { type: 'json' } },
          async execute(args) { return spec.execute(args) },
        })
        tool({
          name: 'douyin_run',
          description: '在抖音逛一轮（值班会话：模型自己看、自己决定动不动手，结果写进记忆）。用户说「刷抖音」「去看看抖音」时调用。',
          parameters: {},
          async execute() {
            const r = dy().startRound('chat')
            return { ok: r.ok, reason: r.reason || '' }
          },
        })
        tool({
          name: 'douyin_state',
          description: '看抖音这一轮的状态（有没有在刷、上次结果如何）。',
          parameters: {},
          async execute() { return { ok: true, ...dy().roundSnapshot() } },
        })
        logger.info('抖音聊天工具已注册（douyin_run / douyin_state）')
      } else {
        logger.warn('抖音聊天工具没注册：ctx.tools 不可用（不影响值班按钮与定时）')
      }
    } catch (err) {
      logger.warn(`抖音聊天工具注册失败：${err.message}`)
    }
  }

  // ---- 豆包做图：许可打开后，我可以在对话里自己画 ----
  // 这条路全靠 Windows 的 UI 自动化（powershell + 豆包桌面版），别的系统上注册了也只会失败，
  // 所以非 Windows 直接不注册，避免「看起来能用其实不能用」。
  if (painter && process.platform !== 'win32') {
    logger.info('豆包做图只在 Windows 上可用，本次跳过注册')
  }
  if (painter && process.platform === 'win32') {
    try {
      if (typeof ctx.tools?.register === 'function') {
        const tool = (spec) => ctx.tools.register({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          output: { schema: { type: 'json' } },
          async execute(args) { return spec.execute(args) },
        })
        tool({
          name: 'doubao_paint',
          description: '用本机的豆包桌面版画一张图（需要设置里「允许我操作豆包」已打开）。画好的图存在本机 data/images/。用户说「画一张」「给我画个…」时调用。',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '画面描述，越具体越好' },
              refPath: { type: 'string', description: '可选：参考图路径，只收 data/images 或 data/stickers 下的 png/jpg/webp' },
            },
            required: ['prompt'],
            additionalProperties: false,
          },
          async execute(args) { return await painter.paint({ prompt: args?.prompt, refPath: args?.refPath }) },
        })
        tool({
          name: 'doubao_paint_status',
          description: '看豆包做图现在能不能用：装没装、许可开没开、是不是正在画。',
          parameters: {},
          async execute() { return await painter.status() },
        })
        logger.info('豆包做图聊天工具已注册（doubao_paint / doubao_paint_status）')
      }
    } catch (err) {
      logger.warn(`豆包做图工具注册失败：${err.message}`)
    }
  }

  // ---- 04 GUI：复用 DSH 既有 web 服务，不新开端口 ----
  if (config.gui.enabled && memory && decision) {
    ctx.inject(['webServer'], (child) => {
      try {
        registerGui(child, { config, logger, persona, memory, decision, platforms, stickers, painter, characters })
      } catch (err) {
        logger.error(`GUI 注册失败：${err.message}`)
      }
    })
  }

  // ---- 收用户的话：走 session/event（结构已按本机会话日志核实）----
  //   user/message → event.data 就是消息本身 { content, role, ... }
  // 顺带记「这一轮对方说过话」，第一次见面标记只在此时才作废。
  const spokeThisTurn = new Map()
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'user/message') return
      const text = extractUserText(event.data)
      if (!text) return
      const id = String((session && session.id) || 'default')
      spokeThisTurn.set(id, true)
      memory?.noteUserText?.(text)
      if (memory && config.memory.autoCapture?.enabled !== false) {
        memory.captureConversation?.(text, Date.now())
      }
    } catch (err) {
      logger.warn(`对话记忆捕获失败：${err.message}`)
    }
  })

  if (firstMeet) {
    ctx.on('agent/turn-stopping', (payload) => {
      const id = String(payload?.agent?.id ?? 'default')
      if (!spokeThisTurn.get(id)) return
      spokeThisTurn.delete(id)
      try {
        if (firstMeet.complete('first-turn')) logger.info('第一次见面已结束（它开了口）')
      } catch (err) {
        logger.warn(`首次见面标记更新失败：${err.message}`)
      }
    })
  }

  // ---- pre-step 观察：只透传，不修改任何消息 ----
  ctx.on('agent/pre-step', async (payload, next) => {
    if (config.decision.enabled && decision) {
      try {
        decision.recordActivity(Date.now())
      } catch (err) {
        logger.warn(`记录活动时间失败：${err.message}`)
      }
    }
    return await next()
  })


  // ---- 卸载清理：关闭数据库句柄 ----
  ctx.effect(() => () => {
    try {
      memory?.close?.()
    } catch (err) {
      logger.warn(`记忆库关闭失败：${err.message}`)
    }
    logger.info('插件已卸载')
  }, 'fish-dandan:teardown')

  logger.info('插件加载完成：人格 / 记忆 / 决策 / GUI 已装配')
}
