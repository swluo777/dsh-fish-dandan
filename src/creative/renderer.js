// ============================================================
// 创作工作室 · Python 运行环境与渲染调用
//
// 依赖归属：
// - 本宿主不把 Pillow / tzdata 装进自己的 Node 项目，也不装进全局 Python；
// - 创作工作室在 pyproject.toml / requirements.txt 里声明依赖；
// - 平台在插件安装后为它准备一个隔离的 venv，放在插件目录同级的
//   <插件目录名>-runtime/，不在插件目录内部，也不写进用户自己的项目；
// - 卸载时插件目录和同级依赖目录按安装来源分别处理。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fromRoot } from '../utils/paths.js'
import { readJsonSafe, writeJsonAtomic } from '../utils/json.js'
import { removeTree } from './remove-tree.js'

const RUNTIME_ROOT = 'data/creative/runtime'
const INPUTS_ROOT = 'data/creative/inputs'
const READY_FILE = '.fish-dandan-ready.json'
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const RUNTIME_SUFFIX = '-runtime'
const DEFAULT_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const OFFICIAL_PIP_INDEX = 'https://pypi.org/simple'

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function renderError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

function isInside(target, root) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function hash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}

function safeJobId(value) {
  const id = text(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || id === '.' || id === '..') {
    throw renderError('JOB_ID_INVALID', 'job_id 不能用作目录名')
  }
  return id
}

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

function runtimeDirFor(plugin) {
  if (plugin?.root) {
    const root = path.resolve(plugin.root)
    // 依赖目录与插件目录同级，不放进插件内部，也不写进宿主 data 目录。
    return path.join(path.dirname(root), path.basename(root) + RUNTIME_SUFFIX)
  }
  return path.join(fromRoot(RUNTIME_ROOT), 'local-missing')
}

function requirementsFingerprint(plugin) {
  const reqFile = path.join(plugin?.root || '', 'requirements.txt')
  let source = ''
  try {
    source = fs.readFileSync(reqFile, 'utf8')
  } catch {
    source = (plugin?.requirements?.packages || []).join('\n')
  }
  return hash(source.replace(/\r\n/g, '\n').trim())
}

function pipIndex() {
  return text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PIP_INDEX) || DEFAULT_PIP_INDEX
}

function pipArgs(restoreArgs, index) {
  return [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-input',
    '--timeout', '60',
    '--retries', '2',
    '-i', index,
    ...restoreArgs,
  ]
}

/**
 * 跑一个子进程；参数数组直传，不拼 shell。
 * 超时会 kill 子进程并返回 timeout 标记，由调用方决定报什么错。
 */
function runProcess(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        env: env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error: err, timeout: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        ...result,
        stdout: stdout.slice(-MAX_OUTPUT_BYTES),
        stderr: stderr.slice(-MAX_OUTPUT_BYTES),
        timeout: timedOut,
      })
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (err) => finish({ code: null, signal: null, error: err }))
    child.on('close', (code, signal) => finish({ code, signal, error: null }))

    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { try { child.kill() } catch { /* 已退出 */ } }
      finish({ code: null, signal: 'SIGKILL', error: null })
    }, Math.max(1000, timeoutMs))
  })
}

async function probePython(candidate) {
  const script = "import sys,json; print(json.dumps({'executable':sys.executable,'major':sys.version_info[0],'minor':sys.version_info[1],'micro':sys.version_info[2]}))"
  const result = await runProcess(candidate.command, [...candidate.args, '-c', script], { timeoutMs: 10_000 })
  if (result.code !== 0) return null
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  try {
    const info = JSON.parse(line)
    if (!info || typeof info !== 'object') return null
    const major = Number(info.major)
    const minor = Number(info.minor)
    return {
      ...candidate,
      executable: text(info.executable) || candidate.command,
      major,
      minor,
      micro: Number(info.micro) || 0,
      version: `${major}.${minor}.${Number(info.micro) || 0}`,
    }
  } catch {
    return null
  }
}

function pythonDownloadUrl() {
  return process.platform === 'win32'
    ? 'https://www.python.org/downloads/windows/'
    : 'https://www.python.org/downloads/'
}

