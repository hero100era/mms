import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const migrationsDir = path.join(repoRoot, 'db', 'migrations')
const lockFile = path.join(repoRoot, 'db', 'migrations.lock.json')

export interface ReleaseGateCheckResult {
  passed: boolean
  totalMigrations: number
  lockedMigrations: number
  errors: string[]
  warnings: string[]
}

export function runReleaseGateCheck(options: { checkCandidateReviews?: boolean } = {}): ReleaseGateCheckResult {
  let errors: string[] = []
  let warnings: string[] = []

  if (!fs.existsSync(lockFile)) {
    errors.push('db/migrations.lock.json does not exist')
    return { passed: false, totalMigrations: 0, lockedMigrations: 0, errors, warnings }
  }

  let lock: Record<string, string> = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  let directories = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  let destructive = [
    /\bdrop\s+table\b/i,
    /\bdrop\s+column\b/i,
    /\balter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\btype\b/i,
    /\bdrop\s+constraint\b/i,
    /\bdrop\s+policy\b/i,
    /\bdrop\s+function\b/i,
    /\brevoke\b[\s\S]*?\b(int_|ext_|web_)[a-z_]+\b/i,
  ]

  let lockedCount = 0

  for (let directory of directories) {
    let dir = path.join(migrationsDir, directory)
    let reviewFile = path.join(dir, 'REVIEW.md')
    if (!fs.existsSync(reviewFile)) {
      errors.push(`${directory}: REVIEW.md is missing`)
      continue
    }

    let review = fs.readFileSync(reviewFile, 'utf8')
    let sql = ['schema.sql', 'nontx.sql']
      .map((file) => path.join(dir, file))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n')

    for (let pattern of destructive) {
      if (pattern.test(sql) && !/allow-destructive:/i.test(review)) {
        errors.push(`${directory}: destructive statement needs an allow-destructive line in REVIEW.md`)
        break
      }
    }

    // Verify directory hash against lockfile
    let hash = createHash('sha256')
    for (let file of fs.readdirSync(dir).sort()) {
      let full = path.join(dir, file)
      if (!fs.statSync(full).isFile()) continue
      hash.update(file)
      hash.update('\0')
      hash.update(fs.readFileSync(full))
      hash.update('\0')
    }
    let digest = hash.digest('hex')

    if (!lock[directory]) {
      errors.push(`${directory}: not in db/migrations.lock.json (unlocked migration)`)
    } else if (lock[directory] !== digest) {
      errors.push(`${directory}: hash changed after it was locked in migrations.lock.json`)
    } else {
      lockedCount++
    }

    // Check recent / candidate migration reviews for completed checklists and rollback notes
    if (options.checkCandidateReviews) {
      let isCandidate = directory >= '20261108T'
      if (isCandidate) {
        if (/-\s*\[\s*\]/.test(review)) {
          errors.push(`${directory}: REVIEW.md has uncompleted checkboxes (- [ ])`)
        }
        if (!/rollback/i.test(review)) {
          errors.push(`${directory}: REVIEW.md is missing explicit rollback / forward-fix strategy`)
        }
      }
    }
  }

  for (let directory of Object.keys(lock)) {
    if (!directories.includes(directory)) {
      errors.push(`${directory}: locked migration exists in lockfile but not on disk`)
    }
  }

  let baselineFile = path.join(repoRoot, 'db', 'production-baseline.lock.json')
  if (fs.existsSync(baselineFile)) {
    let baselineLock: Record<string, string> = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
    for (let [dirName, baselineHash] of Object.entries(baselineLock)) {
      if (!directories.includes(dirName)) {
        errors.push(`FIRST_PRODUCTION_BASELINE violation: baseline migration "${dirName}" is missing`)
      } else if (lock[dirName] !== baselineHash) {
        errors.push(`FIRST_PRODUCTION_BASELINE violation: baseline migration "${dirName}" was modified after baseline freeze`)
      }
    }
  }

  return {
    passed: errors.length === 0,
    totalMigrations: directories.length,
    lockedMigrations: lockedCount,
    errors,
    warnings,
  }
}

if (process.argv[1] && process.argv[1].endsWith('check-release-gate.ts')) {
  let result = runReleaseGateCheck({ checkCandidateReviews: true })
  console.log(`Release Migration Gate: ${result.lockedMigrations}/${result.totalMigrations} migrations locked`)
  let baselineRecordFile = path.join(repoRoot, 'db', 'FIRST_PRODUCTION_BASELINE.json')
  if (fs.existsSync(baselineRecordFile)) {
    let rec = JSON.parse(fs.readFileSync(baselineRecordFile, 'utf8'))
    if (rec.status === 'NOT_ESTABLISHED') {
      console.log(`Production Baseline: ${rec.baseline} (Status: NOT_ESTABLISHED - Prototype Normalization Preview Active)`)
    } else {
      console.log(`Production Baseline: ${rec.baseline} (${rec.status} at tag ${rec.tag || rec.releaseId}, ${rec.totalMigrations} migrations)`)
    }
  }

  try {
    let { verifyBaseline } = await import('../db/scripts/verify-baseline.ts')
    let bv = verifyBaseline()
    if (!bv.passed) {
      for (let err of bv.errors) console.error(`GATE FAILED (Baseline Verification): ${err}`)
      process.exit(1)
    }
  } catch (err: any) {
    console.error(`GATE FAILED: Could not run verify-baseline: ${err.message || err}`)
    process.exit(1)
  }
  if (!result.passed) {
    for (let err of result.errors) console.error(`GATE FAILED: ${err}`)
    process.exit(1)
  }
  console.log('Release migration gate check PASSED: all migrations locked and verified.')

  try {
    let { psql, requireDatabaseUrl } = await import('../db/scripts/lib.ts')
    let testConn = psql(requireDatabaseUrl(), ['-tA', '-c', 'SELECT 1;'], { allowFailure: true })
    if (testConn.status !== 0) {
      console.log('Database unreachable; skipping live evidence check.')
    } else {
      let { collectAndVerifyEvidence } = await import('./verify-migration-evidence.ts')
      let ev = collectAndVerifyEvidence()
      if (!ev.passed) {
        for (let err of ev.errors) console.error(`EVIDENCE GATE FAILED: ${err}`)
        process.exit(1)
      }
      console.log('Migration review evidence check PASSED: schema and security properties verified.')
    }
  } catch (e: any) {
    // Only warn if DB connection is unavailable in environment without DATABASE_URL
    if (process.env.DATABASE_URL) {
      console.error(`EVIDENCE GATE FAILED: ${e?.message ?? e}`)
      process.exit(1)
    }
  }
}
