// Windows 上 Git 克隆会把 .git/objects/pack 里的包文件标成只读，
// fs.rmSync 递归删除时会报 EPERM。删除前先递归清掉只读属性，
// 再交给 fs.rmSync 处理；不跟随符号链接，只删链接本身。
import fs from 'node:fs'
import path from 'node:path'

function clearReadOnly(target) {
  let stat = null
  try {
    stat = fs.lstatSync(target)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      clearReadOnly(path.join(target, entry))
    }
    try { fs.chmodSync(target, 0o777) } catch { /* 目录可能已被占用 */ }
    return
  }
  try { fs.chmodSync(target, 0o666) } catch { /* 文件可能已被占用 */ }
}

export function removeTree(target) {
  if (!target) return false
  let stat = null
  try {
    stat = fs.lstatSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
  clearReadOnly(target)
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
  return true
}
