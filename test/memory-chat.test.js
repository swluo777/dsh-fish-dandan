import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemory } from '../src/memory/index.js'
import { createMemorySearchTool } from '../src/memory/chat-tool.js'
import { silentLogger, testConfig, tmpDir } from './helpers.js'

test('主对话记忆工具：查喜欢列表时带回主人最近和模型观察', async () => {
  const dir = tmpDir('memory-chat')
  const config = testConfig(dir)
  const memory = createMemory({ config, logger: silentLogger() })
  memory.recordEvent({
    content: '主人最近在抖音新喜欢了 12 个视频：梧桐大道、青花瓷、手势舞。',
    person: '主人',
    tags: ['主人', '喜欢'],
    importance: 4,
  }, 'test')
  memory.recordEvent({
    content: '翻了翻老蛋蛋的喜欢，一堆穿裙子的小姐姐，还有梧桐大道、青花瓷、手势舞。',
    tags: ['抖音', '值班', '自己'],
    importance: 5,
  }, 'test')
  memory.recordEvent({
    content: '主人的抖音喜欢列表现在是锁着的。',
    person: '主人',
    tags: ['主人', '喜欢', '隐私'],
    importance: 2,
  }, 'test')

  const tool = createMemorySearchTool(memory)
  const result = await tool.execute({ query: '喜欢列表' })
  assert.equal(result.ok, true)
  assert.match(result.ownerLatest.content, /12 个视频/)
  assert.ok(result.memories.some((m) => m.content.includes('翻了翻老蛋蛋的喜欢')), '模型自己的观察也要能查到')
  assert.ok(!result.memories.some((m) => m.content.includes('锁着')), '隐私状态不混进普通检索')
  assert.ok(result.hint.includes('不要编'))
  memory.close()
})
