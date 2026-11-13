// ============================================================
// 临时浏览器档案清扫
//
// 背景：cdp.js 在调用方没传 profileDir 时会 mkdtemp 一个 fish-douyin-*；
// 值班结束走 taskkill /T /F 强杀，closeBrowser 跑不到，目录就留在磁盘。
// 2026-11-11/12 密集运行后堆了 111 个、约 10 GB（审计记录）。
//
// 这里做启动兜底：只清超过 minAgeMs 的 fish-douyin-*；先 rename 再删，
// rename 失败说明还有进程握着目录里的句柄，跳过，绝不碰正在用的档案。
// ============================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'fish-douyin-'
const TRASH_MARK = '.delete-'
export const DEFAULT_MIN_AGE_MS = 12 * 60 * 60 * 1000

/** 递归累加文件大小；目录刚被删、文件被占用都只跳过，不抛。 */
function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const p = path.join(cur, entry.name)
      if (entry.isDirectory()) { stack.push(p); continue }
      if (!entry.isFile()) continue
      try { total += fs.statSync(p).size } catch { /* 文件刚被删掉，忽略 */ }
    }
  }
  return total
}

/**
 * 清扫临时浏览器档案。
 * @param {{ tmpDir?: string, minAgeMs?: number, logger?: object }} [options]
 * @returns {{ removed: number, bytes: number, skippedBusy: number }}
 */
export function sweepStaleProfiles({ tmpDir = os.tmpdir(), minAgeMs = DEFAULT_MIN_AGE_MS, logger = null } = {}) {
  let removed = 0
  let bytes = 0
  let skippedBusy = 0
  let names = []
  try { names = fs.readdirSync(tmpDir) } catch { return { removed, bytes, skippedBusy } }

  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue
    const dir = path.join(tmpDir, name)
    let st
    try { st = fs.statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    if (Date.now() - st.mtimeMs < minAgeMs) continue

    // 上次 rename 成功但 rm 失败的残骸：直接再删一次
    if (name.includes(TRASH_MARK)) {
      const size = dirSize(dir)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        removed += 1
        bytes += size
      } catch { skippedBusy += 1 }
      continue
    }

    // 先改名：Windows 上有进程握着目录里的文件时 rename 会失败。
    // 这样比「先查 PID 再删」可靠，也不会误删正在跑的档案。
    const trash = `${dir}${TRASH_MARK}${Date.now()}`
    try { fs.renameSync(dir, trash) } catch { skippedBusy += 1; continue }
    const size = dirSize(trash)
    try {
      fs.rmSync(trash, { recursive: true, force: true })
      removed += 1
      bytes += size
    } catch { skippedBusy += 1 }
  }

  if (removed || skippedBusy) {
    const mb = (bytes / 1048576).toFixed(1)
    logger?.info?.(`临时浏览器档案清理：删除 ${removed} 个，释放 ${mb} MB${skippedBusy ? `，跳过占用中 ${skippedBusy} 个` : ''}`)
  }
  return { removed, bytes, skippedBusy }
}
