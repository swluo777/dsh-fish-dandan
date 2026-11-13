import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTabWatch } from '../src/platform/douyin/tab-watch.js'
import { tmpDir } from './helpers.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function makeWatch({ open, file = true, intervalMs = 20 } = {}) {
  const dir = tmpDir('tab-watch')
  const tabFile = path.join(dir, 'tab.json')
  if (file) fs.writeFileSync(tabFile, JSON.stringify({ targetId: 'target-1', httpBase: 'http://127.0.0.1:9224' }))
  const state = { running: true, stopping: false, closed: 0 }
  const watch = createTabWatch({
    hub: { isTabOpen: async () => open },
    tabFile,
    isRunning: () => state.running,
    isStopping: () => state.stopping,
    onClosed: () => { state.closed += 1; state.stopping = true },
    intervalMs,
  })
  return { watch, state, tabFile }
}

test('标签页 watchdog：target 不在了就通知宿主停止，且只通知一次', async () => {
  const { watch, state } = makeWatch({ open: false })
  watch.start()
  await sleep(70)
  watch.stop()
  assert.equal(state.closed, 1, '标签页关闭要触发停止')
})

test('标签页 watchdog：target 还在、没有 tab 记录、正在停止时都不误杀', async () => {
  const cases = [
    { name: 'target 还在', opts: { open: true }, run: true },
    { name: '还没有 tab 记录', opts: { open: false, file: false }, run: true },
    { name: '已经在停止', opts: { open: false }, run: false },
  ]
  for (const c of cases) {
    const { watch, state } = makeWatch(c.opts)
    if (!c.run) state.stopping = true
    watch.start()
    await sleep(50)
    watch.stop()
    assert.equal(state.closed, 0, `${c.name}时不该停`)
  }
})

test('标签页 watchdog：读不到浏览器状态时不误判为关闭', async () => {
  const dir = tmpDir('tab-watch-error')
  const tabFile = path.join(dir, 'tab.json')
  fs.writeFileSync(tabFile, JSON.stringify({ targetId: 'target-1' }))
  let closed = 0
  const watch = createTabWatch({
    hub: { isTabOpen: async () => { throw new Error('browser busy') } },
    tabFile,
    isRunning: () => true,
    isStopping: () => false,
    onClosed: () => { closed += 1 },
    intervalMs: 20,
  })
  watch.start()
  await sleep(50)
  watch.stop()
  assert.equal(closed, 0, '读不到状态不能当成用户关了标签页')
})
