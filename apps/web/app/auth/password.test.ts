import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DUMMY_HASH,
  dummyVerifyPassword,
  hashPassword,
  validatePassword,
  verifyPassword,
} from './password.ts'

test('password policy validation', () => {
  // Too short (< 12)
  let short = validatePassword('short123')
  assert.equal(short.valid, false)
  assert.match(short.error!, /at least 12 characters/)

  // In blocklist
  let blocked = validatePassword('password1234')
  assert.equal(blocked.valid, false)
  assert.match(blocked.error!, /too common/)

  // Valid password
  let valid = validatePassword('correct horse battery staple')
  assert.equal(valid.valid, true)
  assert.equal(valid.error, undefined)

  // 12-char valid password
  let valid12 = validatePassword('MySecurePass1')
  assert.equal(valid12.valid, true)
})

test('argon2id hash and verify', async () => {
  let password = 'a very secure long password 2026'
  let hash = await hashPassword(password)

  assert.ok(hash.startsWith('$argon2id$v=19$'))
  assert.ok(await verifyPassword(password, hash))
  assert.equal(await verifyPassword('wrong password here', hash), false)
  assert.equal(await verifyPassword(password, 'invalid-hash-string'), false)
})

test('dummy verify runs with timing parity and returns false', async () => {
  assert.ok(typeof DUMMY_HASH === 'string')
  assert.match(DUMMY_HASH, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  let result = await dummyVerifyPassword('some-user-password')
  assert.equal(result, false)
  let emptyResult = await dummyVerifyPassword('')
  assert.equal(emptyResult, false)
})
