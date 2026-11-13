// ============================================================
// Windows PowerShell 可执行文件定位。
//
// 有些 Node 子进程的 PATH 不包含 System32（例如从桌面/沙盒启动的宿主），
// 直接写 'powershell.exe' 会得到 ENOENT。这里优先保留用户显式配置，
// 再从 SystemRoot 找 Windows PowerShell；最后才回退到 PATH 查找。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

let cached = ''

export function resolvePowerShell() {
  if (process.env.FISH_POWERSHELL) return process.env.FISH_POWERSHELL
  if (cached) return cached
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
    const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(candidate)) {
      cached = candidate
      return cached
    }
  }
  // 交给系统 PATH 解析；找不到时调用方会得到清晰的 ENOENT。
  cached = 'powershell.exe'
  return cached
}