function pythonPathKey(value) {
  const raw = text(value)
  return process.platform === 'win32' ? raw.toLowerCase() : raw
}

function candidateKey(candidate) {
  const key = [candidate.command, ...(candidate.args || [])].join(' ')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function publicPython(info) {
  return {
    version: info.version,
    executable: info.executable,
    major: info.major,
    minor: info.minor,
    micro: info.micro,
    supported: Boolean(info.major >= 3 && info.minor >= 11),
    source: text(info.label) || '本机',
    origin: text(info.origin) || 'host',
    preferred: Boolean(info.preferred),
  }
}

function comparePython(a, b) {
  return (b.major - a.major) || (b.minor - a.minor) || (b.micro - a.micro)
}

/** DSH 自己的资源根目录；不猜盘符，按宿主进程位置找。 */
function dshResourceRoots() {
  const roots = []
  const add = (value) => {
    const root = text(value)
    if (root && !roots.some((item) => path.resolve(item).toLowerCase() === path.resolve(root).toLowerCase())) {
      roots.push(root)
    }
  }
  if (process.resourcesPath) add(process.resourcesPath)
  if (process.env.DSH_RESOURCES_PATH) add(process.env.DSH_RESOURCES_PATH)
  try {
    let current = path.dirname(process.execPath)
    for (let depth = 0; depth < 8; depth += 1) {
      if (!current || current === path.dirname(current)) break
      if (path.basename(current).toLowerCase() === 'resources') add(current)
      const nestedResources = path.join(current, 'resources')
      if (fs.existsSync(nestedResources)) add(nestedResources)
      current = path.dirname(current)
    }
  } catch { /* 某些运行环境没有 execPath */ }
  return roots
}

/** DSH 安装包里的 Python；路径由 resources/runtime 的同一套布局推出。 */
function collectDshPythonCandidates(add) {
  const executable = process.platform === 'win32' ? 'python.exe' : 'python3'
  for (const resources of dshResourceRoots()) {
    const candidates = [
      path.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python', executable),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        add(candidate, [], 'DSH 自带 Python', { origin: 'dsh', preferred: true })
      }
    }
  }
}

/** 豆包沙盒里的 Python 只能算兜底，不是 DSH 自带的 Python。 */
function collectDoubaoPythonCandidates(add) {
  const roots = []
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Doubao', 'User Data', 'sandbox_runtime'))
    if (process.env.USERPROFILE) roots.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Doubao', 'User Data', 'sandbox_runtime'))
  }
  const executable = process.platform === 'win32' ? 'python.exe' : 'python3'
  for (const root of roots) {
    const bases = path.join(root, 'bases')
    let entries = []
    try {
      entries = fs.readdirSync(bases, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(bases, entry.name, 'python', executable)
      if (fs.existsSync(candidate)) {
        add(candidate, [], '豆包运行环境', { origin: 'doubao', preferred: false })
      }
    }
  }
}

function pythonInRoot(root) {
  if (!root) return ''
  const candidate = process.platform === 'win32'
    ? path.join(root, 'python.exe')
    : path.join(root, 'bin', 'python3')
  return fs.existsSync(candidate) ? candidate : ''
}

function addPythonRoot(add, root, label, origin) {
  const executable = pythonInRoot(root)
  if (executable) add(executable, [], label, { origin, preferred: false })
}

function fixedDriveRoots() {
  if (process.platform !== 'win32') return []
  const roots = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.existsSync(root)) roots.push(root)
    } catch { /* 断开的网络盘 */ }
  }
  return roots
}

