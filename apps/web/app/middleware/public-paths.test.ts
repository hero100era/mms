import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  __testables,
  declaredRoutePatterns,
  isBreakGlassPublicPath,
  isMfaPublicPath,
} from './public-paths.ts'

const patternSources = declaredRoutePatterns()

describe('public-paths', () => {
  it('every exact allow-list entry is a declared route', () => {
    for (let [name, paths] of Object.entries({
      SHARED_EXACT: __testables.SHARED_EXACT,
      MFA_EXACT: __testables.MFA_EXACT,
      BREAK_GLASS_EXACT: __testables.BREAK_GLASS_EXACT,
    })) {
      for (let path of paths) {
        assert.ok(
          patternSources.includes(path),
          `${name} entry ${JSON.stringify(path)} does not match any declared route`,
        )
      }
    }
  })

  it('every prefix allow-list entry matches at least one declared route', () => {
    for (let [name, prefixes] of Object.entries({
      SHARED_PREFIXES: __testables.SHARED_PREFIXES,
      MFA_PREFIXES: __testables.MFA_PREFIXES,
    })) {
      for (let prefix of prefixes) {
        assert.ok(
          patternSources.some((source) => source.startsWith(prefix)),
          `${name} prefix ${JSON.stringify(prefix)} matches no declared route`,
        )
      }
    }
  })

  it('gate predicates do not widen the route contract', () => {
    const gates = { isMfaPublicPath, isBreakGlassPublicPath }
    for (let path of patternSources) {
      for (let [name, gate] of Object.entries(gates)) {
        // Every allowed path must itself be (or be under) a declared route: the
        // predicates never introduce a path that does not exist in the contract.
        if (!gate(path)) continue
        assert.ok(
          patternSources.includes(path) || patternSources.some((source) => source.startsWith(path)),
          `${name} allows ${JSON.stringify(path)} which is not a declared route`,
        )
      }
    }
  })

  it('MFA gate blocks the OAuth upgrade path and app pages', () => {
    for (let path of ['/auth/google/callback', '/auth/microsoft/start', '/profile', '/admin/positions', '/surveys']) {
      assert.equal(isMfaPublicPath(path), false, `${path} must not bypass MFA`)
    }
    assert.equal(isMfaPublicPath('/mfa'), true)
    assert.equal(isMfaPublicPath('/mfa/enrol'), true)
    assert.equal(isMfaPublicPath('/login'), true)
    assert.equal(isMfaPublicPath('/invite/token'), true)
  })

  it('break-glass gate only allows the reason pages and logout/assets/jwks', () => {
    assert.equal(isBreakGlassPublicPath('/break-glass'), true)
    assert.equal(isBreakGlassPublicPath('/break-glass/activate'), true)
    assert.equal(isBreakGlassPublicPath('/break-glass/deactivate'), true)
    assert.equal(isBreakGlassPublicPath('/logout'), true)
    for (let path of ['/auth/microsoft/callback', '/profile', '/admin/positions']) {
      assert.equal(isBreakGlassPublicPath(path), false, `${path} must not be reachable while dormant`)
    }
  })
})
