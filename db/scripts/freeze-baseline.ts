import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  applyBootstrap,
  applyMigrations,
  migrationsDir as defaultMigrationsDir,
  parseDatabaseUrl,
  psql,
  repoRoot as defaultRepoRoot,
  requireDatabaseUrl,
  run,
  withDatabase,
} from './lib.ts'
import { verifyBaseline } from './verify-baseline.ts'

/**
 * ADR-0032: FIRST_PRODUCTION_BASELINE Freeze Procedure
 *
 * Transitions migration history from pre-production normalization to permanent immutability.
 * This is a strictly one-way operation that creates db/production-baseline.lock.json
 * and updates db/FIRST_PRODUCTION_BASELINE.json with formal release approval provenance.
 *
 * Execution Governance:
 * - Must run in an approved release workflow (GitHub Actions environment: 'production-release')
 *   or an isolated temporary worktree test mode (MMS_FREEZE_TEST_MODE).
 * - Self-asserted local CLI arguments are rejected to prevent unproven baseline claims.
 * - Database Execution Model: Ephemeral local PostgreSQL 18.x service on the approved CI runner.
 */

function checkGitWorkingTreeClean(root: string): string {
  let statusResult = run('git', ['status', '--porcelain'], { cwd: root })
  if (statusResult.stdout.trim().length > 0) {
    throw new Error(
      `FATAL: Git working tree is dirty. Production baseline freeze must be executed from a clean working copy.\nUncommitted changes:\n${statusResult.stdout}`,
    )
  }
  let headCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  return headCommit
}

function validateLocalExecutionModel(url: string) {
  if (process.env.NODE_ENV === 'production' && !process.env.GITHUB_ACTIONS && !process.env.MMS_FREEZE_TEST_MODE) {
    throw new Error('FATAL: Production baseline freeze cannot run directly on production host')
  }

  let parts = parseDatabaseUrl(url)
  let allowedHosts = ['localhost', '127.0.0.1', '::1']
  let isLocalSocket = parts.host.startsWith('/')
  let isLocalHost = allowedHosts.includes(parts.host) || isLocalSocket

  if (!isLocalHost) {
    throw new Error(
      `FATAL: Refusing non-local PostgreSQL host "${parts.host}". The approved execution model requires an ephemeral local PostgreSQL 18.x service on the CI runner.`,
    )
  }

  let dbLower = parts.database.toLowerCase()
  if (dbLower.includes('prod') || dbLower.includes('live')) {
    throw new Error(
      `FATAL: Database URL references a production/live database name ("${parts.database}"). Refusing to proceed.`,
    )
  }
}

function verifyReleaseTagAuthenticity(root: string, expectedTag: string, commitSha: string): string {
  // Check 1: Tag exists and points to current commit
  let tagCommitResult = run('git', ['rev-list', '-n', '1', expectedTag], { cwd: root, allowFailure: true })
  if (tagCommitResult.status !== 0 || !tagCommitResult.stdout.trim()) {
    throw new Error(`FATAL: Release tag "${expectedTag}" does not exist in repository`)
  }
  let tagCommit = tagCommitResult.stdout.trim()
  if (tagCommit !== commitSha) {
    throw new Error(
      `FATAL: Release tag "${expectedTag}" points to commit ${tagCommit}, but current HEAD is ${commitSha}`,
    )
  }

  // Check 2: Tag is an annotated tag object (not just a lightweight pointer)
  let tagTypeResult = run('git', ['cat-file', '-t', expectedTag], { cwd: root, allowFailure: true })
  let tagType = tagTypeResult.stdout.trim()
  if (tagType !== 'tag') {
    throw new Error(
      `FATAL: Release tag "${expectedTag}" is a lightweight tag (${tagType}). Baseline freeze requires an annotated release tag.`,
    )
  }

  let tagSha = run('git', ['rev-parse', expectedTag], { cwd: root }).stdout.trim()
  return tagSha
}

export type FreezeOptions = {
  repoRoot?: string
  migrationsDir?: string
}

