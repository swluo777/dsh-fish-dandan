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
  assert.ok(html.includes('if (S.tab === "home") paintHome();') && html.includes('if (S.tab === "state") {') && html.includes('paintState();'),
    '数据加载后走局部更新，不再整页 render')
  assert.ok(html.includes('S._schedSig'), '调度表单只在后端数据变化时重建，编辑中的值不丢')
  assert.ok(html.includes('data-hreveal='), '主页折叠区展开状态要持久化')
  assert.ok(html.includes('closest("[data-nudge]")') && html.includes('closest("[data-approve]")'), '状态页事件用委托，动态按钮不用重绑')
  assert.ok(html.includes('class="btn sm quiet" data-nudge="clear"') && !html.includes('btn sm ghost" data-nudge="clear"'), '取消指定要可见，但和普通按钮有轻微区分')
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
  assert.ok(html.includes('这些参数分别是干嘛的'), '调度参数说明默认收起')
  for (const k of ['静默开始 / 静默结束', '每日总次数上限', '每类动作每天最多', '每类动作间隔（分钟）', '随机抖动（0–1）', '最小空闲（分钟）']) {
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
  assert.ok(html.includes('围观模式：窗口可见，随时能停。'), '固定围观要写清窗口可见')
  assert.ok(!html.includes('后台一个看不见的窗口') && !html.includes('静默模式不会弹窗'), '不再有静默模式文案')
  assert.ok(html.includes('先打开「允许它用抖音」。'), '关着时只给一句提示')
  assert.ok(html.includes('记忆名单') && !html.includes('自动回所有人'), '私信不再摆「自动回所有人」这一行，记忆名单独立')
  assert.ok(html.includes('data-run-kind') && html.includes('立即触发一次') && ['自主探索', '社交互动', '专注创作'].every((label) => html.includes(label)), '三类动作都有立即触发入口')
  assert.ok(html.includes('data-stop-kind') && html.includes('终止'), '执行中的动作行变成终止按钮')
  assert.ok(html.includes('ensureActivityWatch') && html.includes('setTimeout(tick, 1200)'), '活动执行中短轮询，结束后恢复按钮')
  assert.ok(!html.includes('data-browse="run"') && !html.includes('现在去刷一轮'), '平台页不再有手动刷流入口')
  assert.ok(html.includes('专注创作') && html.includes('画一张图放桌面'), '专注创作备注只写画一张图放桌面')
  assert.ok(html.includes('data-browse="stop"') && html.includes('停止'), '进行中可停止')
  assert.ok(!html.includes('让它自己挑时候去'), '平台页不再承担自主触发')
  assert.ok(html.includes('停止会关掉这个活动标签页') && html.includes('监听不受影响'), '停止只收活动标签页，不连坐监听')
  assert.ok(!html.includes('关掉设置页不影响它刷'), '默认没有定时任务：不再有「后台自动刷」的说明')
  assert.ok(!html.includes('switchHtml("autoWake.enabled"'), '平台页不再有独立自唤醒开关')
  assert.ok(html.includes('每类动作的频率上限') && html.includes('actionLimits'), '行为页有分类频率输入')
  assert.ok(html.includes('class="limit-rows"') && html.includes('class="limit-row"') && html.includes('class="limit-name"'), '三类动作各占一行，每行两个输入')
  assert.ok(html.includes('function browseStatusHtml(') && html.includes('/platforms/douyin/browse/stop'), '刷流状态与停止接口')
  assert.ok(html.includes('登录已过期，请重新扫码'), 'Cookie 失效要提醒重新扫码')
  assert.ok(!html.includes('data-preveal="douyinSettings"') && html.includes('class="pset-block"'), '详细设置拆成平铺分组，不再压一个大折叠')
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
  assert.ok(html.includes('}, 1000);'), '平台页每秒同步监听状态，关标签页后开关立刻跟上')
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
  assert.ok(html.includes('data-pset="comments.enabled"') && html.includes('/platforms/douyin/comments'), '回评论是开关，接真实标签页接口')
  assert.ok(html.includes('function paintComments(') && html.includes('function loadComments(') && html.includes('loadComments()'), '回评论开关跟随后端标签页状态')
  const tabGroupStart = html.indexOf('浏览器标签页')
  const actionsStart = html.indexOf('它可以在抖音做什么')
  const tabGroupHtml = html.slice(tabGroupStart, actionsStart)
  assert.ok(tabGroupStart > -1 && actionsStart > tabGroupStart &&
    tabGroupHtml.includes('switchHtml("browse.enabled"') &&
    tabGroupHtml.includes('switchHtml("listen.enabled"') &&
    tabGroupHtml.includes('switchHtml("comments.enabled"'), '三个标签页开关框在同一组')
  assert.ok(html.includes('class="tab-group" id="tabGroup"') && html.includes('.tab-group{'), '标签页开关有独立边框容器')
  assert.ok(html.includes('三个独立开关，各管一个标签页') && !html.includes('两个独立开关'), '文案按三个开关写')
  assert.ok(html.includes('helpTip("replyComments")') && !html.includes('data-preveal="replyHow"'), '回评论说明收进问号，不再单独占一个折叠')
  assert.ok(html.includes('回评论') && !html.includes('回评论（监听式，待接入）'), '回评论不再是死入口占位')
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
  assert.ok(html.includes('这里只给权限') && html.includes('也不负责自动触发'), '安全边界一句话说清：平台页只给权限，自动触发归行为调度')
  assert.ok(html.includes('id="stkGrid"') && html.includes('/stickers/import') && html.includes('/stickers/upload'), '表情包是功能不是开关：上传 + 从链接导入 + 网格')
  assert.ok(html.includes('标语义') && html.includes('/stickers/enrich') && html.includes('stkCaptionBar'), '表情包页有标语义按钮、说明问号和后台进度条')
  assert.ok(html.includes('stkCaptionStopBtn') && html.includes('stopStickerCaptioning'), '标的过程中有停止按钮，能中途停下')
  assert.ok(html.includes('method: "DELETE"'), '停止走 DELETE，不靠关闭页面')
  assert.ok(html.includes('stickerSemantics') && html.includes('为什么要标语义'), '标语义旁边有渐进式说明')
  assert.ok(html.includes('下载和上传新图都不会自动标'), '标语义必须明确说明不会自动跑，只能点按钮触发')
  assert.ok(html.includes('抖音、B站、QQ 共用一套'), '表情包跨平台共用一套')
  assert.ok(html.includes('data-tab="stickers"') && html.includes('TABS = ["home"'), '表情包是独立侧边栏页')
  assert.ok(html.includes('stkRemoteClear') && html.includes('/stickers/install/status'), '远程列表可收起，下载有进度轮询')
  assert.ok(html.includes('/platform/settings'), '设置走 GET/PUT 接口')
})

