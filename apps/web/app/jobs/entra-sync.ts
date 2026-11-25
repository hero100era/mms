import type { Pool } from 'pg'
import {
  DefaultEntraDirectoryClient,
  MockEntraDirectoryClient,
  fetchWithGraphRetry,
  getEntraDirectoryClient,
  hasCustomEntraDirectoryClient,
  resetEntraDirectoryClient,
  setEntraDirectoryClient,
  type EntraDirectoryClient,
  type EntraUserDirectoryStatus,
} from '../auth/entra-client.ts'
import { withClient } from '../db/role-pool.ts'
import { createScheduler } from './scheduler.ts'
import { getWorkerPool } from './worker-client.ts'

export {
  DefaultEntraDirectoryClient,
  MockEntraDirectoryClient,
  fetchWithGraphRetry,
  getEntraDirectoryClient,
  hasCustomEntraDirectoryClient,
  resetEntraDirectoryClient,
  setEntraDirectoryClient,
  type EntraDirectoryClient,
  type EntraUserDirectoryStatus,
}

export interface EntraSyncOptions {
  client?: EntraDirectoryClient
  pool?: Pool
  reason?: string
}

export interface EntraSyncResult {
  runId: string | number
  status: 'clean' | 'deprovisioned' | 'failed'
  usersChecked: number
  usersDeprovisioned: number
  deprovisionedUserIds: string[]
  proposalsStaged: string[]
  details: Record<string, unknown>
  errorMessage?: string
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let results = new Array<R>(items.length)
  let index = 0
  async function worker() {
    while (index < items.length) {
      let i = index++
      results[i] = await fn(items[i]!)
    }
  }
  let workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Executes a full Entra deprovisioning synchronization pass against MMS staff users.
 * Continues scanning remaining users even if individual user checks fail, ensuring
 * that the 24-hour Revocation SLA is fulfilled for all eligible staff accounts.
 */
export async function runEntraDeprovisionSync(options?: EntraSyncOptions): Promise<EntraSyncResult> {
  let pool = options?.pool ?? getWorkerPool()
  let directoryClient = options?.client ?? getEntraDirectoryClient()

  let usersChecked = 0
  let deprovisionedUserIds: string[] = []
  let deprovisionDetails: Record<string, unknown> = {}
  let proposalsStaged: string[] = []
  let userErrors: Record<string, string> = {}
  let recorded = false

  try {
    // 1. Fetch active and suspended internal staff users
    let staffRes = await pool.query<{
      user_id: string
      entra_tenant_id: string
      entra_object_id: string
      display_name: string
      email: string
      status: string
      has_position: boolean
    }>('select user_id, entra_tenant_id, entra_object_id, display_name, email, status, has_position from private.entra_sync_list_staff()')

    let staffUsers = staffRes.rows
    usersChecked = staffUsers.length

    // Bounded concurrency directory checks (default concurrency = 5)
    let userStatuses = await mapConcurrent(staffUsers, 5, async (user) => {
      try {
        let status = await directoryClient.getUserStatus(user.entra_tenant_id, user.entra_object_id)
        return { user, status }
      } catch (dirErr) {
        let msg = dirErr instanceof Error ? dirErr.message : String(dirErr)
        console.error(`Entra directory check error for user ${user.user_id}:`, dirErr)
        return { user, error: msg }
      }
    })

    for (let item of userStatuses) {
      let { user, status, error: dirErr } = item
      if (dirErr) {
        userErrors[user.user_id] = dirErr
        continue
      }
      if (!status) continue

      let shouldDeprovision = false
      let deprovisionReason = ''

      if (!status.exists || status.deleted) {
        shouldDeprovision = true
        deprovisionReason = 'Entra deprovisioning sync: Account deleted in Microsoft Entra'
      } else if (!status.accountEnabled) {
        shouldDeprovision = true
        deprovisionReason = 'Entra deprovisioning sync: Account disabled in Microsoft Entra'
      } else if (!status.hasMmsUserRole) {
        shouldDeprovision = true
        deprovisionReason = 'Entra deprovisioning sync: MMS.User app role removed in Microsoft Entra'
      }

      if (shouldDeprovision) {
        let details = {
          entraTenantId: user.entra_tenant_id,
          entraObjectId: user.entra_object_id,
          directoryStatus: status,
        }

        try {
          let depRes = await pool.query<{ deprovision_staff_user: { deactivated: boolean } }>(
            'select private.deprovision_staff_user($1, $2, $3) as deprovision_staff_user',
            [user.user_id, deprovisionReason, JSON.stringify(details)],
          )

          let result = depRes.rows[0]?.deprovision_staff_user
          if (result?.deactivated) {
            deprovisionedUserIds.push(user.user_id)
            deprovisionDetails[user.user_id] = {
              reason: deprovisionReason,
              status,
            }
          }
        } catch (depErr) {
          let msg = depErr instanceof Error ? depErr.message : String(depErr)
          console.error(`Entra deprovision DB error for user ${user.user_id}:`, depErr)
          userErrors[user.user_id] = msg
        }

        // A deprovisioned account must not be proposed for a position in the same pass.
        continue
      }

      // Card H-13: a staff member with no position and directory attributes that look
      // like a title or an office is staged for HR review. This stages a proposal, never
      // a position: the sync has no authority to place anyone, and HR decides.
      if (!user.has_position && (status.jobTitle || status.officeLocation)) {
        try {
          await pool.query(
            'select private.position_proposal_record($1, $2, $3, $4, $5) as proposal_id',
            [
              user.user_id,
              status.jobTitle ?? null,
              status.department ?? null,
              status.officeLocation ?? null,
              JSON.stringify({
                source: 'entra',
                userPrincipalName: status.userPrincipalName ?? null,
                jobTitle: status.jobTitle ?? null,
                department: status.department ?? null,
                officeLocation: status.officeLocation ?? null,
              }),
            ],
          )
          proposalsStaged.push(user.user_id)
        } catch (proposalErr) {
          // A proposal failure is recorded against the user but must not stop the
          // deprovisioning pass: losing an account revocation to a staging problem
          // would be a worse outcome than a missing proposal.
          let msg = proposalErr instanceof Error ? proposalErr.message : String(proposalErr)
          console.error(`Entra position proposal error for user ${user.user_id}:`, proposalErr)
          userErrors[user.user_id] = msg
        }
      }
    }

    let hasErrors = Object.keys(userErrors).length > 0
    let finalStatus: 'clean' | 'deprovisioned' | 'failed' = hasErrors
      ? 'failed'
      : deprovisionedUserIds.length > 0
        ? 'deprovisioned'
        : 'clean'

    let aggregateError = hasErrors
      ? Object.entries(userErrors)
          .map(([uid, msg]) => `user ${uid}: ${msg}`)
          .join('; ')
      : null

    let recordedDetails = {
      ...deprovisionDetails,
      ...(hasErrors ? { errors: userErrors } : {}),
      ...(proposalsStaged.length > 0 ? { proposalsStaged } : {}),
    }

    // 2. Record synchronization run in audit_trail.entra_sync_run
    let recordRes = await pool.query<{ run_id: string | number }>(
      'select private.record_entra_sync_run($1, $2, $3, $4, $5, $6) as run_id',
      [
        finalStatus,
        usersChecked,
        deprovisionedUserIds.length,
        deprovisionedUserIds,
        aggregateError,
        JSON.stringify(recordedDetails),
      ],
    )
    let runId = recordRes.rows[0]?.run_id ?? 0
    recorded = true

    if (hasErrors) {
      throw new Error(`Entra deprovisioning sync encountered errors: ${aggregateError}`)
    }

    return {
      runId,
      status: finalStatus,
      usersChecked,
      usersDeprovisioned: deprovisionedUserIds.length,
      deprovisionedUserIds,
      proposalsStaged,
      details: deprovisionDetails,
    }
  } catch (error) {
    let errorMsg = error instanceof Error ? error.message : String(error)
    if (!recorded) {
      try {
        await pool.query<{ run_id: string | number }>(
          'select private.record_entra_sync_run($1, $2, $3, $4, $5, $6) as run_id',
          [
            'failed',
            usersChecked,
            deprovisionedUserIds.length,
            deprovisionedUserIds,
            errorMsg,
            JSON.stringify(deprovisionDetails),
          ],
        )
      } catch (recordErr) {
        console.error('Failed to record failed Entra sync run:', recordErr)
      }
    }
    throw error
  }
}

/**
 * Checks if Entra synchronization is overdue and runs an immediate sync pass if needed.
 */
export async function checkAndRunOverdueEntraSync(intervalMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    let isOverdue = false
    await withClient(getWorkerPool(), async (client) => {
      let res = await client.query<{ last_run_at: Date | null }>(`
        select max(run_at) as last_run_at
          from audit_trail.entra_sync_run
         where status in ('clean', 'deprovisioned')
      `)
      let lastRun = res.rows[0]?.last_run_at
      isOverdue = !lastRun || Date.now() - new Date(lastRun).getTime() >= intervalMs
    })
    if (isOverdue) {
      await runEntraDeprovisionSync()
    }
  } catch (err) {
    console.error('Failed to check or run overdue Entra sync:', err)
  }
}

