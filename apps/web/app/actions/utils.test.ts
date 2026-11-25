import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isStepUpValid, parseUuidOrNull, safeReturnTo } from './utils.ts'

describe('parseUuidOrNull', () => {
  it('accepts a canonical UUID in either case and trims whitespace', () => {
    assert.equal(parseUuidOrNull('  D0000000-0000-0000-0000-000000000001  '), 'D0000000-0000-0000-0000-000000000001')
  })

  it('rejects anything that is not a UUID', () => {
    for (let value of [null, undefined, 42, '', 'not-a-uuid', 'd0000000-0000-0000-0000-00000000000g']) {
      assert.equal(parseUuidOrNull(value), null)
    }
  })
})

describe('safeReturnTo', () => {
  it('allows same-origin absolute paths', () => {
    assert.equal(safeReturnTo('/profile?success=linked'), '/profile?success=linked')
    assert.equal(safeReturnTo('  /triage  '), '/triage')
  })

  it('blocks protocol-relative URLs, absolute URLs and junk', () => {
    for (let value of ['//evil.example', 'https://evil.example', '', 'profile', null, undefined]) {
      assert.equal(safeReturnTo(value), '/profile')
    }
    assert.equal(safeReturnTo('//evil.example', '/login'), '/login')
  })

  // R1.5: browsers normalise backslashes and may decode encoded separators
  // before following a redirect. Those forms must not become open redirects.
  it('blocks backslash and encoded-separator open redirects', () => {
    for (let value of [
      '/\\evil.example',
      '/%2f%2fevil.example',
      '/%2F%2Fevil.example',
      '/%5cevil.example',
      '/a/..\\evil.example',
      '/\n//evil.example',
      'javascript:alert(1)',
    ]) {
      assert.equal(safeReturnTo(value), '/profile', `must reject ${JSON.stringify(value)}`)
    }
  })

  it('keeps query strings, fragments and encoded non-separators', () => {
    assert.equal(safeReturnTo('/profile?next=%2Ffoo#section'), '/profile?next=%2Ffoo#section')
    assert.equal(safeReturnTo('/a/../b'), '/a/../b')
    assert.equal(safeReturnTo('/survey/123?tab=documents'), '/survey/123?tab=documents')
  })
})

describe('isStepUpValid', () => {
  const auth = (time: string | undefined) => ({ authTime: time } as any)

  it('accepts a recent step-up and falls back to authTime', () => {
    let now = new Date().toISOString()
    assert.equal(isStepUpValid({ authTime: '2000-01-01T00:00:00.000Z', stepUpAt: now } as any), true)
    assert.equal(isStepUpValid(auth(now)), true)
  })

  it('rejects missing, stale and future timestamps', () => {
    assert.equal(isStepUpValid(null), false)
    assert.equal(isStepUpValid(auth(undefined)), false)
    assert.equal(isStepUpValid(auth('2000-01-01T00:00:00.000Z')), false)
    assert.equal(isStepUpValid(auth(new Date(Date.now() + 60_000).toISOString())), false)
  })
})