test('网页：存储页显示占用，清理弹窗给缓存、旧档案和自由创作旧稿三项', () => {
  assert.ok(html.includes('data-tab="storage"') && html.includes('storage: "存储"'), '存储是独立侧边栏页')
  assert.ok(html.includes('function renderStorage(') && html.includes('/storage'), '存储页要拉本机占用')
  assert.ok(html.includes('清理存储') && html.includes('data-stg-open'), '有清理存储入口')
  assert.ok(html.includes('id="storageOverlay"') && html.includes('id="storageChoices"'), '清理前有小弹窗')
  assert.ok(html.includes('清理可再生缓存') && html.includes('清理旧监听档案'), '弹窗保留原有两项')
  assert.ok(html.includes('清理自由创作的旧稿') && html.includes('id="stgFree"'), '弹窗要有第三项自由创作旧稿')
  assert.ok(html.includes('保留最近 15 张'), '第三项要说明保留策略')
  const storageCode = fs.readFileSync(path.resolve('src/storage/index.js'), 'utf8')
  assert.ok(storageCode.includes("label: '创意工作室'") && storageCode.includes("label: '自由创作 / 画画'") && storageCode.includes("label: '旧版创作残留'"), '存储分类要拆开')
  assert.ok(html.includes('/storage/cleanup') && html.includes('targets'), '清理动作走后端接口')
  assert.ok(!html.includes('清空 data') && !html.includes('删除全部'), '不提供危险的整目录删除')
  assert.ok(html.includes('登录态') && html.includes('形象原图'), '文案说清哪些不会动')
})

