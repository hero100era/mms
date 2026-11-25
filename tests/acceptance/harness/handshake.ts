/**
 * tests/acceptance/harness/handshake.ts
 *
 * Server readiness detection and in-process server management for MMS Acceptance Tests.
 *
 * Implements:
 * - Server health probe targeting /__acceptance/health
 * - Fallback to /login status check (200 OK / 302) when /__acceptance/health is not yet available (pre-M3)
 * - Semantic PostgREST readiness check (probing root / OpenAPI spec at port 3001)
 * - Safe in-process server startup fallback when no external server is running
 */

import * as http from 'node:http'

export interface ServerProbeResult {
  healthy: boolean
  status: number
  endpoint: string
  latencyMs: number
  detail?: string
}

export interface PostgrestProbeResult {
  healthy: boolean
  status: number
  latencyMs: number
  detail?: string
}

export interface HandshakeResult {
  ready: boolean
  webServer: ServerProbeResult
  postgrest: PostgrestProbeResult
  baseUrl: string
  pgrstUrl: string
  totalTimeMs: number
}

export interface HandshakeOptions {
  baseUrl?: string
  pgrstUrl?: string
  timeoutMs?: number
  pollIntervalMs?: number
  allowPostgrest404?: boolean // For pre-P7.4 environments
}

/**
 * Probes the MMS Web Server readiness.
 * First checks /__acceptance/health (P7.1 standard).
 * If 404 or connection failure, falls back to /login check (HTTP 200/302).
 */
export async function probeWebServer(baseUrl: string): Promise<ServerProbeResult> {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const startTime = Date.now()

  // 1. Primary probe: /__acceptance/health
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const healthUrl = `${cleanBase}/__acceptance/health`
    const res = await fetch(healthUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timer)
    const latencyMs = Date.now() - startTime

    if (res.status === 200) {
      return {
        healthy: true,
        status: 200,
        endpoint: '/__acceptance/health',
        latencyMs,
        detail: 'Standard acceptance health endpoint ready',
      }
    }
  } catch {
    // Fall through to fallback
  }

  // 2. Fallback probe: /login
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const loginUrl = `${cleanBase}/login`
    const res = await fetch(loginUrl, { signal: controller.signal })
    clearTimeout(timer)
    const latencyMs = Date.now() - startTime

    if (res.status === 200 || res.status === 302) {
      return {
        healthy: true,
        status: res.status,
        endpoint: '/login (fallback)',
        latencyMs,
        detail: `Server responsive on /login (status ${res.status})`,
      }
    }

    return {
      healthy: false,
      status: res.status,
      endpoint: '/login (fallback)',
      latencyMs,
      detail: `Unexpected status ${res.status} on /login`,
    }
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      healthy: false,
      status: 0,
      endpoint: 'failed',
      latencyMs,
      detail: `Connection failed: ${errMsg}`,
    }
  }
}

/**
 * Probes PostgREST readiness at root endpoint /.
 */
export async function probePostgrest(
  pgrstUrl: string,
  options?: { allowPostgrest404?: boolean },
): Promise<PostgrestProbeResult> {
  const cleanUrl = pgrstUrl.replace(/\/+$/, '')
  const startTime = Date.now()
  const allow404 = options?.allowPostgrest404 ?? true // Allow 404 until Phase P7.4 migration

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(cleanUrl, { signal: controller.signal })
    clearTimeout(timer)
    const latencyMs = Date.now() - startTime

    // PostgREST returns 200 for OpenAPI schema document at root /.
    // In unmigrated dev setups, it may return 404 for unconfigured root schema.
    if (res.status === 200 || (allow404 && res.status === 404)) {
      return {
        healthy: true,
        status: res.status,
        latencyMs,
        detail: res.status === 200 ? 'PostgREST root OpenAPI available' : 'PostgREST server active (HTTP 404 fallback)',
      }
    }

    return {
      healthy: false,
      status: res.status,
      latencyMs,
      detail: `PostgREST returned unexpected status ${res.status}`,
    }
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      healthy: false,
      status: 0,
      latencyMs,
      detail: `PostgREST connection failed: ${errMsg}`,
    }
  }
}

