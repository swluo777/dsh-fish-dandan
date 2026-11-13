// ============================================================
// 06 抖音适配器：登录会话 + 模型值班 + 自主互动。
// 实现 05 契约 connect / disconnect / normalize / send / capabilities。
// 生产刷流只有模型值班（duty.js）一条路径；旧脚本 browse.js 已删除。
// ============================================================

import { createSessionStore } from './session.js'
import { createLoginFlow, probeAlive } from './login.js'
import { createJournal } from './journal.js'
import { createDutyService } from './duty.js'
import { createPlatformSettings } from '../settings.js'
import { createInboxWatcher } from './listener.js'
import { sweepStaleProfiles } from './temp-profiles.js'
import { createBrowserHub } from './browser-hub.js'

export function createDouyinAdapter({ config, logger, memory, decision, persona }) {
  const sessionStore = createSessionStore({ config, logger })
  // 全项目唯一的一个浏览器、一份档案；登录/活动/监听/值班都连它，各用各的标签页。
  const browserHub = createBrowserHub({ config, logger })
  const loginFlow = createLoginFlow({
    config,
    logger,
    sessionStore,
    hub: browserHub,
    // 扫码/导入成功后才启动监听与自唤醒；状态查询本身不再拉起任何服务。
    onSuccess: () => ensureSessionServices(),
  })
  const journal = createJournal({ config, logger })
  const settingsStore = createPlatformSettings({ config, logger })
  const duty = createDutyService({ config, logger, memory, journalStore: journal, platformSettings: settingsStore, persona, hub: browserHub })
  // 私信监听：共享浏览器里的一个常驻标签页，开关打开就轮询，关掉就只关这个标签。
  // 实时回复由宿主注入的草稿器负责（见 setDraftHandler），不依赖值班。
  let draftHandler = null
  const inboxWatcher = createInboxWatcher({
    config,
    logger,
    platformSettings: settingsStore,
    hub: browserHub,
    onMessage: async (item, api) => {
      if (typeof draftHandler !== 'function') {
        logger.warn?.('私信监听：收到新私信，但自动回复还没接上（只入队不回）')
        return
      }
      if (item.status !== 'approved') return
      logger.info?.(`私信监听：交给自动回复（${item.name}）`)
      return await draftHandler(item, api)
    },
  })
  // 心情驱动的自唤醒：只有设置里明确打开时才挂 20 分钟定时器；默认关。
  // 开关本身只是权限，不是「到点必刷」；每次到点还要看精力、无聊、静默时段。
  let autoWakeTimer = null
  let selfFactDone = false

  function autoWakeEnabled() {
    try { return settingsStore.get()?.douyin?.autoWake?.enabled === true } catch { return false }
  }

  /** 三个开关同时满足才允许自唤醒：平台总开关、刷抖音权限、自唤醒权限。 */
  function autoWakeAllowed() {
    if (!config.platforms.enabled) return false
    try {
      const d = settingsStore.get()?.douyin
      return d?.browse?.enabled === true && d?.autoWake?.enabled === true
    } catch { return false }
  }

  function startAutoWake() {
    if (!autoWakeAllowed() || !sessionStore.load()) { stopAutoWake(); return }
    if (autoWakeTimer) return
    autoWakeTimer = setInterval(() => {
      try {
        if (!autoWakeAllowed()) { stopAutoWake(); return }
        const cfg = settingsStore.get()?.douyin
        if (!cfg || !cfg.browse || !cfg.browse.enabled) return
        const snap = duty.snapshot()
        if (snap.running) return
        // 自唤醒不做网络探测：只认本地登录态，避免每 20 分钟发一次请求
        if (loginState({ probe: false }) !== 'connected') return
        const st = decision && typeof decision.getInternalState === 'function' ? decision.getInternalState() : null
        const vars = (st && st.vars) || {}
        const energy = Number(vars.energy ?? 100)
        if (energy < 35) return
        // 静默时段（和「行为调度」里设的一致）不自动去刷；手动点按钮不受这个限制
        if (decision && typeof decision.canWake === 'function' && !decision.canWake(Date.now())) return
        const last = Number(snap.lastRun && snap.lastRun.at) || 0
        if (Date.now() - last < 60 * 60_000) return
        const drive = (Number(vars.boredom) || 0) * 0.5 + (Number(vars.socialNeed) || 0) * 0.3
        const chance = Math.min(0.6, Math.max(0.1, drive / 100))
        if (Math.random() > chance) return
        const r = duty.start('自己醒了')
        logger.info?.(r.ok
          ? `自唤醒：心情到了（无聊 ${Math.round(Number(vars.boredom) || 0)}、精力 ${Math.round(energy)}），去抖音待一会儿`
          : `自唤醒没成：${r.reason}`)
      } catch (err) {
        logger.warn?.(`自唤醒失败：${err.message}`)
      }
    }, 20 * 60_000)
    autoWakeTimer.unref?.()
    logger.info?.('自唤醒已挂上（每 20 分钟看一次心情，想刷才刷）')
  }

  function stopAutoWake() {
    if (!autoWakeTimer) return
    clearInterval(autoWakeTimer)
    autoWakeTimer = null
  }

  function applyAutoWake() {
    try {
      if (autoWakeEnabled()) startAutoWake()
      else stopAutoWake()
    } catch (err) {
      logger.warn?.(`自唤醒开关应用失败：${err.message}`)
    }
  }

  /**
   * 让它在聊天里知道「我有抖音号、我会自己刷」。
   * 只写一次，锚定在记忆里；没有登录态不写，免得它以为自己有个空号。
   */
  function ensureSelfFact() {
    if (selfFactDone || !memory || typeof memory.recordEvent !== 'function') return
    try {
      const anchors = memory.list({ tier: 'anchor', limit: 50 }) || []
      if (anchors.some((r) => Array.isArray(r.tags) && r.tags.includes('self-douyin'))) { selfFactDone = true; return }
      memory.recordEvent(
        {
          content: '我在抖音有一个自己的号（登录在本机）。我会自己刷视频、点赞、关注、评论、回复，那是我自己的生活，不是别人的。',
          tier: 'anchor', importance: 9, tags: ['self-douyin', '抖音', '自我'], summary: '我有抖音号',
        },
        'douyin-self',
      )
      selfFactDone = true
      logger.info?.('已记住：它自己有一个抖音号')
    } catch (err) {
      logger.warn?.(`抖音自我事实写入失败：${err.message}`)
    }
  }
  /**
   * 登录成功后要长期跑的东西：自我事实、私信监听、自唤醒。
   * 只在这里启动一次；状态查询（status/login.snapshot）不再顺带拉起任何服务。
   */
  let servicesStarted = false
  function ensureSessionServices() {
    if (servicesStarted) return
    if (!sessionStore.load()) return
    servicesStarted = true
    ensureSelfFact()
    try { inboxWatcher.start() } catch (err) { logger.warn?.(`私信监听启动失败：${err.message}`) }
    try { startAutoWake() } catch (err) { logger.warn?.(`自唤醒启动失败：${err.message}`) }
  }

  /** 退出登录/断开平台时，把常驻服务一起收掉，不留后台浏览器和定时器。 */
  function stopSessionServices() {
    servicesStarted = false
    try { inboxWatcher.stop() } catch (err) { logger.warn?.(`私信监听停止失败：${err.message}`) }
    stopAutoWake()
  }

  let lastProbeAt = 0
  let lastProbe = { alive: null, reason: 'not-checked' }
  let probePending = null

  function cookieHeader() {
    const session = sessionStore.load()
    if (!session || !Array.isArray(session.cookies)) return null
    return session.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  /**
   * 登录态：只读本地会话 + 惰性保活探测。
   * 不启动监听/自唤醒——那些是登录成功后的常驻服务，由 ensureSessionServices 负责。
   * @param {{ probe?: boolean }} [options] probe=false 时连网络探测都不做（给定时器用）
   */
  function loginState({ probe = true } = {}) {
    const session = sessionStore.load()
    if (!session) return 'logged-out'
    // 刚扫码保存的会话比上次探测新：直接认为活着，别让界面继续显示「登录过期」。
    // 以前看 loginFlow.phase==='success'，可那个相位永不复位（审计发现）。
    if (session.savedAt && session.savedAt > lastProbeAt) {
      lastProbe = { alive: true, reason: 'ok' }
      lastProbeAt = session.savedAt
    }
    if (!probe) {
      if (lastProbe.alive === false && lastProbe.reason !== 'network-error') return 'expired'
      return 'connected'
    }
    // 惰性保活：距上次探测超过 keepAliveHours 才真正发请求，平时只读本地。
    // 判成过期时缩短到 60 秒重验一次：网络抖动/风控误判能自己恢复，不会一直挂着红字。
    // 单飞：同一时刻只允许一个探测在飞，否则状态轮询会连发好几次（审计发现）。
    const hours = config.platforms.douyin.keepAliveHours ?? 12
    const due = Date.now() - lastProbeAt > (lastProbe.alive === false ? 60_000 : hours * 3600_000)
    if ((lastProbe.alive === null || due) && !probePending) {
      probePending = probeAlive(cookieHeader(), { logger })
        .then((r) => { lastProbe = r })
        .catch((err) => { lastProbe = { alive: null, reason: `probe-failed: ${err.message}` } })
        .finally(() => { probePending = null; lastProbeAt = Date.now() })
    }
    // 网络错误不等于过期：只有明确判失效才让人重新扫码
    if (lastProbe.alive === false && lastProbe.reason !== 'network-error') return 'expired'
    return 'connected'
  }

  // 已有登录态：插件起来就把常驻服务接上，不再等某次状态查询来触发。
  ensureSessionServices()

  return {
    platform: 'douyin',
    name: '抖音',
    detail: '它自己刷、自己决定点不点赞，不用你盯着。',
    connected: false,

    capabilities() {
      // 保留 browse 这个能力名给网页/平台契约；实际执行已经只有模型值班。
      return ['session', 'browse', 'interact']
    },

    /** 一轮的统一入口：只有模型值班。值班起不成就把原因亮出来，不退回脚本。 */
    startRound(why = 'manual') {
      return duty.start(why)
    },

    stopRound() {
      return duty.stop()
    },

    roundSnapshot() {
      const d = duty.snapshot()
      // 只返回值班事实 + 流水账统计；不再混入旧脚本的 today/lastRun。
      let journalCounts = { total: 0, today: 0, byType: {} }
      try { journalCounts = journal.counts() } catch { /* 统计失败不影响状态 */ }
      return {
        ...d,
        journal: journalCounts,
      }
    },

    connect() {
      this.connected = true
      // 启动兜底：先清掉上次强杀留下的临时浏览器档案，再接常驻服务。
      // 只清 12 小时前的 fish-douyin-*，占用中的 rename 失败会自动跳过。
      try { sweepStaleProfiles({ logger }) } catch (err) { logger.warn?.(`临时浏览器档案清扫失败：${err.message}`) }
      ensureSessionServices()
      loginState() // 顺手做一次惰性保活
      return undefined
    },

    disconnect() {
      this.connected = false
      stopSessionServices()
    },

    duty,

    /** 给宿主读当前平台设置（被动私信只读 expressionLevel，不写）。 */
    settings: () => settingsStore.get(),

    /** P1 只读刷流时实现完整归一化；当前不会收到抖音事件。 */
    normalize(event) {
      return {
        conversation: { kind: event?.kind || 'private', externalId: event?.convId || 'douyin-direct' },
        sender: { platformUserId: event?.userId || 'unknown', displayName: event?.name || '' },
        content: event?.text || '',
        nativeMessageId: event?.id || '',
        raw: event || {},
      }
    },

    /** 宿主主动出站（比如收到私信后回一条）还没接；刷流里的互动由值班会话自己执行，不走这里。 */
    send() {
      throw new Error('宿主主动出站尚未接入；刷流中的互动由它自己判断并执行')
    },

    status() {
      return loginState()
    },

    /** 供 GUI 使用：登录流程与存储快照。 */
    login: {
      snapshot: () => ({ ...loginFlow.snapshot(), status: loginState(), detail: loginFlow.snapshot().detail }),
      start: () => loginFlow.start(),
      cancel: () => loginFlow.cancel(),
      logout: async () => {
        sessionStore.clear()
        stopSessionServices()
        lastProbe = { alive: false, reason: 'logged-out' }
        lastProbeAt = Date.now()
        // 只清加密会话不够：固定档案里的 Cookie 还在，浏览器会继续显示已登录。
        // 浏览器开着就当场清；没开就留标记，下次启动前先清。
        try { await browserHub.logout() } catch (err) { logger.warn?.(`退出登录清理浏览器失败：${err.message}`) }
        loginState({ probe: false })
      },
      /**
       * 降级路径：CDP 不可用时手动导入 Cookie。接受数组或 "name=value; ..." 字符串。
       * 与扫码走同一份加密存储，导入前不校验内容真伪——由保活探测负责识别失效。
       */
      importCookies(raw) {
        let cookies = raw
        if (typeof raw === 'string') {
          cookies = raw.split(';').map((pair) => {
            const idx = pair.indexOf('=')
            if (idx <= 0) return null
            return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '.douyin.com', path: '/' }
          }).filter(Boolean)
        }
        // 逐项清洗：数组里混进 null / 无名字的项时，以前会直接 TypeError（GUI 500）
        const cleaned = (Array.isArray(cookies) ? cookies : [])
          .filter((c) => c && typeof c === 'object')
          .map((c) => ({
            name: String(c.name || '').trim(),
            value: String(c.value ?? ''),
            domain: String(c.domain || '.douyin.com'),
            path: String(c.path || '/'),
            ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
            ...(c.secure === true ? { secure: true } : {}),
            ...(c.httpOnly === true ? { httpOnly: true } : {}),
          }))
          // 只留抖音域的 Cookie：不把无关网站的凭证一起存进来、一起送出去
          .filter((c) => c.name && c.domain.includes('douyin'))
        if (!cleaned.some((c) => c.name.startsWith('sessionid'))) {
          throw new Error('导入的 Cookie 里没有找到 sessionid（登录态主标识），确认是从已登录的抖音网页复制')
        }
        sessionStore.save(cleaned, { account: 'douyin-web', source: 'manual-import' })
        ensureSessionServices()
        return { ...loginFlow.snapshot(), status: loginState({ probe: false }) }
      },
      sessionPath: sessionStore.path,
    },

    /** 自唤醒开关：默认关；设置页保存后由 API 调 apply 立即生效。 */
    autoWake: {
      snapshot: () => ({ enabled: autoWakeEnabled(), running: Boolean(autoWakeTimer) }),
      apply: () => applyAutoWake(),
    },

    /** 私信监听（共享浏览器标签页；被动回复归监听，实时回复靠宿主注入的草稿器） */
    inbox: {
      start: () => inboxWatcher.start(),
      stop: () => inboxWatcher.stop(),
      /** 开关变化时调用：开=起浏览器开始轮询，关=关浏览器 */
      apply: (reason) => inboxWatcher.apply(reason),
      snapshot: () => inboxWatcher.snapshot(),
      decide: (id, status) => inboxWatcher.decide(id, status),
      reply: (name, text) => inboxWatcher.reply(name, text),
      sendSticker: (name, file) => inboxWatcher.sendSticker(name, file),
      peek: (name) => inboxWatcher.peek(name),
      /** 宿主注入草稿器：收到新私信时由它生成回复 */
      setDraftHandler: (fn) => { draftHandler = typeof fn === 'function' ? fn : null },
      getDraftHandler: () => draftHandler,
    },

    /**
     * 它做过什么：只读流水账，不需要谁批准。
     * 记录里带当时的心情和理由，方便回头看它是不是越来越像自己。
     */
    journal: {
      list: (limit) => journal.list({ limit: limit || 50 }),
      counts: () => journal.counts(),
    },

    /** 插件卸载时停掉常驻服务和共享浏览器。 */
    dispose() {
      stopSessionServices()
      try { loginFlow.dispose?.() } catch (err) { logger.warn?.(`登录流程卸载失败：${err.message}`) }
      Promise.resolve(browserHub.shutdown()).catch((err) => logger.warn?.(`共享浏览器关闭失败：${err.message}`))
    },

    /** 内部调试用：取 Cookie 头（P1 刷流时用），绝不进日志。 */
    _cookieHeader: cookieHeader,
  }
}
