import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  MemoryWormStorage,
  WormStorageCollisionError,
  WormStorageViolationError,
} from './worm-storage.ts'

test('MemoryWormStorage enforces Write-Once-Read-Many semantics', async () => {
  let worm = new MemoryWormStorage()
  let path = 'worm/audit_trail/seals/seal_100_200.jsonl'
  let content = '{"format":"mms-audit-seal-v1"}\n'

  // 1. Initial write succeeds
  let res = await worm.write(path, content)
  assert.equal(res.uri, path)
  assert.equal(res.sha256Hex.length, 64)

  // 2. Read back matches content exactly
  let readBack = await worm.read(path)
  assert.ok(readBack)
  assert.equal(readBack.toString('utf8'), content)

  // 3. Idempotent resume: writing identical content succeeds without error
  let resumeRes = await worm.write(path, content)
  assert.equal(resumeRes.uri, path)
  assert.equal(resumeRes.sha256Hex, res.sha256Hex)

  // 4. Overwrite attempt with different content throws WormStorageCollisionError
  let tamperedContent = '{"format":"mms-audit-seal-v1","tampered":true}\n'
  await assert.rejects(
    async () => {
      await worm.write(path, tamperedContent)
    },
    (err: unknown) => {
      assert.ok(err instanceof WormStorageCollisionError)
      assert.ok(err.message.includes('WORM storage collision'))
      return true
    },
  )

  // 5. Deletion attempt throws WormStorageViolationError
  await assert.rejects(
    async () => {
      await worm.delete(path)
    },
    (err: unknown) => {
      assert.ok(err instanceof WormStorageViolationError)
      assert.ok(err.message.includes('Deletion is strictly prohibited'))
      return true
    },
  )

  // 6. Non-existent path returns null and false
  assert.equal(await worm.read('worm/nonexistent.jsonl'), null)
  assert.equal(await worm.exists('worm/nonexistent.jsonl'), false)
  assert.equal(await worm.exists(path), true)
})
