// ============================================================
// JSON / JSONL 读写：原子写、坏文件不致命
// 所有 data/ 下的持久化都走这里，避免半写文件
// ============================================================

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ensureDirFor } from './paths.js'

/**
 * 读取 JSON；文件不存在或损坏时返回 fallback，并回调 onError 供调用方记录。
 * @param {string} filePath
 * @param {*} fallback
 * @param {(err: Error) => void} [onError]
 */
export function readJsonSafe(filePath, fallback, onError) {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(text)
    if (data === null || typeof data !== 'object') throw new Error('根节点不是对象')
    return data
  } catch (err) {
    if (err?.code !== 'ENOENT' && typeof onError === 'function') onError(err)
    return fallback
  }
}

/** 原子写 JSON：先写临时文件再 rename，进程中断不会留下半个文件。 */
export function writeJsonAtomic(filePath, data, { space = 2 } = {}) {
  ensureDirFor(filePath)
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, space) + '\n', 'utf8')
  fs.renameSync(tmp, filePath)
}

/** 追加一行 JSONL；失败只抛给调用方，不静默吞掉。 */
export function appendJsonl(filePath, record) {
  ensureDirFor(filePath)
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
}

/** 读取 JSONL，跳过损坏行。 */
export function readJsonl(filePath, onError) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT' && typeof onError === 'function') onError(err)
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch (err) {
      if (typeof onError === 'function') onError(err)
    }
  }
  return out
}
