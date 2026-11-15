// 评论必须绑定到读到的那条视频：页面换了就拒绝，不能把上一段上下文发到新视频下面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { postComment, replyToComment, captureVideoFrames, readOwnerLikes, pickPanelEmojiCandidate, currentVideoId, CAPTCHA_JS } from '../src/platform/douyin/actions.js'

function pageAtVideo(id) {
  return {
    cmd: async (method, params) => {
      if (method !== 'Runtime.evaluate') throw new Error('页面已经换了就不该继续点')
      const expr = String((params && params.expression) || '')
      // currentVideoId 的表达式比 SNAPSHOT_JS 短，先认它。
      if (expr.includes('const m = (location.pathname') && !expr.includes('comments: items')) {
        return { result: { value: id } }
      }
      return { result: { value: null } }
    },
  }
}

test('面板表情：按名称/别名匹配，找不到就不点第一个', () => {
  const items = [
    { label: '微笑', x: 1, y: 1 },
    { label: '笑哭', x: 2, y: 2 },
    { label: '点赞', x: 3, y: 3 },
  ]
  assert.equal(pickPanelEmojiCandidate(items, '笑哭').label, '笑哭')
  assert.equal(pickPanelEmojiCandidate(items, '赞').label, '点赞')
  assert.equal(pickPanelEmojiCandidate(items, '不不不'), null)
  assert.equal(pickPanelEmojiCandidate([], '微笑'), null)
})

test('评论：页面已经翻到别的视频时拒绝发送', async () => {
  const r = await postComment(pageAtVideo('B'), '这条真有意思', { expectVideoId: 'A' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /不是要评论的那条/)
})

test('回复：页面已经翻到别的视频时拒绝发送', async () => {
  const r = await replyToComment(pageAtVideo('B'), { author: '路人', text: '怎么说？' }, '这样做的', { expectVideoId: 'A' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /视频已经换了/)
})

test('当前视频 id：视频详情页从 modal_id 取到，不再因为路径是 / 而返回空', async () => {
  const page = {
    cmd: async (method, params) => {
      if (method !== 'Runtime.evaluate') throw new Error('只该读页面')
      const expr = String((params && params.expression) || '')
      if (expr.includes('location.search') && expr.includes('modal_id')) return { result: { value: '7707691785736175481' } }
      return { result: { value: '' } }
    },
  }
  assert.equal(await currentVideoId(page), '7707691785736175481')
})

test('画面理解：截视频元素所在区域，返回可给多模态模型的帧', async () => {
  let shots = 0
  const page = {
    cmd: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, width: 300, height: 500 } } }
      }
      if (method === 'Page.captureScreenshot') {
        shots += 1
        assert.deepEqual(params.clip, { x: 10, y: 20, width: 300, height: 500, scale: 1 })
        return { data: `frame-${shots}` }
      }
      throw new Error(`不认识的命令：${method}`)
    },
  }
  const r = await captureVideoFrames(page, { count: 2, intervalMs: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.frames.length, 2)
  assert.deepEqual(r.frames.map((f) => f.data), ['frame-1', 'frame-2'])
  assert.equal(r.frames[0].mimeType, 'image/jpeg')
})

test('主人喜欢列表：链接不对直接拒绝；锁着只返回 locked，不读卡片', async () => {
  const bad = await readOwnerLikes({ cmd: async () => ({}) }, 'https://www.douyin.com/search/x')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /主页链接不对/)

  const page = {
    cmd: async (method, params) => {
      if (method === 'Page.navigate') return {}
      if (method === 'Input.dispatchMouseEvent') return {}
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '')
        if (expr.includes('document.body')) return { result: { value: '喜欢列表 已锁定' } }
        return { result: { value: { x: 10, y: 20, w: 80, h: 20 } } } // 「喜欢」页签
      }
      throw new Error(`不认识的命令：${method}`)
    },
  }
  const r = await readOwnerLikes(page, 'https://www.douyin.com/user/abc')
  assert.equal(r.ok, true)
  assert.equal(r.visibility, 'locked')
  assert.equal(r.items.length, 0)
})

test('评论图片：走评论框的隐藏上传入口，不再依赖 Ctrl+V 图片', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /DOM\.setFileInputFiles/, '评论图片必须塞进隐藏 file input')
  assert.match(src, /comment-input-inner-container input\[type="file"\]/, '只认评论输入框里的上传入口')
  assert.match(src, /panel\.querySelector\('img'\)/, '图片缩略图在输入容器里，不在 contenteditable 里')
  assert.doesNotMatch(src, /pasteImageToFocusedInput\(page, image/, '评论图片不能再走不可用的 Ctrl+V 路径')
})

