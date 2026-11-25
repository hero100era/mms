// Server-only. PostgreSQL-backed step-up throttling namespace (R2-H01).
// Tracks attempt limits for step-up authentication across user, user:ip, and
// user:session buckets in iam.step_up_attempt via auth_gateway RPCs so limits
// hold across all web replicas and restarts without touching iam.login_attempt.
import { authCall } from './gateway-client.ts'

export const STEP_UP_MAX_ATTEMPTS = 5
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
export const MAX_BUCKETS = 10_000

export interface StepUpAttemptRecord {
  timestamps: number[]
}

type StepUpStatusResult = {
  throttled: boolean
  retry_after: number
}

// Non-security display hint populated by isStepUpThrottled() so synchronous
// getStepUpRetryAfter() callers receive the exact DB-computed Retry-After value.
const retryAfterHints = new Map<string, number>()

// Track any in-flight clearStepUpThrottle() calls (which existing test suites
// invoke synchronously) so subsequent throttle checks never race ahead of them.
const pendingClears = new Set<Promise<void>>()

async function flushPendingClears(): Promise<void> {
  while (pendingClears.size > 0) {
    await Promise.allSettled(Array.from(pendingClears))
  }
}

function hintKey(userId: string, ip: string, sessionId?: string): string {
  return `${userId}|${ip}|${sessionId ?? ''}`
}

/**
 * Checks whether password step-up is currently throttled for this user/ip/session.
 * Does NOT touch iam.login_attempt or affect primary login lockout.
 */
export async function isStepUpThrottled(
  userId: string,
  ip: string,
  sessionId?: string,
): Promise<boolean> {
  await flushPendingClears()
  let res = await authCall<StepUpStatusResult>('auth.step_up_status', [
    userId,
    ip,
    sessionId ?? null,
    `${Math.floor(STEP_UP_WINDOW_MS / 1000)} seconds`,
    STEP_UP_MAX_ATTEMPTS,
  ])
  if (res && typeof res.retry_after === 'number') {
    retryAfterHints.set(hintKey(userId, ip, sessionId), res.retry_after)
    if (retryAfterHints.size > MAX_BUCKETS) {
      let oldest = retryAfterHints.keys().next()
      if (!oldest.done) retryAfterHints.delete(oldest.value)
    }
  }
  return Boolean(res?.throttled)
}

/**
 * Returns the Retry-After interval in seconds for the step-up throttle.
 */
export function getStepUpRetryAfter(
  userId: string,
  ip: string,
  sessionId?: string,
): number {
  return retryAfterHints.get(hintKey(userId, ip, sessionId)) ?? 60
}

/**
 * Records a step-up attempt in PostgreSQL. If success is true, clears prior
 * failed step-up attempts for this user.
 */
export async function recordStepUpAttempt(
  userId: string,
  ip: string,
  success: boolean,
  sessionId?: string,
): Promise<void> {
  await flushPendingClears()
  await authCall<void>('auth.step_up_record', [
    userId,
    ip,
    success,
    sessionId ?? null,
    `${Math.floor(STEP_UP_WINDOW_MS / 1000)} seconds`,
  ])
  if (success) {
    retryAfterHints.delete(hintKey(userId, ip, sessionId))
  }
}

/** Test seam: reset step-up throttle state in PostgreSQL */
export function clearStepUpThrottle(userId?: string): Promise<void> {
  if (userId) {
    for (let key of Array.from(retryAfterHints.keys())) {
      if (key.startsWith(`${userId}|`)) retryAfterHints.delete(key)
    }
  } else {
    retryAfterHints.clear()
  }

  let promise = authCall<void>('auth.step_up_clear', [userId ?? null])
    .catch(() => {})
    .finally(() => {
      pendingClears.delete(promise)
    })
  pendingClears.add(promise)
  return promise
}
