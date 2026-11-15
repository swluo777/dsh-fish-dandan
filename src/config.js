// ============================================================
// 插件配置：默认值 + 宽松校验
// 不依赖 schemastery，避免为一个 Config 引入外部包
// 非法值一律钳制/回退并记 warning，绝不因配置错误让插件起不来
// ============================================================

import { clampNumber } from './utils/text.js'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export const DEFAULT_CONFIG = {
  /** 运行时数据根目录，相对项目根；测试里可指向临时目录 */
  dataDir: 'data',
  persona: {
    templatePath: 'persona/default-persona.json',
    corePath: 'data/persona/core-persona.json',
    auditPath: 'data/persona/audit.jsonl',
    /** 「第一次见面」标记：首装时落盘，第一次开口后作废 */
    firstMeetPath: 'data/state/first-meet.json',
    /** 人格锚点在系统提示词中的顺序，位于部署 persona 之前、第一方指导之后 */
    sectionOrder: 60,
    /** 记忆摘要作为运行时上下文的顺序 */
    contextOrder: 4200,
  },
  memory: {
    dbPath: 'data/memory/memory.db',
    jsonlPath: 'data/memory/memory.jsonl',
    /** 每次注入最多几条记忆 */
    maxInject: 6,
    /** 注入上下文的字符预算（超了先砍相关经历，人物卡与免责声明保留） */
    injectMaxChars: 1200,
    /** 对话内容自动进记忆：默认开，但有三道闸（规则筛选 / 每日配额 / 安全清洗） */
    autoCapture: { enabled: true, dailyQuota: 8, maxChars: 300 },
    /** 单次检索默认返回条数 */
    recallLimit: 20,
    /** 衰减半衰期（天） */
    halfLifeDays: { episodic: 14, trait: 90 },
    /** 低于该有效强度且超过最小年龄的情景记忆进入归档 */
    archiveThreshold: 0.08,
    archiveAfterDays: 30,
  },
  /** 表情包库：不内置素材，初始为空，靠上传或外部导入填满 */
  stickers: {
    dir: 'data/stickers',
    /** 单张上限，超过直接拒绝（QQ/抖音对图片都有大小限制） */
    maxBytes: 8 * 1024 * 1024,
  },
  /** 豆包桌面版生图（零 API Key 路线）：开关存在 platform-settings，这里只放默认值 */
  image: {
    doubao: {
      enabled: false,
      outDir: 'data/images',
    },
  },
  decision: {
    enabled: true,
    /** 状态推进间隔 */
    tickIntervalMs: 60_000,
    /** 同一状态最短停留，防抖 */
    minDwellMs: 15 * 60_000,
    /** 两次自主唤醒的基础间隔 */
    wakeBaseMs: 30 * 60_000,
    /** 抖动比例：±jitterRatio */
    jitterRatio: 0.35,
    /** 最小空闲间隔 */
    minIdleMs: 10 * 60_000,
    /** 每日最多自主唤醒次数 */
    dailyBudget: 8,
    /** 静默时段（本地时间） */
    quietHours: { start: '23:00', end: '07:00' },
    statePath: 'data/state/decision.json',
    schedulerPath: 'data/state/scheduler.json',
    /** 待确认动作落盘；重启后还能恢复，不再只存在内存里 */
    pendingPath: 'data/state/pending.json',
    /** 待确认动作多久没处理就自动失效 */
    pendingTtlMs: 30 * 60_000,
    /** 当前活动状态落盘；重启时用来识别「上次跑到一半」 */
    activityPath: 'data/state/activity.json',
    /** ALMA 三层情感状态（PAD 心情 / 情绪 / 历史采样） */
    affectPath: 'data/state/affect.json',
    /** 对外动作是否允许自动执行；默认关闭，一律进待确认 */
    autoExternal: false,
    /** 同一类行为的最小间隔，避免反复做同一件事 */
    minActionGapMs: 20 * 60_000,
    /**
     * 每类执行动作的独立频率闸：每日最多次数 + 同类动作最小间隔。
     * 0 次 = 该类动作不再由自主唤醒拉起；单类上限之外还有 dailyBudget 总上限。
     */
    actionLimits: {
      explore: { dailyBudget: 3, gapMs: 90 * 60_000 },
      social: { dailyBudget: 2, gapMs: 120 * 60_000 },
      create: { dailyBudget: 2, gapMs: 120 * 60_000 },
    },
    /** 进入睡眠时顺手做一次记忆复盘（Letta sleep-time 思路） */
    reviewOnSleep: true,
    /**
     * 专注创作（行为与调度 → create）的本地画图参数。
     * 纯本地 Canvas 绘制，不调用生图模型；产物放桌面，过程页留在 data/creative。
     */
    draw: {
      enabled: true,
      /** 网页与中间稿目录（相对项目根） */
      outDir: 'data/creative',
      /** 指定表情包 id；留空则按心情自动挑 */
      stickerId: '',
      /** 右下角落款称呼；留空取角色 displayName，再退回「蛋蛋」 */
      signatureName: '',
      /** 桌面输出目录；留空自动找系统桌面 */
      desktopDir: '',
      width: 1080,
      height: 1440,
      /** 页面渲染超时（毫秒），超时按失败处理，不拖死调度 */
      screenshotTimeoutMs: 12_000,
      /** 独白模型等待上限（毫秒），超时用本地兜底句，不阻塞画图 */
      modelTimeoutMs: 10_000,
      /** 保留多少个过程 HTML，避免无限堆积 */
      keepHtml: 30,
      /** 台账里保留多少条记录 */
      keepIndex: 60,
    },
  },
  gui: {
    enabled: true,
    basePath: '/fish-dandan/api',
    /** 网页版设置页路径（与 basePath 同源，挂在同一个 web 服务上） */
    uiPath: '/fish-dandan/ui',
    maxBodyBytes: 64 * 1024,
    /** 是否允许非回环连接访问；默认只允许本机 */
    allowRemote: false,
    /** 从零配置向导的完成标记（本机状态，不入库） */
    wizardPath: 'data/state/wizard.json',
  },
  platforms: {
    /** 总开关；关闭时所有适配器都不连接、不执行 */
    enabled: false,
    /** 对外发送是否必须人工确认 */
    requireApproval: true,
    /** 06 抖音：登录会话与浏览器引擎 */
    /** 平台设置（刷流开关 / 互动能力 / 表达浓度）持久化位置；公开配置可入库，登录态不在这里 */
    settingsPath: 'data/state/platform-settings.json',
    douyin: {
      sessionPath: 'data/platform/douyin-session.json',
      /** 刷流量额度（今日已刷秒数 + 各互动次数），重启不清零，避免重启即超刷 */
      usagePath: 'data/state/douyin-usage.json',
      /** 看过的视频 id（去重，避免每次刷到同一条） */
      seenPath: 'data/state/douyin-seen.json',
      /** 它自己做过什么的流水账（点赞/评论/回复/转发/私信），只看不审批 */
      journalPath: 'data/state/douyin-journal.json',
      /** 值班会话的家目录（事件/日志/停止标记），值班模式开着才有内容 */
      dutyPath: 'data/duty',
      browserPath: '',
      /** 登录用浏览器调试端口 */
      loginPort: 9224,
      /** 刷流/围观用浏览器调试端口（兼容旧配置；现在所有服务走共享浏览器） */
      browsePort: 9225,
      /** 私信监听端口（兼容旧配置；现在监听和登录/活动共用共享浏览器） */
      listenPort: 9445,
      /** 值班会话用的浏览器端口 */
      dutyPort: 9334,
      /** 固定浏览器档案：开一次就一直留着，登录态/缓存都在，别频繁开关 */
      browserProfilePath: 'data/browser-profile',
      /** 共享浏览器发现文件：值班独立进程靠它找到插件那个浏览器 */
      hubStatePath: 'data/platform/browser-hub.json',
      /** 刷流单独一份档案：登录窗口留着时再开刷流不会抢实例 */
      // 刷流复用登录那份档案：同一台「设备」，登录态、指纹都是真的；另起一份会被抖音当成新设备
  browseProfilePath: 'data/browser-profile',
      loginTimeoutMs: 5 * 60_000,
      keepAliveHours: 12,
    },
    /** 拟人化发送延迟区间（毫秒） */
    sendDelayMs: { min: 400, max: 1600 },
    /** 每个平台每分钟最多发几条 */
    maxSendsPerMinute: 20,
    /** 各适配器自己的配置，基座不解释其内容 */
    adapterConfig: {},
    /** 身份归一的持久化路径 */
    identityPath: 'data/identity/identities.json',
  },
  security: {
    maxMemoryChars: 2000,
  },
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merge(base, patch, warnings, path = '') {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!isPlainObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    // YAML / JSON 里可能出现原型链键；配置不需要它们，直接丢弃。
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      warnings.push(`配置项 ${path ? `${path}.` : ''}${key} 不允许，已忽略`)
      continue
    }
    const current = out[key]
    const here = path ? `${path}.${key}` : key
    if (current === undefined) {
      warnings.push(`未知配置项 ${here}，已忽略`)
      continue
    }
    // 默认值是对象、用户给的却不是对象（YAML 少缩进最常见）：保留默认，别用字符串把对象顶掉。
    // 否则后面 `merged.memory.dbPath = ...` 会在字符串上赋值，严格模式直接抛异常，整个插件起不来。
    if (isPlainObject(current) && !isPlainObject(value)) {
      warnings.push(`配置 ${here} 应该是对象，收到 ${typeof value}，已保留默认值`)
      continue
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = merge(current, value, warnings, here)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 取某一段配置；不是对象就整段换成默认值并记一笔。 */
function section(config, key, warnings) {
  if (!isPlainObject(config[key])) {
    warnings.push(`配置 ${key} 不是对象，已整段回退默认值`)
    config[key] = structuredClone(DEFAULT_CONFIG[key])
  }
  return config[key]
}

function num(value, min, max, fallback, warnings, name) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    warnings.push(`配置 ${name} 不是合法数字，回退为 ${fallback}`)
    return fallback
  }
  if (n < min || n > max) {
    warnings.push(`配置 ${name} 超出范围 [${min}, ${max}]，已钳制`)
    return clampNumber(n, min, max, fallback)
  }
  return n
}

