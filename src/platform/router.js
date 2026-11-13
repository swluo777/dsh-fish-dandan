// ============================================================
// 出站闸门：总开关 → 人工确认 → 限流 → 拟人化延迟
// 与具体平台无关，06/07/08 共用
// ============================================================

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {{ config: object, logger: object, random?: () => number, sleep?: Function, now?: () => number }} deps
 */
export function createSendGate({ config, logger, random = Math.random, sleep = defaultSleep, now = () => Date.now() }) {
  const buckets = new Map()
  // 每个平台一条串行链：并发调用不会在「延迟」期间一起冲进额度判断。
  const queues = new Map()

  function enqueue(platform, task) {
    const prev = queues.get(platform) || Promise.resolve()
    const next = prev.then(task, task)
    // 链上只保留「已完成」信号，避免失败把后续调用一起拖垮
    queues.set(platform, next.then(() => undefined, () => undefined))
    return next
  }

  function recent(platform, at) {
    const list = buckets.get(platform) ?? []
    const cutoff = at - 60_000
    const kept = list.filter((ts) => ts > cutoff)
    buckets.set(platform, kept)
    return kept
  }

  function allow(platform) {
    const at = now()
    const list = recent(platform, at)
    if (list.length >= config.platforms.maxSendsPerMinute) return false
    list.push(at)
    return true
  }

  /**
   * @param {string} platform
   * @param {{ approved?: boolean, requiresApproval?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, reason?: string, code?: string }>}
   */
  async function check(platform, { approved = false, requiresApproval = false } = {}) {
    if (!config.platforms.enabled) {
      return { ok: false, code: 'DISABLED', reason: '平台总开关未开启（platforms.enabled）' }
    }
    const mustApprove = config.platforms.requireApproval || requiresApproval
    if (mustApprove && !approved) {
      return { ok: false, code: 'NEEDS_APPROVAL', reason: '这个动作需要人工确认' }
    }
    const { min, max } = config.platforms.sendDelayMs
    // 同一平台的出站排队执行：先等拟人化延迟，再占额度。
    // 这样并发请求不会在「还没发出去」的时候就一起把这一分钟的额度占满。
    return enqueue(platform, async () => {
      // 先看一眼额度：已经满了就别白等这一轮拟人化延迟
      if (recent(platform, now()).length >= config.platforms.maxSendsPerMinute) {
        return { ok: false, code: 'RATE_LIMITED', reason: `超过每分钟 ${config.platforms.maxSendsPerMinute} 条的发送上限` }
      }
      const delay = Math.round(min + random() * Math.max(0, max - min))
      if (delay > 0) await sleep(delay)
      if (!allow(platform)) {
        return { ok: false, code: 'RATE_LIMITED', reason: `超过每分钟 ${config.platforms.maxSendsPerMinute} 条的发送上限` }
      }
      logger.debug(`出站闸门放行 ${platform}，延迟 ${delay}ms`)
      return { ok: true, delay }
    })
  }

  function snapshot() {
    return {
      enabled: config.platforms.enabled,
      requireApproval: config.platforms.requireApproval,
      maxSendsPerMinute: config.platforms.maxSendsPerMinute,
      usedThisMinute: [...buckets.entries()].map(([platform, list]) => ({
        platform,
        used: recent(platform, now()).length,
      })),
    }
  }

  return { check, snapshot }
}