let entraIntervalMs = 24 * 60 * 60 * 1000

const entraSyncScheduler = createScheduler({
  label: 'entra deprovision sync',
  intervalMs: entraIntervalMs,
  run: runEntraDeprovisionSync,
  onStart: () => checkAndRunOverdueEntraSync(entraIntervalMs),
  onError: (error, phase) =>
    phase === 'startup'
      ? console.error('Initial overdue entra sync check error:', error)
      : console.error('scheduled entra deprovision sync error:', error),
})

/**
 * Starts the periodic Entra deprovisioning sync scheduler (default: every 24 hours).
 * Runs an initial overdue check upon startup so server restarts do not delay sync.
 */
export function startEntraSyncScheduler(intervalMs = 24 * 60 * 60 * 1000): void {
  // Gracefully skip in dev/test if Entra credentials are not configured and no mock client set
  if (!process.env.MMS_ENTRA_CLIENT_SECRET && !hasCustomEntraDirectoryClient()) {
    return
  }
  entraIntervalMs = intervalMs
  entraSyncScheduler.start(intervalMs)
}

/**
 * Stops the periodic Entra deprovisioning sync scheduler.
 */
export function stopEntraSyncScheduler(): void {
  entraSyncScheduler.stop()
}

export function drainEntraSyncScheduler(timeoutMs = 15_000): Promise<void> {
  return entraSyncScheduler.drain(timeoutMs)
}