function timeText(value, fallback, warnings, name) {
  if (typeof value === 'string' && TIME_RE.test(value)) return value
  warnings.push(`配置 ${name} 不是 HH:MM，回退为 ${fallback}`)
  return fallback
}

/**
 * 合并用户配置并做范围校验。
 * @param {unknown} raw
 * @returns {{ config: typeof DEFAULT_CONFIG, warnings: string[] }}
 */
export function resolveConfig(raw) {
  const warnings = []
  let merged
  try {
    // 一定要深拷贝：merge 是浅合并，直接改 DEFAULT_CONFIG 会污染下一次调用
    merged = merge(structuredClone(DEFAULT_CONFIG), isPlainObject(raw) ? structuredClone(raw) : {}, warnings)
  } catch (err) {
    warnings.push(`配置合并失败（${err.message}），已整体回退默认值`)
    merged = structuredClone(DEFAULT_CONFIG)
  }

  // 逐段兜底：任何一段不是对象都换回默认值，后面的赋值才不会落在字符串上
  for (const key of ['persona', 'memory', 'stickers', 'image', 'decision', 'gui', 'platforms', 'security']) {
    section(merged, key, warnings)
  }
  for (const [owner, key] of [['image', 'doubao'], ['memory', 'autoCapture'], ['memory', 'halfLifeDays'], ['decision', 'quietHours'], ['platforms', 'sendDelayMs'], ['platforms', 'douyin']]) {
    const cfg = merged[owner]
    if (!isPlainObject(cfg[key])) {
      warnings.push(`配置 ${owner}.${key} 不是对象，已回退默认值`)
      cfg[key] = structuredClone(DEFAULT_CONFIG[owner][key])
    }
  }

  merged.dataDir = typeof merged.dataDir === 'string' && merged.dataDir.trim() ? merged.dataDir.trim() : 'data'

  for (const key of ['templatePath', 'corePath', 'auditPath', 'dbPath', 'jsonlPath', 'statePath', 'schedulerPath', 'pendingPath', 'activityPath']) {
    const target = key === 'templatePath' ? merged.persona : key === 'corePath' || key === 'auditPath' ? merged.persona : key === 'dbPath' || key === 'jsonlPath' ? merged.memory : merged.decision
    if (typeof target[key] !== 'string' || !target[key].trim()) {
      warnings.push(`配置 ${key} 非法，已回退默认`)
      target[key] = key === 'templatePath' ? DEFAULT_CONFIG.persona.templatePath
        : key === 'corePath' ? DEFAULT_CONFIG.persona.corePath
        : key === 'auditPath' ? DEFAULT_CONFIG.persona.auditPath
        : key === 'dbPath' ? DEFAULT_CONFIG.memory.dbPath
        : key === 'jsonlPath' ? DEFAULT_CONFIG.memory.jsonlPath
        : key === 'statePath' ? DEFAULT_CONFIG.decision.statePath
        : key === 'schedulerPath' ? DEFAULT_CONFIG.decision.schedulerPath
        : key === 'pendingPath' ? DEFAULT_CONFIG.decision.pendingPath
        : DEFAULT_CONFIG.decision.activityPath
    }
  }

  merged.persona.sectionOrder = num(merged.persona.sectionOrder, 1, 10_000, 60, warnings, 'persona.sectionOrder')
  merged.persona.contextOrder = num(merged.persona.contextOrder, 1, 10_000, 4200, warnings, 'persona.contextOrder')

  merged.memory.maxInject = Math.round(num(merged.memory.maxInject, 0, 20, 6, warnings, 'memory.maxInject'))
  merged.memory.recallLimit = Math.round(num(merged.memory.recallLimit, 1, 200, 20, warnings, 'memory.recallLimit'))
  merged.memory.halfLifeDays.episodic = num(merged.memory.halfLifeDays.episodic, 0.1, 3650, 14, warnings, 'memory.halfLifeDays.episodic')
  merged.memory.halfLifeDays.trait = num(merged.memory.halfLifeDays.trait, 0.1, 3650, 90, warnings, 'memory.halfLifeDays.trait')
  merged.memory.archiveThreshold = num(merged.memory.archiveThreshold, 0, 1, 0.08, warnings, 'memory.archiveThreshold')
  merged.memory.archiveAfterDays = num(merged.memory.archiveAfterDays, 1, 3650, 30, warnings, 'memory.archiveAfterDays')

  const d = merged.decision
  d.enabled = Boolean(d.enabled)
  d.tickIntervalMs = num(d.tickIntervalMs, 5_000, 3_600_000, 60_000, warnings, 'decision.tickIntervalMs')
  d.minDwellMs = num(d.minDwellMs, 0, 86_400_000, 15 * 60_000, warnings, 'decision.minDwellMs')
  d.wakeBaseMs = num(d.wakeBaseMs, 60_000, 86_400_000, 30 * 60_000, warnings, 'decision.wakeBaseMs')
  d.jitterRatio = num(d.jitterRatio, 0, 1, 0.35, warnings, 'decision.jitterRatio')
  d.minIdleMs = num(d.minIdleMs, 0, 86_400_000, 10 * 60_000, warnings, 'decision.minIdleMs')
  d.dailyBudget = Math.round(num(d.dailyBudget, 0, 96, 8, warnings, 'decision.dailyBudget'))
  d.quietHours.start = timeText(d.quietHours.start, '23:00', warnings, 'decision.quietHours.start')
  d.quietHours.end = timeText(d.quietHours.end, '07:00', warnings, 'decision.quietHours.end')
  d.autoExternal = Boolean(d.autoExternal)
  d.minActionGapMs = num(d.minActionGapMs, 0, 86_400_000, 20 * 60_000, warnings, 'decision.minActionGapMs')
  const limitDefaults = DEFAULT_CONFIG.decision.actionLimits
  const limitInput = d.actionLimits && typeof d.actionLimits === 'object' ? d.actionLimits : {}
  d.actionLimits = {}
  for (const kind of Object.keys(limitDefaults)) {
    const src = limitInput[kind] && typeof limitInput[kind] === 'object' ? limitInput[kind] : {}
    d.actionLimits[kind] = {
      dailyBudget: Math.round(num(src.dailyBudget, 0, 96, limitDefaults[kind].dailyBudget, warnings, `decision.actionLimits.${kind}.dailyBudget`)),
      gapMs: num(src.gapMs, 0, 86_400_000, limitDefaults[kind].gapMs, warnings, `decision.actionLimits.${kind}.gapMs`),
    }
  }
  d.reviewOnSleep = Boolean(d.reviewOnSleep)

  merged.gui.enabled = Boolean(merged.gui.enabled)
  // 这两个值会注入 HTML 的 <script> 与 img src，只允许路径安全字符，防止配置注入
  const SAFE_GUI_PATH = /^\/[A-Za-z0-9/_.-]*$/
  const safeGuiPath = (value, fallback, key) => {
    const v = typeof value === 'string' ? value.replace(/\/+$/, '') : ''
    if (SAFE_GUI_PATH.test(v) && !v.includes('..')) return v
    if (value !== undefined) warnings.push(`${key} 含非法字符，已回退默认值`)
    return fallback
  }
  merged.gui.basePath = safeGuiPath(merged.gui.basePath, DEFAULT_CONFIG.gui.basePath, 'gui.basePath')
  merged.gui.uiPath = safeGuiPath(merged.gui.uiPath, DEFAULT_CONFIG.gui.uiPath, 'gui.uiPath')
  merged.gui.maxBodyBytes = Math.round(num(merged.gui.maxBodyBytes, 1024, 1024 * 1024, 64 * 1024, warnings, 'gui.maxBodyBytes'))
  merged.gui.allowRemote = Boolean(merged.gui.allowRemote)

  const p = merged.platforms
  p.enabled = Boolean(p.enabled)
  p.requireApproval = p.requireApproval !== false
  const delay = p.sendDelayMs && typeof p.sendDelayMs === 'object' ? p.sendDelayMs : DEFAULT_CONFIG.platforms.sendDelayMs
  const min = num(delay.min, 0, 60_000, 400, warnings, 'platforms.sendDelayMs.min')
  const max = num(delay.max, 0, 60_000, 1600, warnings, 'platforms.sendDelayMs.max')
  p.sendDelayMs = { min: Math.min(min, max), max: Math.max(min, max) }
  p.maxSendsPerMinute = Math.round(num(p.maxSendsPerMinute, 1, 600, 20, warnings, 'platforms.maxSendsPerMinute'))
  p.adapterConfig = p.adapterConfig && typeof p.adapterConfig === 'object' && !Array.isArray(p.adapterConfig) ? p.adapterConfig : {}
  p.identityPath = typeof p.identityPath === 'string' && p.identityPath.trim()
    ? p.identityPath
    : DEFAULT_CONFIG.platforms.identityPath

  merged.security.maxMemoryChars = Math.round(num(merged.security.maxMemoryChars, 100, 20_000, 2000, warnings, 'security.maxMemoryChars'))

  // 端口一律按数字校验：配成字符串时 `loginPort + 1` 会变字符串拼接（"92241"）
  const dy = merged.platforms.douyin
  dy.loginPort = Math.round(num(dy.loginPort, 1024, 65_535, 9224, warnings, 'platforms.douyin.loginPort'))
  dy.browsePort = Math.round(num(dy.browsePort, 1024, 65_535, dy.loginPort + 1, warnings, 'platforms.douyin.browsePort'))
  dy.listenPort = Math.round(num(dy.listenPort, 1024, 65_535, 9445, warnings, 'platforms.douyin.listenPort'))
  dy.dutyPort = Math.round(num(dy.dutyPort, 1024, 65_535, 9334, warnings, 'platforms.douyin.dutyPort'))
  dy.keepAliveHours = num(dy.keepAliveHours, 0, 720, 12, warnings, 'platforms.douyin.keepAliveHours')
  dy.loginTimeoutMs = num(dy.loginTimeoutMs, 10_000, 3_600_000, 5 * 60_000, warnings, 'platforms.douyin.loginTimeoutMs')

  return { config: merged, warnings }
}

/** 解析静默时段为当天的分钟数区间。 */
export function quietMinutes(quietHours) {
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  return { start: toMin(quietHours.start), end: toMin(quietHours.end) }
}

/** 判断某一时刻是否处于静默时段（支持跨午夜）。 */
export function isQuietAt(now, quietHours) {
  const { start, end } = quietMinutes(quietHours)
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  if (start === end) return false
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

/** 若在静默时段，返回静默结束时刻；否则返回 null。 */
export function quietEndAfter(now, quietHours) {
  if (!isQuietAt(now, quietHours)) return null
  const { end } = quietMinutes(quietHours)
  const d = new Date(now)
  const target = new Date(d)
  target.setHours(Math.floor(end / 60), end % 60, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return target.getTime()
}