function condaRoots() {
  const roots = []
  const add = (value) => {
    const root = text(value)
    if (root && roots.every((item) => path.resolve(item).toLowerCase() !== path.resolve(root).toLowerCase())) {
      roots.push(root)
    }
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const envFile = home && path.join(home, '.conda', 'environments.txt')
  if (envFile) {
    try {
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) add(line.trim())
    } catch { /* 没有 conda 清单 */ }
  }
  for (const name of ['anaconda3', 'miniconda3', 'Anaconda3', 'Miniconda3']) {
    if (home) add(path.join(home, name))
    if (process.env.ProgramData) add(path.join(process.env.ProgramData, name))
  }
  for (const drive of fixedDriveRoots()) {
    let entries = []
    try {
      entries = fs.readdirSync(drive, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (entry.isDirectory() && /^(anaconda|miniconda)/i.test(entry.name)) {
        add(path.join(drive, entry.name))
      }
    }
  }
  return roots
}

async function collectCondaPythonCandidates(add) {
  const roots = new Set(condaRoots().map((root) => path.resolve(root)))
  const conda = await runProcess('where.exe', ['conda'], { timeoutMs: 10_000 })
  for (const line of String(conda.stdout || '').split(/\r?\n/)) {
    const executable = line.trim().replace(/^"|"$/g, '')
    if (!executable) continue
    const root = path.dirname(path.dirname(executable))
    if (root) roots.add(path.resolve(root))
  }
  for (const root of roots) {
    addPythonRoot(add, root, 'Conda 环境', 'conda')
    let envs = []
    try {
      envs = fs.readdirSync(path.join(root, 'envs'), { withFileTypes: true })
    } catch { continue }
    for (const entry of envs) {
      if (entry.isDirectory()) addPythonRoot(add, path.join(root, 'envs', entry.name), 'Conda 环境', 'conda')
    }
  }
}

/** 有界扫描虚拟环境：只看用户项目目录，不碰系统盘常见大目录。 */
function findVenvRoots(root, budget) {
  const roots = []
  if (!root || !fs.existsSync(root)) return roots
  const queue = [{ dir: root, depth: 0 }]
  const skip = new Set(['node_modules', '.git', 'appdata', 'windows', 'program files', 'program files (x86)', '$recycle.bin', '.cache', '__pycache__'])
  while (queue.length && budget.left > 0) {
    const current = queue.shift()
    let entries = []
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
    } catch { continue }
    budget.left -= 1
    if (entries.some((entry) => !entry.isDirectory() && entry.name.toLowerCase() === 'pyvenv.cfg')) {
      roots.push(current.dir)
    }
    if (current.depth >= 4) continue
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name.toLowerCase())) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return roots
}

function collectVenvPythonCandidates(add) {
  const roots = []
  const addRoot = (value) => {
    const root = text(value)
    if (root && roots.every((item) => path.resolve(item).toLowerCase() !== path.resolve(root).toLowerCase())) {
      roots.push(root)
    }
  }
  for (const key of ['VIRTUAL_ENV', 'CONDA_PREFIX']) addRoot(process.env[key])
  for (const explicit of String(process.env.FISH_DANDAN_CREATIVE_STUDIO_VENV_ROOTS || '').split(';')) {
    addRoot(explicit)
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  for (const name of ['Projects', 'projects', 'Workspace', 'workspace', 'Code', 'code', 'Dev', 'dev']) {
    if (home) addRoot(path.join(home, name))
  }
  for (const drive of fixedDriveRoots()) {
    for (const name of ['Projects', 'projects', 'Workspace', 'workspace', 'Code', 'code', 'Dev', 'dev']) {
      addRoot(path.join(drive, name))
    }
  }
  addRoot(process.cwd())
  const budget = { left: 2500 }
  for (const root of roots) {
    for (const venv of findVenvRoots(root, budget)) {
      addPythonRoot(add, venv, '虚拟环境', 'venv')
    }
    if (budget.left <= 0) break
  }
}

/** 找 DSH 自带 Python、py 启动器登记、PATH 和常见安装目录里的 Python；只做发现，不安装。 */
async function collectPythonCandidates() {
  const explicit = text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PYTHON)
  if (explicit) {
    return [{ command: explicit, args: [], label: 'FISH_DANDAN_CREATIVE_STUDIO_PYTHON', origin: 'explicit', preferred: true }]
  }

  const list = []
  const seen = new Set()
  const add = (command, args, label, meta = {}) => {
    const candidate = {
      command,
      args: args || [],
      label: label || '本机',
      origin: meta.origin || 'host',
      preferred: Boolean(meta.preferred),
    }
    if (!candidate.command) return
    const key = candidateKey(candidate)
    if (seen.has(key)) return
    seen.add(key)
    list.push(candidate)
  }

  collectDshPythonCandidates(add)
  await collectCondaPythonCandidates(add)
  collectVenvPythonCandidates(add)

  if (process.platform === 'win32') {
    add('py', ['-3'], 'py -3')
    const launcher = await runProcess('py', ['-0p'], { timeoutMs: 10_000 })
    for (const line of String(launcher.stdout || '').split(/\r?\n/)) {
      const match = line.match(/([A-Za-z]:\\[^"*]*?python\.exe)/i)
      if (match && fs.existsSync(match[1])) add(match[1], [], 'py -0p')
    }
    for (const name of ['python', 'python3']) {
      const found = await runProcess('where.exe', [name], { timeoutMs: 10_000 })
      for (const line of String(found.stdout || '').split(/\r?\n/)) {
        const executable = line.trim().replace(/^"|"$/g, '')
        if (executable && fs.existsSync(executable)) add(executable, [], `PATH: ${name}`)
      }
    }

    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Python'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Python'),
      'C:\\',
    ].filter(Boolean)
    for (const root of roots) {
      let entries = []
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^Python3/i.test(entry.name)) continue
        const executable = path.join(root, entry.name, 'python.exe')
        if (fs.existsSync(executable)) add(executable, [], '常见安装目录')
      }
    }
  } else {
    add('python3', [], 'PATH: python3')
    add('python', [], 'PATH: python')
    for (const name of ['python3', 'python']) {
      const found = await runProcess('which', [name], { timeoutMs: 10_000 })
      const executable = String(found.stdout || '').trim().split(/\r?\n/)[0]
      if (found.code === 0 && executable) add(executable, [], `PATH: ${name}`)
    }
    for (const executable of ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']) {
      if (fs.existsSync(executable)) add(executable, [], '常见安装目录')
    }
  }

  collectDoubaoPythonCandidates(add)

  return list
}

