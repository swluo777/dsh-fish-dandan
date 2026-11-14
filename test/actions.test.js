// 评论必须绑定到读到的那条视频：页面换了就拒绝，不能把上一段上下文发到新视频下面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { postComment, replyToComment, captureVideoFrames, readOwnerLikes, pickPanelEmojiCandidate } from '../src/platform/douyin/actions.js'

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
  assert.match(src, /afterEnter\.count > beforeComments\.count/, '不能只靠输入框是否清空来判断评论已发出')
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


