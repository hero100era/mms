import { routes } from '../routes.ts'

// Route-derived public-path predicates for the MFA and break-glass gates.
//
// These gates used to decide with `path.endsWith(suffix)` against a
// hand-written list; a path that *ends with* an allowed suffix but is not the
// declared route stayed allowed, and any new public route silently bypassed
// or bricked the gate. The predicate now names actual routes, so adding a
// route means deciding which gate, if any, it bypasses — and `public-paths.test.ts`
// fails if an entry drifts away from the route contract.

/** Paths that are already public because no session can exist, plus assets/JWKS. */
const SHARED_EXACT = new Set<string>([
  routes.jwks.href(), // PostgREST fetches with no credentials
])

const SHARED_PREFIXES = ['/assets/']

/** Routes reachable while authenticating as an external password user without MFA. */
const MFA_EXACT = new Set<string>([
  routes.session.login.href(),
  routes.session.loginDev.href(),
  routes.session.devLogin.href(),
  routes.session.devLoginSubmit.href(),
  routes.session.loginPassword.href(),
  routes.session.logout.href(),
  routes.session.forgotPassword.href(),
  routes.session.forgotPasswordSubmit.href(),
  routes.mfa.challenge.href(),
  routes.mfa.submit.href(),
  routes.mfa.enrol.href(),
  routes.mfa.enrolSubmit.href(),
  routes.mfa.stepUp.href(),
  routes.mfa.stepUpSubmit.href(),
])

const MFA_PREFIXES = [
  '/reset-password/',
  '/invite/',
  '/step-up/',
]

/** Routes reachable while a break-glass account is dormant (pre-activation). */
const BREAK_GLASS_EXACT = new Set<string>([
  routes.breakGlass.index.href(),
  routes.breakGlass.activate.href(),
  routes.breakGlass.deactivate.href(),
  routes.session.logout.href(),
])

export type GatePredicate = (pathname: string) => boolean

export const isMfaPublicPath: GatePredicate = (pathname) =>
  SHARED_EXACT.has(pathname) ||
  MFA_EXACT.has(pathname) ||
  SHARED_PREFIXES.some((p) => pathname.startsWith(p)) ||
  MFA_PREFIXES.some((p) => pathname.startsWith(p))

export const isBreakGlassPublicPath: GatePredicate = (pathname) =>
  SHARED_EXACT.has(pathname) ||
  BREAK_GLASS_EXACT.has(pathname) ||
  SHARED_PREFIXES.some((p) => pathname.startsWith(p))

/** All patterns declared in the route contract, for drift checks in tests. */
export function declaredRoutePatterns(): string[] {
  let patterns: string[] = []
  function walk(value: unknown): void {
    if (value == null) return
    if (Array.isArray(value)) {
      for (let item of value) walk(item)
      return
    }
    if (typeof value !== 'object') return
    for (let entry of Object.values(value as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && 'pattern' in (entry as Record<string, unknown>)) {
        let pattern = (entry as { pattern?: { source?: string } }).pattern
        if (pattern?.source) patterns.push(pattern.source)
        continue
      }
      walk(entry)
    }
  }
  walk(routes)
  return patterns
}

export const __testables = { SHARED_EXACT, SHARED_PREFIXES, MFA_EXACT, MFA_PREFIXES, BREAK_GLASS_EXACT }