/**
 * 扫描并返回本机所有可运行的 Python。
 * 这是纯检测：不下载、不安装、不执行插件代码；页面用它决定是否能进入装依赖。
 */
async function detectHostPython() {
  const explicit = text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PYTHON)
  const candidates = await collectPythonCandidates()
  const probes = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    info: await probePython(candidate),
  })))
  const found = []
  const seen = new Set()
  for (const item of probes) {
    if (!item.info) continue
    const key = pythonPathKey(item.info.executable)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(publicPython(item.info))
  }
  found.sort((a, b) => (Number(b.preferred) - Number(a.preferred)) || comparePython(a, b))
  const selected = found.find((item) => item.supported) || null

  let reason
  if (explicit) {
    reason = selected
      ? `使用环境变量指定的 Python ${selected.version}`
      : `环境变量指定的 Python 无法运行，或版本低于 3.11`
  } else if (selected && selected.preferred) {
    reason = `使用 DSH 自带的 Python ${selected.version}`
  } else if (selected) {
    reason = found.length > 1
      ? `找到 ${found.length} 个 Python，将使用 ${selected.version}`
      : `找到 Python ${selected.version}`
  } else if (found.length) {
    reason = `找到 ${found.length} 个 Python，但没有 3.11 或更高版本`
  } else {
    reason = candidates.length
      ? '没有找到可运行的 Python；Microsoft Store 占位程序不算'
      : '没有检测到 Python'
  }

  return {
    supported: Boolean(selected),
    explicit: Boolean(explicit),
    selected,
    candidates: found,
    reason,
    downloadUrl: pythonDownloadUrl(),
  }
}

async function findHostPython() {
  const detection = await detectHostPython()
  if (detection.selected) {
    return {
      command: detection.selected.executable,
      args: [],
      executable: detection.selected.executable,
      label: detection.selected.source,
      version: detection.selected.version,
      major: detection.selected.major,
      minor: detection.selected.minor,
    }
  }
  if (detection.candidates.length) {
    const first = detection.candidates[0]
    throw renderError(
      'PYTHON_VERSION_UNSUPPORTED',
      `找到的 Python 是 ${first.version}，创作工作室需要 3.11 或更高版本`,
      { pythonPath: first.executable, found: detection.candidates.map((item) => item.version) }
    )
  }
  throw renderError(
    'PYTHON_NOT_FOUND',
    '这台电脑上没找到 Python 3.11+。请先安装 Python，安装时勾选 Add python.exe to PATH',
    { downloadUrl: detection.downloadUrl }
  )
}

