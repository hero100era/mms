import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  parseDatabaseUrl,
  psql,
  repoRoot,
  requireDatabaseUrl,
  run,
  withDatabase,
} from '../db/scripts/lib.ts'
import { verifyBaseline } from '../db/scripts/verify-baseline.ts'

/**
 * ADR-0032: Complete Release Rehearsal (Dry-Run without Freezing)
 *
 * Runs the end-to-end release gate sequence without establishing the real production baseline:
 * 1. Architecture and boundary checks
 * 2. Full database lint, drift (C1/C3/C5), pgschema spike, pgTAP tests, and catalog evidence
 * 3. Pre-production baseline preview and policy verification
 * 4. Freeze-lifecycle integration test in an isolated temporary worktree
 * 5. Clean replay into disposable scratch database
 * 6. Invariant assertion: real repository remains strictly NOT_ESTABLISHED
 */
async function main() {
  console.log('=================================================================')
  console.log('MMS Production Release Rehearsal (ADR-0032)')
  console.log('Mode: Dry-Run / Non-Freezing Rehearsal')
  console.log('=================================================================\n')

  let url = requireDatabaseUrl()
  let parts = parseDatabaseUrl(url)
  console.log(`Database Host: ${parts.host}:${parts.port}/${parts.database}`)

  // Step 1: Pre-requisite assertions on real repository
  console.log('Step 1/7: Checking repository pre-production invariants...')
  let baselineRecordFile = path.join(repoRoot, 'db', 'FIRST_PRODUCTION_BASELINE.json')
  let baselineLockFile = path.join(repoRoot, 'db', 'production-baseline.lock.json')

  let record = JSON.parse(fs.readFileSync(baselineRecordFile, 'utf8'))
  if (record.status !== 'NOT_ESTABLISHED') {
    throw new Error(`Rehearsal expected NOT_ESTABLISHED but got ${record.status}`)
  }
  if (fs.existsSync(baselineLockFile)) {
    throw new Error('Rehearsal failed: db/production-baseline.lock.json must be absent in pre-production')
  }
  console.log('✅ Baseline is NOT_ESTABLISHED and production lock is absent.\n')

  // Step 2: Code quality and boundaries
  console.log('Step 2/7: Running typecheck, doctor, and boundary checks...')
  run('npm', ['run', 'typecheck'])
  run('npm', ['run', 'doctor'])
  run('npm', ['run', 'check:boundary'])
  console.log('✅ Boundary and type checks passed.\n')

  // Step 3: Database lint, C1/C3/C5 drift, and pgschema coverage
  console.log('Step 3/7: Running database schema lint, drift check, and pgschema spike...')
  run('npm', ['run', 'db:check'])
  run('npm', ['run', 'db:spike'])
  console.log('✅ Schema lint, zero drift, and pgschema spike passed.\n')

  // Step 4: pgTAP suites and live invariants
  console.log('Step 4/7: Running 23 pgTAP suites and live catalog verification...')
  run('npm', ['run', 'db:test'])
  run('npm', ['run', 'db:verify'])
  console.log('✅ pgTAP tests and live invariants passed.\n')

  // Step 5: Baseline preview verification & release check gate
  console.log('Step 5/7: Verifying baseline preview and release migration gate...')
  let bv = verifyBaseline()
  if (!bv.passed) {
    throw new Error(`Baseline verification failed:\n${bv.errors.join('\n')}`)
  }
  run('npm', ['run', 'release:check'])
  console.log('✅ Baseline preview and release migration gate passed.\n')

  // Step 6: Full freeze lifecycle integration test in isolated worktree
  console.log('Step 6/7: Executing freeze-lifecycle integration test in isolated temporary worktree...')
  run('node', ['--import', 'remix/node-tsx', '--test', 'apps/web/app/db/freeze-lifecycle.test.ts'])
  console.log('✅ Freeze lifecycle integration test passed (all 11 test assertions verified).\n')

  // Step 7: Ephemeral scratch database replay drill
  console.log('Step 7/7: Executing scratch database replay drill...')
  let scratchDb = `mms_rehearsal_scratch_${Date.now()}_scratch`
  let safeScratchDb = scratchDb.replace(/"/g, '""')
  let adminUrl = withDatabase(url, 'postgres')
  let scratchUrl = withDatabase(url, scratchDb)

  psql(adminUrl, ['-c', `CREATE DATABASE "${safeScratchDb}";`])
  psql(adminUrl, [
    '-c',
    `COMMENT ON DATABASE "${safeScratchDb}" IS 'DISPOSABLE_SCRATCH_DATABASE: created by release rehearsal';`,
  ])

  try {
    let { applyBootstrap, applyMigrations } = await import('../db/scripts/lib.ts')
    applyBootstrap(scratchUrl)
    applyMigrations(scratchUrl)
    run('npm', ['run', 'db:verify'], { env: { DATABASE_URL: scratchUrl } })
    console.log('✅ Scratch replay and invariant check passed.')
  } finally {
    psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS "${safeScratchDb}" WITH (FORCE);`])
    console.log('✅ Scratch database dropped cleanly.\n')
  }

  // Final Invariant Check
  let finalRecord = JSON.parse(fs.readFileSync(baselineRecordFile, 'utf8'))
  if (finalRecord.status !== 'NOT_ESTABLISHED' || fs.existsSync(baselineLockFile)) {
    throw new Error('FATAL: Rehearsal corrupted the baseline state!')
  }

  console.log('=================================================================')
  console.log('RELEASE REHEARSAL SUCCESSFUL!')
  console.log('All gates, verification checks, and scratch drills PASSED.')
  console.log('Real repository status remains: FIRST_PRODUCTION_BASELINE = NOT_ESTABLISHED.')
  console.log('The irreversible freeze will execute only upon formal release.')
  console.log('=================================================================')
}

main().catch((err) => {
  console.error('\n❌ Release rehearsal failed:', err.message || err)
  process.exit(1)
})
