import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { assertDevAuthAllowed, isDevLoginAllowed } from './dev-stub.ts'

const saved = { ...process.env }

afterEach(() => {
  process.env = { ...saved }
})

describe('assertDevAuthAllowed', () => {
  it('rejects the stub in production', () => {
    delete process.env.ALLOW_DEV_LOGIN
    delete process.env.ALLOW_TEST_SCANNER
    delete process.env.ALLOW_TEST_STORAGE
    process.env.MMS_AUTH_STUB = '1'
    process.env.NODE_ENV = 'production'
    assert.throws(() => assertDevAuthAllowed(), /not allowed in production/)
  })

  it('rejects ALLOW_DEV_LOGIN=true when APP_ENV=production', () => {
    delete process.env.ALLOW_TEST_SCANNER
    delete process.env.ALLOW_TEST_STORAGE
    process.env.APP_ENV = 'production'
    process.env.ALLOW_DEV_LOGIN = 'true'
    assert.throws(() => assertDevAuthAllowed(), /ALLOW_DEV_LOGIN is strictly prohibited in production/)
  })

  it('rejects ALLOW_TEST_SCANNER=true when APP_ENV=production', () => {
    delete process.env.ALLOW_DEV_LOGIN
    delete process.env.ALLOW_TEST_STORAGE
    process.env.APP_ENV = 'production'
    process.env.ALLOW_TEST_SCANNER = 'true'
    assert.throws(() => assertDevAuthAllowed(), /ALLOW_TEST_SCANNER is strictly prohibited in production/)
  })

  it('rejects ALLOW_TEST_STORAGE=true when NODE_ENV=production', () => {
    delete process.env.ALLOW_DEV_LOGIN
    delete process.env.ALLOW_TEST_SCANNER
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_TEST_STORAGE = 'true'
    assert.throws(() => assertDevAuthAllowed(), /ALLOW_TEST_STORAGE is strictly prohibited in production/)
  })

  it('rejects the stub on a non-local host', () => {
    process.env.MMS_AUTH_STUB = '1'
    process.env.NODE_ENV = 'development'
    process.env.HOST = '0.0.0.0'
    assert.throws(() => assertDevAuthAllowed(), /not allowed on host/)
  })

  it('allows the stub locally', () => {
    process.env.MMS_AUTH_STUB = '1'
    process.env.NODE_ENV = 'development'
    process.env.HOST = '127.0.0.1'
    assert.doesNotThrow(() => assertDevAuthAllowed())
  })
})

describe('isDevLoginAllowed', () => {
  it('returns false when APP_ENV=production', () => {
    process.env.APP_ENV = 'production'
    process.env.ALLOW_DEV_LOGIN = 'true'
    assert.equal(isDevLoginAllowed(), false)
  })

  it('returns false when ALLOW_DEV_LOGIN is not set', () => {
    process.env.APP_ENV = 'test'
    delete process.env.ALLOW_DEV_LOGIN
    assert.equal(isDevLoginAllowed(), false)
  })

  it('returns true when APP_ENV=test and ALLOW_DEV_LOGIN=true', () => {
    process.env.APP_ENV = 'test'
    process.env.NODE_ENV = 'test'
    process.env.ALLOW_DEV_LOGIN = 'true'
    assert.equal(isDevLoginAllowed(), true)
  })

  it('returns true when APP_ENV=local and ALLOW_DEV_LOGIN=1', () => {
    process.env.APP_ENV = 'local'
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_LOGIN = '1'
    assert.equal(isDevLoginAllowed(), true)
  })
})
