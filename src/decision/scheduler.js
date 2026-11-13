// ============================================================
// 有界调度：静默时段 / 每日预算 / 随机抖动 / 最小空闲
// 只有一个 nextWakeAt，错过的触发不重放，只按最新时刻安排
// ============================================================

import { isQuietAt, quietEndAfter } from '../config.js'
import { clampNumber, localDateKey } from '../utils/text.js'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function createScheduler({ config, now = Date.now(), persisted = null, random = Math.random }) {
  const d = config.decision
  const state = {
    dateKey: localDateKey(now),
    used: 0,
    lastActivity: now,
    nextWakeAt: 0,
  }

  if (persisted && typeof persisted === 'object') {
    // 调度参数也要还原：以前只存日期/预算用量，界面说「已保存」重启却回默认
    if (persisted.settings) applyPatch(persisted.settings)
    state.dateKey = typeof persisted.dateKey === 'string' ? persisted.dateKey : state.dateKey
    state.used = Math.round(clampNumber(persisted.used, 0, d.dailyBudget, 0))
    state.lastActivity = Number.isFinite(persisted.lastActivity) ? persisted.lastActivity : now
    state.nextWakeAt = Number.isFinite(persisted.nextWakeAt) ? persisted.nextWakeAt : 0
  }
  if (!state.nextWakeAt) state.nextWakeAt = computeNextWake(now)

  function rollover(at) {
    const key = localDateKey(at)
    if (key !== state.dateKey) {
      state.dateKey = key
      state.used = 0
    }
  }

  function computeNextWake(at) {
    rollover(at)
    const base = d.wakeBaseMs * (1 + (random() * 2 - 1) * d.jitterRatio)
    let candidate = Math.max(at + Math.max(base, 1_000), state.lastActivity + d.minIdleMs)
    if (isQuietAt(candidate, d.quietHours)) {
      const end = quietEndAfter(candidate, d.quietHours)
      const extra = Math.max(0, d.wakeBaseMs * d.jitterRatio * random())
      candidate = (end ?? candidate) + extra
    }
    return Math.round(candidate)
  }

  function canWake(at) {
    rollover(at)
    if (d.dailyBudget <= 0) return false
    if (state.used >= d.dailyBudget) return false
    if (at < state.nextWakeAt) return false
    if (at - state.lastActivity < d.minIdleMs) return false
    if (isQuietAt(at, d.quietHours)) return false
    return true
  }

  function recordWake(at) {
    rollover(at)
    state.used += 1
    state.lastActivity = at
    state.nextWakeAt = computeNextWake(at)
    return state.used
  }

  function recordActivity(at) {
    state.lastActivity = at
    if (state.nextWakeAt < at + d.minIdleMs) state.nextWakeAt = computeNextWake(at)
  }

  function update(patch = {}) {
    const { issues, changed } = applyPatch(patch)
    // 只有真的改了参数才重算：以前点一次「保存」就把快到的唤醒又推后半小时
    if (changed) state.nextWakeAt = computeNextWake(Date.now())
    return { ok: issues.length === 0, issues }
  }

  /** 把补丁应用到调度配置，返回问题与是否真的变化（构造时复用它回放已存设置）。 */
  function applyPatch(patch = {}) {
    const issues = []
    let changed = false
    if (patch.quietHours && typeof patch.quietHours === 'object') {
      const { start, end } = patch.quietHours
      if (typeof start === 'string' && TIME_RE.test(start)) {
        if (d.quietHours.start !== start) { d.quietHours.start = start; changed = true }
      } else if (start !== undefined) issues.push('quietHours.start 需为 HH:MM')
      if (typeof end === 'string' && TIME_RE.test(end)) {
        if (d.quietHours.end !== end) { d.quietHours.end = end; changed = true }
      } else if (end !== undefined) issues.push('quietHours.end 需为 HH:MM')
    }
    if (patch.dailyBudget !== undefined) {
      const next = Math.round(clampNumber(patch.dailyBudget, 0, 96, d.dailyBudget))
      if (next !== d.dailyBudget) { d.dailyBudget = next; changed = true }
      if (state.used > d.dailyBudget) state.used = d.dailyBudget
    }
    if (patch.jitterRatio !== undefined) {
      const next = clampNumber(patch.jitterRatio, 0, 1, d.jitterRatio)
      if (next !== d.jitterRatio) { d.jitterRatio = next; changed = true }
    }
    if (patch.minIdleMs !== undefined) {
      const next = clampNumber(patch.minIdleMs, 0, 86_400_000, d.minIdleMs)
      if (next !== d.minIdleMs) { d.minIdleMs = next; changed = true }
    }
    if (patch.wakeBaseMs !== undefined) {
      const next = clampNumber(patch.wakeBaseMs, 60_000, 86_400_000, d.wakeBaseMs)
      if (next !== d.wakeBaseMs) { d.wakeBaseMs = next; changed = true }
    }
    return { issues, changed }
  }

  function snapshot(at = Date.now()) {
    rollover(at)
    return {
      enabled: d.enabled,
      quietHours: { ...d.quietHours },
      dailyBudget: d.dailyBudget,
      usedToday: state.used,
      jitterRatio: d.jitterRatio,
      minIdleMs: d.minIdleMs,
      wakeBaseMs: d.wakeBaseMs,
      nextWakeAt: state.nextWakeAt || null,
      inQuietHours: isQuietAt(at, d.quietHours),
      lastActivity: state.lastActivity,
    }
  }

  function persistable() {
    return {
      dateKey: state.dateKey,
      used: state.used,
      lastActivity: state.lastActivity,
      nextWakeAt: state.nextWakeAt,
      settings: {
        quietHours: { ...d.quietHours },
        dailyBudget: d.dailyBudget,
        jitterRatio: d.jitterRatio,
        minIdleMs: d.minIdleMs,
        wakeBaseMs: d.wakeBaseMs,
      },
    }
  }

  return { canWake, recordWake, recordActivity, computeNextWake, update, snapshot, persistable, isQuietAt: (at) => isQuietAt(at, d.quietHours) }
}
