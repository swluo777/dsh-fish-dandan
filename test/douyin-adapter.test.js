// 抖音适配器：状态查询只读，不能顺手拉起浏览器/定时器
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createDouyinAdapter } from '../src/platform/douyin/index.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

function makeAdapter(dir) {
  const config = testConfig(dir, {
    platforms: {
      enabled: true,
      settingsPath: path.join(dir, 'state', 'platform-settings.json'),
      identityPath: path.join(dir, 'identity', 'identities.json'),
      douyin: {
        sessionPath: path.join(dir, 'platform', 'douyin-session.json'),
        usagePath: path.join(dir, 'state', 'douyin-usage.json'),
        seenPath: path.join(dir, 'state', 'douyin-seen.json'),
        journalPath: path.join(dir, 'state', 'douyin-journal.json'),
        dutyPath: path.join(dir, 'duty'),
        browserProfilePath: path.join(dir, 'profile'),
        loginPort: 19224,
        listenPort: 19445,
        dutyPort: 19334,
        hubStatePath: path.join(dir, 'platform', 'browser-hub.json'),
      },
    },
  })
  return createDouyinAdapter({ config, logger: silentLogger(), memory: null, decision: null, persona: null })
}

test('抖音适配器：反复查状态不会挂自唤醒定时器', () => {
  const adapter = makeAdapter(tmpDir('douyin-adapter-status'))
  assert.equal(adapter.browse, undefined, '旧脚本 browse 入口已摘除，只保留模型值班')
  assert.equal(adapter.autoWake, undefined, '平台页的独立自唤醒入口已收掉')

  // 导入登录态会启动常驻服务；但不应再出现自动去抖音的定时器
  adapter.login.importCookies('sessionid=test-only; path=/')
  assert.equal(adapter.status(), 'connected')
  assert.equal(adapter.inbox.snapshot().running, false, '监听没开就不启浏览器')
  assert.equal(adapter.roundSnapshot().running, false, '刷流没开就不启浏览器')

  for (let i = 0; i < 20; i += 1) {
    assert.equal(adapter.status(), 'connected')
    assert.equal(adapter.login.snapshot().status, 'connected')
    assert.equal(adapter.roundSnapshot().running, false)
  }
  assert.equal(adapter.autoWake, undefined, '状态轮询不能产生新定时器')

  adapter.login.logout()
  assert.equal(adapter.status(), 'logged-out')
  adapter.dispose()
})

test('抖音适配器：旧的 autoWake 设置不再恢复独立入口', () => {
  const dir = tmpDir('douyin-adapter-autowake')
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'state', 'platform-settings.json'),
    JSON.stringify({ douyin: { browse: { enabled: true }, autoWake: { enabled: true } } }),
    'utf8',
  )
  const adapter = makeAdapter(dir)
  assert.equal(adapter.autoWake, undefined)
  adapter.login.importCookies('sessionid=test-only; path=/')
  assert.equal(adapter.autoWake, undefined, '旧字段不会让适配器重新挂定时器')
  adapter.dispose()
})
