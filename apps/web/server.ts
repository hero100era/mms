import * as http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'

import { assertDevAuthAllowed } from './app/auth/dev-stub.ts'
import { startBreakGlassDrillScheduler, stopBreakGlassDrillScheduler } from './app/jobs/break-glass-alerts.ts'
import { startEntraSyncScheduler, stopEntraSyncScheduler } from './app/jobs/entra-sync.ts'
import { startMalwareScanScheduler, stopMalwareScanScheduler } from './app/jobs/malware-scanner.ts'
import { startQuarantineSweepScheduler, stopQuarantineSweepScheduler } from './app/jobs/quarantine-sweep.ts'
import { startOutboxPoller, stopOutboxPoller } from './app/jobs/poller.ts'
import { assertPlan, runtimePlan } from './app/jobs/runtime.ts'
import { closeGatewayPool } from './app/auth/gateway-client.ts'
import { closeWorkerPool } from './app/jobs/worker-client.ts'
import { setPeerAddress } from './app/middleware/request-context.ts'
import { router } from './app/router.ts'

assertDevAuthAllowed()

// Card H-11: the web tier serves HTTP. The job and sealer deployments are separate
// processes (see apps/web/worker.ts and apps/web/sealer.ts) so the web tier does not
// hold their database roles; in development the single process still does everything.
const plan = runtimePlan()
assertPlan(plan)
if (!plan.http) {
  throw new Error(
    `MMS_RUNTIME_ROLE=${plan.role} does not serve HTTP; start worker.ts or sealer.ts instead`,
  )
}

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 44100
const hmrProxyPort = process.env.HMR_PROXY_PORT
  ? Number.parseInt(process.env.HMR_PROXY_PORT, 10)
  : null
const isHmr = process.env.REMIX_NODE_HMR === '1'

// A two-argument fetch handler makes the Node adapter pass the real peer address.
// `router.fetch` alone is a one-argument handler, so the address was previously
// discarded and every direct caller collapsed to the 0.0.0.0 throttle bucket.
const requestListener = createRequestListener(
  (request: Request, client: { address: string }) => {
    setPeerAddress(request, client.address)
    return router.fetch(request)
  },
  { trustProxy: isHmr },
)

const server = http.createServer(requestListener)

const host =
  process.env.HOST ?? (process.env.MMS_AUTH_STUB === '1' || isHmr ? '127.0.0.1' : '0.0.0.0')

server.listen(port, host, () => {
  if (isHmr) {
    import('remix/node-hmr/runtime').then((nodeHmr) => nodeHmr.emitServerReady())
  }

  if (plan.jobs) {
    startOutboxPoller()
    startEntraSyncScheduler()
    startMalwareScanScheduler()
    startQuarantineSweepScheduler()
    startBreakGlassDrillScheduler()
  }
  console.log(`Server listening on http://localhost:${hmrProxyPort ?? port}`)
})

let shuttingDown = false

function shutdown() {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  stopQuarantineSweepScheduler()
  stopMalwareScanScheduler()
  stopEntraSyncScheduler()
  stopBreakGlassDrillScheduler()
  stopOutboxPoller()

  let forceTimer = setTimeout(() => {
    server.closeAllConnections()
    process.exit(1)
  }, 10_000)
  forceTimer.unref()

  server.close(() => {
    Promise.allSettled([closeWorkerPool(), closeGatewayPool()]).finally(() => {
      clearTimeout(forceTimer)
      process.exit(0)
    })
  })
  server.closeIdleConnections()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
