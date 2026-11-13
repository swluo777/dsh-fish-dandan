// 隐私红线：运行时原始人格、记忆、状态、日志不能进 Git；公开配方与脱敏示例必须能入库；模板底图属于本地素材
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('.')

/**
 * Git 不一定在当前进程的 PATH 里（Windows 上从桌面启动 Node 很常见）。
 * 先试命令，再试常见安装位置；找不到就让隐私测试显式跳过，不伪装成「忽略规则通过」。
 */
function findGit() {
  if (process.env.GIT_BIN && existsSync(process.env.GIT_BIN)) return process.env.GIT_BIN
  try {
    execFileSync('git', ['--version'], { cwd: ROOT, stdio: 'ignore' })
    return 'git'
  } catch { /* 继续找常见路径 */ }
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'git.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
  return candidates.find((candidate) => candidate && existsSync(candidate)) || ''
}

const GIT = findGit()
const gitTest = GIT ? {} : { skip: '未找到 git 可执行文件，跳过 Git 忽略规则校验' }

function ignored(rel) {
  if (!GIT) return false
  try {
    execFileSync(GIT, ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('记忆 / 收件箱 / 状态流水 / 登录态 / 日志一律被忽略', gitTest, () => {
  const privatePaths = [
    'data/persona/audit.jsonl',
    'data/memory/memory.db',
    'data/memory/memory.jsonl',
    'data/state/affect.json',
    'data/state/decision.json',
    'data/state/douyin-inbox.json',
    'data/state/douyin-journal.json',
    'persona/my-persona.json',
    'persona/我的大肥鱼.json',
    'local/persona.json',
    'local/backup.jsonl',
    'config.local.json',
    'backup.memory.json',
    'data/plugin.log',
  ]
  for (const rel of privatePaths) {
    assert.ok(ignored(rel), `${rel} 会被提交，必须加进 .gitignore`)
  }
})

test('核心人格与公开配置可以入库，方便别人在现有养成基础上改', gitTest, () => {
  for (const rel of [
    'data/persona/core-persona.json',
    'data/state/platform-settings.json',
  ]) assert.ok(!ignored(rel), `${rel} 应该入库，否则别人拿到的是空框架`)
})

test('公开配方与占位文件不能被误忽略', gitTest, () => {
  for (const rel of [
    'persona/default-persona.json', 'persona/.gitkeep', 'data/.gitkeep',
    'data/share/README.md',
    'data/share/persona.example.json',
    'data/share/platform-settings.example.json',
    'data/share/memory-samples.jsonl',
    'README.md',
  ]) assert.ok(!ignored(rel), `${rel} 被误忽略，项目会缺文件`)
})

test('模板底图属于本地素材，不进仓库', gitTest, () => {
  for (const rel of [
    'data/templates/backgrounds/bg-00.png',
    'data/templates/profile/avatar-1080.png',
  ]) assert.ok(ignored(rel), `${rel} 是本地素材，不应被提交；/data/templates/** 应从放行列表移除`)
})

test('公开分享示例只带公开作者身份，不含其他账号、联系方式或浏览器登录态', () => {
  const files = [
    'data/share/README.md',
    'data/share/persona.example.json',
    'data/share/platform-settings.example.json',
    'data/share/memory-samples.jsonl',
  ]
  const joined = files.map((rel) => readFileSync(path.join(ROOT, rel), 'utf8')).join('\n')
  const platform = JSON.parse(readFileSync(path.join(ROOT, 'data/share/platform-settings.example.json'), 'utf8'))
  const dataFiles = files.filter((rel) => !rel.endsWith('README.md'))
    .map((rel) => readFileSync(path.join(ROOT, rel), 'utf8')).join('\n')
  const publicProfile = 'https://www.douyin.com/user/MS4wLjABAAAAoaPUwWqXi7uyLKcxnUSzirWJsu8Ffy_SRnUbfZZJbRE'
  assert.equal(platform.douyin.listen.ownerName, '思维_', '公开身份示例：昵称')
  assert.equal(platform.douyin.listen.ownerId, '23003690', '公开身份示例：抖音号')
  assert.equal(platform.douyin.owner.profileUrl, publicProfile, '公开身份示例：主页')
  assert.ok(!/https?:\/\/(www\.)?douyin\.com\/user\//.test(joined.replace(publicProfile, '')), '除公开身份外，不能带别的抖音主页链接')
  assert.ok(!/\b1[3-9]\d{9}\b/.test(joined), '分享示例不能带手机号')
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(joined), '分享示例不能带邮箱')
  assert.ok(!/sessionid|cookie/i.test(dataFiles), '分享示例不能带登录态')
  assert.ok(!/\"(ownerName|ownerId|profileUrl)\"\s*:\s*\"[^\"]+\"/.test(
    dataFiles.replace(/\"ownerName\"\s*:\s*\"思维_\"/, '').replace(/\"ownerId\"\s*:\s*\"23003690\"/, '').replace(publicProfile, '')
  ), '除公开身份外，账号字段不能出现别的值')
})

test('.env 系列只放行示例', gitTest, () => {
  assert.ok(ignored('.env'))
  assert.ok(ignored('.env.local'))
  assert.ok(!ignored('.env.example'))
})
