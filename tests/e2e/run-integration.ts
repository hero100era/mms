import * as http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'
import { setPeerAddress } from '../../apps/web/app/middleware/request-context.ts'
import { router } from '../../apps/web/app/router.ts'
import { requireDatabaseUrl } from '../../db/scripts/lib.ts'

import { runStationIsolationTest } from './authorization/station-isolation.test.ts'
import { runCustomerIsolationTest } from './authorization/customer-isolation.test.ts'
import { runSysadminSodTest } from './authorization/sysadmin-sod.test.ts'
import { runExpiredQualificationTest } from './authorization/expired-qualification.test.ts'
import { runDirectPostgrestTests } from './postgrest/direct-pgrst.test.ts'

export async function runIntegrationAcceptanceSuite(): Promise<void> {
  console.log('================================================================')
  console.log('MMS R8.6 HTTP/Router Acceptance Integration Suite')
  console.log('================================================================')

  // Set test environment switches
  process.env.APP_ENV = 'test'
  process.env.NODE_ENV = 'test'
  process.env.ALLOW_DEV_LOGIN = 'true'
  
  // Require explicit DATABASE_URL (no embedded credentials or password fallbacks)
  requireDatabaseUrl()

  let testPort = 44100
  let baseUrl = process.env.APPLICATION_BASE_URL ?? `http://localhost:${testPort}`
  let pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'

  // Check if an existing server is running at baseUrl
  let existingServer = false
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 1000)
    let res = await fetch(`${baseUrl}/login`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 200) {
      existingServer = true
      console.log(`Using existing MMS web server running at ${baseUrl}`)
    }
  } catch {}

  let server: http.Server | null = null
  if (!existingServer) {
    console.log(`Starting in-process acceptance HTTP server on port ${testPort}...`)
    let requestListener = createRequestListener(
      (request: Request, client: { address: string }) => {
        setPeerAddress(request, client.address)
        return router.fetch(request)
      },
      { trustProxy: true },
    )
    server = http.createServer(requestListener)
    await new Promise<void>((resolve) => {
      server!.listen(testPort, '127.0.0.1', () => resolve())
    })
    console.log(`Acceptance server listening on ${baseUrl}`)
  }

  try {
    console.log('----------------------------------------------------------------')
    console.log('Running HTTP/Router Acceptance Scenarios:')
    console.log('----------------------------------------------------------------')

    await runStationIsolationTest(baseUrl)
    await runCustomerIsolationTest(baseUrl)
    await runSysadminSodTest(baseUrl)
    await runExpiredQualificationTest(baseUrl)

    console.log('----------------------------------------------------------------')
    console.log('Running Direct PostgREST Acceptance Suite:')
    console.log('----------------------------------------------------------------')
    await runDirectPostgrestTests(pgrstUrl)

    console.log('================================================================')
    console.log('PASS: All HTTP/Router and Direct PostgREST tests passed.')
    console.log('================================================================')
  } finally {
    if (server) {
      console.log('Stopping acceptance HTTP server...')
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('run-integration.ts')) {
  runIntegrationAcceptanceSuite()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error('FAIL: Integration acceptance suite failed:', err)
      process.exit(1)
    })
}