function venvSourcePython(venv) {
  const configFile = path.join(venv, 'pyvenv.cfg')
  if (!fs.existsSync(configFile)) return null
  try {
    const lines = fs.readFileSync(configFile, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const match = line.match(/^\s*executable\s*=\s*(.+)$/)
      if (match) return match[1].trim() || null
    }
  } catch {
    // 读不到就回退到 venv 自己的 python；不影响就绪判断。
  }
  return null
}

function runtimeStatus(plugin) {
  const explicit = text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PYTHON)
  if (explicit) {
    return {
      ready: true,
      managed: false,
      python: explicit,
      sourcePython: explicit,
      venv: null,
      version: null,
      reason: '使用环境变量指定的 Python',
      explicit: true,
    }
  }
  if (!plugin?.root) {
    return {
      ready: false,
      managed: false,
      python: null,
      sourcePython: null,
      venv: null,
      version: null,
      reason: '插件还没安装',
      explicit: false,
    }
  }

  const venv = runtimeDirFor(plugin)
  const python = venvPython(venv)
  const marker = readJsonSafe(path.join(venv, READY_FILE), null)
  const fingerprint = requirementsFingerprint(plugin)
  const ready = Boolean(marker && fs.existsSync(python) && marker.requirementsHash === fingerprint)
  return {
    ready,
    managed: true,
    python: ready ? python : null,
    sourcePython: ready ? (text(marker.sourcePython) || venvSourcePython(venv) || python) : null,
    venv,
    version: ready ? (text(marker.pythonVersion) || null) : null,
    reason: ready
      ? '运行环境已就绪'
      : marker && marker.requirementsHash !== fingerprint
        ? '依赖清单变了，需要重新安装依赖'
        : '还没有安装依赖',
    explicit: false,
  }
}

async function checkImports(python) {
  const script = "import sys,json,PIL,zoneinfo; from zoneinfo import ZoneInfo; ZoneInfo('Asia/Shanghai'); print(json.dumps({'version':f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}','pillow':PIL.__version__}))"
  const result = await runProcess(python, ['-c', script], { timeoutMs: 20_000 })
  if (result.code !== 0) {
    return { ok: false, output: (result.stderr || result.stdout || '导入失败').trim() }
  }
  try {
    const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).pop())
    return { ok: true, ...payload }
  } catch {
    return { ok: true, version: null, pillow: null }
  }
}

