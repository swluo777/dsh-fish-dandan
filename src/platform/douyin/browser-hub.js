// ============================================================
// 共享浏览器 hub：全项目只开一个 Chromium 进程、一份固定档案。
//
// 为什么要有它：
//   以前登录/刷流/值班共用档案但各开各的进程，监听又是另一份档案；
//   结果一处扫码，另一处不认，两个 Chromium 还会抢同一个档案锁。
//
// 现在的规矩：
//   1. 一个浏览器进程、一份 data/browser-profile，所有服务都连它；
//   2. 登录/活动/监听/值班各自开自己的标签页，谁也导航不走谁；
//   3. 任何服务停止时只关自己的标签页，绝不 Browser.close；
//   4. 浏览器被用户关掉，所有标签页一起失效，服务各自停。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { ensureBrowser, attachPage, openNewPage, closePage, closeBrowser } from './cdp.js'
import { fromRoot } from '../../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'

const HUB_FILE = 'data/platform/browser-hub.json'

function uniq(list) {
  return [...new Set(list.filter((n) => Number.isFinite(n) && n > 0))]
}

function portOf(httpBase, fallback) {
  try { return Number(new URL(httpBase).port) || fallback } catch { return fallback }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * @param {object} opts
 * @param {object} opts.config 项目配置
 * @param {object} opts.logger
 * @param {object} [opts.driver] 测试注入：ensureBrowser/attachPage/openNewPage/closePage/closeBrowser/isAlive
 */
export function createBrowserHub({ config, logger = console, driver } = {}) {
  const cfg = (config && config.platforms && config.platforms.douyin) || {}
  const hubPort = Number(cfg.hubPort) || Number(cfg.loginPort) || 9224
  const profileSetting = cfg.browserProfilePath || 'data/browser-profile'
  const profileDir = fromRoot(profileSetting)
  const hubFile = fromRoot(cfg.hubStatePath || HUB_FILE)
  // 标记跟 hub 状态放同一目录：生产是 data/platform，测试注入的临时目录也不会写到项目里
  const logoutFlag = fromRoot(cfg.logoutPendingPath || path.join(path.dirname(hubFile), 'douyin-logout-pending'))
  const d = {
    ensureBrowser,
    attachPage,
    openNewPage,
    closePage,
    closeBrowser,
    ...(driver || {}),
  }

  let handle = null
  let fresh = false
  let ensuring = null
  const tabs = new Map() // kind -> page
  const opening = new Map() // kind -> Promise，防并发开同类标签
  const deadListeners = new Set()

  const probe = async (base) => {
    // 探测端口上有没有浏览器：测试可注入 probe，生产走 HTTP
    if (typeof d.probe === 'function' && driver?.probe) {
      try { return Boolean(await d.probe(base)) } catch { return false }
    }
    try {
      const r = await fetch(`${base}/json/version`, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
      })
      return Boolean(r.ok)
    } catch { return false }
  }

  const alive = async (h = handle) => {
    if (!h) return false
    if (typeof d.isAlive === 'function' && driver?.isAlive) {
      try { return Boolean(await d.isAlive(h)) } catch { return false }
    }
    return await probe(h.httpBase)
  }

  function writeHub(owner = 'plugin') {
    try {
      writeJsonAtomic(hubFile, {
        port: handle?.port || hubPort,
        httpBase: handle?.httpBase || `http://127.0.0.1:${hubPort}`,
        pid: handle?.child?.pid || 0,
        owner,
        profile: profileSetting,
        updatedAt: Date.now(),
      })
    } catch (err) { logger.warn?.(`共享浏览器信息写入失败：${err.message}`) }
  }

  function removeHub() {
    try { fs.rmSync(hubFile, { force: true }) } catch { /* 忽略 */ }
  }

  function notifyDead() {
    for (const fn of deadListeners) { try { fn() } catch { /* 订阅方自己处理 */ } }
  }

  function bindExit(h) {
    if (!h?.child || typeof h.child.once !== 'function') return
    h.child.once('exit', () => {
      if (handle && handle.child === h.child) { handle = null; fresh = false; tabs.clear() }
      notifyDead()
    })
  }

  /** 端口上已有浏览器就接上；没有才启动。返回值里 port 是实际用的端口。 */
  async function ensure() {
    if (handle && await alive(handle)) {
      await applyPendingLogout(handle)
      return handle
    }
    if (ensuring) return ensuring
    ensuring = (async () => {
      if (handle) {
        // 端口已经不应答：自己拉起来的旧进程尽量收掉，避免它占着端口/档案
        if (handle.child) { try { d.closeBrowser(handle) } catch { /* 已经没了 */ } }
        // 旧浏览器已经死了，登记表里的页面引用全部作废；不清掉会让下一次关闭/重开
        // 拿着已经不存在的 target 去操作，看起来像“怎么都唤不起来”。
        tabs.clear()
      }
      handle = null
      fresh = false
      const saved = readJsonSafe(hubFile, null)
      const candidates = uniq([
        Number(saved?.port),
        hubPort,
        Number(cfg.browsePort),
        Number(cfg.dutyPort),
        Number(cfg.loginPort),
      ])
      for (const p of candidates) {
        const base = `http://127.0.0.1:${p}`
        if (await probe(base)) {
          handle = { httpBase: base, child: null, profileDir, persistent: true, reused: true, port: p, version: saved?.version || '' }
          await applyPendingLogout(handle)
          writeHub('plugin')
          logger.info?.(`共享浏览器：接上已开的浏览器（端口 ${p}）`)
          return handle
        }
      }
      const h = await d.ensureBrowser({
        browserPath: cfg.browserPath,
        port: hubPort,
        headless: false,
        startUrl: 'about:blank',
        logger,
        profileDir,
      })
      h.port = portOf(h.httpBase, hubPort)
      handle = h
      fresh = !h.reused
      bindExit(h)
      await applyPendingLogout(h)
      writeHub('plugin')
      logger.info?.(`共享浏览器：已启动（端口 ${h.port}，档案 ${profileSetting}）`)
      return handle
    })()
    try { return await ensuring } finally { ensuring = null }
  }

  // 所有 kind 共用一条开标签队列：浏览器冷启动时，只有一个调用能认领浏览器自带的
  // about:blank；其它 kind 必须等它登记完再新开自己的页。否则两个监听会连到同一个
  // target，用户关掉其中一个时两个 onClose 一起触发，两个开关同时被写回关闭。
  let openQueue = Promise.resolve()
  function queueOpen(task) {
    const result = openQueue.then(task, task)
    openQueue = result.catch(() => { /* 失败不堵住后面排队的调用 */ })
    return result
  }

  /** 这个 target 是否已经被别的 kind 登记了；同一个物理页不能挂两个服务。 */
  function targetUsedByOther(page, kind) {
    if (!page?.targetId) return false
    for (const [otherKind, other] of tabs) {
      if (otherKind !== kind && other?.targetId === page.targetId) return true
    }
    return false
  }

  /** 开一个自己的标签页；同一个 kind 只保留一页，旧的先关掉。 */
  function openTab(kind, url = 'about:blank', { bringToFront = false } = {}) {
    if (opening.has(kind)) return opening.get(kind)
    const task = queueOpen(async () => {
      const h = await ensure()
      if (tabs.has(kind)) await closeTab(kind)
      let page
      if (fresh) {
        // 刚启动的浏览器自带一个 about:blank，先用它，避免每次多留一个空白页
        try {
          page = await d.attachPage(h.httpBase, { preferUrl: 'about:blank' })
          // 先确认这个 target 没被别的服务登记，再导航；否则会把别人的页面带走。
          if (targetUsedByOther(page, kind)) {
            page = null
          } else if (url && url !== 'about:blank') {
            await page.cmd('Page.navigate', { url }).catch(() => {})
          }
        } catch { /* 没有初始页就新开一个 */ }
        fresh = false // 不管有没有接上初始页，只试一次，别下次把登录页当成空白页导航走
      }
      // 兜底：就算初始页被别的服务先认领了，也不能关闭它（那是别人的页），只能自己新开。
      if (page && targetUsedByOther(page, kind)) page = null
      if (!page) page = await d.openNewPage(h.httpBase, url)
      page.kind = kind
      tabs.set(kind, page)
      if (bringToFront) await page.cmd('Page.bringToFront').catch(() => {})
      writeHub('plugin')
      return page
    })
    opening.set(kind, task)
    return task.finally(() => {
      if (opening.get(kind) === task) opening.delete(kind)
    })
  }

  async function closeTab(kindOrPage) {
    const page = typeof kindOrPage === 'string' ? tabs.get(kindOrPage) : kindOrPage
    if (!page) return
    // 只摘掉「当前登记的就是这一页」；避免旧的关闭动作把刚开的新标签从表里删掉
    if (page.kind && tabs.get(page.kind) === page) tabs.delete(page.kind)
    try { await d.closePage(page) } catch { /* 浏览器可能已经没了 */ }
    if (handle) writeHub('plugin')
  }

  async function closeAllTabs() {
    const pages = [...tabs.values()]
    tabs.clear()
    for (const page of pages) {
      try { await d.closePage(page) } catch { /* 忽略 */ }
    }
  }

  async function pageCount(base) {
    try {
      const r = await fetch(`${base}/json/list`, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
      })
      const list = await r.json()
      return (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page').length
    } catch { return 0 }
  }

  /** 登录标签关掉后如果没别的活，就把浏览器也收掉；有监听/活动/值班在跑就留着。 */
  async function closeIfIdle() {
    if (tabs.size) return
    const h = handle
    if (!h?.child) return // 别人开的浏览器不替它做主
    // 给监听/活动 1.2 秒：登录成功回调里可能刚挂了监听，它 1 秒后才开标签
    await sleep(1200)
    if (tabs.size || handle !== h) return
    // hub 不认识值班的标签，数一下实际页面：还有别人的页就绝不关浏览器
    if (await pageCount(h.httpBase) > 0) return
    try { d.closeBrowser(h) } catch { /* 忽略 */ }
    handle = null
    fresh = false
    removeHub()
  }

  function isAlive() { return alive() }

  /** 这个标签页还在不在：用户手动关掉标签页后，CDP 连接会断，这里按 targetId 核对。 */
  async function isTabOpen(page) {
    if (!page || !page.targetId) return true
    const base = page.httpBase || handle?.httpBase
    if (!base) return false
    try {
      const r = await fetch(`${base}/json/list`, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
      })
      if (!r.ok) return false
      const list = await r.json()
      return (Array.isArray(list) ? list : []).some((t) => t && t.id === page.targetId)
    } catch { return false }
  }

  function onDead(fn) {
    deadListeners.add(fn)
    return () => deadListeners.delete(fn)
  }

  /* ------------------------------------------------------------------ 退出登录 */
  // 只清本地加密会话不够：Cookie 还在固定档案里，重新打开抖音仍是登录态。
  // 这里尽量在浏览器开着时直接清；浏览器没开就留一个标记，下次启动时先清再开页。
  function logoutPending() {
    try { return fs.existsSync(logoutFlag) } catch { return false }
  }

  function markLogoutPending() {
    try {
      fs.mkdirSync(path.dirname(logoutFlag), { recursive: true })
      writeJsonAtomic(logoutFlag, { at: Date.now() })
    } catch (err) {
      logger.warn?.(`退出登录标记写入失败：${err.message}`)
    }
  }

  function clearLogoutPending() {
    try { fs.rmSync(logoutFlag, { force: true }) } catch { /* 忽略 */ }
  }

  /** 在一个临时空白标签里清掉整只浏览器的 Cookie，以及抖音源的本地存储。 */
  async function clearCookiesOn(h) {
    let page = null
    let ok = false
    try {
      page = await d.openNewPage(h.httpBase, 'about:blank')
      try {
        await page.cmd('Network.clearBrowserCookies')
        ok = true
      } catch (err) {
        logger.warn?.(`清浏览器 Cookie 失败：${err.message}`)
      }
      try {
        await page.cmd('Storage.clearDataForOrigin', { origin: 'https://www.douyin.com', storageTypes: 'all' })
        ok = true
      } catch (err) {
        logger.warn?.(`清抖音本地存储失败：${err.message}`)
      }
    } catch (err) {
      logger.warn?.(`退出登录时打开清理标签失败：${err.message}`)
    } finally {
      if (page) { try { await d.closePage(page) } catch { /* 忽略 */ } }
    }
    return ok
  }

  let clearing = null
  async function applyPendingLogout(h) {
    if (!logoutPending() || !h) return false
    if (clearing) return clearing
    clearing = (async () => {
      const ok = await clearCookiesOn(h)
      // 清理失败就保留标记，下一次启动/打开标签页再试，不能假装已经退出
      if (ok) clearLogoutPending()
      return ok
    })()
    try { return await clearing } finally { clearing = null }
  }

  function snapshot() {
    return {
      mode: 'shared-browser',
      port: handle?.port || hubPort,
      profile: profileSetting,
      browserOpen: Boolean(handle),
      tabs: [...tabs.keys()],
    }
  }

  async function shutdown() {
    await closeAllTabs()
    if (handle?.child) {
      try { d.closeBrowser(handle) } catch { /* 忽略 */ }
      removeHub()
    }
    handle = null
    fresh = false
    deadListeners.clear()
  }

  /**
   * 退出登录：关掉插件自己的标签页，再清浏览器 Cookie。
   * 浏览器没开时不主动拉起窗口，只留标记，下次启动前清理。
   */
  async function logout() {
    markLogoutPending()
    try { await closeAllTabs() } catch { /* 忽略 */ }
    if (handle) await applyPendingLogout(handle)
    try { await closeIfIdle() } catch { /* 忽略 */ }
  }

  return { ensure, openTab, closeTab, closeAllTabs, closeIfIdle, isAlive, isTabOpen, onDead, snapshot, shutdown, logout }
}
