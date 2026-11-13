// 平台设置存储：只做权限划分（开关 + 能力位 + 自唤醒权限），不再有任何预算/时长/节奏字段
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createPlatformSettings } from '../src/platform/settings.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

test('平台设置：默认只有权限位，没有任何时长/额度', () => {
  const dir = tmpDir('pset-default')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.get()
  assert.equal(s.douyin.browse.enabled, false, '权限开关默认关')
  assert.equal(s.douyin.browse.mode, 'watch')
  assert.equal(s.douyin.browse.readComments, true)
  assert.equal(s.douyin.browse.commentLimit, 5)
  assert.equal(s.douyin.browse.vision, false, '画面理解默认关，开了才截图')
  assert.deepEqual(s.douyin.browse.interests, [])
  assert.equal(s.douyin.owner.profileUrl, 'https://www.douyin.com/user/MS4wLjABAAAAoaPUwWqXi7uyLKcxnUSzirWJsu8Ffy_SRnUbfZZJbRE', '主人主页默认带公开身份示例')
  assert.equal(s.douyin.owner.readLikes, false, '喜欢列表默认不偷窥')
  assert.equal(s.douyin.listen.ownerName, '思维_', '默认带公开昵称，设置页能直接看到')
  assert.equal(s.douyin.listen.ownerId, '23003690', '默认带公开抖音号，设置页能直接看到')
  assert.equal(s.douyin.autoWake.enabled, false, '自唤醒默认关，不搞到点自动跑')
  assert.equal(s.douyin.actions.dm, true, '互动能力默认都允许')
  assert.equal(s.douyin.actions.like, true)
  assert.equal(s.douyin.actions.mentionOwner, false, '艾特主人默认关，避免公开评论默认带主人')
  assert.equal(s.douyin.listen.scope, 'all', '私信固定所有人，不再有只回主人')
  assert.equal(s.douyin.listen.autoReply, true, '所有私信自动回')
  assert.deepEqual(s.douyin.listen.memoryAllow, [], '记忆名单默认空；主人隐式可用')
  assert.equal(s.douyin.actions.follow, false, '关注整体关闭：默认不允许')
  assert.equal(s.douyin.actions.forward, false, '分享给主人默认关：打开开关才允许')
  assert.equal(s.douyin.actions.publish, false, '发作品整体关闭：默认不允许')
  // 预算/节奏/定时字段一个都不该有
  assert.ok(!('pace' in s.douyin), '不再有活跃时段/每日额度')
  assert.ok(!('duty' in s.douyin), '不再有值班时长/条数预算')
  assert.ok(!('sessionMinutes' in s.douyin.browse), '不再有单次时长')
  assert.ok(!('maxVideos' in s.douyin.browse), '不再有条数上限')
  assert.ok(!('dwellMinSec' in s.douyin.browse), '不再有停留区间')
  assert.equal(s.stickers.enabled, false, '跨平台表情包库预留位默认关')
  assert.equal(s.appearance.enabled, false, '形象设计预留位默认关')
})

test('平台设置：新装从公开示例初始化，保存后只改自己的运行文件', () => {
  const dir = tmpDir('pset-public-default')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.get()
  assert.equal(s.douyin.listen.ownerName, '思维_', '新装就能在设置页看到公开昵称')
  assert.equal(s.douyin.listen.ownerId, '23003690', '新装就能看到公开抖音号')
  assert.equal(s.douyin.owner.profileUrl.includes('/user/'), true, '新装就能看到公开主页')

  const saved = store.patch({ douyin: { listen: { ownerName: '我自己的昵称' } } })
  assert.equal(saved.douyin.listen.ownerName, '我自己的昵称')
  const onDisk = JSON.parse(fs.readFileSync(store.filePath, 'utf8'))
  assert.equal(onDisk.douyin.listen.ownerName, '我自己的昵称', '保存只写运行文件')
  const example = JSON.parse(fs.readFileSync('data/share/platform-settings.example.json', 'utf8'))
  assert.equal(example.douyin.listen.ownerName, '思维_', '仓库里的公开示例不被运行时覆盖')
})

test('平台设置：补丁只改权限，未知键与旧预算键一律丢弃', () => {
  const dir = tmpDir('pset-patch')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.patch({
    douyin: { browse: { enabled: true, mode: 'silent' }, autoWake: { enabled: true }, actions: { follow: true, forward: true, publish: true }, pace: { dailyMinutes: 999 }, duty: { maxMinutes: 60 } },
    hack: { x: 1 },
    evil: 2,
  })
  assert.equal(s.douyin.browse.enabled, true)
  assert.equal(s.douyin.browse.mode, 'watch', '静默已下线，旧配置一律归一为围观')
  assert.equal(s.douyin.autoWake.enabled, true, '明确打开才开自唤醒')
  assert.ok(!('pace' in s.douyin) && !('duty' in s.douyin), '预算类字段不该再出现')
  assert.equal(s.douyin.actions.like, true, '没提到的能力保持默认')
  assert.equal(s.douyin.actions.follow, false, '关注整体关闭：补丁也打不开')
  assert.equal(s.douyin.actions.forward, true, '「分享给主人」是唯一开放的转发类能力')
  assert.equal(s.douyin.actions.publish, false, '发作品整体关闭：补丁也打不开')
  assert.ok(!('hack' in s) && !('evil' in s), '未知键一律丢弃')
  const onDisk = JSON.parse(fs.readFileSync(store.filePath, 'utf8'))
  assert.equal(onDisk.douyin.browse.enabled, true, '落盘成功')
  assert.ok(!('evil' in onDisk))
})

