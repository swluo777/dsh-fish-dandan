// 测试公共夹具：临时目录、静默日志、可控配置
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveConfig } from '../src/config.js'

export function tmpDir(name = 'fish-dandan') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
}

export function silentLogger() {
  const lines = []
  const push = (level) => (msg) => lines.push(`${level} ${msg}`)
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'), lines }
}

/** 生成一套指向临时目录的配置。 */
export function testConfig(dir, overrides = {}) {
  const base = {
    persona: {
      corePath: path.join(dir, 'persona', 'core.json'),
      auditPath: path.join(dir, 'persona', 'audit.jsonl'),
      templatePath: 'persona/default-persona.json',
    },
    memory: {
      dbPath: path.join(dir, 'memory', 'memory.db'),
      jsonlPath: path.join(dir, 'memory', 'memory.jsonl'),
    },
    decision: {
      enabled: false,
      statePath: path.join(dir, 'state', 'decision.json'),
      schedulerPath: path.join(dir, 'state', 'scheduler.json'),
      affectPath: path.join(dir, 'state', 'affect.json'),
      tickIntervalMs: 60_000,
      minDwellMs: 15 * 60_000,
      wakeBaseMs: 30 * 60_000,
      minIdleMs: 10 * 60_000,
      dailyBudget: 8,
    },
    gui: { enabled: true, wizardPath: path.join(dir, 'state', 'wizard.json') },
    platforms: { identityPath: path.join(dir, 'identity', 'identities.json'), settingsPath: path.join(dir, 'state', 'platform-settings.json') },
  }
  const merged = { ...base, ...overrides }
  if (overrides.persona) merged.persona = { ...base.persona, ...overrides.persona }
  if (overrides.memory) merged.memory = { ...base.memory, ...overrides.memory }
  if (overrides.decision) merged.decision = { ...base.decision, ...overrides.decision }
  if (overrides.gui) merged.gui = { ...base.gui, ...overrides.gui }
  if (overrides.platforms) merged.platforms = { ...base.platforms, ...overrides.platforms }
  return resolveConfig(merged).config
}

export class FakeReq extends EventEmitter {
  constructor({ method = 'GET', url = '/', body, address = '127.0.0.1', headers = {} } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.socket = { remoteAddress: address }
    if (body !== undefined) {
      process.nextTick(() => {
        this.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
        this.emit('end')
      })
    }
  }

  destroy() {}
}

export class FakeRes {
  constructor() {
    this.statusCode = 0
    this.headers = {}
    this.body = ''
    this.headersSent = false
  }

  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers || {}
    this.headersSent = true
  }

  end(body = '') {
    this.body += body
  }

  json() {
    return JSON.parse(this.body || '{}')
  }
}

export async function callHandler(handler, options = {}) {
  const req = new FakeReq(options)
  const res = new FakeRes()
  await handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.json() }
}
