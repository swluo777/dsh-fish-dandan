// ============================================================
// 记忆存储层
// 首选 node:sqlite（零依赖），不可用时降级为 append-only JSONL
// 铁律：内容字段写入后不可 UPDATE；删除只是 archived=1；所有变更写审计
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { appendJsonl, readJsonl, readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { ensureDirFor, fromRoot } from '../utils/paths.js'

const JSONL_FIELD_MAP = {
  tier: 'tier',
  last_accessed: 'lastAccessed',
  access_count: 'accessCount',
  strength: 'strength',
  pinned: 'pinned',
  archived: 'archived',
  importance: 'importance',
}

const LIFECYCLE_FIELDS = new Set(['tier', 'last_accessed', 'access_count', 'strength', 'pinned', 'archived', 'importance'])

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  importance INTEGER NOT NULL DEFAULT 5,
  pinned INTEGER NOT NULL DEFAULT 0,
  platform TEXT,
  person TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  quarantine INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  strength REAL NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier, archived);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

function rowToRecord(row) {
  return {
    id: row.id,
    tier: row.tier,
    content: row.content,
    summary: row.summary ?? '',
    importance: Number(row.importance),
    pinned: Boolean(row.pinned),
    platform: row.platform ?? '',
    person: row.person ?? '',
    tags: safeJson(row.tags, []),
    source: row.source ?? '',
    flags: safeJson(row.flags, []),
    quarantine: Boolean(row.quarantine),
    createdAt: Number(row.created_at),
    lastAccessed: row.last_accessed == null ? null : Number(row.last_accessed),
    accessCount: Number(row.access_count),
    strength: Number(row.strength),
    archived: Boolean(row.archived),
  }
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

class SqliteBackend {
  constructor(dbPath, logger) {
    // 动态导入放在工厂里做，便于在无 sqlite 的环境整体降级
    const { DatabaseSync } = requireSqlite()
    ensureDirFor(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(SCHEMA)
    this.logger = logger
    this.kind = 'sqlite'
  }

  insert(record) {
    this.db.prepare(`INSERT INTO memories
      (id, tier, content, summary, importance, pinned, platform, person, tags, source, flags, quarantine, created_at, last_accessed, access_count, strength, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id, record.tier, record.content, record.summary ?? '', record.importance,
        record.pinned ? 1 : 0, record.platform ?? '', record.person ?? '',
        JSON.stringify(record.tags ?? []), record.source ?? '', JSON.stringify(record.flags ?? []),
        record.quarantine ? 1 : 0, record.createdAt, record.lastAccessed ?? null,
        record.accessCount ?? 0, record.strength ?? 1, record.archived ? 1 : 0,
      )
  }

  updateLifecycle(id, patch) {
    const fields = Object.keys(patch).filter((key) => LIFECYCLE_FIELDS.has(key))
    if (!fields.length) return
    const sets = fields.map((f) => `${f} = ?`).join(', ')
    const values = fields.map((f) => {
      const v = patch[f]
      if (f === 'pinned' || f === 'archived') return v ? 1 : 0
      return v
    })
    this.db.prepare(`UPDATE memories SET ${sets} WHERE id = ?`).run(...values, id)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return row ? rowToRecord(row) : null
  }

  list({ tier, limit = 100, offset = 0, includeArchived = false, includeQuarantined = true } = {}) {
    const clauses = []
    const params = []
    if (tier) {
      clauses.push('tier = ?')
      params.push(tier)
    }
    if (!includeArchived) clauses.push('archived = 0')
    if (!includeQuarantined) clauses.push('quarantine = 0')
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, Math.max(0, offset))
    return rows.map(rowToRecord)
  }

  count({ tier, includeArchived = false, includeQuarantined = true } = {}) {
    const clauses = []
    const params = []
    if (tier) {
      clauses.push('tier = ?')
      params.push(tier)
    }
    if (!includeArchived) clauses.push('archived = 0')
    if (!includeQuarantined) clauses.push('quarantine = 0')
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM memories ${where}`).get(...params).n)
  }

  candidates({ tier, platform, person, includeQuarantined = false } = {}) {
    const clauses = ['archived = 0']
    const params = []
    if (tier) {
      clauses.push('tier = ?')
      params.push(tier)
    }
    if (platform) {
      clauses.push('platform = ?')
      params.push(platform)
    }
    if (person) {
      clauses.push('person = ?')
      params.push(person)
    }
    if (!includeQuarantined) clauses.push('quarantine = 0')
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')}`).all(...params)
    return rows.map(rowToRecord)
  }

  audit(entry) {
    this.db.prepare('INSERT INTO audit_log (at, action, target, detail) VALUES (?, ?, ?, ?)')
      .run(entry.at, entry.action, entry.target ?? '', entry.detail ?? '')
  }

  auditLog(limit = 100) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit).map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      action: row.action,
      target: row.target,
      detail: row.detail,
    }))
  }

  stats() {
    const totals = { anchor: 0, trait: 0, episodic: 0 }
    for (const row of this.db.prepare('SELECT tier, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY tier').all()) {
      totals[row.tier] = Number(row.n)
    }
    const pinned = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE pinned = 1 AND archived = 0').get().n)
    const quarantined = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE quarantine = 1 AND archived = 0').get().n)
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get().n)
    return { total, byTier: totals, pinned, quarantined }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  close() {
    this.db.close()
  }
}

