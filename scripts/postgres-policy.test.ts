import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APPROVED_POSTGRES_BASELINE,
  APPROVED_POSTGRES_VERSIONS,
  verifyPostgresVersion,
} from '../db/scripts/postgres-policy.ts'

describe('R8.6-F05 PostgreSQL Version Policy Enforcement', () => {
  it('1. Baseline version 18.7 passes', () => {
    let result = verifyPostgresVersion(180007, '18.7 (Debian 18.7-1.pgdg13+2)')
    assert.equal(result.passed, true)
    assert.ok(result.detail.includes('18.7'))
    assert.equal(result.error, undefined)
  })

  it('2. Approved patch versions pass', () => {
    for (let ver of APPROVED_POSTGRES_VERSIONS) {
      let [major, patch] = ver.split('.').map(Number)
      let num = major! * 10000 + patch!
      let result = verifyPostgresVersion(num, `${ver} (Test Server)`)
      assert.equal(result.passed, true)
    }
  })

  it('3. Major version less than 18 fails fast', () => {
    let result = verifyPostgresVersion(160004, '16.4')
    assert.equal(result.passed, false)
    assert.ok(result.error?.includes('requires approved PostgreSQL 18.x'))
  })

  it('4. Major version 19 or higher fails fast', () => {
    let result = verifyPostgresVersion(190001, '19.1')
    assert.equal(result.passed, false)
    assert.ok(result.error?.includes('PostgreSQL 19.x or higher has not been approved'))
  })

  it('5. Unapproved 18.x patch version fails with actionable error', () => {
    let result = verifyPostgresVersion(180009, '18.9')
    assert.equal(result.passed, false)
    assert.ok(result.error?.includes('requires explicit approval in db/scripts/postgres-policy.ts'))
    assert.ok(result.error?.includes(APPROVED_POSTGRES_BASELINE))
  })
})