describe('isStepUpValid with controlled-time clock seam', () => {
  const baseTime = 1_700_000_000_000 // fixed reference epoch ms

  it('validates at exact instant of authentication (elapsed = 0)', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    assert.equal(isStepUpValid(auth, baseTime), true)
  })

  it('validates within 10-minute freshness window (5m, 9m, 9m59s)', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    assert.equal(isStepUpValid(auth, baseTime + 5 * 60 * 1000), true)
    assert.equal(isStepUpValid(auth, baseTime + 9 * 60 * 1000), true)
    assert.equal(isStepUpValid(auth, baseTime + (10 * 60 - 1) * 1000), true)
  })

  it('rejects at the exact 10-minute boundary (elapsed = 600,000ms strictly expired)', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    // T2.1-P2.2-02 mandates exactly 10m00s is expired
    assert.equal(isStepUpValid(auth, baseTime + 10 * 60 * 1000), false)
  })

  it('rejects 1 millisecond past the 10-minute boundary without wall-clock sleep', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    assert.equal(isStepUpValid(auth, baseTime + 10 * 60 * 1000 + 1), false)
  })

  it('rejects stale authentications (> 10 minutes, e.g. 15m, 1h)', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    assert.equal(isStepUpValid(auth, baseTime + 15 * 60 * 1000), false)
    assert.equal(isStepUpValid(auth, baseTime + 60 * 60 * 1000), false)
  })

  it('rejects timestamps in the future (clock skew/manipulation)', () => {
    let auth = { authTime: new Date(baseTime + 60_000).toISOString() } as any
    assert.equal(isStepUpValid(auth, baseTime), false)
  })

  it('prefers recent stepUpAt over stale authTime', () => {
    let auth = {
      authTime: new Date(baseTime - 60 * 60 * 1000).toISOString(), // 1 hr ago
      stepUpAt: new Date(baseTime).toISOString(),                 // fresh
    } as any
    assert.equal(isStepUpValid(auth, baseTime + 5 * 60 * 1000), true)
  })

  it('rejects when stepUpAt is stale even if authTime was provided', () => {
    let auth = {
      authTime: new Date(baseTime - 30 * 60 * 1000).toISOString(),
      stepUpAt: new Date(baseTime - 11 * 60 * 1000).toISOString(), // 11 mins ago
    } as any
    assert.equal(isStepUpValid(auth, baseTime), false)
  })

  it('supports raw numeric epoch timestamps in milliseconds', () => {
    let auth = { authTime: baseTime } as any
    assert.equal(isStepUpValid(auth, baseTime + 5 * 60 * 1000), true)
    assert.equal(isStepUpValid(auth, baseTime + 11 * 60 * 1000), false)
  })

  it('supports Date objects and ISO strings as now argument', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    assert.equal(isStepUpValid(auth, new Date(baseTime + 5 * 60 * 1000)), true)
    assert.equal(isStepUpValid(auth, new Date(baseTime + 10 * 60 * 1000).toISOString()), false)
  })

  it('extracts test clock from context request headers (x-test-clock)', () => {
    let auth = { authTime: new Date(baseTime).toISOString() } as any
    let mockContextValid = {
      request: new Request('http://localhost/', {
        headers: { 'x-test-clock': new Date(baseTime + 5 * 60 * 1000).toISOString() },
      }),
    }
    assert.equal(isStepUpValid(auth, mockContextValid as any), true)

    let mockContextExpired = {
      request: new Request('http://localhost/', {
        headers: { 'x-test-clock': new Date(baseTime + 10 * 60 * 1000).toISOString() },
      }),
    }
    assert.equal(isStepUpValid(auth, mockContextExpired as any), false)
  })

  it('ignores x-test-clock and uses Date.now() when NODE_ENV is production', () => {
    let originalEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      // Fresh authTime relative to wall-clock Date.now()
      let freshAuth = { authTime: new Date(Date.now() - 60_000).toISOString() } as any
      // Spoofed x-test-clock in the past (expired)
      let mockContextExpiredClock = {
        request: new Request('http://localhost/', {
          headers: { 'x-test-clock': new Date(Date.now() - 20 * 60 * 1000).toISOString() },
        }),
      }
      // Should ignore x-test-clock and evaluate fresh against Date.now()
      assert.equal(isStepUpValid(freshAuth, mockContextExpiredClock as any), true)

      // Stale authTime relative to wall-clock Date.now()
      let staleAuth = { authTime: new Date(Date.now() - 20 * 60 * 1000).toISOString() } as any
      // Spoofed x-test-clock pretending to be fresh
      let mockContextFreshClock = {
        request: new Request('http://localhost/', {
          headers: { 'x-test-clock': new Date(Date.now() - 19 * 60 * 1000).toISOString() },
        }),
      }
      // Should ignore x-test-clock and evaluate stale against Date.now()
      assert.equal(isStepUpValid(staleAuth, mockContextFreshClock as any), false)
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })

  it('fails safely on null, undefined, and malformed date strings', () => {
    assert.equal(isStepUpValid(null, baseTime), false)
    assert.equal(isStepUpValid({} as any, baseTime), false)
    assert.equal(isStepUpValid({ authTime: 'invalid-date' } as any, baseTime), false)
  })
})
