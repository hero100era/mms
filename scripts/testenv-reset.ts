import * as path from 'node:path'

import {
  applyBootstrap,
  applyMigrations,
  parseDatabaseUrl,
  psql,
  redactDatabaseUrl,
  repoRoot,
  requireDatabaseUrl,
  run,
  withDatabase,
} from '../db/scripts/lib.ts'
import { seedTestDatabase } from '../db/scripts/seed-test.ts'
import {
  assertCanDestroyDatabase,
  setDisposableMarker,
  terminateDatabaseSessions,
} from '../db/scripts/testenv-safety.ts'

export async function resetAcceptanceEnvironment(
  targetDatabase?: string,
  options: { allowInitialCreate?: boolean } = {},
): Promise<void> {
  let rawUrl = requireDatabaseUrl()
  let parts = parseDatabaseUrl(rawUrl)
  let actualTarget = targetDatabase ?? (parts.database || 'mms_acceptance')
  let targetUrl = withDatabase(rawUrl, actualTarget)
  let adminUrl = withDatabase(rawUrl, 'postgres')

  console.log(`================================================================`)
  console.log(`[testenv:reset] Starting deterministic reset of ${actualTarget}`)
  console.log(`================================================================`)

  // 1. Run safety checks (R8.6.4)
  console.log(`[1/10] Verifying safety invariants and disposable destination...`)
  assertCanDestroyDatabase({
    databaseUrl: targetUrl,
    targetDatabase: actualTarget,
    appEnv: process.env.APP_ENV ?? 'test',
    allowInitialCreate: options.allowInitialCreate,
  })

  // 2. Terminate only acceptance DB sessions
  console.log(`[2/10] Terminating active connections to ${actualTarget}...`)
  let terminated = terminateDatabaseSessions(adminUrl, actualTarget)
  if (terminated > 0) {
    console.log(`  Terminated ${terminated} active session(s) on ${actualTarget}`)
  }

  // 3. Drop target database
  console.log(`[3/10] Dropping disposable database ${actualTarget}...`)
  psql(adminUrl, ['-c', `drop database if exists "${actualTarget}" with (force)`])

  // 4. Create blank target database
  console.log(`[4/10] Creating blank database ${actualTarget}...`)
  psql(adminUrl, ['-c', `create database "${actualTarget}" encoding 'UTF8' template template0`])
  psql(adminUrl, ['-c', `alter database "${actualTarget}" set timezone to 'UTC'`])

  // 5. Mark database with durable disposable marker (R8.6.4)
  console.log(`[5/10] Applying durable disposable environment marker...`)
  setDisposableMarker(adminUrl, targetUrl, actualTarget, 'acceptance')

  // 6. Bootstrap required roles and extensions
  console.log(`[6/10] Bootstrapping roles, schemas, extensions via normal MMS mechanism...`)
  applyBootstrap(targetUrl)

  // 7. Apply every repository migration
  console.log(`[7/10] Applying all repository migrations...`)
  applyMigrations(targetUrl)

  // 8. Run schema/database checks
  console.log(`[8/10] Running schema and lint verification...`)
  run('node', ['db/scripts/lint-schema.ts'], { cwd: repoRoot, env: { DATABASE_URL: targetUrl } })

  // 9. Load deterministic fixtures
  console.log(`[9/10] Loading deterministic fixtures (organizations, personas, ships, workflows)...`)
  seedTestDatabase(targetUrl)

  // 10. Verify PostgREST connectivity & notify reload
  console.log(`[10/10] Verifying PostgREST connectivity & reloading schema cache...`)
  psql(targetUrl, ['-c', "NOTIFY pgrst, 'reload schema';"], { allowFailure: true })

  let pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 2000)
    let res = await fetch(`${pgrstUrl}/`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.ok || res.status === 404 || res.status === 200) {
      console.log(`  PostgREST responding at ${pgrstUrl} (status ${res.status})`)
    }
  } catch {
    console.log(`  Note: PostgREST is not currently running on ${pgrstUrl}. Start it with 'npm run postgrest:test'.`)
  }

  console.log(`================================================================`)
  console.log(`[testenv:reset] Acceptance environment ${actualTarget} is READY!`)
  console.log(`================================================================`)
}

if (process.argv[1] && process.argv[1].endsWith('testenv-reset.ts')) {
  let dbArgIdx = process.argv.indexOf('--database')
  let targetFromArg = dbArgIdx !== -1 && process.argv[dbArgIdx + 1] ? process.argv[dbArgIdx + 1] : undefined
  let allowInit = process.argv.includes('--allow-initial-create') || process.env.ALLOW_INITIAL_CREATE === '1'

  resetAcceptanceEnvironment(targetFromArg, { allowInitialCreate: allowInit })
    .then(() => process.exit(0))
    .catch((err: any) => {
      console.error(err.message)
      process.exit(1)
    })
}
