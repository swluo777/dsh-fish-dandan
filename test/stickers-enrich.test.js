import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStickerCaptioner } from '../src/stickers/enrich.js'

// 图义默认 logger 是 console；Node 22 的 test runner 在隔离子进程里会把
// 普通 stdout 日志当成 IPC 消息解析，触发 “Unable to deserialize cloned data”。
// 测试里不需要这些调试日志，统一静音。
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function tempPng() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-caption-'))
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return file
}

function fakeAttachments() {
  return {
    async saveImage(input) {
      assert.ok(input.data instanceof Uint8Array || Buffer.isBuffer(input.data), '要把图片字节交给附件服务')
      assert.equal(input.mediaType, 'image/png')
      return { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1, name: input.name }
    },
  }
}

test('图义标注：先把图片交给附件服务，再以 image 引用送进多模态模型', async () => {
  const file = tempPng()
  let sawImage = false
  let sawRequest = null
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }] } }
    },
    async *stream(req) {
      sawRequest = req
      const content = req.messages[0].content
      sawImage = content.some((part) => part.type === 'image'
        && part.attachment?.attachmentId === 'sha256:test'
        && !part.data
        && !part.mimeType)
      yield { type: 'text-delta', text: '```json\n' }
      yield { type: 'text-delta', text: '{"caption":"在的，收到","emotion":["友好"],"intents":["greeting"],"avoid":["serious"],"confidence":0.88}' }
      yield { type: 'text-delta', text: '\n```' }
    },
  }
  const captioner = createStickerCaptioner({ logger: quiet,
    llm,
    attachments: fakeAttachments(),
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  const controller = new AbortController()
  const meta = await captioner({ id: 'x', file, ext: 'png' }, { signal: controller.signal })
  assert.equal(sawImage, true, '必须用 DSH 的 ImageBlock，也就是 {type:image, attachment}，不能直接塞 data/mimeType')
  assert.equal(sawRequest.reasoningEffort, 'off', '模型声明支持 off 时，图义调用要关闭思考')
  assert.ok(sawRequest.maxTokens >= 900, '输出预算要够写完一句 JSON')
  assert.equal(sawRequest.signal, controller.signal, '停止信号要传进模型调用')
  assert.equal(meta.caption, '在的，收到')
  assert.deepEqual(meta.emotion, ['友好'])
  assert.deepEqual(meta.intents, ['greeting'])
  assert.equal(meta.confidence, 0.88)
})

test('图义标注：路由只给 low/high 时选最低档，不硬写 off', async () => {
  const file = tempPng()
  let sawRequest = null
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
    },
    async *stream(req) {
      sawRequest = req
      yield { type: 'text-delta', text: '{"caption":"点头同意","emotion":["认同"],"intents":["agree"]}' }
    },
  }
  const captioner = createStickerCaptioner({ logger: quiet,
    llm,
    attachments: fakeAttachments(),
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  await captioner({ id: 'x', file, ext: 'png' })
  assert.equal(sawRequest.reasoningEffort, 'low')
  assert.ok(sawRequest.maxTokens >= 2400, '有思考时要留够正文预算')
})

test('图义标注：路由没有思考档位时不传 reasoningEffort', async () => {
  const file = tempPng()
  let sawRequest = null
  const llm = {
    async resolveModelInfo() {
      return { reasoning: false }
    },
    async *stream(req) {
      sawRequest = req
      yield { type: 'text-delta', text: '{"caption":"收到","emotion":["友好"],"intents":["greeting"]}' }
    },
  }
  const captioner = createStickerCaptioner({ logger: quiet,
    llm,
    attachments: fakeAttachments(),
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  await captioner({ id: 'x', file, ext: 'png' })
  assert.equal('reasoningEffort' in sawRequest, false)
  assert.ok(sawRequest.maxTokens >= 6000)
})

test('图义标注：没有附件服务时明确失败，不伪造成功', async () => {
  const file = tempPng()
  const captioner = createStickerCaptioner({ logger: quiet,
    llm: { async *stream() { yield { type: 'text-delta', text: '{"caption":"x"}' } } },
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  await assert.rejects(() => captioner({ id: 'x', file, ext: 'png' }), /没有可用的图片附件服务/)
})

test('图义标注：模型没给 JSON 时明确失败，不写空 caption', async () => {
  const file = tempPng()
  const llm = {
    async resolveModelInfo() { return null },
    async *stream() {
      yield { type: 'text-delta', text: '这张图挺可爱的' }
      yield { type: 'finish', reason: 'length' }
    },
  }
  const captioner = createStickerCaptioner({ logger: quiet,
    llm,
    attachments: fakeAttachments(),
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  await assert.rejects(() => captioner({ id: 'x', file, ext: 'png' }), /JSON.*length/)
})

test('图义标注：结束帧用 reason.failure 包住真实原因时也要透出来', async () => {
  const file = tempPng()
  const llm = {
    async resolveModelInfo() { return null },
    async *stream() {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: '当前模型不支持 off 档' },
        },
      }
    },
  }
  const captioner = createStickerCaptioner({ logger: quiet,
    llm,
    attachments: fakeAttachments(),
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  await assert.rejects(
    () => captioner({ id: 'x', file, ext: 'png' }),
    /模型调用失败（UNSUPPORTED_REASONING_EFFORT）：当前模型不支持 off 档/,
  )
})

test('图义标注：stream 直接抛错时也给出真实原因，不变成空 JSON', async () => {
  const file = tempPng()
  const llm = {
    async resolveModelInfo() { return null },
    async *stream() {
      const err = new Error('请求被宿主拒绝：图片输入不可用')
      err.code = 'UNSUPPORTED_INPUT_MODALITY'
      throw err
    },
  }
  const captioner = createStickerCaptioner({ logger: quiet,
    llm,
    attachments: fakeAttachments(),
    defaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) },
  })
  await assert.rejects(() => captioner({ id: 'x', file, ext: 'png' }), /图片输入不可用/)
})
