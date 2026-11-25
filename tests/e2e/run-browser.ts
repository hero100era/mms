import * as http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'
import { setPeerAddress } from '../../apps/web/app/middleware/request-context.ts'
import { router } from '../../apps/web/app/router.ts'
import { requireDatabaseUrl } from '../../db/scripts/lib.ts'

import { closeSharedBrowser } from './browser/helpers/browser-auth.ts'
import { runPW001StationIsolation } from './browser/pw-001-station-isolation.test.ts'
import { runPW002CustomerIsolation } from './browser/pw-002-customer-isolation.test.ts'
import { runPW003SysadminSod } from './browser/pw-003-sysadmin-sod.test.ts'
import { runPW004ExpiredQualification } from './browser/pw-004-expired-qualification.test.ts'

export async function runBrowserE2ESuite(): Promise<void> {
  console.log('================================================================')
  console.log('MMS R8.6 Real Playwright Browser Acceptance Suite (Chromium)')
  console.log('================================================================')

  // Set test environment switches
  process.env.APP_ENV = 'test'
  process.env.NODE_ENV = 'test'
  process.env.ALLOW_DEV_LOGIN = 'true'

  requireDatabaseUrl()

  let testPort = 44100
  let baseUrl = process.env.APPLICATION_BASE_URL ?? `http://localhost:${testPort}`

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
    server.on('error', (err) => console.error('SERVER ERROR:', err))
    server.on('close', () => console.log('SERVER CLOSED EVENT'))
    await new Promise<void>((resolve) => {
      server!.listen(testPort, '127.0.0.1', () => resolve())
    })
    console.log(`Acceptance server listening on ${baseUrl}`)
  }

  process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err))
  process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err))

  try {
    console.log('----------------------------------------------------------------')
    console.log('Running Real Playwright Browser Scenarios (Chromium):')
    console.log('----------------------------------------------------------------')

    console.log('>> Executing PW-001...')
    await runPW001StationIsolation(baseUrl)
    console.log('>> Executing PW-002...')
    await runPW002CustomerIsolation(baseUrl)
    console.log('>> Executing PW-003...')
    await runPW003SysadminSod(baseUrl)
    console.log('>> Executing PW-004...')
    await runPW004ExpiredQualification(baseUrl)

    console.log('================================================================')
    console.log('PASS: All Playwright browser tests (PW-001 through PW-004) passed.')
    console.log('================================================================')
  } catch (err) {
    console.error('Playwright suite execution threw error:', err)
    throw err
  } finally {
    await closeSharedBrowser()
    if (server) {
      console.log('Stopping acceptance HTTP server...')
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('run-browser.ts')) {
  runBrowserE2ESuite()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error('FAIL: Playwright browser acceptance suite failed:', err)
      process.exit(1)
    })
}
