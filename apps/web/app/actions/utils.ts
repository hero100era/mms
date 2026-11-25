// Pure, dependency-free helpers shared by the action controllers.
//
// These used to live in `helpers.tsx`, whose other occupant is the OAuth
// callback state machine. Importing that file pulled in the auth view module
// (`auth-pages.tsx`), the Document shell, the asset pipeline's top-level
// `await`, session secrets and the provider configs -- even for a controller
// that only wanted to validate a UUID. Keeping the pure helpers here keeps
// that dependency fan-out out of the request path.
import type { SessionAuth } from '../auth/context.ts'
import { routes } from '../routes.ts'

export function devEnabled(): boolean {
  return process.env.MMS_AUTH_STUB === '1'
}

export function authData(userId: string, activeRole: string, assignableRoles: string[]): SessionAuth {
  return {
    userId,
    kind: 'internal',
    activeRole,
    authMethod: 'entra',
    authTime: new Date().toISOString(),
    assignableRoles,
  }
}

export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes

/** True when a recent step-up (or the original sign-in) is within 10 minutes.
 *  Accepts an injectable clock `now?: number | Date | string | { request?: Request }` (defaults to Date.now())
 *  for deterministic testing.
 */
export function isStepUpValid(
  auth: SessionAuth | null,
  now?: number | Date | string | { request?: Request },
): boolean {
  if (!auth) return false
  let timeVal = auth.stepUpAt ?? auth.authTime
  if (!timeVal) return false
  let timestamp = typeof timeVal === 'number' ? timeVal : new Date(timeVal).getTime()
  if (Number.isNaN(timestamp)) return false

  let currentMs: number
  if (now !== undefined && now !== null) {
    if (typeof now === 'number') {
      currentMs = now
    } else if (now instanceof Date) {
      currentMs = now.getTime()
    } else if (typeof now === 'string') {
      currentMs = new Date(now).getTime()
    } else if (typeof now === 'object' && 'request' in now && (now as any).request) {
      let testClock =
        process.env.NODE_ENV === 'test'
          ? (now as any).request.headers?.get?.('x-test-clock')
          : null
      currentMs = testClock ? new Date(testClock).getTime() : Date.now()
    } else {
      currentMs = Date.now()
    }
  } else {
    currentMs = Date.now()
  }

  if (Number.isNaN(currentMs)) return false

  let elapsed = currentMs - timestamp
  // Strict inequality: exactly at 10m00s (600,000ms), step-up is expired per T2.1-P2.2-02
  return elapsed >= 0 && elapsed < STEP_UP_MAX_AGE_MS
}

/** Only same-origin absolute paths are safe post-login redirect targets. */
export function safeReturnTo(url: string | null | undefined, fallback = routes.session.profile.href()): string {
  if (!url || typeof url !== 'string') return fallback
  let trimmed = url.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback
  // Browsers normalise `\` to `/` in URL paths, so `/\evil.example` is an
  // open redirect. Reject backslashes and control characters outright.
  if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return fallback
  // Some user agents decode percent-encoded separators before following the
  // redirect, turning /%2f%2fevil.example into //evil.example. Encoded
  // separators in a query string are harmless; restrict the check to the path.
  let path = trimmed.split(/[?#]/, 1)[0]!
  if (/%(?:2f|5c)/i.test(path)) return fallback
  // Parse against a synthetic origin: absolute URLs, protocol-relative URLs
  // and non-http schemes all escape that origin and are refused.
  try {
    let base = 'https://mms.invalid'
    if (new URL(trimmed, base).origin !== base) return fallback
  } catch {
    return fallback
  }
  return trimmed
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseUuidOrNull(val: unknown): string | null {
  if (typeof val === 'string' && UUID_PATTERN.test(val.trim())) {
    return val.trim()
  }
  return null
}
