// ============================================================
// 值班标签页 watchdog：用户手动关掉标签页时，值班进程不一定会收到通知。
// 这里只做一件事：按 targetId 核对标签页还在不在；不在就通知宿主停止。
// 抽成独立小模块是为了能单测，不把浏览器/子进程混进来。
// ============================================================
import { readJsonSafe } from '../../utils/json.js'

/**
 * @param {{
 *   hub?: { isTabOpen?: (page: { targetId?: string, httpBase?: string }) => Promise<boolean>|boolean },
 *   tabFile: string,
 *   isRunning: () => boolean,
 *   isStopping: () => boolean,
 *   onClosed: () => void,
 *   logger?: { warn?: (m: string) => void },
 *   intervalMs?: number,
 *   read?: (file: string, fallback: any) => any,
 * }} opts
 */
export function createTabWatch({
  hub, tabFile, isRunning, isStopping, onClosed, logger,
  intervalMs = 1000, read = readJsonSafe,
} = {}) {
  let timer = null

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  function start() {
    stop()
    if (!hub || typeof hub.isTabOpen !== 'function') return false
    timer = setInterval(async () => {
      if (!isRunning() || isStopping()) return
      const tab = read(tabFile, null)
      if (!tab || !tab.targetId) return
      let open = true
      try { open = await hub.isTabOpen(tab) } catch { return } // 读不到浏览器状态时不误杀
      if (open) return
      try { onClosed() } catch (err) { logger?.warn?.(`值班标签页 watchdog 停止失败：${err.message}`) }
    }, intervalMs)
    timer.unref?.()
    return true
  }

  return { start, stop }
}