test('评论发图：上传后等落盘再点发送，成功以评论列表新增为准', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /initial\.image\)[\s\S]{0,120}await sleep\(1500\)/, '图片缩略图出现后要等服务端收完再点发送')
  assert.match(src, /clickCommentSendButton/, '图片评论只点一次红色发送按钮，不能 Enter 后再补一次')
  assert.match(src, /imageCount/, '图片评论成功要能识别评论列表里新出现的图片')
  assert.match(src, /comments\.count > beforeComments\.count/, '不能只靠输入框是否清空来判断评论已发出')
  assert.match(src, /panelCount > beforeComments\.panelCount/, '真实详情页没有 comment-item 时，用「全部评论(n)」计数确认新增')
})

test('发送遇到验证码：停在当前页等用户处理，不把输入框消失当成发送成功', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /waitForCaptcha/, '发送后必须先识别验证码')
  assert.match(src, /出现验证码，停在当前页面等你处理/, '验证码要等用户，不能直接关详情回推荐')
  assert.match(src, /等待验证码超时，这条评论没有发出去/, '超时才允许失败收尾')
  assert.match(src, /验证码已经解决，但输入框里还有字/, '验证码过了要补一次发送')
})

test('回复支持三种形态：表情包图片 / 文字+面板表情 / 纯文字', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /const wantsText = Boolean\(String\(text \|\| ''\)\.trim\(\)\)/, '纯表情包回复没有文字时要跳过 fillEditor')
  assert.match(src, /addEmoji\(page, emoji/, '文字回复要能插抖音面板表情')
  assert.match(src, /uploadImageToComment\(page, image\)/, '表情包回复要能传本地图片')
  assert.doesNotMatch(src, /fallbackText|改发文字/, '模型/图片失败不能再用固定句或文字保底')
})

test('评论输入/发送：只点有字区域，不按最右侧盲点图片按钮', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /commentTextPoint/, '输入框点击要单独算文字区域坐标')
  assert.match(src, /iconLefts\.length[\s\S]{0,80}Math\.min\(\.\.\.iconLefts\) - 16/, '点击点必须限制在右侧图标左边')
  assert.doesNotMatch(src, /icons\[1\]\.x/, '不能按固定第二个图标当表情按钮')
  assert.doesNotMatch(src, /cands\.sort\(\(a, b\) => b\.l - a\.l\)/, '发送按钮不能按最右侧小元素盲点')
  assert.match(src, /const isSend = /, '发送按钮要按「发送/发布/评论」语义找')
  assert.match(src, /发送按钮不能按“最右侧小图标”盲点|绝不按“最右侧小图标”盲点/, '代码要说明为什么不能盲点')
})

test('验证码识别脚本本身能编译执行', () => {
  assert.doesNotThrow(() => new Function(`return ${CAPTCHA_JS}`))
})

test('评论艾特：只点头像卡，并且点完必须看到 mention 实体才算成功', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /t !== target/, '名字必须完全匹配，不能点到「思维读书」这类相近的人')
  assert.match(src, /douyin_mention_word/, '点完要校验抖音的 mention 实体，不能只信点击返回')
  assert.doesNotMatch(src, /out\.sort\(\(a, b\) => a\.h - b\.h\)/, '不能按最小高度选到卡片里的名字小字')
  assert.match(src, /r\.width >= 100 && r\.height >= 16/, '几像素宽的隐藏残留面板不能算评论区已打开')
  assert.match(src, /r\.top > ref\.bottom \+ 500/, '@ 下拉可能在输入框下方，不能只认上方候选')
  assert.match(src, /ambiguous: true/, '多个同名头像时必须拒绝，不能猜一个点')
  assert.match(src, /cards\.length > 1/, '嵌套节点先合并，再判断是否存在多个同名候选')
})

test('回复：真实详情页没有 comment-item 时，也能靠「全部评论 / 回复」认面板并确认回复态', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /全部评论/, '真实详情页要用「全部评论」标题认评论区')
  assert.match(src, /回复中/, '点完要认「回复中」或引用条，不能盲目往输入框塞字')
  assert.match(src, /点了「回复」但没进入回复状态/, '点完没进入回复态要明确失败')
})

test('评论入口：面板收起时点当前视频最右侧的评论图标，不点背景 feed 的图标', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /cands\.sort\(\(a, b\) => b\.left - a\.left\)/, '推荐流背景卡片也有评论图标，必须取最右侧那个')
  assert.match(src, /r\.left < 0 \|\| r\.left >= window\.innerWidth/, '离屏的评论图标不能参与点击')
  assert.match(src, /for \(let i = 0; i < 8; i\+\+\) \{[\s\S]{0,120}await sleep\(500\)/, '评论面板有动画，不能只等 900ms 就判失败')
})

test('回复按钮：目标在面板底部时先滚到中间并做命中测试，不能被输入区挡住还盲点', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /btn\.scrollIntoView\(\{ block: 'center'/, '目标回复按钮可能被输入区挡住，先滚到面板中间')
  assert.match(src, /clickable === false/, '命中测试失败时不能继续点击')
  assert.match(src, /被输入区或浮层挡住/, '被遮挡要给出明确失败原因')
})

