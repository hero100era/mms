import * as path from 'node:path'

import { parseDatabaseUrl, psql, repoRoot, requireDatabaseUrl } from './lib.ts'
import {
  assertCanDestroyDatabase,
  isDisposableDatabaseName,
  readDatabaseComment,
  readTableMarker,
} from './testenv-safety.ts'

export function seedTestDatabase(databaseUrl?: string): void {
  let url = databaseUrl ?? requireDatabaseUrl()
  let parts = parseDatabaseUrl(url)
  let database = parts.database

  // Prohibit running against unmarked or production database (R8.6.6)
  let adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'

  let comment = readDatabaseComment(adminUrl.toString(), database)
  let tableMarker = readTableMarker(url)

  let isMarkedDisposable = (comment && comment.includes('MMS_DISPOSABLE_ENV')) || tableMarker?.isDisposable === true
  let isProduction = (comment && comment.includes('MMS_PRODUCTION_ENV')) || process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production'

  if (isProduction) {
    throw new Error(`ABORT: db:seed:test is strictly forbidden against production database "${database}".`)
  }

  if (database === 'postgres') {
    throw new Error(`ABORT: db:seed:test cannot run against administrative database "postgres".`)
  }

  if (database === 'mms_dev') {
    throw new Error(`ABORT: db:seed:test cannot run against development database "mms_dev".`)
  }

  if (!isDisposableDatabaseName(database)) {
    throw new Error(
      `ABORT: Database "${database}" is not an authorized disposable database name (must end in _acceptance, _test, _drill, _scratch, _restore). Refusing to seed test fixtures.`,
    )
  }

  // Refuse against unmarked database - positive marker verification is strictly required
  if (!isMarkedDisposable) {
    throw new Error(
      `ABORT: Database "${database}" is not positively marked as disposable (missing MMS_DISPOSABLE_ENV marker). Refusing to seed test fixtures.`,
    )
  }

  console.log(`[db:seed:test] Seeding deterministic fixtures into ${database}...`)

  // 1. Base organization fixtures
  let orgSqlPath = path.join(repoRoot, 'db', 'fixtures', 'org.sql')
  psql(url, ['-f', orgSqlPath])

  // 2. Deterministic testenv fixtures
  let testenvSqlPath = path.join(repoRoot, 'db', 'fixtures', 'testenv-fixtures.sql')
  psql(url, ['-f', testenvSqlPath])

  // 3. Notify PostgREST to reload schema cache
  psql(url, ['-c', "NOTIFY pgrst, 'reload schema';"], { allowFailure: true })

  console.log(`[db:seed:test] Successfully seeded deterministic fixtures into ${database}:`)
  console.log(`  - 2 Organizations (TEST ABC SHIPPING LTD, TEST XYZ MARITIME LTD)`)
  console.log(`  - 3 Synthetic Vessels (MV TEST ALPHA, MV TEST BRAVO, MV TEST CHARLIE)`)
  console.log(`  - 15 Test Personas (customers, surveyors, managers, coordinators, compliance, hr, finance, sysadmin, expired, break-glass)`)
  console.log(`  - 5 Workflow Requests (draft, submitted, triage, accepted, rejected)`)
}

if (process.argv[1] && process.argv[1].endsWith('seed-test.ts')) {
  try {
    seedTestDatabase()
  } catch (err: any) {
    console.error(err.message)
    process.exit(1)
  }
}
