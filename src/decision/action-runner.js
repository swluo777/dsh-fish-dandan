// ============================================================
// 行为执行器：把「状态机想做什么」接到真正会跑的动作上。
// 同一时间只允许一个活动；活动状态写回 decision，GUI 只读这一份。
// 设计：docs/architecture/24-行为执行器与自动策略设计.md
// ============================================================

import { STATE_LABELS } from './state.js'

const LABELS = {
  explore: '自主探索',
  social: '社交互动',
  create: '专注创作',
}

function clean(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function loginStatus(adapter) {
  try {
    const snap = adapter?.login?.snapshot?.()
    return String(snap?.status || 'unknown')
  } catch {
    return 'unknown'
  }
}

/**
 * @param {{
 *   config: object,
 *   logger: object,
 *   decision: object,
 *   getDouyin: () => object,
 *   getDraw?: () => object,
 * }} deps
 */
export function createActionRunner({ config, logger, decision, getDouyin, getDraw } = {}) {
  let activity = null
  let currentRun = null
  let unsubscribeSettled = null

  function adapter() {
    try { return getDouyin?.() || null } catch { return null }
  }

  function drawStudio() {
    try { return getDraw?.() || null } catch { return null }
  }

  function bindDouyin() {
    if (unsubscribeSettled) return
    const dy = adapter()
    if (dy && typeof dy.onRoundSettled === 'function') {
      unsubscribeSettled = dy.onRoundSettled(onRoundSettled)
    }
  }

  function activityView() {
    return activity ? { ...activity } : null
  }

  function saveActivity(patch = {}) {
    activity = { ...(activity || {}), ...patch }
    try { decision.setActivity(activity) } catch (err) { logger?.warn?.(`活动状态写入失败：${err.message}`) }
    return activity
  }

  function finish(id, status, detail, result) {
    if (!activity || (id && activity.id !== id)) return activity
    return saveActivity({
      status,
      detail: clean(detail, 180),
      endedAt: Date.now(),
      canStop: false,
      result: result || null,
      updatedAt: Date.now(),
    })
  }

  function skip(kind, reason, trigger = 'state') {
    const id = `${Date.now()}-${kind}-skip`
    activity = {
      id,
      kind,
      label: LABELS[kind] || kind,
      status: 'skipped',
      trigger,
      detail: clean(reason, 180),
      startedAt: Date.now(),
      endedAt: Date.now(),
      canStop: false,
      result: { ok: false, reason: clean(reason, 180) },
    }
    try { decision.setActivity(activity) } catch { /* 忽略 */ }
    logger?.info?.(`${LABELS[kind] || kind}跳过：${clean(reason, 120)}`)
    return { ok: false, reason: clean(reason, 180), activity: activityView() }
  }

  // 抖音本地动作只认平台页的「允许它用抖音」；platforms.enabled 是适配器连接/出站开关，
  // 不再拦刷流和社交。关掉「允许它用抖音」时，手动触发也一样不启动。
  function settingsGate(adapterInstance, kind) {
    if (kind === 'create') return ''
    let s
    try { s = adapterInstance?.settings?.() || {} } catch { s = {} }
    // 适配器的 settings() 返回整份平台设置：douyin.browse / douyin.actions / douyin.listen。
    const douyin = s.douyin || {}
    if (douyin.browse?.enabled !== true) return '平台页的刷抖音权限没打开；请先到「平台」页把「允许它用抖音」打开，再回来点「立即触发一次」'
    const login = loginStatus(adapterInstance)
    if (login !== 'connected' && login !== 'unknown') return '抖音还没登录；请先去「平台」页扫码登录，再回来点「立即触发一次」'
    if (kind === 'social') {
      if (douyin.actions?.dm !== true) return '平台页的「私信（主动）」没打开；请先去「平台」页打开它，再回来点「立即触发一次」'
      if (!String(douyin.listen?.ownerName || '').trim()) return '平台页还没填「我的抖音昵称」；请先去「平台」页填好并保存，再回来点「立即触发一次」'
    }
    return ''
  }

  function prepare(kind, context = {}) {
    const dy = adapter()
    if (kind === 'explore') {
      return {
        text: '去抖音逛一圈，把有意思的东西记下来',
        payload: { task: 'explore' },
        preview: { title: '自主探索', detail: '它会去抖音刷一轮；刷到什么由它自己决定，记下的东西会在这一轮结束时写进记忆。' },
      }
    }
    if (kind === 'social') {
      const owner = clean(dy?.settings?.()?.douyin?.listen?.ownerName || '', 40)
      return {
        text: owner ? `找${owner}聊两句，看看对方在忙什么` : '找主人聊两句，看看对方在忙什么',
        payload: { task: 'social', target: owner || '主人', maxBubbles: 2 },
        preview: {
          title: '社交互动',
          detail: owner
            ? `它会先读和「${owner}」的最近对话，再发 1-2 句；发完就结束，这一轮不会继续刷视频。`
            : '它会先读和主人的最近对话，再发 1-2 句；发完就结束。',
          owner,
        },
      }
    }
    if (kind === 'create') {
      const draw = drawStudio()
      const view = draw?.preview ? draw.preview({ trigger: context.trigger || 'state' }) : null
      return {
        text: view?.text || '画一张图放桌面',
        payload: { theme: 'free', stickerId: view?.payload?.stickerId || '', plan: view?.plan || null },
        preview: {
          title: '专注创作',
          detail: view?.detail || '它会用当前心情和表情包当参考，画一张手绘稿放到桌面。',
        },
      }
    }
    return { payload: null, preview: null }
  }

  function begin(kind, { trigger = 'state', payload = null, preview = null } = {}) {
    const id = `${Date.now()}-${kind}`
    activity = {
      id,
      kind,
      label: LABELS[kind] || STATE_LABELS[kind] || kind,
      status: 'running',
      trigger,
      detail: clean(preview?.detail || '', 180),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      canStop: true,
      preview: preview || null,
      result: null,
    }
    currentRun = { id, kind, roundId: '', cancelRequested: false, promise: null }
    saveActivity(activity)
    return currentRun
  }

  function startExplore({ trigger = 'state' } = {}) {
    const dy = adapter()
    if (!dy || typeof dy.startRound !== 'function') return skip('explore', '抖音适配器没有准备好', trigger)
    const gate = settingsGate(dy, 'explore')
    if (gate) return skip('explore', gate, trigger)
    const prepared = prepare('explore')
    const run = begin('explore', { trigger, payload: prepared.payload, preview: prepared.preview })
    const result = dy.startRound('自主探索', { task: 'explore', owner: trigger })
    if (!result?.ok) {
      finish(run.id, 'failed', result?.reason || '值班没有起来', result)
      currentRun = null
      return { ok: false, reason: result?.reason || '值班没有起来', activity: activityView() }
    }
    run.roundId = result?.round?.id || ''
    saveActivity({ roundId: run.roundId, detail: result?.detail || prepared.preview?.detail || '正在去抖音刷一轮' })
    return { ok: true, started: true, activity: activityView() }
  }

  function startSocial({ trigger = 'state' } = {}) {
    const dy = adapter()
    if (!dy || typeof dy.startRound !== 'function') return skip('social', '抖音适配器没有准备好', trigger)
    const gate = settingsGate(dy, 'social')
    if (gate) return skip('social', gate, trigger)
    const prepared = prepare('social')
    const run = begin('social', { trigger, payload: prepared.payload, preview: prepared.preview })
    const result = dy.startRound('社交互动', { task: 'social', owner: 'social' })
    if (!result?.ok) {
      finish(run.id, 'failed', result?.reason || '值班没有起来', result)
      currentRun = null
      return { ok: false, reason: result?.reason || '值班没有起来', activity: activityView() }
    }
    run.roundId = result?.round?.id || ''
    saveActivity({ roundId: run.roundId, detail: `正在找${prepared.preview?.owner || '主人'}聊两句` })
    return { ok: true, started: true, activity: activityView() }
  }

  function startCreate({ trigger = 'state', pending = null, decision: decisionSnapshot = null } = {}) {
    const draw = drawStudio()
    if (!draw || typeof draw.draw !== 'function') return skip('create', '画图模块没有准备好', trigger)
    // 审批/自动触发时，执行的就是主人看到/调度决定的那张计划，不再临时换一张。
    const decidedPlan = pending?.plan?.payload?.plan || decisionSnapshot?.plan?.payload?.plan || null
    const source = pending?.plan || decisionSnapshot?.plan || null
    const prepared = decidedPlan && source
      ? {
          text: source.text || '画一张图放桌面',
          payload: source.payload || {},
          preview: source.preview || { title: '专注创作', detail: '按已经确认的画面画一张手绘稿。' },
        }
      : prepare('create')
    const fixedPlan = decidedPlan || prepared.payload?.plan || null
    const run = begin('create', { trigger, payload: prepared.payload, preview: prepared.preview })
    run.promise = (async () => {
      let result = null
      try {
        result = await draw.draw({
          trigger,
          plan: fixedPlan,
          onProgress: (text) => {
            if (!activity || activity.id !== run.id) return
            if (['done', 'failed', 'cancelled'].includes(activity.status)) return
            saveActivity({ detail: clean(text, 180) })
          },
          isCancelled: () => run.cancelRequested,
        })
      } catch (err) {
        result = { ok: false, reason: err.message }
      }
      if (!activity || activity.id !== run.id) return
      if (run.cancelRequested || result?.cancelled) {
        if (!['cancelled'].includes(activity.status)) finish(run.id, 'cancelled', '主人强制停止了这一轮', result)
      } else if (result?.ok) {
        finish(run.id, 'done', `画好了，放在桌面：${result.pngPath}`, {
          ok: true,
          pngPath: result.pngPath,
          htmlPath: result.htmlPath,
          plan: result.plan,
          ms: result.ms,
        })
      } else {
        finish(run.id, 'failed', result?.reason || '没有画成', result)
      }
      currentRun = null
    })()
    return { ok: true, started: true, activity: activityView() }
  }

  function start(kind, options = {}) {
    bindDouyin()
    if (!['explore', 'social', 'create'].includes(kind)) return { ok: false, reason: `未知动作：${kind}` }
    if (activity && ['running', 'stopping'].includes(activity.status)) {
      return { ok: false, reason: `它正在${activity.label || '忙'}，等这一轮结束再开始`, activity: activityView() }
    }
    if (kind === 'explore') return startExplore(options)
    if (kind === 'social') return startSocial(options)
    return startCreate(options)
  }

  function onRoundSettled(result) {
    const run = currentRun
    if (!run) return
    if (run.kind !== 'explore' && run.kind !== 'social') return
    const roundId = result?.round?.id || ''
    if (run.roundId && roundId && run.roundId !== roundId) return
    if (!run.roundId && !roundId) {
      const dy = adapter()
      if (dy?.roundSnapshot?.()?.running) return
    }
    if (run.kind === 'social' && result?.socialSent) {
      finish(run.id, 'done', '已经找主人聊过了', result)
    } else if (run.cancelRequested) {
      finish(run.id, 'cancelled', '主人强制停止了这一轮', result)
    } else if (result?.ok) {
      finish(run.id, 'done', result?.lastRun?.detail || '这一轮已经结束', result)
    } else {
      finish(run.id, 'failed', result?.lastRun?.error || '这一轮没有正常结束', result)
    }
    currentRun = null
  }

  async function stop(reason = 'manual') {
    if (!activity || !['running', 'stopping'].includes(activity.status)) {
      return { ok: false, reason: '现在没有正在做的动作', activity: activityView() }
    }
    const run = currentRun
    if (run) run.cancelRequested = true
    saveActivity({ status: 'stopping', detail: '正在停止…', canStop: false })
    if (run?.kind === 'create') {
      // 画图是本地任务：标记后由它自己收尾（关页面、删半成品、写活动记录）
      finish(run.id, 'cancelled', '主人强制停止了这一轮')
      currentRun = null
      return { ok: true, activity: activityView() }
    }
    const dy = adapter()
    const result = dy?.stopRound?.(reason)
    if (!result?.ok) {
      finish(run?.id || activity.id, 'cancelled', result?.reason || '没有正在进行的轮次', result)
      currentRun = null
    }
    return { ok: true, activity: activityView() }
  }

  function snapshot() {
    return activityView()
  }

  function dispose() {
    try { unsubscribeSettled?.() } catch { /* 忽略 */ }
    unsubscribeSettled = null
  }

  return { prepare, start, stop, snapshot, dispose, bind: bindDouyin }
}