test('网页：形象库去掉重复说明，详情直接展开，缩略图切换主预览', () => {
  assert.ok(!html.includes('仓库只带缩略图'), '不再重复写仓库只带缩略图')
  assert.ok(!html.includes('管理本地原图') && !html.includes('<summary>形象详情'), '形象详情和本地原图都不再做下拉菜单')
  assert.ok(html.includes('<div class="char-detail">') && html.includes('char-detail-body'), '详情内容直接展开在页面里')
  const installed = html.slice(html.indexOf('if (pack.installed && pack.originalReady)'), html.indexOf('if (pack.installed && !pack.originalReady)'));
  assert.ok(!installed.includes('<details'), '已下载状态不把管理按钮藏进折叠区')
  assert.ok(installed.includes('data-char-action="install"') && installed.includes('data-char-action="remove"'), '重新下载和删除按钮直接放在外面')
  assert.ok(html.includes('<div class="card-head"><div class="num">形</div><div><h2>形象</h2></div>') &&
    html.includes('data-char-action="upload"') && html.includes('上传形象'), '页面不再叫初始形象，并给用户上传留入口')
  assert.ok(!html.includes('>初始<') && html.includes('>内置<') && !html.includes('仓库里的初始形象'), '内置图只标「内置」，上传后不会把其他图叫成初始形象')
  assert.ok(!html.includes('按需下载') && html.includes('会一起下载') && html.includes('下载全部 '), '整套下载不能写成按需下载')
  const grid = html.slice(html.indexOf('function paintCharGrid('), html.indexOf('function startCharacterPoll('));
  assert.ok(!grid.includes('data-char-zoom'), '点小缩略图只切换主预览，不直接弹大图')
  assert.ok(grid.includes('data-char-card'), '小缩略图仍然负责选中')
  const hero = html.slice(html.indexOf('function paintCharHero('), html.indexOf('function paintCharPack('));
  assert.ok(hero.includes('data-char-zoom'), '主预览点击后才打开大图')
  assert.ok(html.includes('id="charViewer"') && html.includes('function openCharViewer(') && html.includes('function closeCharViewer('), '大图弹层要有开关逻辑')
  assert.ok(html.includes('function zoomCharViewer(') && html.includes('addEventListener("wheel"') && html.includes('Math.min(5'), '大图弹层支持滚轮放大')
  assert.ok(!html.includes('id="charViewerNote"') && !html.includes('id="charViewerDone"') && !html.includes('char-viewer-foot') && !html.includes('服装细节'), '大图弹层不再放底部说明和重复关闭按钮')
  assert.ok(html.includes('function startCharViewerDrag(') && html.includes('pointerdown') && html.includes('setPointerCapture') && html.includes('charViewerDrag.left'), '放大后可以按住画面直接拖动查看四周')
  assert.ok(html.includes('addEventListener("dblclick", resetCharViewerZoom)'), '双击可以回到原大小')
  const remove = html.slice(html.indexOf('async function removeCharacterPack('), html.indexOf('async function copyCharacterFileName('));
  assert.ok(remove.includes('await confirmAction(') && !remove.includes('window.confirm('), '删除本机原图要用站内确认弹窗，不用浏览器原生 confirm')
})