async function prepareRuntime(plugin, { onProgress } = {}) {
  const report = (percent, message, phase = 'installing') => {
    try {
      onProgress?.({ percent, message, phase })
    } catch { /* 进度回调不能影响安装 */ }
  }

  const current = runtimeStatus(plugin)
  if (current.ready && !current.explicit) {
    report(100, '依赖已安装', 'ready')
    return current
  }

  const explicit = text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PYTHON)
  if (explicit) {
    report(10, '检查环境变量指定的 Python…', 'checking')
    const check = await checkImports(explicit)
    if (!check.ok) {
      throw renderError(
        'PYTHON_DEPS_MISSING',
        'FISH_DANDAN_CREATIVE_STUDIO_PYTHON 指向的 Python 缺少 Pillow / tzdata，或无法运行',
        { output: check.output }
      )
    }
    report(100, '依赖已确认', 'ready')
    return { ...runtimeStatus(plugin), sourcePython: explicit, version: check.version || null, reason: '使用环境变量指定的 Python，依赖已确认' }
  }

  report(8, '检查 Python 3.11+…', 'checking')
  const base = await findHostPython()
  report(18, `已找到 Python ${base.version}`, 'checking')
  const venv = runtimeDirFor(plugin)
  const python = venvPython(venv)

  report(25, '创建隔离运行环境…', 'creating-venv')
  fs.mkdirSync(path.dirname(venv), { recursive: true })
  const create = await runProcess(
    base.executable || base.command,
    [...(base.executable ? [] : base.args), '-m', 'venv', '--clear', venv],
    { cwd: plugin.root, timeoutMs: 120_000 }
  )
  if (create.code !== 0) {
    throw renderError(
      'VENV_CREATE_FAILED',
      '创建 Python 运行环境失败；可能这个 Python 没有安装 venv 组件',
      { output: (create.stderr || create.stdout || '').trim() }
    )
  }
  report(35, '运行环境创建完成', 'creating-venv')

  const reqFile = path.join(plugin.root, 'requirements.txt')
  const packages = (plugin?.requirements?.packages || []).filter(Boolean)
  const restoreArgs = fs.existsSync(reqFile)
    ? ['-r', reqFile]
    : (packages.length ? packages : ['Pillow>=10.0.0', 'tzdata>=2024.1'])

  const primaryIndex = pipIndex()
  const fallbackIndex = primaryIndex === OFFICIAL_PIP_INDEX ? null : OFFICIAL_PIP_INDEX
  const runPip = (index) => runProcess(python, pipArgs(restoreArgs, index), {
    cwd: plugin.root,
    timeoutMs: 300_000,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
    },
  })

  report(42, `安装 Pillow / tzdata（${primaryIndex === DEFAULT_PIP_INDEX ? '国内源' : '指定源'}）`, 'installing-deps')
  let install = await runPip(primaryIndex)

  if (install.code !== 0) {
    // 某些精简 Python 的 venv 没带 pip；补一次 ensurepip 再装。
    report(52, 'pip 不可用，补装 pip 后重试…', 'installing-deps')
    const ensure = await runProcess(python, ['-m', 'ensurepip', '--upgrade'], {
      cwd: plugin.root,
      timeoutMs: 120_000,
    })
    if (ensure.code === 0) {
      report(58, '补装 pip 完成，继续安装…', 'installing-deps')
      install = await runPip(primaryIndex)
    }
  }

  if (install.code !== 0 && fallbackIndex) {
    report(64, '国内源安装失败，切官方源重试…', 'installing-deps')
    install = await runPip(fallbackIndex)
  }

  if (install.code !== 0) {
    throw renderError(
      'PIP_INSTALL_FAILED',
      '安装创作工作室的 Python 依赖失败，检查网络或 pip 源',
      { output: (install.stderr || install.stdout || '').trim() }
    )
  }

  report(82, '依赖安装完成，正在验证导入…', 'verifying')
  const check = await checkImports(python)
  if (!check.ok) {
    throw renderError(
      'PYTHON_DEPS_MISSING',
      '依赖安装后仍无法导入 Pillow / tzdata',
      { output: check.output }
    )
  }

  writeJsonAtomic(path.join(venv, READY_FILE), {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    sourcePython: base.executable || base.command,
    pythonVersion: check.version || null,
    pillow: check.pillow || null,
    requirementsHash: requirementsFingerprint(plugin),
    packages: Array.isArray(restoreArgs) ? restoreArgs : [],
  })
  report(100, '依赖已安装', 'ready')
  return runtimeStatus(plugin)
}

function parseJsonPayload(stdout) {
  const source = String(stdout || '').trim()
  if (!source) return null
  try {
    return JSON.parse(source)
  } catch { /* 继续从前后找 JSON */ }
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return null
  }
}

