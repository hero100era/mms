import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseDatabaseUrl,
  redactDatabaseUrl,
  requireDatabaseUrl,
} from '../db/scripts/lib.ts'

describe('R8.6-F01 Credential Redaction and Safety', () => {
  it('1. Missing DATABASE_URL throws an actionable error', () => {
    let orig = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      assert.throws(
        () => requireDatabaseUrl(),
        { message: /DATABASE_URL is required.*See docs\/testing\/native-environment\.md/ },
      )
    } finally {
      process.env.DATABASE_URL = orig
    }
  })

  it('2. redactDatabaseUrl redacts passwords completely', () => {
    let rawUrl = 'postgresql://myuser:supersecretpassword@127.0.0.1:5432/mms_acceptance'
    let redacted = redactDatabaseUrl(rawUrl)
    assert.ok(!redacted.includes('supersecretpassword'), 'Redacted URL must not contain the secret password')
    assert.ok(redacted.includes('***'), 'Redacted URL must replace password with ***')
    assert.ok(redacted.includes('myuser'), 'Redacted URL should preserve username')
    assert.ok(redacted.includes('mms_acceptance'), 'Redacted URL should preserve database name')
  })

  it('3. redactDatabaseUrl handles non-standard or malformed strings gracefully without leaking', () => {
    let rawUrl = 'postgres://authenticator:summer2011@127.0.0.1:5432/mms_dev'
    let redacted = redactDatabaseUrl(rawUrl)
    assert.ok(!redacted.includes('summer2011'), 'Must redact even non-standard schemes')
    assert.ok(redacted.includes('***'), 'Must contain *** mask')
  })

  it('4. parseDatabaseUrl parses credentials correctly for libpq usage without mutating original', () => {
    let rawUrl = 'postgresql://custom_worker:pass123@db.example.internal:5433/mms_dev'
    let parts = parseDatabaseUrl(rawUrl)
    assert.equal(parts.user, 'custom_worker')
    assert.equal(parts.password, 'pass123')
    assert.equal(parts.host, 'db.example.internal')
    assert.equal(parts.port, 5433)
    assert.equal(parts.database, 'mms_dev')
  })

  it('5. URL without password leaves password empty', () => {
    let rawUrl = 'postgresql://postgres@127.0.0.1:5432/mms_acceptance'
    let parts = parseDatabaseUrl(rawUrl)
    assert.equal(parts.user, 'postgres')
    assert.equal(parts.password, '')
    assert.equal(parts.database, 'mms_acceptance')

    let redacted = redactDatabaseUrl(rawUrl)
    assert.ok(!redacted.includes('***'), 'URL without password does not need mask')
  })
})
