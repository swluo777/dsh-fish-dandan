// ============================================================
// 通用文件日志器
// 所有模块统一使用，写入 <项目根>/data/plugin.log
// 日志失败只落 stderr，绝不影响主流程；同一个错误只喊一次，不刷屏。
// 需要静音时设环境变量 FISH_SOUL_NO_LOG=1（测试 / 手动装配脚本用）。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fromRoot } from './paths.js'

// 复用 paths.js 的项目根（已 realpath 展开）：以 link: 方式装进 profile 时，
// 日志和记忆会落在同一个地方，而不是日志进 profile、数据进源码目录。
const LOG_FILE = fromRoot('data/plugin.log')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
// 生产环境可通过环境变量提高阈值；默认 info
const THRESHOLD = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info
const SILENT = /^(1|true|yes|off)$/i.test(String(process.env.FISH_SOUL_NO_LOG || ''))

let dirReady = false
let warned = false

function ensureDir() {
  if (dirReady) return true
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    dirReady = true
    return true
  } catch (err) {
    if (!warned) {
      warned = true
      console.error('[logger] 建日志目录失败，本次运行不再写文件日志：', err?.message)
    }
    return false
  }
}

function write(level, message) {
  if (SILENT) return
  if ((LEVELS[level] ?? LEVELS.info) < THRESHOLD) return
  if (!ensureDir()) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}\n`
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch (err) {
    if (!warned) {
      warned = true
      console.error('[logger] 写日志失败，本次运行不再写文件日志：', err?.message)
    }
  }
}

export const logger = {
  debug: (msg) => write('debug', msg),
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
  file: LOG_FILE,
}
