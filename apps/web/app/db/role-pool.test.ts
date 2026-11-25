import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRolePool, withRole } from './role-pool.ts'

describe('withRole', () => {
  it('swaps only the username, keeping host, port, password and database', () => {
    let url = 'postgresql://postgres:s3cret@127.0.0.1:55432/mms_dev?sslmode=disable'
    let derived = withRole(url, 'audit_sealer')
    let parsed = new URL(derived)
    assert.equal(parsed.username, 'audit_sealer')
    assert.equal(parsed.password, 's3cret')
    assert.equal(parsed.hostname, '127.0.0.1')
    assert.equal(parsed.port, '55432')
    assert.equal(parsed.pathname, '/mms_dev')
    assert.equal(parsed.searchParams.get('sslmode'), 'disable')

    // Empty password in non-production resolves fallback password
    let urlNoPass = 'postgresql://postgres@127.0.0.1:55432/mms_dev?sslmode=disable'
    let derivedNoPass = withRole(urlNoPass, 'audit_sealer')
    let parsedNoPass = new URL(derivedNoPass)
    assert.equal(parsedNoPass.username, 'audit_sealer')
    assert.equal(parsedNoPass.password, process.env.NODE_ENV !== 'production' ? 'devpassword' : '')
  })

  it('returns an unparseable URL unchanged rather than hiding a config error', () => {
    assert.equal(withRole('not a url', 'worker'), 'not a url')
  })
})

describe('createRolePool', () => {
  it('resolves the URL once, lazily, and hands out one stable pool', async () => {
    let resolutions = 0
    let pool = createRolePool(() => {
      resolutions++
      return 'postgresql://worker@127.0.0.1:55432/mms_dev'
    }, 3)

    assert.equal(resolutions, 0, 'must not connect/read config at import time')
    let first = pool.get()
    assert.equal(resolutions, 1)
    assert.equal(pool.get(), first, 'pool must be shared across call sites')
    assert.equal(first.options.max, 3)

    await pool.close()
    let second = pool.get()
    assert.notEqual(second, first, 'close() must allow a fresh pool')
    assert.equal(resolutions, 2)
    await pool.close()
  })
})
