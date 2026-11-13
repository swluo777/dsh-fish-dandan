// ============================================================
// 最小 ZIP 解包器（只读，零依赖）
//
// 用途：从 GitHub 的 zipball 里取出表情包（manifest.json + memes/**）。
// 只支持 stored(0) 与 deflate(8) 两种压缩方式——GitHub zipball 就是这两种。
// 不写盘、不执行任何东西，只返回 [{ name, data }]。
// ============================================================

import zlib from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** 从尾部找 End Of Central Directory。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 66 * 1024)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 解析 zip，返回 [{ name, data }]。
 * @param {Buffer} buf
 * @param {{ maxEntryBytes?: number }} [options]
 */
export function readZipEntries(buf, { maxEntryBytes = 16 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('zip 找不到目录结尾（可能不是 zip）')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (!count || !offset) throw new Error('zip 目录为空')

  const entries = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) break
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen

    if (!name || name.endsWith('/')) continue
    if (compressedSize > maxEntryBytes) continue
    if (localOffset + 30 > buf.length) continue
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) continue
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buf.length) continue
    const raw = buf.subarray(dataStart, dataEnd)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else continue
    entries.push({ name, data })
  }
  return entries
}

/** 去掉 zip 顶层的仓库名目录（GitHub zipball 形如 owner-repo-sha/...）。 */
export function stripZipRoot(entries) {
  const first = entries.find((e) => e.name.includes('/'))
  if (!first) return entries
  const prefix = first.name.slice(0, first.name.indexOf('/') + 1)
  if (!entries.every((e) => e.name.startsWith(prefix))) return entries
  return entries.map((e) => ({ ...e, name: e.name.slice(prefix.length) })).filter((e) => e.name)
}
