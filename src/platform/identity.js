// ============================================================
// 身份归一：platform + platformUserId ↔ unifiedPersonId
// 同一真实用户跨平台识别为同一人；未识别先建临时档，确认后合并
// 只存 ID 与映射，不存任何凭证、昵称以外的隐私
// ============================================================

import { createHash } from 'node:crypto'
import path from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { fromRoot } from '../utils/paths.js'

const VERSION = 1

function keyOf(platform, platformUserId) {
  return `${platform}:${platformUserId}`
}

function makeId(key) {
  return `p_${createHash('sha1').update(key).digest('hex').slice(0, 12)}`
}

/**
 * @param {{ config: object, logger: object }} deps
 */
export function createIdentityRegistry({ config, logger }) {
  const file = path.isAbsolute(config.platforms.identityPath)
    ? config.platforms.identityPath
    : fromRoot(config.platforms.identityPath)

  const raw = readJsonSafe(file, { version: VERSION, people: [] }, (err) => {
    logger.warn(`身份映射读取失败，使用空表：${err.message}`)
  })
  const people = Array.isArray(raw.people) ? raw.people.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.accounts)) : []
  const index = new Map()
  for (const person of people) {
    for (const account of person.accounts) {
      if (account && account.platform && account.userId) {
        index.set(keyOf(account.platform, account.userId), person.id)
      }
    }
  }

  function persist() {
    try {
      writeJsonAtomic(file, { version: VERSION, people })
    } catch (err) {
      logger.warn(`身份映射写入失败：${err.message}`)
    }
  }

  /** 查或建：同一个平台账号永远落到同一个人。 */
  function resolve(platform, platformUserId) {
    const platformId = String(platformUserId ?? '').trim()
    if (!platform || !platformId) throw new Error('resolveIdentity 需要 platform 与 platformUserId')
    const key = keyOf(platform, platformId)
    const existing = index.get(key)
    if (existing) {
      const person = people.find((p) => p.id === existing)
      if (person) return person
    }

    const person = {
      id: makeId(key),
      name: '',
      provisional: true,
      accounts: [{ platform, userId: platformId }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    people.push(person)
    index.set(key, person.id)
    persist()
    logger.info(`新身份：${platform}/${platformId} → ${person.id}`)
    return person
  }

  /** 把 from 的所有账号并入 to，然后删除 from。 */
  function merge(fromId, toId) {
    if (fromId === toId) return get(toId)
    const from = people.find((p) => p.id === fromId)
    const to = people.find((p) => p.id === toId)
    if (!from || !to) throw new Error('要合并的身份不存在')

    for (const account of from.accounts) {
      if (!to.accounts.some((a) => a.platform === account.platform && a.userId === account.userId)) {
        to.accounts.push(account)
      }
      index.set(keyOf(account.platform, account.userId), to.id)
    }
    to.provisional = false
    to.updatedAt = Date.now()
    const at = people.indexOf(from)
    if (at >= 0) people.splice(at, 1)
    persist()
    logger.info(`身份合并：${fromId} → ${toId}`)
    return to
  }

  /** 手动绑定一个平台账号到指定人。 */
  function link(platform, platformUserId, personId) {
    const person = people.find((p) => p.id === personId)
    if (!person) throw new Error('目标身份不存在')
    const platformId = String(platformUserId)
    const key = keyOf(platform, platformId)
    const current = index.get(key)
    if (current && current !== personId) {
      const owner = people.find((p) => p.id === current)
      if (owner) {
        const i = owner.accounts.findIndex((a) => a.platform === platform && a.userId === platformId)
        if (i >= 0) owner.accounts.splice(i, 1)
      }
    }
    if (!person.accounts.some((a) => a.platform === platform && a.userId === platformId)) {
      person.accounts.push({ platform, userId: platformId })
    }
    index.set(key, personId)
    person.updatedAt = Date.now()
    persist()
    return person
  }

  function get(id) {
    return people.find((p) => p.id === id) ?? null
  }

  function list() {
    return people.map((p) => ({ id: p.id, name: p.name, provisional: p.provisional, accounts: p.accounts.map((a) => ({ ...a })) }))
  }

  return { resolve, merge, link, get, list, file }
}
