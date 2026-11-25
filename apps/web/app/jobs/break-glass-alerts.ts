import { defaultAlerter } from '../audit_trail/alerter.ts'
import { breakGlassDrillOverdue } from '../auth/service.ts'
import { createScheduler } from './scheduler.ts'
import { getWorkerPool } from './worker-client.ts'

// Card H-10: break-glass access is the most dangerous privilege in the system -- an
// account that can act when every other control has failed. Two facts therefore have to
// leave the page and reach someone who is watching:
//
//   1. the window was opened (`BREAK_GLASS_ACTIVATED`), and
//   2. the account has not proven it still works (`BREAK_GLASS_DRILL_OVERDUE`).
//
// Both `AlertType` members existed and neither was ever emitted, because the only reader
// of `drill_overdue` was the page itself. A control whose signal is read only by the person
// who may be locked out is not a control, so the emitters live here, outside the request.

export function alertBreakGlassActivated(
  userId: string,
  validUntil: string | null,
  reason: string | null,
): Promise<unknown> {
  return defaultAlerter.emit(
    'BREAK_GLASS_ACTIVATED',
    'CRITICAL',
    'break-glass',
    'A break-glass account was activated. It now holds int_sysadmin.',
    { userId, validUntil, reason },
  )
}

/**
 * Checks every enabled break-glass account and raises one alert per account whose drill
 * has lapsed. Never raises for an account that is current, so the alert means "this account
 * is untested", not "the checker ran".
 */
export async function checkBreakGlassDrills(): Promise<number> {
  let overdue = await breakGlassDrillOverdue()
  for (let account of overdue) {
    await defaultAlerter.emit(
      'BREAK_GLASS_DRILL_OVERDUE',
      'WARNING',
      'break-glass',
      account.days_since_drill === null
        ? `Break-glass account "${account.label}" has never been drilled.`
        : `Break-glass account "${account.label}" has not been drilled for ${account.days_since_drill} days.`,
      {
        userId: account.user_id,
        label: account.label,
        lastDrillAt: account.last_drill_at,
        daysSinceDrill: account.days_since_drill,
      },
    )
  }
  return overdue.length
}

const drillScheduler = createScheduler({
  label: 'break-glass drill checker',
  intervalMs: 24 * 60 * 60 * 1000,
  run: checkBreakGlassDrills,
  runImmediately: true,
  onError: (error, phase) =>
    phase === 'startup'
      ? console.error('initial break-glass drill check error:', error)
      : console.error('scheduled break-glass drill check error:', error),
})

export function startBreakGlassDrillScheduler(intervalMs = 24 * 60 * 60 * 1000): void {
  drillScheduler.start(intervalMs)
}

export function stopBreakGlassDrillScheduler(): void {
  drillScheduler.stop()
}

export function drainBreakGlassDrillScheduler(timeoutMs = 15_000): Promise<void> {
  return drillScheduler.drain(timeoutMs)
}

/**
 * R8.5: Asynchronous cleanup of expired break-glass accounts.
 * Revokes lingering sessions and resets activation windows in the database.
 * Synchronous denial in private.pre_request() already denied requests immediately;
 * this function performs the database cleanup.
 */
export async function sweepExpiredBreakGlass(): Promise<number> {
  let res = await getWorkerPool().query<{ sweep: number }>(
    'select auth.break_glass_sweep_expired() as sweep',
  )
  return res.rows[0]?.sweep ?? 0
}