/**
 * Ensures the target server and PostgREST are reachable, polling until ready or timeout.
 */
export async function ensureServerReady(options?: HandshakeOptions): Promise<HandshakeResult> {
  const baseUrl = options?.baseUrl ?? process.env.APPLICATION_BASE_URL ?? 'http://localhost:44100'
  const pgrstUrl = options?.pgrstUrl ?? process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'
  const timeoutMs = options?.timeoutMs ?? 10000
  const pollIntervalMs = options?.pollIntervalMs ?? 500
  const allowPostgrest404 = options?.allowPostgrest404 ?? true

  const overallStart = Date.now()

  let lastWebProbe: ServerProbeResult = {
    healthy: false,
    status: 0,
    endpoint: 'none',
    latencyMs: 0,
  }
  let lastPgrstProbe: PostgrestProbeResult = {
    healthy: false,
    status: 0,
    latencyMs: 0,
  }

  while (Date.now() - overallStart < timeoutMs) {
    lastWebProbe = await probeWebServer(baseUrl)
    lastPgrstProbe = await probePostgrest(pgrstUrl, { allowPostgrest404 })

    if (lastWebProbe.healthy && lastPgrstProbe.healthy) {
      return {
        ready: true,
        webServer: lastWebProbe,
        postgrest: lastPgrstProbe,
        baseUrl,
        pgrstUrl,
        totalTimeMs: Date.now() - overallStart,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  // If we reach here, handshake failed
  const failDetails: string[] = []
  if (!lastWebProbe.healthy) {
    failDetails.push(`Web Server at ${baseUrl} is NOT healthy: ${lastWebProbe.detail} (endpoint: ${lastWebProbe.endpoint})`)
  }
  if (!lastPgrstProbe.healthy) {
    failDetails.push(`PostgREST at ${pgrstUrl} is NOT healthy: ${lastPgrstProbe.detail}`)
  }

  throw new Error(
    `Acceptance Test Server Handshake failed after ${timeoutMs}ms:\n` +
      failDetails.map((d) => `  - ${d}`).join('\n') +
      '\n\nVerify that the MMS web server and test environment are active:\n' +
      '  npm run testenv:status\n' +
      '  npm run testenv:start\n',
  )
}

export interface InProcessServerHandle {
  server: http.Server | null
  baseUrl: string
  close: () => Promise<void>
}

/**
 * Detects whether an external server is running at baseUrl. If not, starts
 * an in-process HTTP server using Remix requestListener and router.
 */
export async function startInProcessServerIfNeeded(options?: {
  port?: number
  baseUrl?: string
}): Promise<InProcessServerHandle> {
  const port = options?.port ?? 44100
  const baseUrl = options?.baseUrl ?? process.env.APPLICATION_BASE_URL ?? `http://localhost:${port}`

  const probe = await probeWebServer(baseUrl)
  if (probe.healthy) {
    return {
      server: null,
      baseUrl,
      close: async () => {},
    }
  }

  // Dynamically import Remix router and server listener
  const { createRequestListener } = await import('remix/node-fetch-server')
  const { setPeerAddress } = await import('../../../apps/web/app/middleware/request-context.ts')
  const { router } = await import('../../../apps/web/app/router.ts')

  process.env.APP_ENV = 'test'
  process.env.NODE_ENV = 'test'
  process.env.ALLOW_DEV_LOGIN = 'true'

  const requestListener = createRequestListener(
    (request: Request, client: { address: string }) => {
      setPeerAddress(request, client.address)
      return router.fetch(request)
    },
    { trustProxy: true },
  )

  const server = http.createServer(requestListener)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    server,
    baseUrl,
    close: async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
        })
      }
    },
  }
}