class JsonlBackend {
  constructor(jsonlPath, auditPath, logger) {
    this.jsonlPath = jsonlPath
    this.auditPath = auditPath
    this.logger = logger
    this.kind = 'jsonl'
    this.rows = new Map()
    this.auditRows = []
    this.meta = new Map()
    this.metaPath = `${jsonlPath}.meta.json`
    for (const record of readJsonl(jsonlPath, (err) => logger.warn(`记忆 JSONL 读取失败：${err.message}`))) {
      if (!record || typeof record.id !== 'string') continue
      // 生命周期补丁行：只改已有记录，不新增
      if (record.__lifecycle && record.patch) {
        const row = this.rows.get(record.id)
        if (row) for (const [key, value] of Object.entries(record.patch)) {
          const field = JSONL_FIELD_MAP[key]
          if (field) row[field] = value
        }
        continue
      }
      this.rows.set(record.id, normalizeRecord(record))
    }
    this.auditRows = readJsonl(auditPath, (err) => logger.warn(`审计 JSONL 读取失败：${err.message}`))
    const meta = readJsonSafe(this.metaPath, null, (err) => logger.warn(`记忆 meta 读取失败：${err.message}`))
    if (meta && typeof meta === 'object') for (const [k, v] of Object.entries(meta)) this.meta.set(k, String(v))
  }

  insert(record) {
    this.rows.set(record.id, normalizeRecord(record))
    appendJsonl(this.jsonlPath, record)
  }

  updateLifecycle(id, patch) {
    const record = this.rows.get(id)
    if (!record) return
    const applied = {}
    for (const [key, value] of Object.entries(patch)) {
      const field = JSONL_FIELD_MAP[key]
      if (!field) continue
      record[field] = value
      applied[key] = value
    }
    // 以前只改内存、重启就回退（审计发现）；现在补一条生命周期补丁行，加载时回放
    if (Object.keys(applied).length) appendJsonl(this.jsonlPath, { __lifecycle: true, id, patch: applied, at: Date.now() })
  }

  get(id) {
    return this.rows.get(id) ?? null
  }

  list({ tier, limit = 100, offset = 0, includeArchived = false, includeQuarantined = true } = {}) {
    return [...this.rows.values()]
      .filter((r) => (tier ? r.tier === tier : true))
      .filter((r) => (includeArchived ? true : !r.archived))
      .filter((r) => (includeQuarantined ? true : !r.quarantine))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(Math.max(0, offset), Math.max(0, offset) + limit)
  }

