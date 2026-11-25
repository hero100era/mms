// Card H-11: the job deployment. No HTTP listener, no request path, and only the
// `worker` database role (see app/jobs/worker-client.ts). Run it with
// `MMS_RUNTIME_ROLE=worker npm run start:worker`.
//
// It runs the outbox poller, the outbox-driven side effects it knows how to dispatch,
// the Entra deprovisioning sync and the malware scanner. Splitting this out of the web
// process is what lets the web tier hold no `worker` credential at all.

import { drainBreakGlassDrillScheduler, startBreakGlassDrillScheduler } from './app/jobs/break-glass-alerts.ts'
import { drainEntraSyncScheduler, startEntraSyncScheduler } from './app/jobs/entra-sync.ts'
import { drainMalwareScanScheduler, startMalwareScanScheduler } from './app/jobs/malware-scanner.ts'
import { drainQuarantineSweepScheduler, startQuarantineSweepScheduler } from './app/jobs/quarantine-sweep.ts'
import { drainOutboxPoller, startOutboxPoller } from './app/jobs/poller.ts'
import { assertPlan, runtimePlan } from './app/jobs/runtime.ts'
import { defaultAlerter, OutboxAlertSink } from './app/audit_trail/alerter.ts'
import { closeWorkerPool, getWorkerPool } from './app/jobs/worker-client.ts'
import { assertDevAuthAllowed } from './app/auth/dev-stub.ts'

assertDevAuthAllowed()

const plan = runtimePlan()
assertPlan(plan)
if (!plan.jobs) {
  throw new Error(
    `MMS_RUNTIME_ROLE=${plan.role} does not run application jobs; this entrypoint is for the worker`,
  )
}

defaultAlerter.addSink(new OutboxAlertSink(getWorkerPool()))
startOutboxPoller(undefined, { keepAlive: true })
startEntraSyncScheduler()
startMalwareScanScheduler()
startQuarantineSweepScheduler()
startBreakGlassDrillScheduler()
console.log(`Worker started (runtime role ${plan.role})`)

let shuttingDown = false

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Worker stopping on ${signal}; draining in-flight jobs...`)
  await Promise.allSettled([
    drainBreakGlassDrillScheduler(15_000),
    drainQuarantineSweepScheduler(15_000),
    drainMalwareScanScheduler(15_000),
    drainEntraSyncScheduler(15_000),
    drainOutboxPoller(15_000),
  ])
  await closeWorkerPool().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
