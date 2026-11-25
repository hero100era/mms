// Card H-11: the sealing deployment. Separate from both the web tier and the worker,
// connecting as `audit_sealer` and nothing else.
//
// Tier-2 sealing exists so that the audit trail is copied to WORM storage by something
// that does not share administration with the application. Running it inside the web
// process would quietly undo that: whoever can deploy the application could also run,
// stop, or stall sealing under a role the application holds. `npm run start:sealer` is
// the only thing that starts this work.

import { sealHorizon } from './app/audit_trail/sealer.ts'
import { reconcileAuditEvents } from './app/audit_trail/reconciler.ts'
import { verifyAuditSeals } from './app/audit_trail/verifier.ts'
import { defaultAlerter, OutboxAlertSink } from './app/audit_trail/alerter.ts'
import { closeSealerPool, getSealerPool } from './app/audit_trail/sealer-client.ts'
import { assertPlan, runtimePlan } from './app/jobs/runtime.ts'
import { createScheduler } from './app/jobs/scheduler.ts'
import { assertDevAuthAllowed } from './app/auth/dev-stub.ts'

assertDevAuthAllowed()

const plan = runtimePlan()
assertPlan(plan)
if (!plan.sealer) {
  throw new Error(
    `MMS_RUNTIME_ROLE=${plan.role} does not seal; this entrypoint is for the sealer deployment`,
  )
}

// Sealing is idempotent per horizon, so a missed tick is recovered by the next one. The
// interval is a cadence, not a deadline: `audit_trail.seal` records the horizon each seal
// covered, and the verifier checks the chain, so a gap is visible rather than silent.
defaultAlerter.addSink(new OutboxAlertSink(getSealerPool()))

const INTERVAL_MS = Number.parseInt(process.env.MMS_SEAL_INTERVAL_SECONDS ?? '900', 10) * 1000

let inFlight = false

async function runOnce(trigger: string): Promise<void> {
  // Overlapping runs would compute the same horizon twice and race on the chain head.
  if (inFlight) {
    console.log(`Sealer skipped (${trigger}): previous run still in flight`)
    return
  }
  inFlight = true
  let startedAt = Date.now()
  try {
    let result = await sealHorizon({ alerter: defaultAlerter })
    if (!result.sealed) {
      console.log(`Sealer ${trigger}: nothing to seal (${result.reason ?? 'empty horizon'})`)
    } else {
      console.log(
        `Sealer ${trigger}: sealed ${result.fromXid}..${result.toXid} ` +
          `(${result.changeLogCount} changes, ${result.eventCount} events) in ` +
          `${Date.now() - startedAt}ms -> ${result.wormUri}`,
      )
    }
    if (result.lagWarning) console.error(`Sealer lag warning: ${result.lagWarning}`)
  } catch (error) {
    // A failed seal must not kill the process: the horizon is unchanged, and the next
    // tick retries it. It must be loud, though, because an unsealed horizon is exactly
    // what the control is there to bound.
    console.error('Sealer run failed:', error)
  } finally {
    inFlight = false
  }
}

// Deliberately keepAlive: the sealer must stay alive between ticks, including after a
// failed run, or a transient WORM outage would silently end the deployment.
const sealScheduler = createScheduler({
  label: 'sealer',
  intervalMs: INTERVAL_MS,
  run: () => runOnce('scheduled'),
  keepAlive: true,
})

const RECONCILE_INTERVAL_MS =
  Number.parseInt(process.env.MMS_RECONCILE_INTERVAL_SECONDS ?? '3600', 10) * 1000
const VERIFY_INTERVAL_MS =
  Number.parseInt(process.env.MMS_VERIFY_INTERVAL_SECONDS ?? '21600', 10) * 1000

const reconcileScheduler = createScheduler({
  label: 'audit reconciliation',
  intervalMs: RECONCILE_INTERVAL_MS,
  run: async () => {
    try {
      let report = await reconcileAuditEvents({ alerter: defaultAlerter })
      if (report.status === 'discrepancies_found') {
        console.error(`Reconciliation detected ${report.discrepancyCount} discrepancy(ies)`)
      }
    } catch (err) {
      console.error('Audit reconciliation run failed:', err)
    }
  },
  keepAlive: true,
})

const verifyScheduler = createScheduler({
  label: 'audit verification',
  intervalMs: VERIFY_INTERVAL_MS,
  run: async () => {
    try {
      let report = await verifyAuditSeals({ alerter: defaultAlerter, alertOnZeroRecords: false })
      if (report.status !== 'PASS') {
        console.error(`Audit verification detected ${report.errors.length} tamper/gap error(s)`)
      }
    } catch (err) {
      console.error('Audit verification run failed:', err)
    }
  },
  keepAlive: true,
})

// The first seal runs before the timer is installed, so a restart never leaves a
// horizon waiting for a full interval.
await runOnce('startup')
sealScheduler.start()
reconcileScheduler.start()
verifyScheduler.start()

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Sealer stopping on ${signal}; draining in-flight runs...`)
  await Promise.allSettled([
    verifyScheduler.drain(15_000),
    reconcileScheduler.drain(15_000),
    sealScheduler.drain(15_000),
  ])
  await closeSealerPool().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