  count({ tier, includeArchived = false, includeQuarantined = true } = {}) {
    return [...this.rows.values()]
      .filter((r) => (includeArchived ? true : !r.archived))
      .filter((r) => (includeQuarantined ? true : !r.quarantine))
      .filter((r) => (tier ? r.tier === tier : true)).length
  }

  candidates({ tier, platform, person, includeQuarantined = false } = {}) {
    return [...this.rows.values()]
      .filter((r) => !r.archived)
      .filter((r) => (tier ? r.tier === tier : true))
      .filter((r) => (platform ? r.platform === platform : true))
      .filter((r) => (person ? r.person === person : true))
      .filter((r) => (includeQuarantined ? true : !r.quarantine))
  }

  audit(entry) {
    const row = { at: entry.at, action: entry.action, target: entry.target ?? '', detail: entry.detail ?? '' }
    this.auditRows.push(row)
    appendJsonl(this.auditPath, row)
  }

  auditLog(limit = 100) {
    return this.auditRows.slice(-limit).reverse().map((row, index) => ({ id: index + 1, ...row }))
  }

  stats() {
    const live = [...this.rows.values()].filter((r) => !r.archived)
    const byTier = { anchor: 0, trait: 0, episodic: 0 }
    for (const r of live) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1
    return {
      total: live.length,
      byTier,
      pinned: live.filter((r) => r.pinned).length,
      quarantined: live.filter((r) => r.quarantine).length,
    }
  }

  getMeta(key) {
    return this.meta.get(key) ?? null
  }

  setMeta(key, value) {
    this.meta.set(key, String(value))
    // 以前只写内存，lastReviewAt 与每日配额重启就丢；现在落一个小的 meta 文件
    try {
      writeJsonAtomic(this.metaPath, Object.fromEntries(this.meta))
    } catch (err) {
      this.logger.warn?.(`记忆 meta 落盘失败：${err.message}`)
    }
  }

  close() {}
}

function normalizeRecord(record) {
  return {
    id: record.id,
    tier: record.tier ?? 'episodic',
    content: record.content ?? '',
    summary: record.summary ?? '',
    importance: Number(record.importance ?? 5),
    pinned: Boolean(record.pinned),
    platform: record.platform ?? '',
    person: record.person ?? '',
    tags: Array.isArray(record.tags) ? record.tags : [],
    source: record.source ?? '',
    flags: Array.isArray(record.flags) ? record.flags : [],
    quarantine: Boolean(record.quarantine),
    createdAt: Number(record.createdAt ?? Date.now()),
    lastAccessed: record.lastAccessed ?? null,
    accessCount: Number(record.accessCount ?? 0),
    strength: Number(record.strength ?? 1),
    archived: Boolean(record.archived),
  }
}

let sqliteModule
const requireFromHere = createRequire(import.meta.url)

function requireSqlite() {
  if (sqliteModule) return sqliteModule
  sqliteModule = requireFromHere('node:sqlite')
  return sqliteModule
}

/**
 * 创建存储后端。优先 SQLite，失败自动降级 JSONL。
 * @param {{ config: object, logger: object }} deps
 */
export function createMemoryStore({ config, logger }) {
  const dbPath = path.isAbsolute(config.memory.dbPath) ? config.memory.dbPath : fromRoot(config.memory.dbPath)
  const jsonlPath = path.isAbsolute(config.memory.jsonlPath) ? config.memory.jsonlPath : fromRoot(config.memory.jsonlPath)
  const auditPath = jsonlPath.replace(/\.jsonl$/, '.audit.jsonl')

  try {
    const backend = new SqliteBackend(dbPath, logger)
    logger.info(`记忆存储：SQLite（${dbPath}）`)
    return backend
  } catch (err) {
    logger.warn(`node:sqlite 不可用（${err.message}），降级为 JSONL：${jsonlPath}`)
    try {
      fs.mkdirSync(path.dirname(jsonlPath), { recursive: true })
    } catch (mkdirErr) {
      logger.warn(`记忆目录创建失败：${mkdirErr.message}`)
    }
    return new JsonlBackend(jsonlPath, auditPath, logger)
  }
}
