// ============================================================
// 创作插件：dandan-creative-studio 的宿主侧接口
//
// 这一层做「发现 / 检查 / 安装 / 卸载 / 运行环境 / 渲染编排」：
// - 只扫描插件目录和 JSON，不 import 插件里的 Python；
// - Python 由 renderer 用参数数组 spawn，不拼 shell；
// - 参数由 planner 生成并校验，坏参数不送进 Python；
// - 不接入发布，render-job 只渲染；图片落到创作工作室自己的目录。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { createCreativePlanner } from './planner.js'
import { createCreativeRenderer } from './renderer.js'
import { removeTree } from './remove-tree.js'

export const CREATIVE_STUDIO = Object.freeze({
  id: 'dandan-creative-studio',
  name: '创作工作室',
  projectName: 'dandan-creative-studio',
  installDir: 'data/plugins/dandan-creative-studio',
  runtimeDir: 'data/plugins/dandan-creative-studio-runtime',
  recordPath: 'data/state/creative-studio.json',
  lastPath: 'data/state/creative-studio-last.json',
  accountPath: 'data/state/creative-studio-account.json',
  accountAvatarDir: 'data/creative/account',
  inputsDir: 'data/creative/inputs',
  entry: 'studio/__main__.py',
  pipeline: 'studio/pipeline.py',
  command: 'python -m studio',
  repository: 'https://github.com/swluo777/dandan-creative-studio.git',
})

const FORMAT_LABELS = {
  image_post: '图文',
  image_animation: '动图',
  video: '视频',
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function localError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 只接受 github.com 的仓库页地址。域名固定、拒绝账号密码和查询串，
 * 避免用户把本地路径或其他地址当成 GitHub 仓库交给 git 执行。
 */
function normalizeGitHubRepository(input) {
  const raw = text(input).replace(/\/+$/, '')
  if (!raw) throw localError('GITHUB_URL_REQUIRED', '请填写 GitHub 仓库地址')

  let candidate = raw
  if (/^git@github\.com:/i.test(raw)) {
    candidate = raw.replace(/^git@github\.com:/i, 'https://github.com/')
  }

  let url
  try {
    url = new URL(candidate)
  } catch {
    throw localError('GITHUB_URL_INVALID', '仓库地址格式不正确，例如 https://github.com/owner/repo')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw localError('GITHUB_URL_INVALID', '只支持 github.com 的仓库地址')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw localError('GITHUB_URL_INVALID', '仓库地址不要带账号、密码或查询参数')
  }

  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length !== 2) {
    throw localError('GITHUB_URL_INVALID', '仓库地址要指向具体仓库，例如 https://github.com/owner/repo')
  }
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') {
    throw localError('GITHUB_URL_INVALID', '仓库地址里的 owner 或 repo 名称不合法')
  }
  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git`,
  }
}

function normalizeProxy(value) {
  let raw = text(value)
  if (!raw) return ''
  if (raw.includes('=')) {
    const parts = raw.split(';').map((part) => part.trim()).filter(Boolean)
    const chosen = parts.find((part) => /^https=/i.test(part)) || parts.find((part) => /^http=/i.test(part))
    if (chosen) raw = chosen.slice(chosen.indexOf('=') + 1).trim()
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`
  try {
    const url = new URL(raw)
    if (!url.hostname) return ''
    return raw
  } catch {
    return ''
  }
}

function detectSystemProxy() {
  if (process.platform !== 'win32') return ''
  let output = ''
  try {
    output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  } catch {
    return ''
  }
  const enabled = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(output)
  if (!enabled || Number(enabled[1]) === 0) return ''
  const server = /ProxyServer\s+REG_SZ\s+(.+)$/im.exec(output)
  return server ? normalizeProxy(server[1]) : ''
}

function detectEnvProxy() {
  return normalizeProxy(
    process.env.FISH_DANDAN_CREATIVE_STUDIO_GIT_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || ''
  )
}

function detectGitConfigProxy() {
  for (const key of ['http.proxy', 'https.proxy']) {
    try {
      const configured = execFileSync('git', ['config', '--global', '--get', key], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      }).trim()
      if (configured) return normalizeProxy(configured)
    } catch {
      /* 没有 Git 或没有配置代理时继续找下一个来源 */
    }
  }
  return ''
}

function githubTransports() {
  const list = [{ id: 'direct', label: '直连', proxy: '' }]
  const seen = new Set([''])
  const add = (id, label, proxy) => {
    const normalized = normalizeProxy(proxy)
    if (!normalized || seen.has(normalized.toLowerCase())) return
    seen.add(normalized.toLowerCase())
    list.push({ id, label, proxy: normalized })
  }
  add('system', '系统代理', detectSystemProxy())
  add('env', '环境变量代理', detectEnvProxy())
  add('git', 'Git 代理', detectGitConfigProxy())
  return list
}

