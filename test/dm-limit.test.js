// 主动私信频控：刷流刷到很多人时也不能变成「刷一个人发一条」
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDmLimiter } from '../src/platform/douyin/dm-limit.js'

function makeLimiter() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-limit-'))
  let t = 1_000_000
  const limiter = createDmLimiter({
    path: join(dir, 'dm-ledger.json'),
    cooldownMs: 10 * 60_000,
    maxPerHour: 2,
    now: () => t,
  })
  return { dir, limiter, tick: (ms) => { t += ms } }
}

test('两次私信之间必须隔够冷却时间', () => {
  const { dir, limiter, tick } = makeLimiter()
  try {
    assert.equal(limiter.check('甲').ok, true)
    limiter.record('甲')
    tick(60_000)
    const early = limiter.check('乙')
    assert.equal(early.ok, false)
    assert.match(early.reason, /刚发过私信/)
    tick(9 * 60_000)
    assert.equal(limiter.check('乙').ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('一小时内最多两条，第三条必须被拒', () => {
  const { dir, limiter, tick } = makeLimiter()
  try {
    limiter.record('甲')
    tick(10 * 60_000)
    limiter.record('乙')
    tick(10 * 60_000)
    const third = limiter.check('丙')
    assert.equal(third.ok, false)
    assert.match(third.reason, /额度用完了/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('频控落盘：换一个 limiter 进程仍然生效', () => {
  const { dir, limiter, tick } = makeLimiter()
  try {
    limiter.record('甲')
    tick(60_000)
    const reopened = createDmLimiter({
      path: join(dir, 'dm-ledger.json'),
      cooldownMs: 10 * 60_000,
      maxPerHour: 2,
      now: () => 1_000_000 + 60_000,
    })
    assert.equal(reopened.check('乙').ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('坏账本不影响启动，按空账本处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-limit-bad-'))
  try {
    const limiter = createDmLimiter({ path: join(dir, 'bad.json'), now: () => 1 })
    assert.equal(limiter.check('甲').ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