test('网页：形象库本机上传靠近下载入口，不要求授权勾选', () => {
  for (const id of ['charUploadOverlay', 'charUploadFile', 'charUploadPreview', 'charUploadEntry', 'charUploadOutfit', 'charUploadOutfitCombo', 'charUploadOutfitMenu', 'charUploadOutfitToggle', 'charUploadSubmit']) {
    assert.ok(html.includes('id="' + id + '"'), `上传弹窗缺少 ${id}`)
  }
  const entryAt = html.indexOf('id="charUploadEntry"')
  const packAt = html.indexOf('<div id="charPack"></div>')
  assert.ok(entryAt > packAt && entryAt - packAt < 400, '上传入口要紧挨原图下载卡片，不能藏在页头右上角')
  assert.ok(html.slice(entryAt, entryAt + 260).includes('data-char-action="upload"'), '本机形象卡片里要有上传按钮')
  assert.ok(html.includes('accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"'), '文件选择要支持常见位图格式')
  assert.ok(html.includes('图片只保存在本机。'), '弹窗说明只保留本机保存这一句')
  assert.equal(html.includes('不会随插件分发'), false, '不要放换电脑/分发的备忘')
  assert.equal(html.includes('charUploadRights'), false, '上传不再要求授权勾选')
  assert.equal(html.includes('单张不超过 12MB'), false, '不再显示 12MB 限制')
  assert.ok(html.includes('role="combobox"') && html.includes('aria-controls="charUploadOutfitMenu"'), '造型分类是组合框，点开能看到已有分类')
  assert.ok(html.includes('function charOutfitLabels(') && html.includes('function paintCharOutfitMenu(') && html.includes('function chooseCharOutfit('), '造型分类下拉菜单有自己的展开/选中逻辑')
  assert.ok(html.includes('outfit.value = "本机上传"') && html.includes('input.value = label'), '默认本机上传，同时允许选中已有分类或直接改输入')
  assert.equal(html.includes('charUploadOutfitList'), false, '不用原生 datalist，避免点开不显示选项')
  assert.ok(html.includes('function charPackSide(') && html.includes('.char-pack-side{display:flex;flex-direction:column;align-items:flex-end'), '原图状态和操作按钮统一靠右，和上传卡保持同一视觉列')
  assert.ok(html.includes('function openCharUpload(') && html.includes('function submitCharacterUpload('), '上传弹窗与提交逻辑齐全')
  assert.ok(html.includes('function makeCharThumb(') && html.includes('canvas.width = 640') && html.includes('canvas.height = 360'), '上传前在浏览器生成 16:9 缩略图')
  assert.ok(html.includes('/characters/upload') && html.includes('/characters/delete'), '前端接上上传和删除接口')
  assert.ok(html.includes('outfitLabel:') && html.includes('sourceType === "local-upload"') && html.includes('本机'), '上传时把造型分类传给后端，并保留本机来源标记')
  const remove = html.slice(html.indexOf('async function removeCharacterUpload('), html.indexOf('/* ------------------------------------------------------------------ 存储页 */'));
  assert.ok(remove.includes('await confirmAction(') && !remove.includes('window.confirm('), '删除本机形象要用站内确认弹窗')
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

test('网页：创作依赖未装时按钮灰、安装依赖有进度条', () => {
  assert.ok(html.includes('btn primary is-locked'), '自动做图文初始应是灰色锁定态')
  assert.ok(html.includes('button.classList.toggle("is-locked"'), '权限变化要能切换锁定态')
  assert.ok(html.includes('aria-disabled'), '锁定态要保留可点击提示的语义')
  assert.ok(html.includes('data-cs-install-deps'), '插件安装后要有安装依赖入口')
  assert.ok(html.includes('安装依赖'), '入口文案用用户可以理解的「安装依赖」')
  assert.ok(html.includes('data-cs-detect-python') && html.includes('检测本机 Python'), 'Python 检测入口要从页面走')
  assert.ok(html.includes('会优先使用 DSH 自带的 Python'), '检测要说明优先使用 DSH 自带的 Python')
  assert.ok(fs.readFileSync(path.resolve('src/creative/renderer.js'), 'utf8').includes('DSH 自带 Python'), '检测逻辑要先扫描 DSH 自带 Python')
  const rendererCode = fs.readFileSync(path.resolve('src/creative/renderer.js'), 'utf8')
  assert.ok(rendererCode.includes('collectCondaPythonCandidates') && rendererCode.includes('collectVenvPythonCandidates'), '检测逻辑还要覆盖 Conda 和虚拟环境')
  assert.ok(html.includes('环境依赖') && !html.includes('创作环境'), '这一块叫「环境依赖」')
  assert.ok(!html.includes('蛋蛋创作工作室'), '插件名称不出现蛋蛋两个字')
  assert.ok(html.includes('cs-progress-bar') && html.includes('aria-valuenow'), '安装期间要有进度条')
  assert.ok(html.includes('当前作品'), '生成结果以「当前作品」展示')
  assert.ok(html.includes('id="csPublishCard"') && html.includes('id="csPublish"'), '自动发布要单独成卡，不再和自动做图文挤在一起')
  assert.ok(!html.includes('再做一张'), '当前作品不再需要单独的「再做一张」')
  assert.ok(!html.includes('这一轮只搭入口') && !html.includes('这一版先做图'), '页面不显示旧版能力说明')
  assert.ok(!html.includes('生成后会留在这里'), '页面不显示多余的常驻说明')
  assert.ok(!html.includes('Python 本体') && !html.includes('Pillow / tzdata'), '页面不暴露内部依赖包名')
  assert.ok(html.includes('cs-studio-card') && html.includes('安装与准备'), '插件安装和依赖准备用完整卡片呈现')
  assert.ok(!html.includes('csHeroStatus'), 'Hero 不再重复显示安装状态徽标')
  assert.ok(!html.includes('它负责把大肥鱼写好的内容排成图文卡'), '未安装卡片不再显示多余的说明句')
  assert.ok(html.includes('cs-env-path'), '环境依赖装好后要显示 Python 与依赖的位置')
  assert.ok(html.includes('不会删除你的插件目录、依赖目录或 Python'), '本地版卸载要保留插件目录、依赖目录和 Python')
  assert.ok(html.includes('会删除平台里的插件副本和同级的依赖目录'), 'GitHub 版卸载要删除平台插件副本和依赖目录')
  const api = fs.readFileSync(path.resolve('src/gui/api.js'), 'utf8')
  assert.ok(api.includes("'/creative-studio/prepare-runtime'"), '安装依赖要走后端接口')
  assert.ok(api.includes("'/creative-studio/detect-python'"), '检测 Python 要走后端接口')
  assert.ok(html.includes('FISH_DANDAN_CREATIVE_STUDIO_PIP_INDEX') || fs.readFileSync(path.resolve('src/creative/renderer.js'), 'utf8').includes('FISH_DANDAN_CREATIVE_STUDIO_PIP_INDEX'), '国内源要可配置')
})

test('网页：支持从 GitHub 安装创作工作室', () => {
  const api = fs.readFileSync(path.resolve('src/gui/api.js'), 'utf8')
  const studio = fs.readFileSync(path.resolve('src/creative/studio.js'), 'utf8')
  assert.ok(html.includes('data-cs-github-open') && html.includes('id="csGithubForm"'), '要有从 GitHub 安装的入口和表单')
  assert.ok(html.includes('id="csGithubRepo"') && html.includes('submitCreativeGithubInstall'), '仓库地址输入和提交逻辑要落地')
  assert.ok(html.includes('id="csGithubProgress"') && html.includes('pollCreativeGithubProgress'), '拉取期间要有进度条和状态刷新')
  assert.ok(html.includes('aria-valuenow'), '进度条要暴露当前进度')
  assert.ok(html.includes('cancelCreativeGithubInstall'), '取消按钮要真的能停掉拉取')
  assert.ok(api.includes("'/creative-studio/install-cancel'"), '取消要走后端接口')
  assert.ok(studio.includes('githubTransports') && studio.includes('http.proxy'), 'Git 拉取要按直连、系统代理、Git 代理依次探测')
  assert.ok(studio.includes('detectSystemProxy') && studio.includes('probeGithubTransport'), '系统代理和预探测要落地')
  assert.ok(studio.includes('GITHUB_STALLED') && studio.includes('GITHUB_NETWORK_UNREACHABLE'), '拉取卡住或全部不通要明确报错')
  assert.ok(studio.includes('cancelGithubInstall') && studio.includes('taskkill'), '取消要能结束 Git 子进程')
  assert.ok(studio.includes('removeTree(target)'), 'GitHub 版卸载要清掉 Git 只读文件的删除阻力')
  assert.ok(studio.includes('cleanupGithubInstallStages'), '启动和安装前要清理残留的临时目录')
  assert.ok(api.includes("res.on('close'") && api.includes('cancelIfClientGone'), '浏览器关闭时后端要取消拉取')
  assert.ok(html.includes('/creative-studio/install-github'), '安装请求走后端接口')
  assert.ok(api.includes("'/creative-studio/install-github'") && api.includes('installGithub'), '后端要有 GitHub 安装路由')
  assert.ok(studio.includes("source: 'github'") && studio.includes('managed: true'), 'GitHub 安装要记录为平台管理副本')
  assert.ok(html.includes('p.installSource === "github"') && html.includes('位置：'), 'GitHub 版安装后要像 Python/依赖一样显示插件位置')
  assert.ok(studio.includes("'--progress'") && studio.includes('parseGitCloneProgress'), 'Git 拉取要回传真实进度')
  assert.ok(studio.includes('githubInstallProgress') && studio.includes('progress: installingGithub'), '状态接口要带安装进度')
  assert.ok(studio.includes('https://github.com/swluo777/dandan-creative-studio.git'), '仓库地址要有默认值')
  assert.ok(!html.includes('即将支持'), 'GitHub 入口不再是即将支持')
})

test('网页：全自动发抖音是灰色占位开关', () => {
  assert.ok(html.includes('id="csFullyAuto" disabled'), '开关先禁用，功能还没接')
  assert.ok(html.includes('全自动发抖音'), '开关名字要写全，中间不要句号')
  assert.ok(!html.includes('全自动。发抖音'), '开关名字中间不要句号')
  assert.ok(html.includes('helpTip("fullAuto"'), '开关旁边要有问号')
  assert.ok(html.includes('暂未开放'), '灰色开关旁要说明暂未开放')
  assert.ok(html.includes('会根据他的心情和上面的发布配置，自动做图文或画画，然后自动发布。'), '问号里要写清楚它以后会做什么')
  const label = html.indexOf('全自动发抖音')
  const toggle = html.indexOf('id="csFullyAuto"')
  assert.ok(label < toggle, '功能名和问号放在开关左边')
  const runStatus = html.indexOf('id="csRunStatus"')
  const publishCard = html.indexOf('id="csPublishCard"')
  const autoRow = html.indexOf('class="cs-auto-row"')
  assert.ok(runStatus < publishCard && publishCard < autoRow, '全自动开关要放在独立发布卡里')
})

test('网页：自动发布卡有图文与画画参数', () => {
  assert.ok(html.includes('id="csPublishCard"'), '自动发布要单独成一个卡片')
  assert.ok(html.includes('id="csPublishImage" checked'), '图文默认勾选')
  assert.ok(html.includes('id="csPublishDrawing" disabled'), '画画暂不可选')
  assert.ok(html.includes('id="csDrawingCount"'), '画画要有张数参数')
  assert.ok(html.includes('min="1" max="10"') && html.includes('value="1"'), '画几张默认 1，最大 10')
  assert.ok(html.includes('画几张'), '参数文案要写「画几张」')
  assert.ok(html.includes('没有作品时会提示当前没有作品'), '图文要说明没有当前作品时的报错')
  assert.ok(html.includes('id="csPublish" type="button" aria-disabled="true" disabled'), '自动发布按钮先禁用')
  const work = html.indexOf('id="csLastResult"')
  const publishCard = html.indexOf('id="csPublishCard"')
  assert.ok(work < publishCard, '发布卡放在当前作品下面，先看作品再发')
})

test('网页：当前作品收进自动做图文卡并渐进披露', () => {
  const create = html.indexOf('id="csCreateCard"')
  const publish = html.indexOf('id="csPublishCard"')
  const createToPublish = html.slice(create, publish)
  assert.ok(create >= 0 && publish > create, '自动做图文卡与发布卡都要存在')
  assert.ok(createToPublish.includes('id="csWorkFold"'), '当前作品要收进自动做图文卡')
  assert.ok(createToPublish.includes('id="csLastResult"'), '作品内容要留在创作卡内的折叠区')
  assert.ok(html.includes('<details class="reveal sub cs-work-fold" id="csWorkFold"'), '复用统一样式的渐进披露组件')
  assert.ok(html.includes('<summary><span class="cs-work-fold-title">当前作品</span><span class="hint" id="csWorkHint">'), '折叠摘要显示当前作品')
  assert.ok(html.includes('S.creativeWorkOpen'), '展开状态要能保留')
})

test('网页：当前作品图片点击可放大', () => {
  assert.ok(html.includes('data-cs-work-zoom'), '当前作品图要带放大入口')
  assert.ok(html.includes('function openImageViewer('), '大图预览要复用现有浮层')
  assert.ok(html.includes('const workZoom = e.target.closest("[data-cs-work-zoom]")'), '点击图片要打开大图')
  assert.ok(html.includes('openImageViewer(img.currentSrc || img.src'), '大图要使用当前作品原图地址')
})

test('网页：自动发布按钮走完整图文发布接口', () => {
  assert.ok(html.includes('/creative-studio/publish-image-post'), '自动发布要走完整发布接口')
  assert.ok(html.includes('await req("/creative-studio/publish-image-post"'), '点击按钮要真正发请求')
  assert.ok(html.includes('publish.disabled = !publishReady'), '依赖就绪后自动发布按钮要能点')
  assert.ok(html.includes('S.creativePublishing'), '发布中要锁住按钮，避免重复点')
  assert.ok(html.includes('当前没有作品，先做一张图文'), '没有当前作品时先提示，不打开浏览器')
  assert.ok(html.includes('上传当前作品、填标题和描述、选推荐音乐'), '发布中要告诉用户浏览器在做什么')
})

test('网页：发布身份可改、当前作品显示插件输出目录', () => {  const api = fs.readFileSync(path.resolve('src/gui/api.js'), 'utf8')
  assert.ok(html.includes('data-cs-account-save') && html.includes('data-cs-account-avatar'), '发布身份要有保存昵称和换头像入口')
  assert.ok(html.includes('id="csAccountName"') && html.includes('id="csAvatarFile"'), '昵称输入和头像文件选择要落地')
  assert.ok(html.includes('placeholder="大肥鱼的抖音昵称"'), '昵称占位写项目名大肥鱼，实际默认值仍是蛋蛋')
  assert.ok(html.includes('function saveCreativeAccount(') && html.includes('function uploadCreativeAvatar('), '发布身份保存与头像上传要有前端逻辑')
  assert.ok(html.includes('宿主接口还没更新，重启 DSH 后再换头像'), '旧进程没加载新路由时，405 要提示重启而不是只报 HTTP 405')
  assert.ok(html.includes('const size = 512') && html.includes('toDataURL("image/png")'), '头像上传前在浏览器裁成方形 PNG')
  assert.ok(html.includes('/creative-studio/account-avatar'), '头像走后端接口读取和保存')
  assert.ok(api.includes("'/creative-studio/account'") && api.includes("'/creative-studio/account-avatar'"), '后端要有发布身份与头像接口')
  assert.ok(html.includes('data-cs-copy-output') && html.includes('作品目录'), '当前作品要显示插件输出目录并提供复制')
  assert.ok(html.includes('copyCreativeOutputDir') && html.includes('last.outputDir'), '复制的是宿主读到的插件输出目录')
  assert.ok(!html.includes('蛋蛋这次生成的图文'), '作品图 alt 不再写蛋蛋')
  assert.ok(html.includes('CREATIVE_VOICE_OFF'), '口吻不合格的错误要有用户能看懂的提示')
  const planner = fs.readFileSync(path.resolve('src/creative/planner.js'), 'utf8')
  assert.ok(planner.includes('speech?.styleNotes'), '提示词要带完整口吻规则')
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

