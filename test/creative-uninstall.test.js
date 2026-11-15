import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCreativeRenderer } from '../src/creative/renderer.js'
import { removeTree } from '../src/creative/remove-tree.js'

const logger = { info() {}, warn() {}, error() {} }

function makePlugin(base, name, withRuntime = true, { readOnly = false } = {}) {
  const root = path.join(base, name)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), 'preview')
  const runtime = path.join(base, `${name}-runtime`)
  if (withRuntime) {
    fs.mkdirSync(runtime, { recursive: true })
    const marker = path.join(runtime, 'marker.txt')
    fs.writeFileSync(marker, 'runtime')
    if (readOnly) fs.chmodSync(marker, 0o444)
  }
  return { root, runtime }
}

test('卸载：本地版保留插件目录、依赖目录和本机 Python', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-uninstall-local-'))
  try {
    const { root, runtime } = makePlugin(base, 'dandan-creative-studio')
    const renderer = createCreativeRenderer({ logger })
    assert.equal(
      renderer.removeRuntime({ root, installSource: 'local', managed: false }),
      false,
      '本地版卸载不应清理依赖目录'
    )
    assert.equal(fs.existsSync(root), true, '本地插件目录必须保留')
    assert.equal(fs.existsSync(runtime), true, '本地依赖目录必须保留')
  } finally {
    removeTree(base)
  }
})

test('卸载：GitHub 版删除同级依赖目录，但不碰本机 Python 和插件源目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-uninstall-github-'))
  try {
    const { root, runtime } = makePlugin(base, 'dandan-creative-studio', true, { readOnly: true })
    const renderer = createCreativeRenderer({ logger })
    assert.equal(
      renderer.removeRuntime({ root, installSource: 'github', managed: true }),
      true,
      'GitHub 版卸载应清理带只读文件的同级依赖目录'
    )
    assert.equal(fs.existsSync(runtime), false, '同级依赖目录应被删除')
    assert.equal(fs.existsSync(root), true, '本函数只清理依赖，插件目录由卸载流程单独删除')
  } finally {
    removeTree(base)
  }
})

test('删除：递归清掉只读的 Git pack 文件后再删除目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-remove-ro-'))
  try {
    const packDir = path.join(base, '.git', 'objects', 'pack')
    fs.mkdirSync(packDir, { recursive: true })
    const pack = path.join(packDir, 'pack-test.pack')
    fs.writeFileSync(pack, 'readonly-pack')
    fs.chmodSync(pack, 0o444)
    assert.equal(removeTree(base), true)
    assert.equal(fs.existsSync(base), false, '只读 pack 不应阻止目录删除')
  } finally {
    removeTree(base)
  }
})
