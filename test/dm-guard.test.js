// 主动私信守卫：监听只被动收信，值班主动私信必须限频
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('值班脚本关闭视频页私信作者，主动私信有硬频控', () => {
  const src = read('../src/platform/douyin/duty-server.mjs')
  assert.match(src, /视频页私信作者已关闭/, 'douyin_say 的 dm 分支必须拒绝')
  assert.match(src, /dmGate\(/, '主动私信必须过频控门')
  assert.match(src, /DM_COOLDOWN_MS/, '必须有两次私信的最小间隔')
  assert.match(src, /DM_MAX_PER_HOUR/, '必须有每小时上限')
})

test('艾特主人评论必须先读当前视频的长期记忆，普通评论/回复不受影响', () => {
  const src = read('../src/platform/douyin/duty-server.mjs')
  assert.match(src, /douyin_owner_memory/, '必须有艾特主人记忆工具')
  assert.match(src, /ownerMemoryFor/, '必须有读取凭据')
  assert.match(src, /先调 douyin_owner_memory/, '没读记忆要拒发')
  assert.match(src, /kind === 'comment'[^\n]*mentionOwnerOn\(\)/, '门只挂在艾特主人评论上')
})

test('监听器没有主动浏览/发私信入口，只保留被动回复', () => {
  const src = read('../src/platform/douyin/listener.js')
  assert.doesNotMatch(src, /sendDm\s*\(/, '监听器不能主动私信')
  assert.doesNotMatch(src, /openRecommend|readSnapshot|postComment/, '监听器不能刷视频/评论')
  assert.match(src, /replyTo\(/, '监听器只通过收件箱被动回复')
})

test('值班脚本不读监听队列，只通过主动私信出口发消息', () => {
  const src = read('../src/platform/douyin/duty-server.mjs')
  assert.doesNotMatch(src, /loadInboxState|pollInboxOnce|douyin-inbox/, '值班不能碰监听队列')
  assert.match(src, /replyTo\(/, '主动私信复用收件箱发送口')
})

test('提示词要求低频主动私信，禁止刷一个人发一条', () => {
  const prompt = read('../prompts/douyin-duty.md')
  assert.match(prompt, /工具会硬限频/)
  assert.match(prompt, /不要刷到一个人就发一条/)
})

test('表达层有统一回退顺序：自定义图 -> 面板表情 -> 文字', () => {
  const src = read('../src/platform/douyin/duty-server.mjs')
  assert.match(src, /pickStickerCandidate/, '候选门槛必须走统一函数')
  assert.match(src, /panelEmojiForText/, '自定义图失败要能退回面板表情')
  assert.match(src, /sendStickerInThread/, '主动私信要能在同一次里补图')
  assert.match(src, /stickerFallback/, '匹配失败要返回回退信息，不能直接当终态')
  const prompt = read('../prompts/douyin-duty.md')
  assert.match(prompt, /自定义表情包 → 抖音面板表情 → 文字/)
  assert.match(prompt, /recommendedId/)
})
