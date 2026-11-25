import * as fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { parseDatabaseUrl, psql, repoRoot, requireDatabaseUrl } from '../db/scripts/lib.ts'
import { verifyPostgresVersion } from '../db/scripts/postgres-policy.ts'
import { ensureAcceptanceKeys } from './lib/test-keys.ts'

export async function startAcceptanceEnvironment(): Promise<void> {
  let rawUrl = requireDatabaseUrl()
  let parsed = parseDatabaseUrl(rawUrl)
  let pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'

  console.log('================================================================')
  console.log('Starting MMS Acceptance Environment Processes...')
  console.log('================================================================')

  // 1. Query and verify connected PostgreSQL server version
  let check = psql(
    rawUrl,
    ['-tA', '-c', "SELECT current_setting('server_version_num') || '|' || current_setting('server_version');"],
    { allowFailure: true },
  )
  if (check.status !== 0 || !check.stdout.trim().includes('|')) {
    console.error(`ERROR: PostgreSQL unreachable at ${parsed.host}:${parsed.port}/${parsed.database}. Please ensure PostgreSQL is running.`)
    process.exit(1)
  }

  let [numStr, verStr] = check.stdout.trim().split('|')
  let serverVersionNum = Number.parseInt(numStr!, 10)
  let vCheck = verifyPostgresVersion(serverVersionNum, verStr!)
  if (!vCheck.passed) {
    console.error(vCheck.error)
    process.exit(1)
  }
  console.log(`✓ ${vCheck.detail} verified reachable on ${parsed.host}:${parsed.port}/${parsed.database}`)

  // 2. Query and verify PostgREST binary version
  let pgrstCheck = spawnSync('postgrest', ['--version'], { encoding: 'utf8' })
  let pgrstOutput = (pgrstCheck.stdout ?? '').trim()
  let pgrstMatch = pgrstOutput.match(/PostgREST (\d+)\.(\d+)/)
  let pgrstMajor = pgrstMatch ? Number.parseInt(pgrstMatch[1]!, 10) : 0
  let pgrstMinor = pgrstMatch ? Number.parseInt(pgrstMatch[2]!, 10) : 0
  if (!pgrstMatch || pgrstMajor !== 16 || pgrstMinor !== 5) {
    console.error(`ERROR: PostgREST 16.5 is required by R8.6 baseline, found "${pgrstOutput}".`)
    process.exit(1)
  }

  // 3. Check PostgREST reachability and running version
  let pgrstRunning = false
  let runningPgrstVer = `${pgrstMajor}.${pgrstMinor}`
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 1500)
    let res = await fetch(`${pgrstUrl}/`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 200 || res.status === 404) {
      pgrstRunning = true
      let serverHeader = res.headers.get('server') ?? ''
      let matchHeader = serverHeader.match(/postgrest\/(\d+\.\d+)/i)
      if (matchHeader) {
        runningPgrstVer = matchHeader[1]!
        let [rMaj, rMin] = runningPgrstVer.split('.').map(Number)
        if (rMaj !== 16 || rMin !== 5) {
          console.error(`ERROR: Running PostgREST server version is ${runningPgrstVer}, expected 16.5.`)
          process.exit(1)
        }
      }
    }
  } catch {}

  if (pgrstRunning) {
    console.log(`✓ PostgREST ${runningPgrstVer} verified running on ${pgrstUrl}`)
  } else {
    console.log(`Starting native PostgREST ${pgrstMajor}.${pgrstMinor} on ${pgrstUrl}...`)
    let keySet = ensureAcceptanceKeys()
    let pgrstDbUri =
      process.env.PGRST_DB_URI ??
      (process.env.LOCAL_AUTHENTICATOR_PASSWORD
        ? `postgres://authenticator:${process.env.LOCAL_AUTHENTICATOR_PASSWORD}@${parsed.host}:${parsed.port}/${parsed.database}`
        : `postgres://authenticator@${parsed.host}:${parsed.port}/${parsed.database}`)

    let pgrstEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      PGRST_DB_URI: pgrstDbUri,
      PGRST_DB_SCHEMAS: 'api',
      PGRST_DB_ANON_ROLE: 'web_anon',
      PGRST_SERVER_PORT: '3001',
      PGRST_JWT_AUD: 'mms-api',
      PGRST_JWT_ROLE_CLAIM_KEY: '$.role',
      PGRST_DB_PRE_REQUEST: 'private.pre_request',
      PGRST_OPENAPI_MODE: 'disabled',
    }
    if (process.env.PGRST_JWT_SECRET) {
      pgrstEnv.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET
    } else {
      pgrstEnv.PGRST_JWT_SECRET = `@${keySet.jwksPath}`
    }
    let pgrstProc = spawn('postgrest', [], {
      env: pgrstEnv,
      detached: true,
      stdio: 'ignore',
    })
    pgrstProc.unref()
    console.log(`✓ Spawned native PostgREST ${pgrstMajor}.${pgrstMinor} background process (PID ${pgrstProc.pid})`)
  }

  console.log('----------------------------------------------------------------')
  console.log('Ready to start application server! You can run:')
  console.log('  npm run dev          # Start MMS Web server')
  console.log('  npm run start:worker # Start separate worker process')
  console.log('  npm run start:sealer # Start separate audit sealer process')
  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('testenv-start.ts')) {
  startAcceptanceEnvironment().catch((err) => {
    console.error('Failed to start test environment:', err.message)
    process.exit(1)
  })
}
