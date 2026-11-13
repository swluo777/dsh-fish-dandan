// Windows 文件占用重试：确保临时占用会自动退避，非占用错误不会被吞掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isFsBusy, removeDirectory, retryFs } from '../src/utils/fs-retry.js'
import { tmpDir } from './helpers.js'

test('文件重试：EPERM 是占用错误，普通错误不标成占用', () => {
  assert.equal(isFsBusy(Object.assign(new Error('busy'), { code: 'EPERM' })), true)
  assert.equal(isFsBusy(Object.assign(new Error('empty'), { code: 'ENOTEMPTY' })), true)
  assert.equal(isFsBusy(Object.assign(new Error('bad'), { code: 'ENOENT' })), false)
})

test('文件重试：临时占用会退避后成功', async () => {
  let attempts = 0
  const result = await retryFs('测试操作', async () => {
    attempts += 1
    if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    return 'ok'
  }, { attempts: 4, baseDelay: 20 })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('文件重试：占用一直不释放时给出可读的 PACK_LOCKED', async () => {
  await assert.rejects(
    retryFs('删除测试目录', async () => {
      throw Object.assign(new Error('busy'), { code: 'EPERM' })
    }, { attempts: 2, baseDelay: 20 }),
    (err) => {
      assert.equal(err.code, 'PACK_LOCKED')
      assert.match(err.message, /占用/)
      return true
    },
  )
})

test('文件重试：删除目录带重试，且目录不存在时是幂等的', async () => {
  const dir = tmpDir('fs-retry')
  const target = path.join(dir, 'pack')
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(target, 'nested', 'a.txt'), 'a')
  assert.equal(await removeDirectory(target, { attempts: 1 }), true)
  assert.equal(fs.existsSync(target), false)
  assert.equal(await removeDirectory(target, { attempts: 1 }), false)
})
