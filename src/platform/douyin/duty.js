// ============================================================
// 值班会话（宿主半）：到点/按钮/聊天 → 起一个独立的 DSH 会话，
// 模型在里面用 duty-server 的窄工具自己刷抖音；宿主只留护栏与结算。
// 设计：docs/architecture/07-值班会话（模型驱动刷抖音）设计.md
// ============================================================
import { spawn, spawnSync } from 'node:child_process'
import { rmSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { readJsonSafe, writeJsonAtomic } from '../../utils/json.js'
import { fromRoot } from '../../utils/paths.js'
import { createTabWatch } from './tab-watch.js'
import { normalizeMemoryAllow } from './memory-access.js'

const now = () => Date.now()

/**
 * 杀掉一棵进程树。
 * Windows 上 child.kill() 只杀父进程，值班的 MCP 子进程和浏览器会变成孤儿继续跑，
 * 所以用 taskkill /T /F；其它平台按进程组杀。
 */
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch { /* 已经退出 */ }
}

/** 找 dsh CLI：桌面版在应用资源里，npm 全局在常见位置；找不到就明说，不许静默。 */
function findDshCli(logger) {
  const explicit = String(process.env.FISH_DSH_BIN || '').trim()
  if (explicit && existsSync(explicit)) return { cli: explicit, kind: 'bin' }
  const candidates = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'))
  try { candidates.push(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')) } catch { /* 忽略 */ }
  for (const g of [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]) candidates.push(g)
  for (const cli of candidates) {
    if (cli && existsSync(cli)) return { cli, kind: cli.endsWith('cli.js') ? 'desktop-host' : 'bin' }
  }
  // 应用目录里有界搜一遍（深度 ≤6、最多 2000 个目录）
  const roots = [process.resourcesPath].filter(Boolean)
  const budget = { n: 0 }
  const scan = (dir, depth) => {
    if (depth > 6 || budget.n > 2000) return ''
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const d of ents) {
      if (!d.isDirectory()) continue
      budget.n += 1
      const p = join(dir, d.name)
      if (d.name === 'dsh-desktop-host') {
        const hit = join(p, 'lib', 'cli.js')
        if (existsSync(hit)) return hit
      }
      if (d.name === 'dsh') {
        const hit = join(p, 'lib', 'bin.js')
        if (existsSync(hit)) return hit
      }
      const hit = scan(p, depth + 1)
      if (hit) return hit
    }
    return ''
  }
  for (const root of roots) {
    if (!existsSync(root)) continue
    const hit = scan(root, 0)
    if (hit) return { cli: hit, kind: 'desktop-host' }
  }
  logger?.warn?.('值班模式：没找到 dsh CLI（应用资源、常见全局位置都没有），这一轮不刷；不会退回旧脚本')
  return null
}

function dshHome() {
  return process.env.DSH_HOME ? String(process.env.DSH_HOME) : join(os.homedir(), '.dsh')
}

/** 值班专用 profile：只留 base+headless，工具砍到只剩我们的 MCP。 */
function dutyPatchYml(serverPath, home, cfg, task = 'explore') {
  const posix = (p) => String(p).replace(/\\/g, '/')
  const envLines = [
    `          FISH_DUTY_HOME: '${posix(home)}'`,
    `          FISH_EVENTS: '${posix(join(home, 'duty-events.jsonl'))}'`,
    `          FISH_SESSION_PATH: '${posix(cfg.sessionPath)}'`,
    `          FISH_BROWSER_PROFILE: '${posix(cfg.browserProfilePath || 'data/browser-profile')}'`,
    `          FISH_COMMENT_LIMIT: '${Number(cfg.commentLimit) || 5}'`,
    `          FISH_TASK: '${task === 'social' ? 'social' : 'explore'}'`,
    // 单项能力位传进工具层：关掉的能力，工具直接拒绝执行
    `          FISH_CAPS: '${JSON.stringify({ actions: cfg.actions || {}, readComments: cfg.readComments !== false, vision: cfg.vision === true, stickers: cfg.stickers === true, ownerLikes: cfg.owner?.readLikes === true && Boolean(cfg.owner?.profileUrl) })}'`,
    `          FISH_EXPRESSION: '${JSON.stringify({ level: cfg.expressionLevel || 'natural' }).replace(/'/g, "''")}'`,
    `          FISH_OWNER_PROFILE: '${String(cfg.owner?.profileUrl || '').replace(/'/g, "''")}'`,
    `          FISH_OWNER_ID: '${String(cfg.owner?.ownerId || '').replace(/'/g, "''")}'`,
    `          FISH_OWNER_ADDRESS: '${String(cfg.ownerAddress || '主人').replace(/'/g, "''")}'`,
    `          FISH_DUTY_PORT: '${Number(cfg.dutyPort) || 9334}'`,
    `          FISH_BROWSE_PORT: '${Number(cfg.browsePort) || 9225}'`,
    `          FISH_HUB_PORT: '${Number(cfg.hubPort) || Number(cfg.loginPort) || 9224}'`,
    `          FISH_HUB_FILE: '${posix(cfg.hubStatePath || 'data/platform/browser-hub.json')}'`,
    `          FISH_LISTEN: '${JSON.stringify(cfg.listen || {})}'`,
    `          FISH_MEMORY_DB: '${posix(cfg.memoryDbPath || 'data/memory/memory.db')}'`,
  ]
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) envLines.push("          ELECTRON_RUN_AS_NODE: '1'")
  return `# 值班轮专用层：模型只有"看抖音、动抖音"这一组工具，文件系统/命令/联网全关。
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-jobs
  disabled: true
- id: jobs
  disabled: true
- id: tool-ralph
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- id: tool-web
  disabled: true
- id: web-fetch-http
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- insert:
    - id: mcp-douyin-duty
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: douyin-duty
        transport: stdio
        command: '${posix(process.execPath)}'
        args:
          - '${posix(serverPath)}'
        env:
${envLines.join('\n')}
`
}

