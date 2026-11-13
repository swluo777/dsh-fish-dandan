// 网页冒烟测试：单文件 index.html 没有 DOM 测试框架，
// 用静态结构 + 内联脚本语法解析守住重构底线（零外部依赖）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const file = path.resolve('src/gui/web/index.html')
const html = fs.readFileSync(file, 'utf8')

function inlineScript() {
  const m = html.match(/<script>\s*\(\(\) => \{([\s\S]*?)\}\)\(\);\s*<\/script>/)
  assert.ok(m, '应存在主 IIFE 内联脚本')
  return '(() => {\n' + m[1] + '\n})();'
}

test('网页：内联脚本语法可被解析', () => {
  assert.doesNotThrow(() => new vm.Script(inlineScript(), { filename: 'index.html#inline' }))
})

test('网页：占位符与宿主注入契约完整', () => {
  assert.ok(html.includes('window.__FD_API_BASE__ = "__API_BASE__"'), 'API 基址占位符必须在')
  assert.ok(html.includes('__UI_PATH__/icon.png'), '图标走宿主本地路由')
  assert.ok(html.includes('__API_BASE__') && html.includes('__UI_PATH__'))
  assert.ok(html.includes('/fish-dandan/api'), 'gui.test.js 依赖的默认 API 基址')
})

