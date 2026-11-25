import { defaultAlerter } from '../audit_trail/alerter.ts'
import { alertBreakGlassActivated, sweepExpiredBreakGlass } from './break-glass-alerts.ts'
import { devMailbox } from './dev-mailbox.ts'
import { runEntraDeprovisionSync } from './entra-sync.ts'
import { scanQuarantinedDocumentVersion } from './malware-scanner.ts'
import { createScheduler } from './scheduler.ts'
import { getWorkerPool } from './worker-client.ts'

export type OutboxJob = {
  id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
  enqueued_by: string | null
}

export interface PollOptions {
  limit?: number
  leaseSeconds?: number
  workerId?: string
  retryTransient?: boolean
  defaultRetryDelaySeconds?: number
}

export async function heartbeatJob(jobId: string, extendSeconds = 60): Promise<void> {
  await getWorkerPool().query('select private.job_heartbeat($1, $2)', [jobId, extendSeconds])
}

export async function pollOnce(options?: PollOptions): Promise<number> {
  let pool = getWorkerPool()
  let limit = options?.limit ?? 10
  let leaseSeconds = options?.leaseSeconds ?? 60
  let workerId = options?.workerId ?? null
  let retryTransient = options?.retryTransient ?? true
  let retryDelay = options?.defaultRetryDelaySeconds ?? null

  // R8.5: Asynchronous cleanup of expired break-glass accounts
  await sweepExpiredBreakGlass().catch(() => 0)

  let pollRes = await pool.query<OutboxJob>(
    'select id, kind, payload, attempts, enqueued_by from private.job_poll($1)',
    [limit],
  )
  let jobs = pollRes.rows
  if (jobs.length === 0) return 0

  let processedCount = 0
  for (let job of jobs) {
    let begun = false
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    try {
      let beginRes = await pool.query<{ job: { id: string; kind: string; payload: Record<string, unknown> } }>(
        'select private.job_begin($1, $2, $3) as job',
        [job.id, leaseSeconds, workerId],
      )
      begun = true
      let currentJob = beginRes.rows[0]?.job ?? job

      // Renew lease periodically while long-running jobs execute so another
      // worker cannot reclaim and run the same job concurrently.
      let heartbeatIntervalMs = Math.max(1000, Math.floor((leaseSeconds * 1000) / 2))
      heartbeatTimer = setInterval(() => {
        void heartbeatJob(job.id, leaseSeconds).catch((err) => {
          console.error(`Failed to heartbeat outbox job ${job.id}:`, err)
        })
      }, heartbeatIntervalMs)
      heartbeatTimer.unref()

      if (currentJob.kind === 'invite_email') {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Production email transport is not configured; refusing to send invite_email to devMailbox')
        }
        let email = String(currentJob.payload.email ?? '')
        let token = String(currentJob.payload.token ?? '')
        devMailbox.send({
          to: email,
          subject: 'Invitation to MMS',
          payload: {
            ...currentJob.payload,
            inviteUrl: `/invite/${token}`,
          },
        })
      } else if (currentJob.kind === 'password_reset_email') {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Production email transport is not configured; refusing to send password_reset_email to devMailbox')
        }
        let email = String(currentJob.payload.email ?? '')
        let token = String(currentJob.payload.token ?? '')
        devMailbox.send({
          to: email,
          subject: 'Reset your MMS password',
          payload: {
            ...currentJob.payload,
            resetUrl: `/reset-password/${token}`,
          },
        })
      } else if (currentJob.kind === 'entra_deprovision_sync') {
        await runEntraDeprovisionSync()
      } else if (currentJob.kind === 'malware_scan') {
        let versionId = String(currentJob.payload.versionId ?? '')
        if (versionId) {
          await scanQuarantinedDocumentVersion(versionId)
        }
      } else if (currentJob.kind === 'break_glass_alert') {
        // R1.6: activation writes two outbox rows transactionally (IT security
        // and HO Compliance). Until this branch existed they were claimed and
        // silently marked done without ever leaving the process.
        await alertBreakGlassActivated(
          String(currentJob.payload.user_id ?? ''),
          currentJob.payload.valid_until == null ? null : String(currentJob.payload.valid_until),
          currentJob.payload.reason == null ? null : String(currentJob.payload.reason),
        )
      } else if (currentJob.kind === 'security_alert') {
        // R8.5: Security-critical event alert delivery with durable retries & dead-letter queue
        let alertType = String(currentJob.payload.alert_type ?? '')
        let severity = (currentJob.payload.severity ?? 'WARNING') as any
        let source = String(currentJob.payload.source ?? 'outbox')
        let message = String(currentJob.payload.message ?? '')
        let details = (currentJob.payload.details as Record<string, unknown>) ?? {}
        await defaultAlerter.emitDirect(alertType as any, severity, source, message, details)
      } else {
        // An unrecognised kind must not be acknowledged. Marking it `failed`
        // makes the gap visible in the outbox instead of losing the work.
        throw new Error(`unknown_outbox_kind: ${currentJob.kind}`)
      }

      await pool.query('select private.job_complete($1, $2)', [job.id, 'done'])
      processedCount++
    } catch (error) {
      if (begun) {
        try {
          let msg = error instanceof Error ? error.message : 'Unknown error'
          if (retryTransient) {
            let isFatal = /unknown_outbox_kind/.test(msg)
            let status = isFatal ? 'dead_letter' : 'retry'
            let errorClass = isFatal ? 'fatal' : 'transient'
            await pool.query('select private.job_complete($1, $2, $3, $4, $5)', [
              job.id,
              status,
              msg,
              errorClass,
              retryDelay,
            ])
          } else {
            await pool.query('select private.job_complete($1, $2, $3, $4)', [
              job.id,
              'failed',
              msg,
              'unhandled',
            ])
          }
          processedCount++
        } catch (secondaryError) {
          console.error('Failed to complete job as failed:', secondaryError)
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }
  }
  return processedCount
}

const outboxScheduler = createScheduler({
  label: 'outbox poller',
  intervalMs: 5000,
  run: () => pollOnce({ retryTransient: true }),
  onError: (error) => console.error('outbox poller error:', error),
})

export function startOutboxPoller(intervalMs = 5000, options?: { keepAlive?: boolean }): void {
  outboxScheduler.start(intervalMs, options)
}

export function stopOutboxPoller(): void {
  outboxScheduler.stop()
}

export function drainOutboxPoller(timeoutMs = 15_000): Promise<void> {
  return outboxScheduler.drain(timeoutMs)
}