export async function executeBaselineFreeze(options: FreezeOptions = {}) {
  let root = options.repoRoot ?? defaultRepoRoot
  let mDir = options.migrationsDir ?? (options.repoRoot ? path.join(root, 'db', 'migrations') : defaultMigrationsDir)

  console.log('=================================================================')
  console.log('MMS Production Baseline Freeze Procedure (ADR-0032)')
  console.log('=================================================================\n')

  let baselineLockFile = path.join(root, 'db', 'production-baseline.lock.json')
  let baselineRecordFile = path.join(root, 'db', 'FIRST_PRODUCTION_BASELINE.json')
  let migrationLockFile = path.join(root, 'db', 'migrations.lock.json')

  // Guard 1: One-way refusal if baseline lock already exists
  if (fs.existsSync(baselineLockFile)) {
    throw new Error(
      'FATAL: Production baseline is ALREADY FROZEN. db/production-baseline.lock.json already exists. Overwrite is strictly prohibited (one-way transition).',
    )
  }

  // Guard 2: One-way refusal if release record is already marked established
  if (fs.existsSync(baselineRecordFile)) {
    let currentRec = JSON.parse(fs.readFileSync(baselineRecordFile, 'utf8'))
    if (currentRec.status === 'ESTABLISHED' || currentRec.status === 'FROZEN') {
      throw new Error(
        `FATAL: Production baseline is ALREADY ESTABLISHED in db/FIRST_PRODUCTION_BASELINE.json (status: ${currentRec.status}).`,
      )
    }
  }

  // Guard 3: Reject self-asserted local execution; require protected release context
  let isCiRelease =
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.MMS_RELEASE_ENVIRONMENT === 'production-release' &&
    Boolean(process.env.GITHUB_RUN_ID)

  let isTestMode =
    process.env.MMS_FREEZE_TEST_MODE === 'true' &&
    Boolean(process.env.MMS_FREEZE_TEST_WORKTREE) &&
    process.env.MMS_FREEZE_TEST_WORKTREE === root

  // Safety check: Test mode must NEVER run on the real repository root
  if (isTestMode) {
    let realRoot = defaultRepoRoot
    if (path.resolve(root) === path.resolve(realRoot)) {
      throw new Error('FATAL: MMS_FREEZE_TEST_MODE is strictly forbidden on the primary repository.')
    }
  }

  if (!isCiRelease && !isTestMode) {
    throw new Error(
      `FATAL: Baseline freeze cannot be established through local CLI execution.
Self-asserted approval metadata is prohibited.

The irreversible freeze to FIRST_PRODUCTION_BASELINE must be executed only through
an approved release workflow (e.g. GitHub Actions environment 'production-release')
with verified environment reviewers and provenance.

See ADR-0032 and docs/plans/implementation_plan_v4.2.md.`,
    )
  }

  let releaseId = process.env.MMS_RELEASE_ID
  let approvers = process.env.MMS_RELEASE_APPROVERS
  let tagName = process.env.MMS_RELEASE_TAG
  let workflowRunId = process.env.GITHUB_RUN_ID || (isTestMode ? 'test-run-1' : '')
  let approvalDate = process.env.MMS_APPROVAL_DATE || new Date().toISOString().split('T')[0]
  let ciRef = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${workflowRunId}`
    : (isTestMode ? `test://worktree/${workflowRunId}` : '')

  if (!releaseId || !approvers || !tagName) {
    throw new Error(
      'FATAL: Missing required release provenance: MMS_RELEASE_ID, MMS_RELEASE_APPROVERS, and MMS_RELEASE_TAG must be supplied by the release environment.',
    )
  }

  // Guard 4: Clean git working tree
  console.log('Checking Git working tree cleanliness...')
  let commitSha = checkGitWorkingTreeClean(root)
  console.log(`✅ Clean git working tree at commit ${commitSha}.\n`)

  // Guard 5: Complete lock coverage and hash verification
  console.log('Verifying lock coverage, digests, and review completeness...')
  let baselineVerification = verifyBaseline({ repoRoot: root, migrationsDir: mDir })
  if (!baselineVerification.passed) {
    throw new Error(
      `FATAL: Lock coverage verification failed:\n${baselineVerification.errors.join('\n')}`,
    )
  }
  console.log(`✅ Complete lock coverage confirmed (${baselineVerification.totalMigrations} migrations).\n`)

  // Guard 6: Verify release tag authenticity
  console.log(`Verifying release tag authenticity for "${tagName}"...`)
  let tagSha = verifyReleaseTagAuthenticity(root, tagName, commitSha)
  console.log(`✅ Annotated tag "${tagName}" verified (object SHA: ${tagSha}, points to ${commitSha}).\n`)

  // Guard 7: Duplicate migration ID prefix check
  let directories = fs
    .readdirSync(mDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  let seenIds = new Set<string>()
  for (let dir of directories) {
    let id = dir.split('_')[0]
    if (seenIds.has(id)) {
      throw new Error(`FATAL: Duplicate migration ID found: ${id} in ${dir}`)
    }
    seenIds.add(id)
  }

  // Guard 8: Hardened scratch database safety on ephemeral local service
  let url = requireDatabaseUrl()
  validateLocalExecutionModel(url)

  let scratchDb = `mms_freeze_scratch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_scratch`
  let safeScratchDb = scratchDb.replace(/"/g, '""')
  let adminUrl = withDatabase(url, 'postgres')
  let scratchUrl = withDatabase(url, scratchDb)

  console.log(`Creating isolated scratch database: ${scratchDb}...`)
  psql(adminUrl, ['-c', `CREATE DATABASE "${safeScratchDb}";`])
  psql(adminUrl, [
    '-c',
    `COMMENT ON DATABASE "${safeScratchDb}" IS 'DISPOSABLE_SCRATCH_DATABASE: created by db:baseline:freeze';`,
  ])
  psql(adminUrl, ['-c', `GRANT CREATE ON DATABASE "${safeScratchDb}" TO mms_owner;`], { allowFailure: true })

  try {
    console.log(`Replaying all ${directories.length} normalized migrations into ${scratchDb}...`)
    applyBootstrap(scratchUrl)
    applyMigrations(scratchUrl, { skipSeeds: true })
    console.log('✅ Replay from empty database passed cleanly.\n')

    // If running in test mode with skip gates flag, gates can be skipped for fast test isolation
    if (process.env.MMS_FREEZE_SKIP_GATES !== 'true') {
      console.log('Running full gate checks against scratch database...')
      console.log('1/5: db:check (schema lint, migration check, desired state drift)...')
      run('npm', ['run', 'db:check'], { cwd: root, env: { DATABASE_URL: scratchUrl } })

      console.log('2/5: db:spike (pgschema coverage)...')
      run('npm', ['run', 'db:spike'], { cwd: root, env: { DATABASE_URL: scratchUrl } })

      console.log('3/5: db:test (pgTAP suite against replay DB)...')
      run('npm', ['run', 'db:test'], { cwd: root, env: { DATABASE_URL: scratchUrl } })

      console.log('4/5: db:verify (invariants against live database)...')
      run('npm', ['run', 'db:verify'], { cwd: root, env: { DATABASE_URL: scratchUrl } })

      console.log('5/5: release:check (release migration gate & evidence)...')
      run('npm', ['run', 'release:check'], { cwd: root, env: { DATABASE_URL: scratchUrl } })

      console.log('✅ All full gate verification checks passed!\n')
    }
  } finally {
    console.log(`Safely dropping scratch database: ${scratchDb}...`)
    try {
      psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS "${safeScratchDb}" WITH (FORCE);`])
      console.log('✅ Scratch database dropped cleanly.\n')
    } catch (cleanupErr) {
      console.error(`Warning: Failed to clean up scratch database ${scratchDb}:`, cleanupErr)
    }
  }

  // Step 9: Write immutable production baseline manifest
  console.log(`Copying verified manifest to ${path.relative(root, baselineLockFile)}...`)
  let currentLock = JSON.parse(fs.readFileSync(migrationLockFile, 'utf8'))
  fs.writeFileSync(baselineLockFile, `${JSON.stringify(currentLock, null, 2)}\n`)
  console.log(`✅ Frozen ${Object.keys(currentLock).length} migrations into db/production-baseline.lock.json.\n`)

  // Step 10: Record formal baseline release record with provenance
  let baselineRecord = {
    baseline: 'FIRST_PRODUCTION_BASELINE',
    status: 'ESTABLISHED',
    releaseId,
    commitSha,
    tag: tagName,
    tagSha,
    approvalDate,
    approvers,
    workflowRunId,
    ciReference: ciRef,
    frozenAt: new Date().toISOString(),
    totalMigrations: Object.keys(currentLock).length,
    firstMigration: directories[0],
    lastMigration: directories[directories.length - 1],
    lockManifest: 'db/production-baseline.lock.json',
    policy: 'IMMUTABLE_FORWARD_ONLY',
    schemas: {
      technicalAudit: 'audit_trail',
      reservedMaritimeCompanyAudit: 'audit',
    },
  }
  fs.writeFileSync(baselineRecordFile, `${JSON.stringify(baselineRecord, null, 2)}\n`)
  console.log(`✅ Baseline record updated in ${path.relative(root, baselineRecordFile)}.\n`)

  console.log('=================================================================')
  console.log('FIRST_PRODUCTION_BASELINE SUCCESSFULLY ESTABLISHED!')
  console.log(`Release ID: ${releaseId}`)
  console.log(`Commit SHA: ${commitSha}`)
  console.log(`Tag: ${tagName} (object: ${tagSha})`)
  console.log(`Workflow Run: ${workflowRunId}`)
  console.log(`Approval: ${approvalDate} by ${approvers}`)
  console.log('All historical migrations are now permanently immutable.')
  console.log('=================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('freeze-baseline.ts')) {
  executeBaselineFreeze().catch((err) => {
    console.error('\n❌ Baseline freeze failed:', err.message || err)
    process.exit(1)
  })
}
