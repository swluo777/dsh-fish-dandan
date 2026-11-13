// ============================================================
// 路径工具：所有运行时数据都锚定到项目根，避免 cwd 漂移
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 项目根目录。
 * 插件被 pnpm 以 `link:` 装进 profile 时，`import.meta.url` 会保留符号链接路径，
 * 直接用 dirname 推导会把 data/ 写进 profile。这里先 realpath 展开，保证始终指向源码目录。
 */
function resolveRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let real = here
  try {
    real = fs.realpathSync(here)
  } catch {
    /* 目录暂时不可读时退回原路径，不阻断加载 */
  }
  return path.resolve(real, '..', '..')
}

export const ROOT = resolveRoot()

/** 把相对项目根的路径解析为绝对路径；已是绝对路径则原样返回。 */
export function fromRoot(...parts) {
  return path.resolve(ROOT, ...parts)
}

/** 确保某个文件所在目录存在。 */
export function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

