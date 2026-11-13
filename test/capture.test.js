// 对话自动进记忆的闸门：只记值得长期记住的话，且绝不误把工具输出当用户的话
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCapture, extractUserText, CAPTURE_SIGNALS, CAPTURE_EXCLUDES } from '../src/memory/capture.js'

test('值得长期记住的话会放行，并给出重要度', () => {
  for (const text of [
    '记住，我喝咖啡不加糖，这个别忘了我说过好多次',
    '我们约定好每周六晚上一起看电影，说好了不许放我鸽子',
    '我叫小林，以后叫我阿林就好啦，别叫全名',
    '我特别喜欢下雨天在窗边发呆，讨厌别人突然催我',
    '今天是我们第一次一起把项目跑起来，值得记一下',
  ]) {
    const r = shouldCapture(text)
    assert.equal(r.ok, true, `应放行：${text}`)
    assert.ok(r.importance >= 6 && r.importance <= 8)
  }
})

test('转述 / 假设 / 未兑现打算 / 客套 / 代码块一律不写', () => {
  for (const text of [
    '他说他喜欢下雨天，我只是转述一下啦',
    '假如我们以后养一只猫，你记得买猫粮哦',
    '我打算明天去把那个东西整理一下，可能会用到',
    '好的，收到，谢谢你的提醒呀',
    '嗯。',
    '```js\n记住这个变量\n```',
    '现在正在写这段代码，记住别打断我',
  ]) {
    assert.equal(shouldCapture(text).ok, false, `不应放行：${text}`)
  }
})

test('长度与每日配额是硬闸', () => {
  assert.equal(shouldCapture('记住').ok, false)
  assert.equal(shouldCapture('记住' + '啊'.repeat(400)).ok, false)
  assert.equal(shouldCapture('记住我喜欢下雨天，别忘了我说过', { quotaLeft: 0 }).reason, '今日配额已用完')
  assert.equal(shouldCapture('【记忆摘要】叫我老大').ok, false)
  assert.equal(shouldCapture('   ').ok, false)
  assert.ok(CAPTURE_SIGNALS.length >= 5 && CAPTURE_EXCLUDES.length >= 5)
})

test('extractUserText 认得常见的宿主 payload 形状', () => {
  const cases = [
    ['直接字符串', '你好呀', '你好呀'],
    ['userMessage', { userMessage: '记住我喜欢茶' }, '记住我喜欢茶'],
    ['message.content', { message: { content: '帮我记一下' } }, '帮我记一下'],
    ['input.text', { input: { text: '约定好了' } }, '约定好了'],
    ['多模态 content 数组', { message: { content: [{ type: 'text', text: '我叫小林' }, { type: 'image' }] } }, '我叫小林'],
    ['messages 最后一条', { messages: [{ content: '旧的' }, { content: '新的' }] }, '新的'],
  ]
  for (const [name, payload, expected] of cases) {
    assert.equal(extractUserText(payload), expected, name)
  }
})

test('extractUserText 对未知结构静默跳过，不猜测', () => {
  for (const bad of [null, undefined, 42, {}, { foo: 'bar' }, { message: { content: 123 } }, { toolOutput: '记住这段' }]) {
    assert.equal(extractUserText(bad), '', `应返回空：${JSON.stringify(bad)}`)
  }
  // 明确标记为助手/系统的消息不能当成用户的话
  assert.equal(extractUserText({ content: { role: 'assistant', content: '记住我' } }), '')
})
