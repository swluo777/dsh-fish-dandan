import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaleProfiles } from '../src/platform/douyin/temp-profiles.js'

const HOUR = 3_600_000
const MIN_AGE = 12 * HOUR

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fish-temp-profiles-test-'))
}

function makeDir(root, name, ageMs) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'data.bin'), 'x'.repeat(1024))
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, t, t)
  return dir
}

test('只清超过阈值的 fish-douyin 目录，新的与无关目录保留', () => {
  const root = makeRoot()
  try {
    const old = makeDir(root, 'fish-douyin-old', 13 * HOUR)
    const fresh = makeDir(root, 'fish-douyin-fresh', 10 * 60_000)
    const other = makeDir(root, 'other-app', 13 * HOUR)
    const trash = makeDir(root, 'fish-douyin-old.delete-123', 13 * HOUR)

    const r = sweepStaleProfiles({ tmpDir: root, minAgeMs: MIN_AGE })

    assert.equal(fs.existsSync(old), false)
    assert.equal(fs.existsSync(trash), false)
    assert.equal(fs.existsSync(fresh), true)
    assert.equal(fs.existsSync(other), true)
    assert.equal(r.removed, 2)
    assert.ok(r.bytes >= 2048, `应统计到释放字节，实际 ${r.bytes}`)
    assert.equal(r.skippedBusy, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rename 失败（有进程占用）时跳过，不删正在用的档案', () => {
  const root = makeRoot()
  const realRename = fs.renameSync
  try {
    const busy = makeDir(root, 'fish-douyin-busy', 13 * HOUR)
    mock.method(fs, 'renameSync', (from, to) => {
      if (String(from).includes('busy')) {
        const err = new Error('EBUSY: resource busy or locked')
        err.code = 'EBUSY'
        throw err
      }
      return realRename(from, to)
    })

    const r = sweepStaleProfiles({ tmpDir: root, minAgeMs: MIN_AGE })

    assert.equal(fs.existsSync(busy), true)
    assert.equal(r.removed, 0)
    assert.equal(r.skippedBusy, 1)
  } finally {
    mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('日志只在有动作时写，内容包含删除数与释放量', () => {
  const root = makeRoot()
  const lines = []
  try {
    makeDir(root, 'fish-douyin-old', 13 * HOUR)
    const r = sweepStaleProfiles({ tmpDir: root, minAgeMs: MIN_AGE, logger: { info: (m) => lines.push(m) } })
    assert.equal(r.removed, 1)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /删除 1 个/)
    assert.match(lines[0], /MB/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
