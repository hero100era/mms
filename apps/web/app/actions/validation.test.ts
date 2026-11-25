import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ensureText,
  validateEmail,
  validateEnum,
  validateFilename,
  validateInteger,
  validateOptionalString,
  validateOptionalUuid,
  validatePagination,
  validateReason,
  validateUuid,
  ValidationError,
} from './validation.ts'

describe('R4.1: Shared validation layer', () => {
  it('validates and canonicalizes canonical UUIDs', () => {
    let raw = '  A0000000-0000-0000-0000-000000000001  '
    assert.equal(validateUuid(raw), 'a0000000-0000-0000-0000-000000000001')
    assert.throws(() => validateUuid('not-a-uuid'), ValidationError)
    assert.throws(() => validateUuid(''), ValidationError)
  })

  it('handles optional UUIDs correctly', () => {
    assert.equal(validateOptionalUuid(null), null)
    assert.equal(validateOptionalUuid('   '), null)
    assert.equal(
      validateOptionalUuid('b0000000-0000-0000-0000-000000000002'),
      'b0000000-0000-0000-0000-000000000002',
    )
    assert.throws(() => validateOptionalUuid('bad'), ValidationError)
  })

  it('normalizes and validates emails', () => {
    assert.equal(validateEmail('  USER@Domain.COM '), 'user@domain.com')
    assert.throws(() => validateEmail('not-an-email'), ValidationError)
    assert.throws(() => validateEmail(''), ValidationError)
  })

  it('rejects File objects flowing into text fields', () => {
    let mockFile = new Blob(['content'])
    assert.throws(() => ensureText(mockFile, 'test_field'), (err: any) => {
      assert.ok(err instanceof ValidationError)
      assert.match(err.fields.test_field, /must be a text value, not a file/)
      return true
    })
  })

  it('enforces reason length bounds', () => {
    assert.equal(validateReason('Valid reason here'), 'Valid reason here')
    assert.throws(() => validateReason('ab'), ValidationError) // too short
    assert.throws(() => validateReason('   '), ValidationError) // empty after trim
    assert.throws(() => validateReason('x'.repeat(501)), ValidationError) // exceeds 500
  })

  it('validates enums strictly', () => {
    let allowed = ['global', 'unit'] as const
    assert.equal(validateEnum('global', allowed), 'global')
    assert.throws(() => validateEnum('invalid_scope', allowed), ValidationError)
  })

  it('clamps and validates pagination parameters', () => {
    let { limit, offset } = validatePagination('50', '10')
    assert.equal(limit, 50)
    assert.equal(offset, 10)

    let defaults = validatePagination(undefined, undefined)
    assert.equal(defaults.limit, 20)
    assert.equal(defaults.offset, 0)

    // Clamps to maxLimit
    assert.throws(() => validatePagination('150', '0', 100), ValidationError)
    assert.throws(() => validatePagination('-1', '0'), ValidationError)
  })

  it('validates filenames rejecting path traversal', () => {
    assert.equal(validateFilename('safe-file.pdf'), 'safe-file.pdf')
    assert.throws(() => validateFilename('../evil.txt'), ValidationError)
    assert.throws(() => validateFilename('dir/file.txt'), ValidationError)
    assert.throws(() => validateFilename('dir\\file.txt'), ValidationError)
  })
})