test('平台设置：艾特主人可显式打开，主人昵称/抖音号会清洗后保存', () => {
  const dir = tmpDir('pset-mention-owner')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.patch({
    douyin: { actions: { mentionOwner: true }, listen: { ownerName: '  思维_  ', ownerId: '抖音号：123456789' } },
  })
  assert.equal(s.douyin.actions.mentionOwner, true)
  assert.equal(s.douyin.listen.ownerName, '思维_', '@ 用昵称，去掉首尾空格')
  assert.equal(s.douyin.listen.ownerId, '123456789', '抖音号允许带「抖音号」前缀，保存前剥掉')
})

test('平台设置：记忆名单去重、排除主人、不设人数上限', () => {
  const dir = tmpDir('pset-memory-allow')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const many = Array.from({ length: 25 }, (_, i) => `朋友${i + 1}`)
  const s = store.patch({
    douyin: { listen: { ownerName: '主人', memoryAllow: [' 主人 ', '阿明', '@阿明', '', '阿明', ...many] } },
  })
  assert.deepEqual(s.douyin.listen.memoryAllow, ['阿明', ...many], '去空、去重、去掉主人，25 人全保留')
  assert.equal(s.douyin.listen.scope, 'all', '旧 scope 不再产生只回主人')
})

test('平台设置：旧 scope=owner 会迁到所有人，不再保留主人专属行为', () => {
  const dir = tmpDir('pset-old-scope')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.patch({ douyin: { listen: { scope: 'owner', memoryAllow: [] } } })
  assert.equal(s.douyin.listen.scope, 'all')
  assert.equal(s.douyin.listen.autoReply, true)
})

test('平台设置：文件损坏时回落默认而不是抛错', () => {
  const dir = tmpDir('pset-corrupt')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true })
  fs.writeFileSync(store.filePath, '{broken json!!', 'utf8')
  const s = store.get()
  assert.equal(s.douyin.browse.enabled, false)
  assert.equal(s.douyin.browse.commentLimit, 5)
})

test('平台设置：多次局部补丁互不冲掉其他叶子', () => {
  const dir = tmpDir('pset-merge')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  store.patch({ douyin: { actions: { like: true, dm: true } } })
  const s = store.patch({ douyin: { actions: { like: false } } })
  assert.equal(s.douyin.actions.like, false)
  assert.equal(s.douyin.actions.dm, true, '第二次补丁不应冲掉 dm')
  assert.equal(s.douyin.browse.commentLimit, 5, '读评论条数不受互动补丁影响')
})

test('平台设置：能力位数值与开关都会被清洗', () => {
  const dir = tmpDir('pset-browse')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.patch({
    douyin: {
      browse: {
        commentLimit: 999,
        readComments: false,
        interests: [' 猫 ', '', '摄影', 'x'.repeat(80)],
      },
    },
  })
  assert.equal(s.douyin.browse.commentLimit, 20, '读评论上限 20 条')
  assert.equal(s.douyin.browse.readComments, false, '关掉读评论就真的不读')
  assert.deepEqual(s.douyin.browse.interests, ['猫', '摄影', 'x'.repeat(40)], '去空、截断')
  assert.ok(!('budgets' in s.douyin), '不再有固定配额')
  assert.ok(!('targets' in s.douyin), '「发给谁」不再由人预设')
})

test('平台设置：拒绝原型链补丁键，不让网页请求改写对象原型', () => {
  const dir = tmpDir('pset-proto')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const payload = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"douyin":{"listen":{"ownerName":"安全昵称"}}}')
  const s = store.patch(payload)
  assert.equal({}.polluted, undefined, '全局 Object 原型不能被污染')
  assert.equal(s.douyin.listen.ownerName, '安全昵称', '正常字段仍然保存')
})

test('平台设置：画面理解与主人喜欢列表按明确开关生效，主页只认完整链接', () => {
  const dir = tmpDir('pset-owner')
  const store = createPlatformSettings({ config: testConfig(dir), logger: silentLogger() })
  const s = store.patch({
    douyin: {
      browse: { vision: true },
      owner: { profileUrl: ' https://www.douyin.com/user/MS4wLjABAAAA?from_tab_name=main ', readLikes: true },
    },
  })
  assert.equal(s.douyin.browse.vision, true)
  assert.equal(s.douyin.owner.readLikes, true)
  assert.equal(s.douyin.owner.profileUrl, 'https://www.douyin.com/user/MS4wLjABAAAA?from_tab_name=main')

  const bad = store.patch({ douyin: { owner: { profileUrl: 'https://www.douyin.com/search/xxx' } } })
  assert.equal(bad.douyin.owner.profileUrl, '', '不是用户主页的链接一律不认')
})
