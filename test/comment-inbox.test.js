// 通知入口：点进视频后页面跳走时不能再按旧坐标补点；关详情不能退到 about:blank。
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeNotificationVideo, ensureRecommendPage, openNotificationVideo } from '../src/platform/douyin/comment-inbox.js'

/**
 * 极简 CDP 假页：只回答 comment-inbox 用到的表达式。
 * mode:
 *   - 'video': 第一次点击就进入视频详情（URL 变成 /video/123）
 *   - 'slow-video': URL 已经变成详情，但详情 DOM 要晚几次轮询才挂出来
 *   - 'blank': 第一次点击跳到 about:blank，但没有视频详情
 */
function fakePage(mode) {
  let url = 'https://www.douyin.com/'
  let pressed = 0
  let detailChecks = 0
  const navigations = []
  const page = {
    cmd: async (method, params = {}) => {
      if (method === 'Page.navigate') {
        navigations.push(params.url)
        url = params.url
        return {}
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') {
          pressed += 1
          if (mode === 'video') url = 'https://www.douyin.com/video/123'
          if (mode === 'slow-video') url = 'https://www.douyin.com/video/123'
          if (mode === 'blank') url = 'about:blank'
        }
        return {}
      }
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params.expression || '')
      if (expression === 'location.href') return { result: { value: url } }
      if (expression.includes('comment-input-inner-container') && expression.includes('videoId')) {
        detailChecks += 1
        const slow = mode === 'slow-video' && detailChecks < 2
        const video = slow ? null : /\/video\/(\d+)/.exec(url)
        return { result: { value: { videoId: video ? video[1] : '', panel: false, url } } }
      }
      if (expression.includes('互动消息')) {
        // 通知浮层是否还在：视频详情/空白页都没有。
        return { result: { value: null } }
      }
      if (expression.includes('关闭|close')) return { result: { value: null } }
      return { result: { value: null } }
    },
  }
  return {
    page,
    url: () => url,
    pressed: () => pressed,
    navigations,
  }
}

test('点进视频：URL 已经变成视频详情后，不再按旧通知坐标补点', async () => {
  const fake = fakePage('video')
  const item = {
    click: { x: 1000, y: 200 },
    row: { x: 930, y: 160, width: 300, height: 140 },
  }
  const opened = await openNotificationVideo(fake.page, item)
  assert.equal(opened.ok, true)
  assert.equal(opened.videoId, '123')
  assert.equal(fake.pressed(), 1, '第一下已经进了视频，绝不能补第二下')
})

test('点进视频：URL 先变、详情 DOM 后挂出来时，等一小段再认，不要马上放弃', async () => {
  const fake = fakePage('slow-video')
  const item = {
    click: { x: 1000, y: 200 },
    row: { x: 930, y: 160, width: 300, height: 140 },
  }
  const opened = await openNotificationVideo(fake.page, item)
  assert.equal(opened.ok, true)
  assert.equal(opened.videoId, '123')
  assert.equal(opened.late, true)
  assert.equal(fake.pressed(), 1, '详情晚挂出来也不能补点第二下')
})

test('点进视频：页面跳走但没认出详情时也停止补点，不点新页面上的旧坐标', async () => {
  const fake = fakePage('blank')
  const item = {
    click: { x: 1000, y: 200 },
    row: { x: 930, y: 160, width: 300, height: 140 },
  }
  const opened = await openNotificationVideo(fake.page, item)
  assert.equal(opened.ok, false)
  assert.match(opened.reason, /页面跳走了/)
  assert.equal(fake.pressed(), 1, '页面已经跳走，不能再按旧坐标补第二下')
})

test('关视频详情：没有明确关闭键时回推荐首页，不两次 history.back 到空白页', async () => {
  const fake = fakePage('video')
  await fake.page.cmd('Page.navigate', { url: 'https://www.douyin.com/video/123' })
  assert.equal(fake.url(), 'https://www.douyin.com/video/123')
  fake.navigations.length = 0
  const closed = await closeNotificationVideo(fake.page)
  assert.equal(closed.ok, true)
  assert.equal(fake.url(), 'https://www.douyin.com/')
  assert.deepEqual(fake.navigations, ['https://www.douyin.com/'], '只导航一次，且目标是推荐首页')
})

test('页面已经变成 about:blank 时，直接拉回推荐首页', async () => {
  const fake = fakePage('blank')
  await fake.page.cmd('Page.navigate', { url: 'about:blank' })
  const home = await ensureRecommendPage(fake.page)
  assert.equal(home.ok, true)
  assert.equal(home.url, 'https://www.douyin.com/')
})

test('根路径带 modal_id 仍是视频详情，关详情必须真的导航回推荐首页', async () => {
  const fake = fakePage('video')
  await fake.page.cmd('Page.navigate', { url: 'https://www.douyin.com/?modal_id=7707691785736175481&recommend=1' })
  fake.navigations.length = 0
  const home = await ensureRecommendPage(fake.page)
  assert.equal(home.ok, true)
  assert.equal(home.navigated, true, '不能把 ?modal_id=... 当成推荐首页而不导航')
  assert.deepEqual(fake.navigations, ['https://www.douyin.com/'])
})