export function createDutyService({ config, logger, memory, journalStore, platformSettings, persona, hub } = {}) {
  const home = fromRoot(config.platforms?.douyin?.dutyPath || 'data/duty')
  const hubFile = fromRoot(config.platforms?.douyin?.hubStatePath || 'data/platform/browser-hub.json')
  const eventsFile = join(home, 'duty-events.jsonl')
  const stopFlag = join(home, 'stop')
  const logFile = join(home, 'duty.log')
  const stateFile = join(home, 'duty-state.json')
  // 这一轮是谁拉起的、跑什么任务；宿主和 GUI 都靠它判断「该不该停」。
  const roundFile = join(home, 'round.json')
  // duty-server 把值班标签页的 targetId/调试端口写在这里；宿主靠它判断标签页是不是被手动关了。
  const tabFile = join(home, 'tab.json')
  // duty-server 启动浏览器后把 Edge 主进程 pid 写在这里，停止时按它兜底关窗口
  const browserPidFile = join(home, 'browser.pid')
  const serverPath = fileURLToPath(new URL('./duty-server.mjs', import.meta.url))
  const charterPath = fileURLToPath(new URL('../../../prompts/douyin-duty.md', import.meta.url))
  const playbookPath = fileURLToPath(new URL('../../../prompts/douyin-playbook.md', import.meta.url))
  const journal = journalStore || { record() {}, recentTexts: () => [] }

  let child = null
  let running = false
  let stopping = false
  let startedAt = 0
  let why = ''
  let killTimer = null
  let stopTimer = null
  let eventTimer = null
  let lastRun = readJsonSafe(stateFile, {}).lastRun || null
  let lastCliLog = ''
  let round = null
  let socialSent = false
  let socialStopRequested = false
  const settledListeners = new Set()

  const log = (m) => { try { appendLine(logFile, `${new Date().toISOString()} [host] ${m}`) } catch { /* 忽略 */ } }
  function appendLine(file, text) {
    const fd = openSync(file, 'a')
    try { writeFileSync(fd, text + '\n') } finally { closeSync(fd) }
  }

  function settings() {
    const s = platformSettings?.get?.() || {}
    const d = s.douyin || {}
    const on = (v) => v !== false
    let ownerAddress = '主人'
    try { ownerAddress = String((persona?.current?.()?.speech?.ownerAddress) || '主人').trim() || '主人' } catch { /* 人设读不到就用默认称呼 */ }
    return {
      // 总开关就是「允许它用抖音」：关 = 什么都不做；开 = 不限时长、不限条数
      enabled: Boolean(d.browse?.enabled),
      commentLimit: Number(d.browse?.commentLimit) || 5,
      sessionPath: fromRoot(config.platforms?.douyin?.sessionPath || 'data/platform/douyin-session.json'),
      browserProfilePath: fromRoot(config.platforms?.douyin?.browserProfilePath || 'data/browser-profile'),
      hubStatePath: fromRoot(config.platforms?.douyin?.hubStatePath || 'data/platform/browser-hub.json'),
      // 值班会话的浏览器端口（可配，避免和设备上别的调试端口撞车）
      dutyPort: Number(config.platforms?.douyin?.dutyPort) || 9334,
      // 刷流窗口的端口：值班优先复用它，做到「一个浏览器」
      browsePort: Number(config.platforms?.douyin?.browsePort) || (Number(config.platforms?.douyin?.loginPort) || 9224) + 1,
      // 共享浏览器端口：登录/活动/监听/值班统一走这一个调试端口
      hubPort: Number(config.platforms?.douyin?.hubPort) || Number(config.platforms?.douyin?.loginPort) || 9224,
      // 主动私信默认发给主人；memoryAllow 控制谁能被召回长期记忆
      listen: {
        enabled: d.listen?.enabled === true,
        scope: 'all',
        ownerName: String(d.listen?.ownerName || '').trim(),
        memoryAllow: normalizeMemoryAllow(d.listen?.memoryAllow, d.listen?.ownerName),
        autoReply: true,
      },
      // 值班进程是独立进程；把同一个记忆库路径传过去，供 douyin_dm_context 只读召回
      memoryDbPath: fromRoot(config.memory?.dbPath || 'data/memory/memory.db'),
      // 人格里怎么称呼主人；艾特主人时用来检查文案是不是在跟主人说话
      ownerAddress,
      // 主人主页只读能力：喜欢列表是主人私事，只有明确打开才看
      owner: {
        ownerId: String(d.listen?.ownerId || '').trim(),
        profileUrl: String(d.owner?.profileUrl || '').trim(),
        readLikes: d.owner?.readLikes === true,
      },
      // 视频画面理解：关着就只读文案/评论，开着才截当前视频的帧
      vision: d.browse?.vision === true,
      // 单项能力：关掉的能力工具层直接拒绝，不靠提示词自觉
      readComments: on(d.browse?.readComments),
      // 表情包总闸 + 聊天表达浓度（三档），工具层直接按这个执行
      stickers: s.stickers?.enabled === true,
      expressionLevel: d.expressionLevel || 'natural',
      actions: {
        like: on(d.actions?.like),
        // 关注、发作品整体关闭；分享给主人是独立开关，默认关。
        follow: false,
        favorite: on(d.actions?.favorite),
        comment: on(d.actions?.comment),
        mentionOwner: d.actions?.mentionOwner === true,
        forward: d.actions?.forward === true,
        reply: on(d.actions?.reply),
        dm: on(d.actions?.dm),
        publish: false,
      },
    }
  }

  function personaText() {
    try {
      const p = persona?.current?.() || {}
      const s = p.speech || {}
      const species = p.identity?.species ? `，${p.identity.species}` : ''
      const bits = [`名字：${p.identity?.name || p.name || '大肥鱼'}${species}`, `自称：${s.selfReference || '我'}`, `语气：${s.tone || '温和、口语化'}`]
      if (s.ownerAddress) bits.push(`称呼对方：${s.ownerAddress}`)
      if (Array.isArray(s.catchphrases) && s.catchphrases.length) bits.push(`口头禅（别每条都用）：${s.catchphrases.join('、')}`)
      if (s.styleNotes) bits.push(`语言习惯：${s.styleNotes}`)
      return bits.join('\n')
    } catch { return '' }
  }

  function ensureProfile(cfg, task = 'explore') {
    const dir = join(dshHome(), 'profiles', 'douyin-duty')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-douyin-duty',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.yml'), '# 值班 profile 根：条目全在 patch 里\n[]\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), dutyPatchYml(serverPath, home, cfg, task))
    return dir
  }

  /** 社交互动是受限任务：只读主人上下文、只发主人、发完就收，不读刷流指南。 */
  function buildSocialPrompt(reason, cfg) {
    const owner = String(cfg.listen?.ownerName || '').trim()
    const p = personaText()
    return [
      '下面这一次只做「社交互动」，不刷视频、不点赞、不评论、不找陌生人。',
      '',
      '【这一次】',
      `- 触发：${reason}`,
      `- 只找主人：${owner || '主人'}（工具里可以写「主人」或省略 to；服务端只认主人）`,
      '- 先调 douyin_dm_context 读主人最近的对话，看看对方在忙什么；不要在没读上下文的时候硬开场',
      '- 发 1-2 句，像真人发消息，短一点；不要长篇、不要复盘、不要说「系统/插件/值班」',
      '- 不要提「主人让我来找你」，也不要把主人的私事说给任何人',
      '- 发完立刻 douyin_finish 收尾；不需要刷视频，也不需要写很长的总结',
      '',
      p ? ['【人设】（说话按这个来，别把这段念出来）', p].join('\n') : '',
    ].filter(Boolean).join('\n')
  }

  function buildPrompt(reason, { task = 'explore', owner = '' } = {}) {
    const cfg = settings()
    if (task === 'social') return buildSocialPrompt(reason, cfg)
    let charter = ''
    try { charter = readFileSync(charterPath, 'utf8') } catch { charter = '（指南没读到，按常识来，保守一点）' }
    // 操作手册：每个动作怎么找、怎么点、备用方案都在这里；先读它，别重新猜
    let playbook = ''
    try {
      playbook = readFileSync(playbookPath, 'utf8')
      if (playbook.length > 4000) playbook = playbook.slice(0, 4000) + '\n…（后面略）'
    } catch { playbook = '（操作手册没读到：找不到按钮就跳过，不要瞎点）' }
    const p = personaText()
    return [
      '下面这份是「在抖音待一会儿」的自由活动指南。这段时间抖音是开放的，归你自己安排——**不是任务清单**。',
      '',
      '【这一次】',
      `- 触发：${reason}`,
      `- 方式：围观（窗口可见，主人可能在看）`,
      '- 没有时间预算，也没有条数指标：想待多久、看多少条都随你；想走了就收尾',
      '- 你能做：去任意页面（douyin_open）、看推荐流（douyin_look）、点赞/收藏（douyin_react）、评论/回复（douyin_say）、主动私信（douyin_dm_send，to 省略=主人，也可以填想找的人；工具限频，别刷屏）、看自己的账号（douyin_self）、改自己的昵称签名（douyin_update_self）',
      cfg.actions?.forward ? '- 分享给主人（douyin_share_to_owner）：只有你真的看完当前这条的文案/评论（开了画面理解就加上画面），觉得有意思才分享；每次值班最多一条。可以只发分享卡片；想附一句就先调 douyin_owner_memory 读当前视频相关的 1-2 条记忆，再在 text 里写一句想对主人说的话。工具会先发分享卡片，再用私信补这句话；带文字时还要打开「私信（主动）」。只分享当前视频，只给主人，不要自己挑联系人。' : '',
      cfg.actions?.forward ? '- 分享不是每条都做：大多数视频只是看。卡片发出去后不要再重复分享同一条；如果卡片成功但文字没发出去，工具会返回部分成功，不要把它说成完整成功。' : '',
      '- 主动私信前先调 douyin_dm_context 读对方最近的对话；主人和记忆名单内会同时返回 1-2 条相关记忆，名单外只返回上下文、不返回记忆。先看再写，不要凭空提旧事',
      '- 私信不是刷流动作：不要刷到一个人就发一条；工具会硬限频（两次至少隔 10 分钟、每小时最多 2 条），被拒就去做别的',
      '- 不要把主人的私事告诉陌生人；私信里也不要说「主人让我来找你」这种话',
      cfg.owner?.readLikes && cfg.owner?.profileUrl ? '- 看主人主页的喜欢列表（douyin_owner_likes，只读；锁着就只记锁着）' : '',
      '- douyin_look 读到一条就停在这条：先决定要不要动，想换下一条再调一次；评论只能针对最近一次 look 返回的 video，别拿上一条的文案/评论',
      cfg.vision ? '- douyin_look 会把当前视频的画面截给你看；只根据这一条的画面和文案判断，别把上一条的画面/文案带过来' : '',
      cfg.vision ? '- 看完画面后，用自己的话记一条真正看到的事（douyin_memory），不要只抄文案' : '',
      cfg.owner?.readLikes && cfg.owner?.profileUrl ? '- 想知道主人最近在干什么，可以 douyin_owner_likes 看主人主页的喜欢列表；有新增时先看列表面截图和标题，再用 douyin_memory 写一条「主人最近喜欢什么」的第一人称记忆，然后再继续；锁着就如实记锁着，不猜、不绕过；喜欢列表是主人私事，不在评论或私信里提' : '',
      '- 评论/回复时把最近一次 douyin_look 返回的 video.id 作为 videoId 传给 douyin_say；服务端会核对，传错或漏传会直接拒发',
      '- 点赞/收藏也用同一个 videoId 绑定 douyin_react，别对页面已经翻走的那条动手',
      `- 每条视频能读到 ${cfg.commentLimit} 条评论`,
      cfg.actions?.mentionOwner
        ? (cfg.listen?.ownerName
            ? `- 「艾特主人」开着：你发 kind=comment 时，工具会自动 @ ${cfg.listen.ownerName}，mention 不用自己传。发之前先调 douyin_owner_memory（query 用这条视频的文案/评论里的题眼），有相关记忆就自然挑一句；没命中就按视频写，不要硬扯旧事。评论必须写成「对主人说的话」：拿这条视频的文案/画面/评论区里的一两个具体细节当由头，像把手机递给主人看一样说你的反应；不要写成对视频作者、博主或路人说的普通评论，也不要写成「这个视频真…」这种泛评。这是公开评论，别把记忆原文或主人私事写出去。`
            : '- 「艾特主人」开着，但设置里还没填主人抖音昵称；评论会被工具拒发。先提醒主人去「平台页 → 抖音 → 说话与身份 → 我的抖音昵称」填昵称。')
        : '',
      '- 长期记忆只服务于「艾特主人」的评论；普通评论和 kind=reply 不要读、不要提，reply 只用当前视频和评论区上下文。',
      p ? ['', '【人设】（说话按这个来，别把这段念出来）', p] : '',
      '',
      '【操作手册】（每个动作怎么找、怎么点、找不到怎么办——照这个来，别重新摸索）',
      playbook,
      '',
      '【指南】',
      charter,
      '',
      '最后用 douyin_memory 记下这段时间的事，再 douyin_finish 收尾。',
    ].filter(Boolean).join('\n')
  }

  function importEvents() {
    const summary = { socialSent: false }
    if (!existsSync(eventsFile)) return summary
    const st = readJsonSafe(stateFile, { offset: 0 })
    const oldOffset = Math.max(0, Number(st.offset) || 0)
    const raw = readFileSync(eventsFile, 'utf8')
    const lines = raw.split(/\r?\n/)
    const endsWithNewline = raw.endsWith('\n')
    let offset = Math.min(oldOffset, lines.length)
    for (let i = offset; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line.trim()) {
        offset = i + 1
        continue
      }
      // 子进程还在写这一行时不要消费：等下一次轮询拿到完整行。
      // 这是「值班中途就把记忆导出来」能安全工作的前提。
      if (i === lines.length - 1 && !endsWithNewline) break
      let ev
      try { ev = JSON.parse(line) } catch {
        log(`事件行不是完整 JSON，跳过：${line.slice(0, 80)}`)
        offset = i + 1
        continue
      }
      try {
        if (ev.type === 'react') {
          for (const [k, v] of Object.entries(ev.done || {})) {
            if (v !== true) continue
            journal.record({ type: k, ok: true, videoId: ev.videoId, videoCaption: ev.videoCaption, reason: '值班：它自己决定的', mood: '' })
          }
        } else if (ev.type === 'say') {
          journal.record({
            type: ev.kind,
            ok: ev.ok !== false,
            text: ev.text,
            target: ev.target || {},
            videoId: ev.videoId,
            videoCaption: ev.videoCaption,
            reason: ev.partial ? `值班：卡片已发出，附言失败（${ev.reason || '未知原因'}）` : '值班：它自己决定的',
            mood: '',
          })
          // 社交任务只发主人；只要有一条成功的私信事件，就说明「已经聊到了」。
          if (round?.task === 'social' && ev.kind === 'dm' && ev.ok !== false) {
            socialSent = true
            summary.socialSent = true
          }
        } else if (ev.type === 'memory') {
          memory?.recordEvent?.({ content: ev.content, tier: 'episodic', importance: 5, tags: ['抖音', '值班', '自己'], platform: 'douyin' }, 'douyin-duty')
        } else if (ev.type === 'owner-likes') {
          if (ev.visibility === 'locked') {
            // 锁着也是事实：只记状态，不猜里面有什么，也不每轮重复写。
            memory?.recordEvent?.({ content: '主人的抖音喜欢列表现在是锁着的，我看不到里面有什么。', tier: 'episodic', importance: 2, person: '主人', tags: ['主人', '喜欢', '隐私'], platform: 'douyin' }, 'douyin-duty')
          } else if (ev.visibility === 'open' && Array.isArray(ev.newItems) && ev.newItems.length) {
            const titles = ev.newItems.map((x) => String((x && x.title) || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
            const n = ev.newItems.length
            memory?.recordEvent?.({
              content: `主人最近在抖音新喜欢了 ${n} 个视频${titles.length ? `：${titles.join('、')}` : ''}。`,
              tier: 'episodic', importance: 4, person: '主人', tags: ['主人', '喜欢'], platform: 'douyin',
            }, 'douyin-duty')
          }
        } else if (ev.type === 'publish') {
          // 发作品已整体关闭；这里只兼容导入关闭前的历史事件，不会产生新的发布。
          journal?.record?.({ type: 'publish', ok: true, text: String(ev.title || '').slice(0, 60), reason: '值班：自己发的图文', mood: '' })
          memory?.recordEvent?.({ content: `我在抖音发了一条图文作品${ev.title ? `「${ev.title}」` : ''}，${ev.images || 1} 张图。`, tier: 'episodic', importance: 6, tags: ['抖音', '作品', '自己'], platform: 'douyin' }, 'douyin-duty')
        } else if (ev.type === 'finish') {
          const acts = Object.entries(ev.actions || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join('、')
          const head = `我在抖音值班刷了 ${ev.videos} 条${ev.aborted ? '（中途被停）' : ''}${acts ? `，自己${acts}` : '，只是看'}。`
          const body = ev.summary ? `印象最深的是：${ev.summary}` : ''
          memory?.recordEvent?.({ content: `${head}${body}`, tier: 'episodic', importance: 6, tags: ['抖音', '值班', '自己'], platform: 'douyin' }, 'douyin-duty')
          const counts = ev.actions || {}
          lastRun = {
            at: now(), ok: true, videos: ev.videos, seconds: ev.seconds,
            liked: Number(counts.like) || 0,
            followed: 0,
            favorited: Number(counts.favorite) || 0,
            commented: Number(counts.comment) || 0,
            replied: Number(counts.reply) || 0,
            forwarded: Number(counts.forward) || 0,
            dmed: Number(counts.dm) || 0,
            actions: counts,
            detail: `值班看完 ${ev.videos} 条${acts ? `：${acts}` : '，没动手'}`,
            summary: ev.summary || '',
          }
        }
      } catch (err) {
        log(`事件导入失败（${ev.type}）：${err.message}`)
      }
      offset = i + 1
    }
    if (offset !== oldOffset) writeJsonAtomic(stateFile, { offset, lastRun })
    // 社交互动：消息已经发出，就把「这一轮」强制收掉；不误停别人的轮次。
    if (summary.socialSent && round?.task === 'social' && round?.owner === 'social' && running && !socialStopRequested) {
      socialStopRequested = true
      log('社交消息已发出，按任务边界自动结束这一轮')
      stop('社交消息已发出')
    }
    return summary
  }

  const tabWatch = createTabWatch({
    hub,
    tabFile,
    isRunning: () => running,
    isStopping: () => stopping,
    onClosed: () => {
      log('值班标签页已被手动关闭，自动停止这一轮')
      // stop() 会写 stop 标记并在 2 秒后兜底结束进程树，界面随之从「值班中」切回停止。
      stop()
    },
    logger,
  })

  function startTabWatch() { tabWatch.start() }
  function stopTabWatch() { tabWatch.stop() }

  function settle(exitCode) {
    if (!running && !child && !round) return
    const finishedRound = round
    stopTabWatch()
    if (eventTimer) { clearInterval(eventTimer); eventTimer = null }
    running = false
    stopping = false
    child = null
    try { rmSync(tabFile, { force: true }) } catch { /* 忽略 */ }
    if (killTimer) { clearTimeout(killTimer); killTimer = null }
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
    let summary = { socialSent: false }
    try { summary = importEvents() || summary } catch (err) { log(`结算导入事件失败：${err.message}`) }
    if (finishedRound?.task === 'social' && socialSent && (!lastRun || Number(lastRun.at) < finishedRound.startedAt)) {
      lastRun = {
        at: now(), ok: true, task: 'social', social: true, dmed: 1,
        detail: '已找主人聊了两句', summary: '社交互动完成',
      }
    }
    const ok = finishedRound?.task === 'social'
      ? Boolean(summary.socialSent || socialSent)
      : Boolean(
        summary.socialSent
        || (lastRun && lastRun.ok && Number(lastRun.at) >= Number(finishedRound?.startedAt || 0)),
      )
    try { rmSync(stopFlag, { force: true }) } catch { /* 忽略 */ }
    try { rmSync(browserPidFile, { force: true }) } catch { /* 忽略 */ }
    try { rmSync(roundFile, { force: true }) } catch { /* 忽略 */ }
    log(`值班结束（exit ${exitCode}，任务 ${finishedRound?.task || 'explore'}，${ok ? '成功' : '未完成'}）`)
    for (const listener of settledListeners) {
      try {
        listener({ round: finishedRound, exitCode, ok, socialSent: Boolean(summary.socialSent || socialSent), lastRun })
      } catch (err) {
        log(`值班结算回调失败：${err.message}`)
      }
    }
    round = null
    socialSent = false
    socialStopRequested = false
  }

  function start(reason = 'manual', { task = 'explore', owner = '' } = {}) {
    const cfg = settings()
    const selectedTask = task === 'social' ? 'social' : 'explore'
    if (!cfg.enabled) return { ok: false, reason: '先打开「允许它用抖音」开关' }
    if (selectedTask === 'social') {
      if (!cfg.actions?.dm) return { ok: false, reason: '「私信（主动）」开关没打开，社交互动不能发' }
      if (!String(cfg.listen?.ownerName || '').trim()) return { ok: false, reason: '还没在「说话与身份」里填主人抖音昵称' }
    }
    if (running) return { ok: false, reason: '值班正在进行', ...snapshot() }
    const cli = findDshCli(logger)
    if (!cli) {
      lastRun = { at: now(), ok: false, error: '没找到 dsh CLI，值班模式用不了' }
      return { ok: false, reason: lastRun.error + '；这轮不刷' }
    }
    mkdirSync(home, { recursive: true })
    try { rmSync(stopFlag, { force: true }) } catch { /* 忽略 */ }
    // 上一轮的 tab.json 不能拿来判断这一轮；新标签页由 duty-server 重新写。
    try { rmSync(tabFile, { force: true }) } catch { /* 忽略 */ }
    const newRound = {
      id: `${now()}-${selectedTask}`,
      task: selectedTask,
      owner: String(owner || selectedTask),
      why: reason,
      startedAt: now(),
    }
    writeJsonAtomic(roundFile, newRound)
    ensureProfile(cfg, selectedTask)
    const prompt = buildPrompt(reason, { task: selectedTask, owner: newRound.owner })

    const args = []
    if (cli.kind === 'desktop-host') args.push('--expose-internals')
    args.push(cli.cli, '--profile', 'douyin-duty', prompt)
    log(`值班开跑（${reason}，任务 ${selectedTask}，owner ${newRound.owner}）：--profile douyin-duty`)
    let logFd = -1
    try { logFd = openSync(logFile, 'a') } catch { logFd = -1 }
    try {
      child = spawn(process.execPath, args, {
        cwd: home,
        detached: true,
        windowsHide: true,
        stdio: logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FISH_TASK: selectedTask },
      })
    } catch (err) {
      running = false
      try { rmSync(roundFile, { force: true }) } catch { /* 忽略 */ }
      lastRun = { at: now(), ok: false, error: `值班起不来：${err.message}` }
      logger?.warn?.(lastRun.error)
      return { ok: false, reason: lastRun.error }
    } finally {
      if (logFd >= 0) { try { closeSync(logFd) } catch { /* 忽略 */ } }
    }
    running = true
    stopping = false
    startedAt = now()
    why = reason
    round = newRound
    socialSent = false
    socialStopRequested = false
    startTabWatch()
    // 值班中途也把事件导进记忆：这样主人刚看到它翻完喜欢列表，回主对话问它时，
    // 记忆里已经有了，而不是等值班进程结束才一次性补写。
    if (eventTimer) { clearInterval(eventTimer); eventTimer = null }
    eventTimer = setInterval(() => {
      if (!running) return
      try { importEvents() } catch (err) { log(`值班事件增量导入失败：${err.message}`) }
    }, 2_000)
    eventTimer.unref?.()
    child.on('error', (err) => { log(`值班进程错误：${err.message}`); lastRun = { at: now(), ok: false, error: err.message }; settle(-1) })
    child.on('exit', (code) => settle(code))
    // 不限时；只有「进程卡死」的兜底：6 小时后还没退才强杀，不当作正常限制
    killTimer = setTimeout(() => {
      if (!running || !child) return
      log('值班进程 6 小时没退，兜底结束')
      try { child.kill() } catch { /* 已退出 */ }
    }, 6 * 60 * 60 * 1000)
    try { child.unref?.() } catch { /* 忽略 */ }
    return { ok: true, ...snapshot() }
  }

  function shutdownBrowser() {
    // 共享浏览器归插件所有时，值班只是其中一个标签页：绝不按 pid 杀整个浏览器。
    const hub = readJsonSafe(hubFile, null)
    if (hub && hub.owner === 'plugin') {
      try { rmSync(browserPidFile, { force: true }) } catch { /* 忽略 */ }
      return
    }
    let pid = 0
    try { pid = Number(readFileSync(browserPidFile, 'utf8').trim()) || 0 } catch { /* 文件不存在就跳过 */ }
    if (pid) killTree(pid)
    try { rmSync(browserPidFile, { force: true }) } catch { /* 忽略 */ }
  }

  function stop(reason = 'manual') {
    if (!running) return { ok: false, reason: '没有正在进行的值班', ...snapshot() }
    if (stopping) return { ok: true, ...snapshot() }
    stopping = true
    try { writeFileSync(stopFlag, String(now())) } catch { /* 忽略 */ }
    const pid = child?.pid
    log(`收到停止（${reason}）：留 2 秒让它说完最后一句，然后关窗口、结束整棵进程树`)
    stopTimer = setTimeout(() => {
      stopTimer = null
      killTree(pid)
      shutdownBrowser()
      // Windows 上 exit 事件偶尔不来：兜底结算，别让界面永远显示「值班中」
      const backstop = setTimeout(() => {
        if (!running) return
        log('停止兜底：进程没退，直接结算')
        shutdownBrowser()
        settle(-1)
      }, 5000)
      backstop.unref?.()
    }, 2000)
    stopTimer.unref?.()
    return { ok: true, ...snapshot() }
  }

  function snapshot() {
    const secs = running ? Math.round((now() - startedAt) / 1000) : 0
    return {
      running,
      stopping,
      why,
      seconds: secs,
      task: round?.task || null,
      owner: round?.owner || null,
      round: round ? { ...round } : null,
      socialSent,
      detail: running
        ? (stopping ? '正在停止，关掉窗口…' : `${round?.task === 'social' ? '社交互动中' : '值班中'}（${secs < 60 ? `${secs} 秒` : `${Math.round(secs / 60)} 分钟`}）· ${why}`)
        : '',
      lastRun,
      logFile,
    }
  }

  /** 订阅值班结算；ActionRunner 用它在轮次结束时收活动状态。 */
  function onSettled(listener) {
    if (typeof listener !== 'function') return () => {}
    settledListeners.add(listener)
    return () => settledListeners.delete(listener)
  }

  return {
    start,
    stop,
    snapshot,
    settings,
    onSettled,
    _internal: { findDshCli, buildPrompt, dutyPatchYml, ensureProfile, importEvents },
  }
}
