// ============================================================
// 抖音登录会话的加密存储。
// - 密钥自动降级链：DSH 凭证层（未来可用时优先）→ 环境变量口令 → 本机特征派生
// - AES-256-GCM 加密，Cookie 永不落明文、不进 Git、不进日志、不回显
// - 文件位置：data/platform/douyin-session.json（data/ 整体被 gitignore）
// ============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fromRoot } from '../../utils/paths.js'
import { writeJsonAtomic } from '../../utils/json.js'

// 2026-11-13 项目改名：加密盐和机器标识一起改为 fish-dandan。
// 这会改变密钥派生结果，旧的 data/platform/douyin-session.json 解不开，需要重新扫码登录。
const ALG = 'aes-256-gcm'
const SALT = 'fish-dandan/douyin-session/v1'

/** 用口令派生 32 字节密钥（PBKDF2，抗暴力）。 */
function deriveKey(secret) {
  return crypto.pbkdf2Sync(String(secret), SALT, 120_000, 32, 'sha256')
}

/** 本机特征：hostname + 用户名 + 平台。零配置，绑定本机。取不到时降级，但要告警。 */
function machineSecret() {
  try {
    return { secret: `${os.hostname()}|${os.userInfo().username}|${os.platform()}|fish-dandan`, degraded: false }
  } catch (err) {
    return { secret: 'fish-dandan-local', degraded: true, reason: err && err.message }
  }
}

/**
 * @param {{ config: object, logger: object }} deps
 * env: 传入 process.env（测试可注入）
 */
export function createSessionStore({ config, logger, env = process.env }) {
  const sessionPath = fromRoot(config.platforms.douyin.sessionPath)
  let cachedKey = null
  let cachedSource = ''

  /**
   * 密钥降级链：
   * 1) FISH_SESSION_KEY 环境变量口令（用户显式设置，最明确）；
   * 2) 本机特征派生（零配置；换机器/换系统用户都解不开，符合「本机单人使用」场景）。
   * DSH 凭证层未来如果暴露插件可用的存取接口，在这里插入为第 0 级。
   */
  function resolveKey() {
    if (cachedKey) return { key: cachedKey, source: cachedSource }
    const fromEnv = env.FISH_SESSION_KEY
    if (fromEnv && String(fromEnv).trim()) {
      cachedKey = deriveKey(String(fromEnv).trim())
      cachedSource = 'env'
      return { key: cachedKey, source: cachedSource }
    }
    const machine = machineSecret()
    if (machine.degraded) {
      logger.warn?.(`本机特征取不到（${machine.reason}），登录态密钥退化为固定串：换机器也能解开，建议设置 FISH_SESSION_KEY`)
    }
    cachedKey = deriveKey(machine.secret)
    cachedSource = 'machine'
    return { key: cachedKey, source: cachedSource }
  }

  function encrypt(plain) {
    const { key } = resolveKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALG, key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()])
    return { v: 1, alg: ALG, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  }

  function decryptWith(key, blob) {
    const decipher = crypto.createDecipheriv(blob.alg || ALG, key, Buffer.from(blob.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  }

  function decrypt(blob) {
    const { key, source } = resolveKey()
    return { payload: decryptWith(key, blob), keySource: source }
  }

  /** 保存登录态。cookies: [{ name, value, domain, path, ... }]，meta 附带账号提示。 */
  function save(cookies, meta = {}) {
    if (!Array.isArray(cookies) || !cookies.length) throw new Error('没有可保存的 Cookie')
    const sealed = encrypt({ cookies, savedAt: Date.now(), ...meta })
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    writeJsonAtomic(sessionPath, sealed)
    logger.info(`抖音登录态已加密保存（密钥来源：${resolveKey().source}），文件：${config.platforms.douyin.sessionPath}`)
    return { exists: true }
  }

  /** 读取登录态；不存在/损坏/密钥不匹配一律返回 null，绝不抛出明文内容。 */
  function load() {
    let blob = null
    try {
      blob = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
    } catch {
      return null
    }
    try {
      const { payload, keySource } = decrypt(blob)
      return { ...payload, keySource }
    } catch (err) {
      logger.warn(`抖音登录态解密失败（项目改名会更换密钥，请重新扫码；也可能是换机器或改了口令）：${err.message}`)
      return null
    }
  }

  function exists() {
    try {
      const blob = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
      return Boolean(blob && blob.data)
    } catch {
      return false
    }
  }

  function clear() {
    try { fs.rmSync(sessionPath, { force: true }) } catch { /* fine */ }
    logger.info('抖音登录态已清除')
  }

  function keySource() {
    return resolveKey().source
  }

  return { save, load, exists, clear, keySource, path: sessionPath }
}