test('网页：信息架构是「状态主页 + 独立配置向导」', () => {
  const tabs = html.match(/const TABS = \[([^\]]+)\]/)
  assert.ok(tabs, '应有 TABS 常量')
  const list = tabs[1].match(/"[a-z]+"/g).map((s) => s.replace(/"/g, ''))
  assert.equal(list[0], 'home', '首屏应是当前状态')
  assert.ok(list.includes('setup'), '应有独立的从零配置入口')
  for (const key of ['persona', 'memory', 'state', 'platform', 'safety']) {
    assert.ok(list.includes(key), `原功能 tab ${key} 不能丢`)
  }
  assert.ok(!list.includes('guide'), '旧的开始使用 tab 已被向导取代')
  assert.equal((html.match(/data-tab="/g) || []).length, list.length, '导航按钮数应与 TABS 一致')
  assert.ok(html.includes('function defaultTab() { return "home"; }'))
})

test('网页：三层状态看板与图表函数齐全', () => {
  for (const fn of ['renderHome', 'renderSetup', 'radarSvg', 'emotionSvg', 'moodViz', 'trendSvg',
    'factorRows', 'miniBars', 'startParticles', 'stopParticles', 'applyWizard', 'bindWizard']) {
    assert.ok(html.includes('function ' + fn + '('), `缺少 ${fn}`)
  }
  assert.ok(html.includes('它是什么脾气') && html.includes('这会儿什么感觉') && html.includes('最近的心情'), '三层状态卡要用大白话标题')
  assert.ok(html.includes('想看专业维度') && html.includes('plain-state'), '专业术语收进折叠区、首屏给一句话状态')
  assert.ok(html.includes('id="fsRadar"') && html.includes('id="fsStroke"') && html.includes('id="fsArea"'), 'SVG 渐变定义齐全')
  assert.ok((html.match(/class="viz"/g) || []).length >= 3, '至少三处 SVG 图表')
  assert.ok(html.includes('prefers-reduced-motion') && html.includes('id: "midnight"'), '动效降级 + 暗色由「暗夜蓝黑」皮肤承担')
})

test('网页：配置向导五步、渐进式披露、最后一键应用', () => {
  assert.ok(html.includes('const WIZARD_STEPS = ["认识一下", "定个性子", "怎么说话", "喜好与来历", "确认应用"]'))
  assert.ok(html.includes('data-wiz="apply"') && html.includes('data-wiz="next"') && html.includes('data-wiz="prev"'))
  assert.ok(html.includes('const PRESETS = ['), '应有一键配置原型')
  assert.ok(html.includes('details class="group"'), '高级选项默认折叠')
  assert.ok(html.includes('使用技巧与常见问题'), '使用文档不能丢')
  assert.ok(html.includes('它要管我叫什么') && html.includes('data-address=') && html.includes('"老大"'), '第一次配置就要能选称呼')
  assert.ok(html.includes('用 AI 一键生成') && html.includes('/persona/parse') && html.includes('aiPrompt'), 'AI 人格卡一键生成链路')
  assert.ok(html.includes('现在：') && html.includes('想看专业维度'), '首屏给大白话状态、术语收进折叠区')
  assert.ok(html.includes('这一版还做不到的'), '已知限制要如实写出')
})

test('网页：使用技巧折叠区的排版与当前功能同步', () => {
  assert.ok(html.includes('.done-panel > p{'), '完成页的段落约束不能污染折叠区里的 .tip p')
  assert.ok(!/\.done-panel p\{/.test(html), '不能再用会命中所有后代 p 的旧选择器')
  for (const text of ['监听私信和刷抖音是分开的', '它主动私信太多', '它看了我的喜欢列表', '旧会话不继承记忆段', 'session/event']) {
    assert.ok(html.includes(text), `使用技巧要覆盖当前功能：${text}`)
  }
  assert.ok(!html.includes('pre-step 消息结构'), '自动捕获已走 session/event，旧说明要删掉')
})

test('网页：零外部请求、无构建依赖、无遗留死代码', () => {
  const script = inlineScript()
  for (const bad of ['cdn.', 'unpkg.com', 'jsdelivr', 'fonts.googleapis', 'import(', 'require(']) {
    assert.ok(!script.includes(bad), `内联脚本不应出现 ${bad}`)
  }
  assert.ok(!html.includes('renderGuide') && !html.includes('FISH_MARK'), '旧 guide 实现应已移除')
  assert.ok(!html.includes('function clone('), '零调用工具函数应已移除')
  assert.ok(html.includes('HINTS[S.tab] || HINTS.home'), '新增 tab 时提示语要有兜底')
})

test('网页：serveUi 的两个占位符都会被替换', () => {
  const api = fs.readFileSync(path.resolve('src/gui/api.js'), 'utf8')
  assert.ok(api.includes(".replaceAll('__API_BASE__', config.gui.basePath)"))
  assert.ok(api.includes(".replaceAll('__UI_PATH__', config.gui.uiPath)"))
  assert.ok(api.includes('serveIcon'), '图标本地路由仍在')
})

test('网页：记忆页按渐进式披露解释三层与存储', () => {
  assert.ok(html.includes('它记的东西，分三种'), '首屏先给一句人话')
  for (const w of ['钉住的事', '它的习惯', '那天的事']) {
    assert.ok(html.includes(w), `三层要有白话名：${w}`)
  }
  assert.ok(html.includes('data-reveal=') && html.includes('reveal("diff"') && html.includes('reveal("store"') && html.includes('reveal("words"'),
    '专业细节与存储科普默认折叠')
  assert.ok(html.includes('向量 / Embedding / 向量库') && html.includes('混合检索'), '存储选型要给依据')
  assert.ok(html.includes('本地数据库 SQLite') && html.includes('data/memory/'), '说明当前介质与文件位置')
  assert.ok(html.includes('每天最多自动收 8 条'), '说明记忆增长闸门')
  assert.ok(html.includes('function backendLabel('), '后端类型要翻成白话')
})

test('网页：人格折叠区与滑块分组样式齐全', () => {
  assert.ok(html.includes('details.group .g-body,details.group .group-body{'), 'group-body 必须有内边距')
  assert.ok(html.includes('.grid{display:grid'), 'grid 必须真的定义过')
  assert.ok(html.includes('.sliders{display:grid'), '滑块必须成组，两端标签才不会串到下一行')
  assert.ok(html.includes('<div class="sliders">'), '人格页与向导都要用 sliders 容器')
  assert.ok(html.includes('aria-label="') && html.includes('esc(low)'), '滑块标签要转义并带无障碍名')
})

test('网页：全站折叠区统一为卡片行 + 圆形箭头', () => {
  assert.ok(html.includes('details.group>summary::after') && html.includes('details.reveal>summary::after'), '外层折叠共用同一个右侧指示')
  assert.ok(!html.includes('content:"+"'), '不再用加号/减号当展开指示')
  assert.ok(html.includes('mask:url("data:image/svg+xml'), '箭头用几何遮罩绘制，不依赖文字字形在圆里居中')
  assert.ok(!html.includes('content:"›"'), '不再用文字箭头，避免字形自带留白导致偏心')
  assert.ok(html.includes('details.reveal.sub{'), '嵌套折叠有自己的轻量卡片样式')
  assert.ok(!html.includes('class="chev"'), '人格卡不再额外塞一个旧箭头，避免双指示')
  assert.ok(html.includes('summary:focus-visible'), '键盘焦点要看得见')
  assert.ok(html.includes('details.reveal .rbody') && html.includes('.fold-clip'), '展开后的内容由裁切层接管，减少跳变')
})

test('网页：折叠展开不抖：稳定滚动条槽 + 高度展开 + 淡入', () => {
  assert.ok(html.includes('scrollbar-gutter:stable'), '页面要预留滚动条槽，长短内容切换不能横向抖')
  assert.ok(!html.includes('translateY(-4px)'), '折叠内容不能用位移入场，避免展开时文字抖一下')
  assert.ok(html.includes('const FOLD_OPEN_MS = 380') && html.includes('const FOLD_CLOSE_MS = 250'), '展开慢、收起快，接近 iOS 的节奏')
  assert.ok(html.includes('FOLD_EASE_OPEN') && html.includes('cubic-bezier(.22,1,.36,1)'), '展开用减速曲线，不弹跳')
  assert.ok(html.includes('function animateFold(') && html.includes('function initFoldAnimation(') && html.includes('function toggleFold('), '折叠动画要有可中断的展开/收起入口')
  assert.ok(html.includes('prefers-reduced-motion:reduce'), '系统开了减少动态效果时直接切换')
  assert.ok(html.includes('@supports not (scrollbar-gutter:stable)'), '老浏览器用常驻滚动条兜底')
})

test('网页：定时刷新只换数据，不重建页面', () => {
  assert.ok(html.includes('function paintHome(') && html.includes('function paintState('), '要有局部刷新函数')
  assert.ok(html.includes('id="homeRoot"') && html.includes('id="stateRoot"'), '骨架只建一次')
  assert.ok(html.includes('if (S.tab === "home") paintHome();') && html.includes('if (S.tab === "state") paintState();'),
    '数据加载后走局部更新，不再整页 render')
  assert.ok(html.includes('S._schedSig'), '调度表单只在后端数据变化时重建，编辑中的值不丢')
  assert.ok(html.includes('data-hreveal='), '主页折叠区展开状态要持久化')
  assert.ok(html.includes('closest("[data-nudge]")') && html.includes('closest("[data-approve]")'), '状态页事件用委托，动态按钮不用重绑')
})

test('网页：重新走一遍有折叠入口与二次确认', () => {
  assert.ok(html.includes('想从头再配一次？'), '重来入口默认收起，不放在主按钮行')
  assert.ok(html.includes('function confirmAction(') && html.includes('id="confirmOverlay"'), '危险动作必须二次确认')
  assert.ok(html.includes('restartWizardWithConfirm') && html.includes('data-wiz="restart"'), '完成页要真的绑定事件')
  assert.ok(html.includes('已经保存的人格、记忆和情绪状态都不会删'), '确认文案要写清后果')
  assert.ok(html.includes('cancel.focus()'), '默认焦点在取消，不诱导确认')
})

test('网页：情绪环与调度参数有白话说明', () => {
  assert.ok(html.includes('闪着光的是它此刻的感觉') && html.includes('在盘上连续移动'), '当前点要在盘上连续移动')
  assert.ok(html.includes('典型位置'), '目录点降级为参考位置')
  assert.ok(html.includes('这五项分别是干嘛的'), '调度参数说明默认收起')
  for (const k of ['静默开始 / 静默结束', '每日唤醒预算', '随机抖动（0–1）', '最小空闲（分钟）']) {
    assert.ok(html.includes(k), `缺少调度参数解释：${k}`)
  }
})

test('网页：平台页三卡并列，不被单一平台挡住', () => {
  assert.ok(html.includes('plat-grid') && html.includes('plat-card'), '三卡并列布局')
  assert.ok(html.includes('扩展口'), 'QQ 扩展口状态要有专门渲染')
  assert.ok(html.includes('扫码登录') && html.includes('登录过期') && html.includes('已登录'), '抖音卡登录态要中文渲染')
  assert.ok(html.includes('douyinLoginHtml') && html.includes('/platforms/douyin/login'), '扫码登录链路')
  assert.ok(html.includes('function paintPlatform(') && html.includes('id="platRoot"'), '平台页骨架只建一次，操作后局部刷新不闪')
  assert.ok(!html.includes('fs-fade-up'), '入场动画已移除，重建不再闪')
  assert.ok(html.includes('后端还没加载登录接口'), '旧后端要点破「要重启 DSH」')
  assert.ok(html.includes('hue: Math.random() > 0.5 ? 0 : 1') && html.includes('activeBubbleHues[b.hue]'), '气泡颜色随皮肤切换')
})

test('网页：心情刻度按 -100~+100 整数显示', () => {
  assert.ok(html.includes('function pctLabel('), '显示层换算，内部数据保持 -1~+1')
  assert.ok(html.includes('+100</text>') && html.includes('−100</text>'), '趋势图刻度改成百分制')
  assert.ok(html.includes('>心情分</text>') && html.includes('心情分 −100 ~ +100'), '圈内只留短标签，范围说明放图例')
  assert.ok(html.includes('范围 −100 ~ +100'))
  assert.ok(html.includes('pctLabel(mood.p)') && html.includes('pctLabel(v)'), '环形仪表与三行数值都走百分制')
  assert.ok(html.includes('界面按 −100~+100 的整数显示'), '专业维度里要写清换算关系')
  assert.ok(!html.includes('toFixed(2) + "</text>"'), '环形中心不再显示小数')
})

test('网页：向导完成标记要持久化，重启不再退回第 1 步', () => {
  assert.ok(html.includes('async function loadWizard(') && html.includes('async function saveWizard('), '读写函数齐全')
  assert.ok(html.includes('Promise.all([loadPersona(), loadOverview(), loadWizard()])'), 'boot 时恢复完成标记')
  assert.ok(html.includes('saveWizard(true)'), '一键应用成功后写回 done=true')
  assert.ok(html.includes('saveWizard(false)'), '确认重来后写回 done=false')
})

test('网页：人格页有一句话微调（预览 -> 确认 -> 可撤销）', () => {
  assert.ok(html.includes('id="tuneBox"') && html.includes('预览变更'), '人格页顶部有输入入口')
  assert.ok(html.includes('/persona/tune') && html.includes('function tunePreview('), '解析走后端预览接口')
  assert.ok(html.includes('data-tune="apply-all"') && html.includes('data-tune="apply-traits"'), '应用全部 / 只改性格分开')
  assert.ok(html.includes('data-tune="undo"') && html.includes('已撤销本次调整'), '应用后 30 秒内可撤销')
  assert.ok(html.includes('年龄、外貌、性格标签、日常反应、边界'), '提示语要说清新字段也能一句话改')
  assert.ok(html.includes('c.kind === "text"') && html.includes('c.kind === "list-add"'), '预览要区分文本与列表变更')
  assert.ok(html.includes('听不懂会直说，不会猜着改') || html.includes('听不懂会直说'), '没听懂要直说，不猜着改')
  assert.ok(html.includes('/decision/scheduler'), '勾选联动时改调度参数')
})

test('网页：人格页支持年龄、外貌、性格标签、日常反应与边界', () => {
  for (const field of ['identity.age', 'identity.appearance', 'personality.tags', 'scenes', 'boundaries']) {
    assert.ok(html.includes('data-field="' + field + '"') || html.includes('chipEditor("' + field), `人格页缺少 ${field}`)
  }
  assert.ok(html.includes('日常反应') && html.includes('分寸与边界'), '两组扩展字段要有独立入口')
  assert.ok(html.includes('只写成年角色'), '年龄字段要说明只写成年角色')
})

test('网页：人格快照是页面内一行入口 + 居中只读浮窗', () => {
  assert.ok(html.includes('id="previewBtn"') && html.includes('class="snapshot-row"') && html.includes('aria-haspopup="dialog"'), '人格快照是页面内可见的行入口')
  assert.ok(html.includes('id="previewModal"') && html.includes('class="preview-scrim"'), '点开是页面内浮窗，不是右侧窄抽屉')
  assert.ok(html.includes('function openPreviewModal(') && html.includes('closePreviewModal'), '可打开、可点浮窗外收起')
  assert.ok(html.includes('white-space:pre-wrap') && html.includes('overflow-wrap:anywhere'), '长人格段必须换行，不能向右溢出')
  assert.ok(!html.includes('class="preview-drawer"'), '不再使用右侧窄抽屉')
  assert.ok(!html.includes('id="previewHelp"') && !html.includes('点页面下方的「人格快照」查看'), '人格快照浮窗里不放指向自己的问号/指路文案')
  assert.ok(html.includes('role="dialog"') && html.includes('aria-hidden="true"'), '浮窗默认隐藏，并按弹窗语义声明')
  assert.ok(html.includes('它每次回话时，真正带上的人格设定'), '入口用用户能看懂的话，不写模型内部术语')
})

test('网页：折叠行摘要不复读展开区正文', () => {
  assert.ok(!html.includes('p.backstory || "还没写").slice(0, 36)'), '来历摘要不能截正文')
  assert.ok(!html.includes('p.speech.styleNotes || "还没写").slice(0, 36)'), '语言习惯摘要不能截正文')
  assert.ok(html.includes('它从哪里来，经历过什么') && html.includes('补充语气和说话细节'), '摘要只说明这一栏填什么')
})

test('网页：长说明统一收进问号，全站可点', () => {
  const keys = ['setupIdentity', 'setupTraits', 'setupSpeech', 'setupPrefs', 'setupReview',
    'tune', 'age', 'catchphrases', 'tags', 'scenes', 'boundaries', 'backstory',
    'memoryIntro', 'memoryTerms', 'safetyRules']
  for (const key of keys) assert.ok(html.includes('helpTip("' + key + '")'), `缺少问号帮助：${key}`)
  assert.ok(/document.addEventListener\("click"[\s\S]{0,300}showHelp\(btn\)/.test(html), '问号要在全站点击生效，不只平台页')
  assert.ok(html.includes('font-family:inherit;font-size:11px;font-weight:600') && html.includes('line-height:14px'), '问号固定字重与行高，不跟随父级变粗/偏移')
  assert.ok(!html.includes('<div class="why">保存后'), '向导不再把长备注铺在页面上')
  assert.ok(!html.includes('<div class="pf">'), '人格预览不再铺运行说明')
  assert.ok(!html.includes('专业名：') && !html.includes('class="dm-note"'), '记忆图例与私信说明不再铺内部备注')
})

test('网页：刷抖音有总开关与渐进披露设置，跨平台能力预留', () => {
  assert.ok(html.includes('switchHtml("browse.enabled"') && html.includes('data-pset="'), '允许活动总开关（运行时拼属性）')
  assert.ok(html.includes('允许它用抖音') && html.includes('开 = 允许；关 = 不能刷'), '总开关语义：只授权能不能去刷，不是开始刷')
  assert.ok(html.includes('const canBrowse') && html.includes('!canBrowse'), '未登录/过期时总开关置灰不可开')
  assert.ok(html.includes('先登录，登录后才能开') && html.includes('登录过期了，先重扫'), '按登录状态给出对应提示')
  assert.ok(!html.includes('data-pset-mode'), '静默已下线，不再有活动方式二选一')
  assert.ok(html.includes('围观模式：窗口可见，随时能停') && html.includes('下面决定它能不能自己回来'), '固定围观要写清窗口可见')
  assert.ok(!html.includes('后台一个看不见的窗口') && !html.includes('静默模式不会弹窗'), '不再有静默模式文案')
  assert.ok(html.includes('先打开「允许它用抖音」。'), '关着时只给一句提示')
  assert.ok(html.includes('记忆名单') && !html.includes('自动回所有人'), '私信不再摆「自动回所有人」这一行，记忆名单独立')
  assert.ok(html.includes('现在去刷一轮') && html.includes('data-browse="run"'), '手动开始一段活动')
  assert.ok(html.includes('让它自己挑时候去'), '自动安排是独立开关，和手动按钮分开')
  assert.ok(html.includes('data-browse="stop"') && html.includes('停止'), '进行中可停止')
  assert.ok(html.includes('停止会关掉这个活动标签页') && html.includes('监听不受影响'), '停止只收活动标签页，不连坐监听')
  assert.ok(!html.includes('关掉设置页不影响它刷'), '默认没有定时任务：不再有「后台自动刷」的说明')
  assert.ok(html.includes('switchHtml("autoWake.enabled"') && html.includes('默认关'), '自唤醒是显式开关，默认关')
  assert.ok(html.includes('function browseStatusHtml(') && html.includes('/platforms/douyin/browse/stop'), '刷流状态与停止接口')
  assert.ok(html.includes('登录已过期，请重新扫码'), 'Cookie 失效要提醒重新扫码')
  assert.ok(html.includes('详细设置'), '细节收进折叠区（渐进式披露）')
  assert.ok(html.includes('function paintInbox(') && html.includes('data-pset="listen.enabled"'), '监听开关跟随后端状态')
  assert.ok(html.includes('const listenLocked = !canBrowse'), '监听开关只受登录态限制，不被刷视频总开关连坐')
  assert.ok(html.includes('浏览画面') || html.includes('看画面'), '画面理解有设置入口')
  assert.ok(html.includes('data-owner-profile="owner.profileUrl"') && html.includes('data-owner-save') && html.includes('owner.readLikes'), '主人主页与喜欢列表有设置入口和显式保存按钮')
  assert.ok(html.includes('抖音私信') && !html.includes('自动回所有人') && !html.includes('只自动回我'), '私信不再摆「自动回所有人」这一行')
  assert.ok(!html.includes('陌生人也收（只排队）') && !html.includes('data-dm-scope-toggle'), '旧「只回我/只排队」两态已删除')
  assert.ok(html.includes('memoryChipsHtml(') && html.includes('data-memory-add') && html.includes('data-memory-del'), '记忆名单用标签增删')
  assert.ok(html.includes('dmMemoryInput') && html.includes('maxlength="40"'), '名单输入框按昵称长度限制')
  assert.ok(html.includes('data-help') && html.includes('function showHelp(') && html.includes('help-pop'), '长说明收进问号弹窗')
  assert.ok(html.includes('记忆名单：谁能用到记忆'), '记忆名单说明标题要直白')
  assert.ok(html.includes('它记住的事') && html.includes('名单外的人只能用这次聊过的内容'), '记忆名单要说清：上下文 + 记忆库，名单外只用上下文')
  assert.ok(!html.includes('不是另一个浏览器'), '私信文案不写实现备注')
  assert.ok(html.includes('}, 5000);'), '平台页定时同步监听状态')
  assert.ok(html.includes('S.inboxSeq'), '旧的在途请求不能把开关翻回去')
  assert.ok(!html.includes('data-pset-num="duty.maxMinutes"') && !html.includes('data-pset-num="pace.dailyMinutes"'), '只做权限划分：没有时长/条数/节奏配置')
  assert.ok(!html.includes('data-pset-num="browse.dwellMinSec"'), '不再暴露停留区间')
  assert.ok(html.includes('这里只给权限') && html.includes('不限时长'), '界面上说清是权限不是额度')
  assert.ok(html.includes('["browse.readComments"') && html.includes('data-pset-num="browse.commentLimit"'), '读评论并进权限组、读几条可配')
  assert.ok(html.includes('switchHtml("actions.mentionOwner"') && html.includes('艾特主人'), '评论动作组里有「艾特主人」开关')
  assert.ok(html.includes('id="ownerName"') && html.includes('id="ownerId"') && html.includes('data-owner-identity-save'), '主人昵称/抖音号是共用身份，有保存入口')
  assert.ok(html.includes('S.platformReveal.dutyGuide ? " open"') && html.includes('S.platformReveal.playbook ? " open"'), '值班剧本 / 操作手册展开后，局部重画也要保持打开')
  assert.ok(!html.includes('私信监听是另一个开关'), '「允许它用抖音」的问号只解释这个开关，不夹带私信监听')
  assert.ok(html.includes('先填好下面的「我的抖音昵称」'), '艾特主人提示的是下面的昵称输入框')
  assert.ok(html.includes('function paintOwnerChip(') && /data-owner-identity-save[\s\S]{0,700}paintOwnerChip\(name\)/.test(html), '保存昵称后只更新记忆名单里的主人名字')
  assert.ok(!/data-owner-identity-save[\s\S]{0,700}paintPlatform/.test(html), '保存昵称不能重建整个抖音设置区')
  assert.ok(!html.includes('data-preveal="replyBox"') && !html.includes('回评论（监听式，待接入）'), '回评论死入口已从页面移除')
  assert.ok(!html.includes('看评论区'), '读评论不再单独占一个区块')
  assert.ok(html.includes('function interestChipsHtml(') && html.includes('data-interest-add') && html.includes('data-interest-del'), '兴趣词用标签增删，不是逗号输入框')
  assert.ok(!html.includes('data-pset-time="pace.activeStart"') && !html.includes('data-pset-num="pace.minGapMinutes"'), '不再有频率与时段配置')
  for (const k of ['"actions.like"', '"actions.comment"', '"actions.dm"']) {
    assert.ok(html.includes(k), `互动能力开关位：${k}`)
  }
  assert.ok(!html.includes('"actions.publish"'), '发作品开关不再出现在设置里')
  assert.ok(!html.includes('"actions.follow"'), '关注开关不再出现在设置里')
  assert.ok(html.includes('"actions.forward"') && html.includes('分享给主人'), '只保留「分享给主人」开关，不恢复通用转发')
  assert.ok(!html.includes('关注、转发、发作品暂时关闭'), '页面不再留关闭说明')
  assert.ok(!html.includes('"commentsPerDay", "每天评论"') && !html.includes('data-pset-num="budgets.'), '不再有每轮/每日固定配额')
  assert.ok(!html.includes('targets.dmAllowlist') && !html.includes('data-pset-text="targets.forwardTo"'), '不再让人预设「转给谁/私信谁」')
  assert.ok(html.includes('关掉 = 它不能做'), '互动开关关掉就是真的做不了，要说清')
  assert.ok(html.includes('允许它用抖音') && !html.includes('开 = 起一个模型会话自己刷'), '总开关语义 = 只授权能不能碰，不是开始刷')
  assert.ok(!html.includes('值班模式（会思考）'), '不再有嵌套的值班开关')
  assert.ok(html.includes('const stateText = expired ? "登录过期，重新扫码" : logged ? "" : "未登录，建议用小号";'), '已登录只在右上角徽章显示，登录区不再重复')
  assert.ok(!html.includes('<span class="ok-text">✓ 已登录</span>'), '登录区不能和右上角徽章重复显示「已登录」')
  assert.ok(html.includes('.pill .s{width:7px;height:7px;border-radius:50%;background:currentColor}'), '未登录的圆点要跟着 warn 变橙，不能一直是绿色')
  assert.match(html, /act === "logout"[\s\S]{0,300}await loadPlatforms\(\)/, '退出登录后要重新拉平台状态，右上角徽章同步变回未登录')
  assert.ok(html.includes('function journalHtml(') && html.includes('/platforms/douyin/journal'), '展示它刚自己做了什么（行为日志）')
  assert.ok(html.includes('这里只给权限') && html.includes('默认不自动跑'), '安全边界一句话说清：默认不自动跑')
  assert.ok(html.includes('id="stkGrid"') && html.includes('/stickers/import') && html.includes('/stickers/upload'), '表情包是功能不是开关：上传 + 从链接导入 + 网格')
  assert.ok(html.includes('抖音、B站、QQ 共用一套'), '表情包跨平台共用一套')
  assert.ok(html.includes('data-tab="stickers"') && html.includes('TABS = ["home"'), '表情包是独立侧边栏页')
  assert.ok(html.includes('stkRemoteClear') && html.includes('/stickers/install/status'), '远程列表可收起，下载有进度轮询')
  assert.ok(html.includes('/platform/settings'), '设置走 GET/PUT 接口')
})

test('网页：审计页只显示最近20条，并说明旧记录不会被删除', () => {
  assert.ok(html.includes('/audit?limit=20'), '审计页只取最近 20 条')
  assert.ok(html.includes('这里只显示最近 20 条；更早的审计记录留在本地，不会被删除，也不会因为超过 100 条而消失。'), '要把响应上限和存储保留区分开')
  assert.ok(html.includes('<h2>记忆审计</h2><p>最近 20 条'), '记忆审计标题要写清窗口')
  assert.ok(html.includes('<h2>人格审计</h2><p>最近 20 条'), '人格审计标题要写清窗口')
  assert.ok(html.includes('white-space:nowrap;flex:1;min-width:0'), '单条审计不能因为对象名太长撑成多行')
  assert.match(html, /\.card,\.panel\{[\s\S]*min-width:0;max-width:100%/, '卡片作为网格项要能被压窄，不能把整页撑出去')
  assert.match(html, /\.audit\{[^}]*min-width:0;max-width:100%;overflow:hidden/, '审计区要自己收住横向溢出')
  assert.match(html, /\.audit \.row\{[^}]*min-width:0;max-width:100%;overflow:hidden/, '单行审计行也要收住横向溢出')
})

test('网页：默认皮肤为浅海蓝，经典蓝紫仍可选', () => {
  assert.ok(html.includes('const DEFAULT_THEME_ID = "sky"'), '默认主题 id 必须是 sky')
  assert.ok(html.includes('默认皮肤＝浅海蓝'), '首屏 CSS 默认也要是浅海蓝，避免刷新闪回')
  assert.ok(html.includes('--bg:#f4f9ff') && html.includes('--accent:#3e8ef7'), '首屏默认变量要对齐浅海蓝')
  assert.ok(html.includes('id: "classic"') && html.includes('经典蓝紫'), '经典蓝紫保留为可选皮肤')
  assert.ok(html.includes('id: "sky"') && html.includes('浅海蓝'), '浅海蓝预置存在')
  assert.ok(html.indexOf('id: "sky"') < html.indexOf('id: "classic"'), '默认的浅海蓝必须排在经典蓝紫前面')
  assert.ok(html.includes('fish-theme-explicit') && html.includes('stored.id === "classic"'), '旧默认 classic 要有一次迁移，之后主动选过则保留')
  assert.ok(html.includes('id: "midnight"') && html.includes('暗夜蓝黑') && html.includes('scheme: "dark"'), '预置 3：暗夜蓝黑')
  assert.ok(html.includes('function applyTheme(') && html.includes('fish-theme'), '一键切换并持久化')
  assert.ok(html.includes('fish-custom-themes') && html.includes('function buildCustomTheme(') && html.includes('data-skin-del='), '自定义皮肤可增可删')
  assert.ok(html.includes('id="skinBtn"') && html.includes('aria-label="更换配色皮肤"') && html.includes('id="skinPop"') && html.includes('id="skinList"'), '顶栏入口为图标按钮（带无障碍名）与皮肤面板')
  assert.ok(html.includes('id="skinBg" value="#f4f9ff"') && html.includes('id="skinText" value="#1b2a42"') && html.includes('id="skinAccent" value="#3e8ef7"') && html.includes('id="skinAccent2" value="#7db9ff"'), '自定义皮肤颜色输入框要有合法默认值')
  assert.ok(html.includes('style="stop-color:var(--chart-1)"') && html.includes("style=\"stroke:var(' + v + ')"), '图表三线与渐变走变量，切肤即变')
  assert.ok(html.includes('color-mix(in srgb, var(--accent)'), '阴影/光晕/选区跟随主题')
  assert.ok(html.includes('皮肤闪避'), '刷新前先恢复上次皮肤，不闪默认')
})

