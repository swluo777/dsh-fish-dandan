// ============================================================
// Windows 文件操作重试：杀毒软件、浏览器、索引服务会短暂占用刚下载的图片，
// 直接 rm / rename 会报 EPERM、EBUSY、EACCES 或 ENOTEMPTY。
// 这里统一做退避重试，并把最终失败翻译成用户能理解的 PACK_LOCKED。
// ============================================================

import fs from 'node:fs'
import fsp from 'node:fs/promises'

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
const DEFAULT_ATTEMPTS = 6
const DEFAULT_BASE_DELAY = 120

export function isFsBusy(err) {
  return BUSY_CODES.has(String(err?.code || ''))
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function busyError(action, err) {
  if (!isFsBusy(err)) return err
  return Object.assign(
    new Error(`原图文件正被其他程序占用，暂时不能${action}；先关掉正在看的原图，或等几秒再试。`),
    { code: 'PACK_LOCKED', cause: err, fsCode: err.code },
  )
}

/**
 * 执行一个可能因占用失败的文件操作；只对占用类错误重试。
 * @param {string} action 日志里的动作名
 * @param {Function} fn 实际操作
 * @param {{attempts?: number, baseDelay?: number, logger?: object}} opts
 */
export async function retryFs(action, fn, { attempts = DEFAULT_ATTEMPTS, baseDelay = DEFAULT_BASE_DELAY, logger } = {}) {
  const total = Math.max(1, Number(attempts) || DEFAULT_ATTEMPTS)
  let last = null
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (err) {
      last = err
      if (!isFsBusy(err) || attempt === total - 1) break
      const delay = Math.max(20, (Number(baseDelay) || DEFAULT_BASE_DELAY) * 2 ** attempt)
      logger?.warn?.(`${action}被占用（${err.code}），${delay}ms 后重试 ${attempt + 1}/${total - 1}`)
      await wait(delay)
    }
  }
  throw busyError(action, last)
}

export async function removeDirectory(dir, opts = {}) {
  if (!fs.existsSync(dir)) return false
  await retryFs(`删除 ${dir}`, () => fsp.rm(dir, { recursive: true, force: true }), opts)
  return true
}

export async function renamePath(from, to, opts = {}) {
  await retryFs(`移动 ${from}`, () => fsp.rename(from, to), opts)
}
