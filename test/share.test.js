// 分享给主人：先悬停出面板，再精确点主人行的「分享」；不退回第一个联系人。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { forwardToOwner } from '../src/platform/douyin/actions.js'

test('分享给主人：悬停分享图标，按设置里的主人昵称找人，点主人右侧的分享按钮并确认面板收起', async () => {
  const configuredOwner = '阿甲不吃鱼'
  let panelOpen = true
  let pressed = 0
  const page = {
    cmd: async (method, params = {}) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') { pressed += 1; panelOpen = false }
        return {}
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '')
        if (expr.includes('const target = String(')) {
          return { result: { value: { ok: true, x: 300, y: 400, name: configuredOwner } } }
        }
        if (expr.includes('const sels = ')) {
          return { result: { value: { x: 434, y: 677 } } }
        }
        if (expr.includes('分享给朋友')) {
          return { result: { value: { ok: panelOpen } } }
        }
        if (expr.includes('分享成功')) return { result: { value: false } }
      }
      throw new Error(`不认识的命令：${method}`)
    },
  }
  const r = await forwardToOwner(page, configuredOwner)
  assert.equal(r.ok, true)
  assert.equal(r.to, configuredOwner, '分享对象必须跟随设置里的主人昵称，不能写死')
  assert.equal(pressed, 1, '只点主人行的分享按钮一次，没有点分享图标')
})

test('分享给主人：源码只保留精确实现，不恢复随机转发和全局发送按钮', async () => {
  const src = await readFile(new URL('../src/platform/douyin/actions.js', import.meta.url), 'utf8')
  assert.match(src, /export async function forwardToOwner/, '要有精确找主人的页面动作')
  assert.doesNotMatch(src, /forwardToAny/, '旧的随机挑人实现要移除')
  assert.doesNotMatch(src, /share-send/, '不能依赖旧的全局发送按钮')
  assert.match(src, /mouseHover/, '分享入口必须悬停，不能直接点击')
  assert.match(src, /主人不在最近联系人里/, '找不到主人不能退回第一个联系人')
  assert.doesNotMatch(src, /class\*="share"/, '真实面板类名是随机的，不能靠 class*=share 找面板')
  assert.match(src, /return \{ ok: Boolean\(panel\) \}/, '面板状态必须是 {ok} 对象，不能直接返回布尔值')
  assert.doesNotMatch(src, /思维_|23003690/, '分享动作不能写死某个主人昵称或抖音号，必须用设置传入')
})

test('值班服务端：分享工具固定主人、每次一条、带文字先读记忆、部分成功要如实返回', async () => {
  const server = await readFile(new URL('../src/platform/douyin/duty-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /douyin_share_to_owner/, '要注册分享工具')
  assert.match(server, /const OWNER = String\(LISTEN\.ownerName/, '主人昵称必须来自设置里的 listen.ownerName')
  assert.match(server, /counts\.forward >= 1/, '第二次分享必须被拒')
  assert.match(server, /ownerMemoryFor[\s\S]{0,180}OWNER_MEMORY_TTL_MS/, '带文字必须绑定当前视频且 5 分钟内读过记忆')
  assert.match(server, /replyTo\(p, OWNER, out\.text\)/, '卡片成功后走主人私信补一句')
  assert.match(server, /partial: !textSent/, '卡片成功文字失败要返回部分成功')
  assert.match(server, /target: OWNER/, '目标固定主人')
})
