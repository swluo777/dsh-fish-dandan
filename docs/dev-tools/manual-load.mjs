// 手动加载插件：验证模块可导入、apply 可执行、各注册点齐全
// 使用临时数据目录，不会污染真实 data/
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-dandan-manual-'))
const calls = { sections: [], contexts: [], routes: [], events: [], effects: [] }

const childCtx = {
  systemPrompt: {
    section: (spec) => { calls.sections.push(spec); return () => {} },
    context: (spec) => { calls.contexts.push(spec); return () => {} },
  },
  webServer: {
    register: (route) => { calls.routes.push(route); return () => {} },
  },
}

const fakeCtx = {
  on: (event) => { calls.events.push(event) },
  inject: (deps, callback) => { callback(childCtx) },
  effect: (fn, label) => { calls.effects.push(label); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
}

try {
  // 用本文件位置反推仓库根，不写死任何机器的绝对路径
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.js')
  const mod = await import(pathToFileURL(entry).href)
  console.log('模块导入成功，导出项:', Object.keys(mod))
  console.log('name:', mod.name, '| apply 类型:', typeof mod.apply)

  mod.apply(fakeCtx, {
    persona: {
      corePath: path.join(dir, 'persona', 'core.json'),
      auditPath: path.join(dir, 'persona', 'audit.jsonl'),
    },
    memory: { dbPath: path.join(dir, 'memory', 'memory.db'), jsonlPath: path.join(dir, 'memory', 'memory.jsonl') },
    decision: { statePath: path.join(dir, 'state', 'decision.json'), schedulerPath: path.join(dir, 'state', 'scheduler.json') },
  })

  console.log('人格段落:', calls.sections.map((s) => `${s.name}@${s.order}`).join(', ') || '（无）')
  console.log('记忆上下文:', calls.contexts.map((s) => `${s.name}@${s.order}`).join(', ') || '（无）')
  console.log('GUI 路由:', calls.routes.length, '条')
  console.log('事件监听:', calls.events.join(', ') || '（无）')
  console.log('effect:', calls.effects.join(' | '))
  console.log('临时数据目录:', dir)
} catch (err) {
  console.error('加载失败:', err)
  process.exit(1)
}