async function renderJob(plugin, plan, jobId) {
  const runtime = runtimeStatus(plugin)
  if (!runtime.ready || !runtime.python) {
    throw renderError('RUNTIME_NOT_READY', '依赖还没安装；先点插件卡里的“安装依赖”')
  }

  const id = safeJobId(jobId)
  const inputsRoot = path.resolve(fromRoot(INPUTS_ROOT))
  const jobDir = path.resolve(inputsRoot, id)
  if (!isInside(jobDir, inputsRoot)) {
    throw renderError('JOB_PATH_INVALID', '任务目录越界')
  }
  // 这里只放“给插件吃的参数文件”，不是产物目录。
  // 图片落哪、导出目录怎么建，由创作工作室自己的 render-job 决定。
  if (fs.existsSync(jobDir)) {
    throw renderError('JOB_COLLISION', '这次生成的参数目录已存在，请再点一次')
  }

  fs.mkdirSync(jobDir, { recursive: true })
  const planPath = path.join(jobDir, 'plan.json')
  const jobPath = path.join(jobDir, 'job.json')
  writeJsonAtomic(planPath, plan)
  writeJsonAtomic(jobPath, {
    job_id: id,
    source: 'fish-dandan',
    idempotency_key: id,
    plan_path: planPath,
  })

  let result
  try {
    result = await runProcess(runtime.python, [
      '-m', 'studio', 'render-job',
      '--job', jobPath,
    ], {
      cwd: plugin.root,
      timeoutMs: 120_000,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
      },
    })
  } finally {
    // 参数目录只是给插件吃一次的临时输入，渲染结束就收掉，避免 data/creative/inputs 越积越多。
    try {
      fs.rmSync(jobDir, { recursive: true, force: true })
    } catch { /* 被占用时留给存储页的旧稿清理 */ }
  }

  if (result.timeout) {
    throw renderError('RENDER_TIMEOUT', '渲染超时，创作工作室没有在 120 秒内返回')
  }

  const payload = parseJsonPayload(result.stdout)
  if (!payload) {
    throw renderError(
      'RENDER_FAILED',
      '创作工作室没有返回结果',
      { output: (result.stderr || result.stdout || '').trim().slice(-1200) }
    )
  }

  if (payload.ok !== true || payload.qa?.ok === false || (payload.qa?.errors || []).length) {
    throw renderError(
      'QA_FAILED',
      `图文质检没有通过：${(payload.qa?.errors || []).join('；') || '未知错误'}`,
      { details: payload }
    )
  }

  const rawImage = text(payload.image)
  if (!rawImage) {
    throw renderError('IMAGE_MISSING', '创作工作室结果里没有 image 路径')
  }
  const imagePath = path.isAbsolute(rawImage)
    ? path.resolve(rawImage)
    : path.resolve(plugin.root, rawImage)
  const root = fs.realpathSync(plugin.root)
  let imageReal
  try {
    imageReal = fs.realpathSync(imagePath)
  } catch {
    throw renderError('IMAGE_MISSING', '渲染结果说成功了，但图片文件不存在')
  }
  if (!isInside(imageReal, root)) {
    throw renderError('IMAGE_PATH_INVALID', '渲染结果图片不在创作工作室目录内')
  }
  let stat = null
  try {
    stat = fs.lstatSync(imageReal)
  } catch {
    throw renderError('IMAGE_MISSING', '渲染结果说成功了，但图片文件不存在')
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw renderError('IMAGE_PATH_INVALID', '渲染结果图片不是普通文件')
  }

  return {
    ...payload,
    job_id: id,
    image: imageReal,
    output_dir: text(payload.output_dir) || path.dirname(imageReal),
  }
}

function removeRuntime(plugin) {
  if (text(process.env.FISH_DANDAN_CREATIVE_STUDIO_PYTHON)) return false
  if (!plugin?.root) return false
  // 只有平台管理的 GitHub 安装才清理依赖；本地版保留插件目录、依赖目录和本机 Python。
  if (plugin.installSource !== 'github' || plugin.managed !== true) return false
  const root = path.resolve(plugin.root)
  const venv = path.resolve(runtimeDirFor(plugin))

  // 只删和插件目录同级的 <插件目录名>-runtime，拒绝任意路径。
  if (path.dirname(venv) !== path.dirname(root)) return false
  if (path.basename(venv) !== path.basename(root) + RUNTIME_SUFFIX) return false

  if (!fs.existsSync(venv)) return false
  try {
    return removeTree(venv)
  } catch {
    return false
  }
}

export function createCreativeRenderer({ logger = console } = {}) {
  return {
    runtimeStatus,
    detectPython: async () => {
      logger.info?.('创作工作室：开始检测本机 Python')
      const detection = await detectHostPython()
      logger.info?.(`创作工作室：Python 检测${detection.supported ? `通过（${detection.selected.version}）` : '未通过'}`)
      return detection
    },
    prepareRuntime: async (plugin, { onProgress } = {}) => {
      logger.info?.('创作工作室：开始准备 Python 运行环境')
      const runtime = await prepareRuntime(plugin, { onProgress })
      logger.info?.(`创作工作室：运行环境${runtime.ready ? '已就绪' : '未就绪'}`)
      return runtime
    },
    renderJob,
    removeRuntime,
    paths: { RUNTIME_ROOT, INPUTS_ROOT },
  }
}

export { RUNTIME_ROOT, INPUTS_ROOT, venvPython }