function gitTransportArgs(transport) {
  const proxy = text(transport && transport.proxy)
  if (!proxy) return ['-c', 'http.proxy=', '-c', 'https.proxy=']
  return ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`]
}

function gitProcessEnv(transport) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  }
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  if (!transport || !transport.proxy) {
    for (const key of proxyKeys) delete env[key]
    env.NO_PROXY = 'github.com'
    env.no_proxy = 'github.com'
  } else {
    delete env.NO_PROXY
    delete env.no_proxy
  }
  return env
}

function killProcessTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10 * 1000,
      env: process.env,
    }, () => { /* 由调用方的 reject 统一处理 */ })
    return
  }
  try { child.kill('SIGTERM') } catch { /* 进程可能已经退出 */ }
}

function probeGithubTransport(repository, transport, onChild) {
  return new Promise((resolve, reject) => {
    const args = [
      ...gitTransportArgs(transport),
      'ls-remote', '--symref', repository, 'HEAD',
    ]
    const child = execFile('git', args, {
      windowsHide: true,
      timeout: 7000,
      maxBuffer: 1024 * 1024,
      env: gitProcessEnv(transport),
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve()
        return
      }
      err.detail = text(stderr) || text(stdout)
      if (err.code === 'ENOENT') {
        err.code = 'GIT_NOT_FOUND'
        err.message = '这台电脑没有找到 Git，先安装 Git 再试'
      }
      reject(err)
    })
    if (typeof onChild === 'function') onChild(child)
  })
}

function parseGitCloneProgress(chunk, emit) {
  const lines = String(chunk || '').replace(/\r/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let match = null
    if ((match = /Receiving objects:\s*(\d+)%/.exec(line))) {
      emit({ percent: Math.min(80, Math.round(Number(match[1]) * 0.8)), phase: '正在拉取文件', detail: line })
    } else if ((match = /Resolving deltas:\s*(\d+)%/.exec(line))) {
      emit({ percent: Math.min(98, 80 + Math.round(Number(match[1]) * 0.18)), phase: '正在整理文件', detail: line })
    } else if ((match = /Updating files:\s*(\d+)%/.exec(line))) {
      emit({ percent: Math.min(100, 98 + Math.round(Number(match[1]) * 0.02)), phase: '正在写入文件', detail: line })
    } else if (/remote: Counting objects/.test(line)) {
      emit({ percent: 2, phase: '正在连接 GitHub', detail: line })
    } else if (/remote: Compressing objects/.test(line)) {
      emit({ percent: 8, phase: 'GitHub 正在打包', detail: line })
    } else if (/Cloning into/.test(line)) {
      emit({ percent: 1, phase: '正在连接 GitHub', detail: line })
    }
  }
}

function cloneGitHubRepository(repository, target, transport, onProgress, onChild) {
  return new Promise((resolve, reject) => {
    const args = [
      ...gitTransportArgs(transport),
      'clone',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      '--progress',
      repository,
      target,
    ]
    let settled = false
    let lastProgressAt = Date.now()
    let stallTimer = null
    const finish = (err) => {
      if (settled) return
      settled = true
      if (stallTimer) clearInterval(stallTimer)
      stallTimer = null
      if (err) reject(err)
      else resolve()
    }
    const child = execFile('git', args, {
      windowsHide: true,
      timeout: 15 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: gitProcessEnv(transport),
    }, (err, stdout, stderr) => {
      if (!err) {
        finish()
        return
      }
      err.detail = text(stderr) || text(stdout)
      if (err.code === 'ENOENT') {
        err.code = 'GIT_NOT_FOUND'
        err.message = '这台电脑没有找到 Git，先安装 Git 再试'
      } else if (err.killed || err.signal) {
        err.code = 'GITHUB_TIMEOUT'
        err.message = '从 GitHub 拉取超时；检查网络后重试'
      } else {
        err.code = 'GITHUB_CLONE_FAILED'
        err.message = '从 GitHub 拉取失败；检查网络和仓库地址'
      }
      finish(err)
    })
    stallTimer = setInterval(() => {
      if (settled) return
      if (Date.now() - lastProgressAt < 60 * 1000) return
      killProcessTree(child)
      finish(localError('GITHUB_STALLED', '拉取超过 60 秒没有进度；正在换网络方式重试'))
    }, 10 * 1000)
    if (typeof onChild === 'function') onChild(child)
    if (typeof onProgress === 'function' && child.stderr) {
      child.stderr.on('data', (chunk) => {
        lastProgressAt = Date.now()
        try {
          parseGitCloneProgress(chunk, onProgress)
        } catch {
          /* 进度解析失败不影响克隆 */
        }
      })
    }
  })
}

function isInside(target, root) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

function readJson(file) {
  return readJsonSafe(file, null)
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function listDir(target) {
  try {
    return fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 只解析 [project] 里最小的元信息，不引入 TOML 依赖。 */
function parseProject(textValue) {
  const block = textValue.match(/\[project\]([\s\S]*?)(?=\n\[|$)/)
  if (!block) return null
  const source = block[1]
  const name = source.match(/name\s*=\s*["']([^"']+)["']/)?.[1] || ''
  const version = source.match(/version\s*=\s*["']([^"']+)["']/)?.[1] || ''
  const requiresPython = source.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1] || ''
  const dependenciesBlock = source.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1] || ''
  const dependencies = [...dependenciesBlock.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  return { name, version, requiresPython, dependencies }
}

function scanTemplates(root) {
  return listDir(path.join(root, 'templates'))
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const raw = readJson(path.join(root, 'templates', entry.name, 'template.json'))
      if (!raw || typeof raw !== 'object') return null
      const format = text(raw.format)
      if (!format) return null
      return {
        id: text(raw.id) || entry.name,
        name: text(raw.name) || entry.name,
        format,
        formatLabel: FORMAT_LABELS[format] || format,
        theme: text(raw.theme),
        placements: Object.keys(raw.character?.placements || {}).filter(Boolean).sort(),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function scanCharacters(root) {
  const registry = readJson(path.join(root, 'assets', 'characters', 'registry.json'))
  if (!registry || typeof registry !== 'object') return []
  return Object.entries(registry)
    .map(([id, raw]) => {
      if (!raw || typeof raw !== 'object') return null
      return {
        id: text(raw.id) || id,
        name: text(raw.name) || id,
        avatar: text(raw.avatar),
        poses: Object.keys(raw.poses || {}).filter(Boolean).sort(),
      }
    })
    .filter(Boolean)
}

function scanThemes(root) {
  return listDir(path.join(root, 'themes'))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const raw = readJson(path.join(root, 'themes', entry.name))
      if (!raw || typeof raw !== 'object') return null
      return {
        id: text(raw.id) || entry.name.replace(/\.json$/i, ''),
        name: text(raw.name) || text(raw.id) || entry.name.replace(/\.json$/i, ''),
        mood: Array.isArray(raw.mood) ? raw.mood.map(text).filter(Boolean) : [],
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function scanPresets(root) {
  return listDir(path.join(root, 'presets'))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const raw = readJson(path.join(root, 'presets', entry.name))
      if (!raw || typeof raw !== 'object') return null
      return {
        id: text(raw.id) || entry.name.replace(/\.json$/i, ''),
        name: text(raw.name) || text(raw.id) || entry.name.replace(/\.json$/i, ''),
        format: text(raw.format) || '',
        template: text(raw.template) || '',
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 检查一个候选目录。目录不存在返回 null；目录存在但契约不完整返回 invalid。
 * 这里只读文件，不执行插件代码。
 */
function inspectAt(root, source) {
  if (!isDirectory(root)) return null

  const pyproject = readText(path.join(root, 'pyproject.toml'))
  if (!pyproject) {
    return {
      state: 'invalid',
      installed: false,
      source,
      root,
      reason: '目录存在，但缺少 pyproject.toml',
    }
  }

  const project = parseProject(pyproject)
  if (!project?.name) {
    return {
      state: 'invalid',
      installed: false,
      source,
      root,
      reason: 'pyproject.toml 里没有可读的 [project].name',
    }
  }
  if (project.name !== CREATIVE_STUDIO.projectName) {
    return {
      state: 'invalid',
      installed: false,
      source,
      root,
      reason: `项目名是 ${project.name}，不是 ${CREATIVE_STUDIO.projectName}`,
    }
  }

  const missing = []
  if (!fs.existsSync(path.join(root, CREATIVE_STUDIO.entry))) missing.push(CREATIVE_STUDIO.entry)
  if (!fs.existsSync(path.join(root, CREATIVE_STUDIO.pipeline))) missing.push(CREATIVE_STUDIO.pipeline)
  if (!isDirectory(path.join(root, 'templates'))) missing.push('templates/')
  if (missing.length) {
    return {
      state: 'invalid',
      installed: false,
      source,
      root,
      version: project.version || null,
      reason: `安装不完整，缺少 ${missing.join('、')}`,
    }
  }

  const templates = scanTemplates(root)
  if (!templates.length) {
    return {
      state: 'invalid',
      installed: false,
      source,
      root,
      version: project.version || null,
      reason: 'templates/ 里没有可读的 template.json',
    }
  }

  const formats = [...new Set(templates.map((item) => item.format))].sort()
  const capabilities = formats.map((format) => ({
    id: format,
    label: FORMAT_LABELS[format] || format,
    templateCount: templates.filter((item) => item.format === format).length,
  }))
  const characters = scanCharacters(root)
  const placements = [...new Set(templates.flatMap((item) => item.placements || []))].sort()

  return {
    state: 'installed',
    installed: true,
    source,
    root,
    version: project.version || null,
    requirements: {
      python: project.requiresPython || '>=3.11',
      packages: project.dependencies || [],
    },
    capabilities,
    templates,
    themes: scanThemes(root),
    presets: scanPresets(root),
    characters,
    placements,
  }
}

/**
 * 创建宿主侧的创作插件对象。
 * 当前暴露 status / inspect / installLocal / installGithub / uninstall；渲染与发布仍未接。
 */
export function createCreativeStudioPlugin({
  logger = console,
  getPersona = () => null,
  getState = () => null,
  now = () => new Date(),
} = {}) {
  const installRoot = fromRoot(CREATIVE_STUDIO.installDir)
  const recordFile = fromRoot(CREATIVE_STUDIO.recordPath)
  const lastFile = fromRoot(CREATIVE_STUDIO.lastPath)
  const renderer = createCreativeRenderer({ logger })
  const planner = createCreativePlanner({ logger, getPersona, getState, now })
  let running = null
  let preparing = null
  let installingGithub = false
  let githubCloneChild = null
  let githubInstallCanceled = false
  let githubInstallProgress = null

  function updateGithubInstallProgress(patch) {
    const at = now().getTime()
    githubInstallProgress = {
      percent: 0,
      phase: '准备拉取',
      detail: '',
      startedAt: at,
      updatedAt: at,
      ...(githubInstallProgress || {}),
      ...patch,
      updatedAt: at,
    }
  }

  /**
   * 清理上次进程退出、页面关闭或安装中断后留下的 GitHub 临时目录。
   * 只删除插件目录同级、以 `.插件名-install-` 开头的目录，不碰正式插件目录。
   */
  function cleanupGithubInstallStages() {
    const parent = path.dirname(installRoot)
    const prefix = `.${path.basename(installRoot)}-install-`
    let entries = []
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      const stage = path.join(parent, entry.name)
      if (!isInside(stage, parent)) continue
      try {
        if (removeTree(stage)) removed += 1
      } catch (err) {
        logger.warn(`创作插件临时目录清理失败：${entry.name} ${err.message}`)
      }
    }
    if (removed > 0) logger.info(`创作插件：清理了 ${removed} 个未完成的 GitHub 安装临时目录`)
    return removed
  }

  cleanupGithubInstallStages()

  function readRecord() {
    const record = readJson(recordFile)
    if (!record || typeof record !== 'object') return null
    if (!text(record.path)) return null
    return record
  }

  function readLast() {
    const last = readJson(lastFile)
    if (!last || typeof last !== 'object') return null
    return last
  }

  function readAccount() {
    const account = readJson(fromRoot(CREATIVE_STUDIO.accountPath))
    if (!account || typeof account !== 'object') return null
    return account
  }

  function cleanHandle(value) {
    return text(value)
      .replace(/^@+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
  }

  function personaName() {
    try {
      return cleanHandle(getPersona?.()?.identity?.name)
    } catch {
      return ''
    }
  }

  function accountAvatarFile() {
    const dir = fromRoot(CREATIVE_STUDIO.accountAvatarDir)
    for (const name of ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp']) {
      const file = path.join(dir, name)
      try {
        const stat = fs.lstatSync(file)
        if (stat.isFile() && !stat.isSymbolicLink()) return file
      } catch { /* 试下一个扩展名 */ }
    }
    return null
  }

  function accountAvatarMime() {
    const file = accountAvatarFile()
    if (!file) return ''
    const ext = path.extname(file).toLowerCase()
    return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  }

  function accountStatus() {
    const saved = readAccount()
    const customHandle = cleanHandle(saved?.handle)
    const ownHandle = personaName()
    // 这里是“蛋蛋自己发出去时用的名字”，不是主人的抖音昵称。
    const handle = customHandle || ownHandle || '蛋蛋'
    const avatarFile = accountAvatarFile()
    let avatarUrl = ''
    if (avatarFile) {
      try {
        const stamp = Math.round(fs.statSync(avatarFile).mtimeMs)
        avatarUrl = `/creative-studio/account-avatar?t=${stamp}`
      } catch { /* 文件不可读时不显示预览 */ }
    }
    return {
      handle,
      source: customHandle ? 'custom' : ownHandle ? 'persona' : 'default',
      avatarUrl,
      usingFallbackAvatar: !avatarFile,
      canEdit: true,
    }
  }

  function accountForRender() {
    const status = accountStatus()
    const avatarFile = accountAvatarFile()
    return {
      handle: status.handle || '',
      avatar: avatarFile || '',
    }
  }

  function saveAccount(input) {
    const handle = cleanHandle(input)
    const saved = readAccount() || {}
    writeJsonAtomic(fromRoot(CREATIVE_STUDIO.accountPath), {
      schemaVersion: 1,
      handle,
      updatedAt: new Date().toISOString(),
      ...(saved.avatarFile ? { avatarFile: saved.avatarFile } : {}),
    })
    return status()
  }

  function saveAvatar(dataBase64) {
    const raw = String(dataBase64 || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').trim()
    if (!raw) throw localError('AVATAR_REQUIRED', '没有收到头像图片')
    let buffer
    try {
      buffer = Buffer.from(raw, 'base64')
    } catch {
      throw localError('AVATAR_INVALID', '头像图片格式不正确')
    }
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
      throw localError('AVATAR_TOO_LARGE', '头像不能超过 8MB')
    }
    // 浏览器端统一转成 PNG；这里再校验一次 PNG 头，避免把任意文件写成头像。
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
      throw localError('AVATAR_INVALID', '头像图片格式不正确')
    }
    const dir = fromRoot(CREATIVE_STUDIO.accountAvatarDir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'avatar.png')
    const temp = path.join(dir, `.avatar-${process.pid}-${Date.now()}.tmp`)
    fs.writeFileSync(temp, buffer)
    try {
      fs.copyFileSync(temp, file)
      fs.unlinkSync(temp)
    } catch (err) {
      try { fs.unlinkSync(temp) } catch { /* 临时文件可能已不在 */ }
      throw err
    }
    for (const name of ['avatar.jpg', 'avatar.jpeg', 'avatar.webp']) {
      try { fs.unlinkSync(path.join(dir, name)) } catch { /* 旧格式不存在 */ }
    }
    return status()
  }

  /** 只把创作工作室自己返回的、仍在它目录内的图片交给页面预览。 */
  function imageFor(jobId) {
    const id = text(jobId)
    const last = readLast()
    if (!id || !last || text(last.jobId) !== id || !text(last.imagePath)) return null
    const plugin = inspect()
    if (!text(plugin.root)) return null
    let root
    try {
      root = fs.realpathSync(plugin.root)
    } catch {
      return null
    }
    let image
    try {
      image = fs.realpathSync(path.resolve(String(last.imagePath)))
    } catch {
      return null
    }
    if (!isInside(image, root)) return null
    try {
      const stat = fs.lstatSync(image)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
    } catch {
      return null
    }
    return image
  }

  function writeLast(payload) {
    try {
      writeJsonAtomic(lastFile, payload)
    } catch (err) {
      logger.warn(`创作结果状态写入失败：${err.message}`)
    }
  }

  /**
   * 给自动发布用的当前作品：只认创作工作室自己返回、且仍在插件目录内的图片。
   * 标题用当前作品的短配文；正文优先用 plan.json 里的正文，旧作品没有 plan 时回退到配文。
   */
  function publication() {
    const last = readLast()
    if (!last || last.ok !== true) throw localError('CREATIVE_NO_WORK', '当前没有作品，先做一张图文')
    const imagePath = imageFor(last.jobId)
    if (!imagePath) throw localError('CREATIVE_WORK_GONE', '当前作品图片不在了，再生成一张')
    const caption = text(last.caption)
    let plan = {}
    try {
      plan = readJsonSafe(path.join(path.dirname(imagePath), 'plan.json'), {}, () => {}) || {}
    } catch { /* 旧作品没有 plan 时用配文兜底 */ }
    const hook = text(plan.hook)
    const planBody = text(plan.body)
    const title = (caption || hook || '蛋蛋的图文').slice(0, 20)
    // 图里是「hook + body」两段：body 以逗号/句号开头时直接拼，避免正文从标点开始。
    let body = planBody
      ? (/^[，。；：、,.!?！？]/.test(planBody) ? hook + planBody : [hook, planBody].filter(Boolean).join('\n'))
      : (caption || hook)
    body = body.slice(0, 1000)
    if (!body) body = '今天做了一张图文。'
    return {
      jobId: text(last.jobId),
      imagePath,
      title,
      body,
      caption,
      outputDir: path.dirname(imagePath),
    }
  }

  function newJobId() {
    const stamp = now().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    return `creative-${stamp}-${randomBytes(3).toString('hex')}`
  }

  function recordSource(record) {
    return record?.managed === true || text(record?.source) === 'github' ? 'github' : 'local'
  }

  /**
   * 单安装槽：环境变量覆盖 > 安装记录 > 未安装。
   * 不再静默扫描默认目录，否则卸载后残留目录会继续被当成“已安装”。
   */
  function inspect() {
    const envRoot = text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PATH)
    if (envRoot) {
      const root = fromRoot(envRoot)
      const checked = inspectAt(root, 'env')
      return {
        ...(checked || {}),
        state: checked?.state || 'invalid',
        installed: Boolean(checked?.installed),
        source: 'env',
        root,
        reason: checked?.reason || '环境变量指向的目录不存在',
        installSource: 'env',
        managed: false,
        canUninstall: false,
        uninstallHint: '当前是环境变量开发覆盖，不能在页面卸载；先移除 FISH_DANDAN_CREATIVE_STUDIO_PATH',
      }
    }

    const record = readRecord()
    if (record) {
      const root = fromRoot(record.path)
      const checked = inspectAt(root, 'record')
      const installSource = recordSource(record)
      if (!checked) {
        return {
          state: 'invalid',
          installed: false,
          source: 'record',
          root,
          version: text(record.version) || null,
          reason: '安装记录指向的目录不存在',
          installSource,
          managed: installSource === 'github',
          canUninstall: true,
        }
      }
      return {
        ...checked,
        installSource,
        managed: installSource === 'github',
        canUninstall: true,
      }
    }

    return {
      state: 'missing',
      installed: false,
      source: null,
      root: null,
      reason: '还没有安装创作插件',
      installSource: null,
      managed: false,
      canUninstall: false,
    }
  }

  function status() {
    const plugin = inspect()
    const record = readRecord()
    const recordRepository = record && recordSource(record) === 'github'
      ? (text(record.repository) || (text(record.repo) ? `https://github.com/${text(record.repo)}.git` : ''))
      : ''
    const repository = text(process.env.FISH_DANDAN_CREATIVE_STUDIO_REPO) || recordRepository || CREATIVE_STUDIO.repository
    const imagePost = (plugin.capabilities || []).find((item) => item.id === 'image_post') || null
    const blackCard = (plugin.templates || []).find((item) => item.id === 'black-card' && item.format === 'image_post') || null
    const permission = plugin.state === 'missing'
      ? 'not-installed'
      : plugin.state === 'invalid'
        ? 'invalid'
        : !imagePost || !blackCard
          ? 'unsupported'
          : 'ready'
    const reason = permission === 'not-installed'
      ? '还没有安装创作插件，请先安装'
      : permission === 'invalid'
        ? (plugin.reason || '插件安装不完整，请先卸载后重装')
        : permission === 'unsupported'
          ? '当前插件版本不支持自动做图文'
          : '按当前心情生成一张图文；只生成，不发布'
    const runtime = renderer.runtimeStatus(plugin)
    const last = readLast()
    const lastPreviewable = Boolean(last && last.ok && imageFor(last.jobId))

    return {
      plugin: {
        id: CREATIVE_STUDIO.id,
        name: CREATIVE_STUDIO.name,
        ...plugin,
        entry: {
          command: CREATIVE_STUDIO.command,
          file: CREATIVE_STUDIO.entry,
          implementedInHost: true,
        },
      },
      action: {
        id: 'auto_image_post',
        label: '自动做图文',
        enabled: permission === 'ready',
        permission,
        supportedByPlugin: Boolean(imagePost && blackCard),
        busy: Boolean(running || preparing),
        reason,
      },
      runtime: {
        ...runtime,
        installing: Boolean(preparing),
        progress: preparing ? { ...preparing } : null,
      },
      generation: {
        ready: planner.isReady(),
        reason: planner.isReady() ? '文案模型已接上' : '文案模型还没接上',
      },
      run: running ? { ...running } : null,
      last: last ? { ...last, previewable: lastPreviewable } : null,
      account: accountStatus(),
      install: {
        targetDir: CREATIVE_STUDIO.installDir,
        runtimeDir: CREATIVE_STUDIO.runtimeDir,
        repository,
        mode: 'single-slot',
        activeSource: plugin.installSource,
        enabled: plugin.state === 'missing' && !installingGithub,
        installing: installingGithub,
        progress: installingGithub ? { ...(githubInstallProgress || { percent: 0, phase: '准备拉取' }) } : null,
        reason: plugin.state === 'missing'
          ? '可以从 GitHub 安装到平台插件目录'
          : '先卸载当前版本，再安装新的',
      },
    }
  }

  /**
   * 登记一个本地目录。只写安装记录，不复制文件、不改原项目、不执行代码。
   * 目录必须通过和安装目录同一套契约检查，避免把错目录登记成已安装。
   */
  function installLocal(inputPath) {
    if (installingGithub) throw localError('CREATIVE_STUDIO_BUSY', '正在从 GitHub 安装，等它结束再安装本地版')
    const current = inspect()
    if (current.state === 'installed' || current.state === 'invalid') {
      if (current.installSource === 'env') {
        throw localError('ENV_OVERRIDE', '当前是环境变量开发覆盖，先移除 FISH_DANDAN_CREATIVE_STUDIO_PATH 再安装')
      }
      throw localError('ALREADY_INSTALLED', '已经安装了创作插件；先卸载当前版本，再安装新的')
    }

    let raw = text(inputPath)
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim()
    }
    if (!raw) throw localError('PATH_REQUIRED', '请填写本地项目目录')
    if (!path.isAbsolute(raw)) throw localError('PATH_NOT_ABSOLUTE', '请填写完整的本地目录，例如 E:\\Projects\\dandan-creative-studio')

    let root
    try {
      root = path.resolve(raw)
      const stat = fs.statSync(root)
      if (!stat.isDirectory()) throw localError('PATH_NOT_DIR', '这个路径不是文件夹')
    } catch (err) {
      if (err.code === 'PATH_NOT_DIR') throw err
      throw localError('PATH_NOT_FOUND', '找不到这个文件夹，检查路径是否正确')
    }

    const checked = inspectAt(root, 'local')
    if (!checked || checked.state !== 'installed') {
      throw localError('PLUGIN_INVALID', checked?.reason || '这个目录不是可用的 dandan-creative-studio 项目')
    }

    const record = {
      schemaVersion: 1,
      id: CREATIVE_STUDIO.id,
      source: 'local',
      managed: false,
      path: checked.root,
      version: checked.version || null,
      installedAt: new Date().toISOString(),
    }
    try {
      writeJsonAtomic(recordFile, record)
    } catch (err) {
      logger.warn(`创作插件本地安装记录写入失败：${err.message}`)
      throw localError('RECORD_WRITE_FAILED', '安装记录写入失败，详情见日志')
    }
    logger.info('创作插件已登记本地目录')
    return { ...status(), installedNow: true }
  }

  /**
   * 从 GitHub 安装：浅克隆到平台插件目录，不执行仓库里的代码。
   * 先把仓库拉到同级临时目录并检查契约，再整体换入目标目录；
   * 目标目录已有残留时先改名备份，失败会恢复，避免半安装。
   */
  async function installGithub(inputRepository) {
    if (installingGithub) throw localError('CREATIVE_STUDIO_BUSY', '正在从 GitHub 安装，等它结束再试')
    if (running || preparing) throw localError('CREATIVE_STUDIO_BUSY', '正在生成或安装依赖，等它结束再安装插件')
    if (text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PATH)) {
      throw localError('ENV_OVERRIDE', '当前是环境变量开发覆盖，先移除 FISH_DANDAN_CREATIVE_STUDIO_PATH 再安装')
    }

    const current = inspect()
    if (current.state === 'installed' || current.state === 'invalid') {
      throw localError('ALREADY_INSTALLED', '已经安装了创作插件；先卸载当前版本，再安装新的')
    }

    const repository = normalizeGitHubRepository(inputRepository)
    installingGithub = true
    githubInstallCanceled = false
    githubCloneChild = null
    cleanupGithubInstallStages()
    updateGithubInstallProgress({ percent: 0, phase: '准备拉取', detail: '正在创建临时目录' })
    const parent = path.dirname(installRoot)
    const stage = path.join(parent, `.${path.basename(installRoot)}-install-${randomBytes(6).toString('hex')}`)
    let backup = null
    let placed = false

    try {
      fs.mkdirSync(parent, { recursive: true })
      const transports = githubTransports()
      let cloned = false
      let lastError = null
      for (const transport of transports) {
        if (githubInstallCanceled) throw localError('GITHUB_CANCELED', '已取消从 GitHub 安装')
        updateGithubInstallProgress({ percent: 0, phase: `正在检测网络（${transport.label}）`, detail: '先用 ls-remote 试通不通' })
        try {
          await probeGithubTransport(repository.url, transport, (child) => {
            githubCloneChild = child
          })
          githubCloneChild = null
          if (githubInstallCanceled) throw localError('GITHUB_CANCELED', '已取消从 GitHub 安装')
          updateGithubInstallProgress({ percent: 0, phase: `正在连接 GitHub（${transport.label}）`, detail: '网络可用，开始拉取' })
          removeTree(stage)
          await cloneGitHubRepository(repository.url, stage, transport, (progress) => {
            updateGithubInstallProgress(progress)
          }, (child) => {
            githubCloneChild = child
          })
          githubCloneChild = null
          if (githubInstallCanceled) throw localError('GITHUB_CANCELED', '已取消从 GitHub 安装')
          cloned = true
          break
        } catch (err) {
          githubCloneChild = null
          if (githubInstallCanceled) throw localError('GITHUB_CANCELED', '已取消从 GitHub 安装')
          if (err.code === 'GIT_NOT_FOUND') throw err
          lastError = err
          try { removeTree(stage) } catch { /* 下一轮会再清一次 */ }
          logger.warn(`创作插件 GitHub 安装网络方式「${transport.label}」失败：${err.code || ''} ${err.message}`)
        }
      }
      if (!cloned) {
        throw localError(
          'GITHUB_NETWORK_UNREACHABLE',
          lastError?.code === 'GITHUB_STALLED'
            ? '直连和代理都没能完成拉取；检查网络或代理后再试'
            : '直连和代理都连不上 GitHub；检查网络或代理后再试'
        )
      }
      updateGithubInstallProgress({ percent: 82, phase: '校验项目', detail: '检查项目名、入口文件和模板' })

      const checked = inspectAt(stage, 'github')
      if (!checked || checked.state !== 'installed') {
        throw localError('PLUGIN_INVALID', checked?.reason || '仓库不是完整的创作工作室项目')
      }

      updateGithubInstallProgress({ percent: 90, phase: '换入插件目录', detail: '准备替换平台插件目录' })
      try {
        const stat = fs.lstatSync(installRoot)
        if (stat.isSymbolicLink()) {
          throw localError('INSTALL_PATH_INVALID', '平台插件目录是符号链接，拒绝覆盖；请手动检查')
        }
        if (!stat.isDirectory()) {
          throw localError('INSTALL_PATH_INVALID', '平台插件路径不是文件夹，拒绝覆盖')
        }
        backup = `${installRoot}.backup-${Date.now()}`
        fs.renameSync(installRoot, backup)
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'INSTALL_PATH_INVALID') throw err
        if (err.code === 'INSTALL_PATH_INVALID') throw err
      }

      fs.renameSync(stage, installRoot)
      placed = true

      const record = {
        schemaVersion: 1,
        id: CREATIVE_STUDIO.id,
        source: 'github',
        managed: true,
        repo: `${repository.owner}/${repository.repo}`,
        repository: repository.url,
        ref: null,
        path: installRoot,
        version: checked.version || null,
        installedAt: now().toISOString(),
      }
      updateGithubInstallProgress({ percent: 96, phase: '写入安装记录', detail: '登记 GitHub 版插件' })
      try {
        writeJsonAtomic(recordFile, record)
      } catch (err) {
        logger.warn(`创作插件 GitHub 安装记录写入失败：${err.message}`)
        throw localError('RECORD_WRITE_FAILED', '安装记录写入失败，详情见日志')
      }

      updateGithubInstallProgress({ percent: 100, phase: '安装完成', detail: '' })

      if (backup) {
        try {
          removeTree(backup)
        } catch (err) {
          logger.warn(`创作插件旧目录备份清理失败：${err.message}`)
        }
      }
      logger.info(`创作插件已从 GitHub 安装：${repository.owner}/${repository.repo}`)
      return { ...status(), installedNow: true }
    } catch (err) {
      // 任何一步失败都恢复原目录，避免留下半个插件。
      if (placed) {
        try { removeTree(installRoot) } catch { /* 最后用日志暴露 */ }
      }
      if (backup && !fs.existsSync(installRoot)) {
        try { fs.renameSync(backup, installRoot) } catch (restoreErr) {
          logger.warn(`创作插件安装失败后恢复旧目录失败：${restoreErr.message}`)
        }
      }
      if (githubInstallCanceled) {
        err.code = 'GITHUB_CANCELED'
        err.message = '已取消从 GitHub 安装'
      }
      throw err
    } finally {
      installingGithub = false
      githubCloneChild = null
      githubInstallCanceled = false
      githubInstallProgress = null
      try { removeTree(stage) } catch { /* 临时目录清理失败不影响结果 */ }
    }
  }

  /**
   * 取消正在进行的 GitHub 浅克隆；只停止临时目录里的拉取，不改安装记录。
   */
  function cancelGithubInstall() {
    if (!installingGithub) throw localError('NOT_INSTALLING', '当前没有正在进行的 GitHub 安装')
    githubInstallCanceled = true
    updateGithubInstallProgress({ phase: '正在取消', detail: '停止 Git 拉取' })
    const child = githubCloneChild
    githubCloneChild = null
    killProcessTree(child)
    return { canceling: true }
  }

  /**
   * 卸载当前活跃插件。
   * - 本地版：只删安装记录，保留本地插件目录、同级依赖目录和本机 Python。
   * - GitHub 版：删除平台插件副本和同级依赖目录，保留本机 Python。
   */
  function uninstall() {
    if (installingGithub) throw localError('CREATIVE_STUDIO_BUSY', '正在从 GitHub 安装，等它结束再卸载')
    if (running) throw localError('CREATIVE_STUDIO_BUSY', '正在生成图文，等这次创作结束后再卸载')
    if (preparing) throw localError('CREATIVE_STUDIO_BUSY', '正在安装依赖，等安装结束后再卸载')
    if (text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PATH)) {
      throw localError('ENV_OVERRIDE', '当前是环境变量开发覆盖，不能在页面卸载；先移除 FISH_DANDAN_CREATIVE_STUDIO_PATH')
    }
    const record = readRecord()
    if (!record) throw localError('NOT_INSTALLED', '当前没有已登记的创作插件')

    const installSource = recordSource(record)
    let removedManagedDirectory = false
    let removedRuntime = false
    if (installSource === 'github') {
      const target = path.resolve(fromRoot(record.path))
      const relative = path.relative(installRoot, target)
      // 只允许删平台管理的目录内部；不同盘符时 relative 会是绝对路径
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw localError('UNINSTALL_PATH_INVALID', '安装记录不在平台插件目录内，拒绝删除；请手动检查')
      }
      let stat = null
      try {
        stat = fs.lstatSync(target)
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn(`创作插件卸载前检查失败：${err.message}`)
          throw localError('UNINSTALL_DELETE_FAILED', '卸载前检查目录失败，详情见日志')
        }
      }
      if (stat?.isSymbolicLink()) {
        throw localError('UNINSTALL_PATH_INVALID', '插件目录是符号链接，拒绝删除；请手动处理')
      }
      if (stat && !stat.isDirectory()) {
        throw localError('UNINSTALL_PATH_INVALID', '插件路径不是文件夹，拒绝删除')
      }
      if (stat) {
        try {
          removedManagedDirectory = removeTree(target)
        } catch (err) {
          logger.warn(`创作插件目录删除失败：${err.message}`)
          throw localError('UNINSTALL_DELETE_FAILED', '插件目录删除失败，安装记录仍保留；详情见日志')
        }
      }

      // 依赖装在插件目录同级的 -runtime 目录里，跟着插件一起删。
      removedRuntime = renderer.removeRuntime({
        installSource: 'github',
        managed: true,
        root: target,
      })
      if (!removedRuntime && fs.existsSync(fromRoot(CREATIVE_STUDIO.runtimeDir))) {
        logger.warn('创作插件依赖目录清理失败，安装记录仍保留')
        throw localError('UNINSTALL_DELETE_FAILED', '插件已删除，但依赖目录没删干净；请重试或手动检查')
      }
    }

    try {
      fs.rmSync(recordFile, { force: true })
    } catch (err) {
      logger.warn(`创作插件安装记录删除失败：${err.message}`)
      throw localError('RECORD_REMOVE_FAILED', '安装记录删除失败，详情见日志')
    }

    // 本地版只把页面的安装状态还原为“未安装”，不碰本地插件目录、
    // 同级依赖目录和本机 Python。GitHub 版的清理已在上面完成。
    logger.info('创作插件已卸载')
    return { ...status(), uninstalled: true, removedManagedDirectory, removedRuntime }
  }

  function readyPlugin() {
    const plugin = inspect()
    if (plugin.state === 'missing') {
      throw localError('CREATIVE_STUDIO_NOT_INSTALLED', '还没有安装创作插件，请先安装')
    }
    if (plugin.state !== 'installed') {
      throw localError('CREATIVE_STUDIO_INVALID', plugin.reason || '插件安装不完整，请先卸载后重装')
    }
    const imagePost = (plugin.capabilities || []).find((item) => item.id === 'image_post')
    const blackCard = (plugin.templates || []).find((item) => item.id === 'black-card' && item.format === 'image_post')
    if (!imagePost || !blackCard) {
      throw localError('CREATIVE_STUDIO_UNSUPPORTED', '当前插件版本不支持自动做图文')
    }
    return plugin
  }

  function setGenerator({ llm, defaultModel } = {}) {
    planner.attach({ llm, defaultModel })
  }

  async function detectPython() {
    if (preparing) throw localError('CREATIVE_STUDIO_BUSY', '正在安装依赖，等安装结束后再检测')
    const plugin = inspect()
    if (plugin.state === 'missing') throw localError('CREATIVE_STUDIO_NOT_INSTALLED', '还没有安装创作插件，请先安装')
    if (plugin.state !== 'installed') throw localError('CREATIVE_STUDIO_INVALID', plugin.reason || '插件安装不完整，请先卸载后重装')
    return renderer.detectPython()
  }

  async function prepareRuntime() {
    if (preparing) throw localError('CREATIVE_STUDIO_BUSY', '正在安装依赖，等这次安装结束再点')
    const plugin = readyPlugin()
    preparing = {
      phase: 'checking',
      percent: 5,
      message: '检查 Python 3.11+…',
      startedAt: now().toISOString(),
    }
    try {
      const runtime = await renderer.prepareRuntime(plugin, {
        onProgress: (progress) => {
          if (!preparing) return
          preparing = {
            ...preparing,
            ...progress,
            updatedAt: now().toISOString(),
          }
        },
      })
      logger.info(`创作插件运行环境：${runtime.ready ? '已就绪' : '未就绪'}`)
      preparing = null
      return { ...status(), runtime }
    } catch (err) {
      logger.warn(`创作插件运行环境准备失败：${err?.code || 'UNKNOWN'} ${err?.message || err}`)
      throw err
    } finally {
      preparing = null
    }
  }

  async function renderImagePost({ jobId } = {}) {
    if (running) throw localError('CREATIVE_STUDIO_BUSY', '正在生成上一张图文，等它结束再点')
    if (preparing) throw localError('CREATIVE_STUDIO_BUSY', '正在安装依赖，等安装结束再创作')
    const plugin = readyPlugin()
    const runtime = renderer.runtimeStatus(plugin)
    if (!runtime.ready) {
      throw localError('CREATIVE_STUDIO_RUNTIME_NOT_READY', '依赖还没安装；先点插件卡里的“安装依赖”')
    }

    const id = text(jobId) || newJobId()
    let generated = null
    let previous = null
    running = {
      status: 'planning',
      phase: 'reading',
      jobId: id,
      startedAt: now().toISOString(),
    }

    try {
      running.phase = 'writing'
      previous = readLast()
      const account = accountForRender()
      generated = await planner.generate(plugin, { jobId: id, previous, account })
      const plan = generated.plan
      running.phase = 'rendering'
      const result = await renderer.renderJob(plugin, plan, id)
      const recentThemes = [...new Set([
        plan.theme,
        previous?.theme,
        ...(previous?.recentThemes || []),
      ].filter(Boolean))].slice(0, 3)
      const recentPoses = [...new Set([
        plan.character?.pose,
        previous?.character?.pose,
        ...(previous?.recentPoses || []),
      ].filter(Boolean))].slice(0, 3)
      const last = {
        schemaVersion: 1,
        jobId: id,
        ok: true,
        createdAt: now().toISOString(),
        theme: plan.theme,
        themeName: generated.look.themeName,
        character: plan.character,
        caption: plan.caption,
        imagePath: result.image,
        outputDir: result.output_dir,
        recentThemes,
        recentPoses,
        qa: result.qa || null,
      }
      writeLast(last)
      logger.info(`创作图文完成：${id}（${plan.theme} / ${plan.character.enabled ? plan.character.pose : '无角色'}）`)
      running = null
      return { ...status(), rendered: true, jobId: id }
    } catch (err) {
      const last = {
        schemaVersion: 1,
        jobId: id,
        ok: false,
        createdAt: now().toISOString(),
        theme: generated?.plan?.theme || null,
        themeName: generated?.look?.themeName || null,
        character: generated?.plan?.character || null,
        caption: generated?.plan?.caption || '',
        recentThemes: [...new Set([
          previous?.theme,
          ...(previous?.recentThemes || []),
        ].filter(Boolean))].slice(0, 3),
        recentPoses: [...new Set([
          previous?.character?.pose,
          ...(previous?.recentPoses || []),
        ].filter(Boolean))].slice(0, 3),
        error: {
          code: err?.code || 'CREATIVE_STUDIO_FAILED',
          message: err?.message || '图文生成失败',
        },
      }
      writeLast(last)
      logger.warn(`创作图文失败：${err?.code || 'UNKNOWN'} ${err?.message || err}`)
      throw err
    } finally {
      running = null
    }
  }

  return {
    status,
    inspect,
    imageFor,
    accountAvatarFile,
    accountAvatarMime,
    saveAccount,
    saveAvatar,
    installLocal,
    installGithub,
    cancelGithubInstall,
    uninstall,
    detectPython,
    prepareRuntime,
    renderImagePost,
    publication,
    setGenerator,
    paths: {
      lastFile,
      inputsDir: fromRoot(CREATIVE_STUDIO.inputsDir),
    },
  }
}
