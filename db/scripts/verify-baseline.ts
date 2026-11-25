import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { migrationsDir as defaultMigrationsDir, repoRoot as defaultRepoRoot } from './lib.ts'

export type BaselineVerificationResult = {
  passed: boolean
  status: 'NOT_ESTABLISHED' | 'ESTABLISHED'
  manifestPath: string
  totalMigrations: number
  baselineMigrations: number
  errors: string[]
  metadata?: Record<string, unknown>
}

export type VerifyBaselineOptions = {
  repoRoot?: string
  migrationsDir?: string
}

export function verifyBaseline(options: VerifyBaselineOptions = {}): BaselineVerificationResult {
  let root = options.repoRoot ?? defaultRepoRoot
  let mDir = options.migrationsDir ?? (options.repoRoot ? path.join(root, 'db', 'migrations') : defaultMigrationsDir)

  let errors: string[] = []
  let baselineRecordFile = path.join(root, 'db', 'FIRST_PRODUCTION_BASELINE.json')
  let baselineLockFile = path.join(root, 'db', 'production-baseline.lock.json')
  let previewLockFile = path.join(root, 'docs', 'review', 'production-baseline-preview.lock.json')
  let migrationLockFile = path.join(root, 'db', 'migrations.lock.json')

  if (!fs.existsSync(baselineRecordFile)) {
    errors.push('Missing db/FIRST_PRODUCTION_BASELINE.json release record')
    return { passed: false, status: 'NOT_ESTABLISHED', manifestPath: '', totalMigrations: 0, baselineMigrations: 0, errors }
  }

  let baselineRecord = JSON.parse(fs.readFileSync(baselineRecordFile, 'utf8'))
  let status: 'NOT_ESTABLISHED' | 'ESTABLISHED' =
    baselineRecord.status === 'ESTABLISHED' || baselineRecord.status === 'FROZEN'
      ? 'ESTABLISHED'
      : 'NOT_ESTABLISHED'

  // Pre-production policy invariant: while NOT_ESTABLISHED, production baseline lock must remain strictly absent
  if (status === 'NOT_ESTABLISHED') {
    if (fs.existsSync(baselineLockFile)) {
      errors.push('production-baseline.lock.json must remain absent while baseline status is NOT_ESTABLISHED')
    }
    if (baselineRecord.policy !== 'PRE_PRODUCTION_NORMALIZATION') {
      errors.push(`Baseline policy must be PRE_PRODUCTION_NORMALIZATION while status is NOT_ESTABLISHED (got ${baselineRecord.policy})`)
    }
    if (baselineRecord.schemas?.technicalAudit !== 'audit_trail') {
      errors.push(`Technical audit schema must be audit_trail (got ${baselineRecord.schemas?.technicalAudit})`)
    }
    if (baselineRecord.schemas?.reservedMaritimeCompanyAudit !== 'audit') {
      errors.push(`Reserved maritime company audit schema must be audit (got ${baselineRecord.schemas?.reservedMaritimeCompanyAudit})`)
    }
  }

  let targetManifest = status === 'ESTABLISHED' ? baselineLockFile : previewLockFile
  if (!fs.existsSync(targetManifest)) {
    errors.push(`Target manifest missing: ${path.relative(root, targetManifest)}`)
    return { passed: false, status, manifestPath: targetManifest, totalMigrations: 0, baselineMigrations: 0, errors, metadata: baselineRecord }
  }

  let manifest: Record<string, string> = JSON.parse(fs.readFileSync(targetManifest, 'utf8'))
  if (!fs.existsSync(migrationLockFile)) {
    errors.push('Missing db/migrations.lock.json')
    return { passed: false, status, manifestPath: targetManifest, totalMigrations: 0, baselineMigrations: 0, errors, metadata: baselineRecord }
  }
  let currentLock: Record<string, string> = JSON.parse(fs.readFileSync(migrationLockFile, 'utf8'))

  if (!fs.existsSync(mDir)) {
    errors.push(`Migrations directory missing: ${path.relative(root, mDir)}`)
    return { passed: false, status, manifestPath: targetManifest, totalMigrations: 0, baselineMigrations: 0, errors, metadata: baselineRecord }
  }

  let directories = fs
    .readdirSync(mDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  let manifestKeys = Object.keys(manifest).sort()
  let allowedFiles = new Set(['schema.sql', 'nontx.sql', 'pre.sql', 'post.sql', 'REVIEW.md'])

  // Check 1: Directory count vs manifest
  if (status === 'NOT_ESTABLISHED') {
    // In pre-production preview, manifest must cover exactly all migration directories
    if (manifestKeys.length !== directories.length) {
      errors.push(
        `Preview manifest entry count (${manifestKeys.length}) does not match migration directory count (${directories.length})`,
      )
    }
  } else {
    // In ESTABLISHED baseline, extra migration directories are allowed as forward migrations
    // provided all manifest entries exist in directories
    if (directories.length < manifestKeys.length) {
      errors.push(
        `Migration directory count (${directories.length}) is less than frozen baseline migrations (${manifestKeys.length})`,
      )
    }
  }

  // Check 2: Every directory has valid hash and complete review
  for (let directory of directories) {
    let dir = path.join(mDir, directory)
    let files = fs.readdirSync(dir).sort()

    // Untracked artifact check
    for (let f of files) {
      if (!allowedFiles.has(f)) {
        errors.push(`${directory}: unauthorized migration artifact "${f}" found`)
      }
    }

    // Review record check
    let reviewFile = path.join(dir, 'REVIEW.md')
    if (!fs.existsSync(reviewFile)) {
      errors.push(`${directory}: missing required review record (REVIEW.md)`)
    } else if (directory >= '20261108T') {
      let content = fs.readFileSync(reviewFile, 'utf8')
      if (content.includes('- [ ]')) {
        errors.push(`${directory}: REVIEW.md contains uncompleted checklist item(s)`)
      }
    }

    // Hash computation
    let hash = createHash('sha256')
    for (let file of files) {
      let full = path.join(dir, file)
      if (!fs.statSync(full).isFile()) continue
      hash.update(file)
      hash.update('\0')
      hash.update(fs.readFileSync(full))
      hash.update('\0')
    }
    let digest = hash.digest('hex')

    // If directory is in manifest (baseline/preview migration), disk digest must match manifest hash
    if (manifest[directory]) {
      if (manifest[directory] !== digest) {
        errors.push(`${directory}: disk digest (${digest}) does not match manifest hash (${manifest[directory]})`)
      }
    } else if (status === 'NOT_ESTABLISHED') {
      errors.push(`${directory}: missing from ${path.relative(root, targetManifest)}`)
    } else {
      // Forward migration in ESTABLISHED state: must be after the last baseline migration
      let lastBaseline = manifestKeys[manifestKeys.length - 1]
      if (directory <= lastBaseline) {
        errors.push(`${directory}: historical migration missing from production baseline manifest`)
      }
    }

    // Disk digest must match current migration lock
    if (!currentLock[directory]) {
      errors.push(`${directory}: missing from db/migrations.lock.json`)
    } else if (currentLock[directory] !== digest) {
      errors.push(`${directory}: disk digest does not match db/migrations.lock.json`)
    }
  }

  // Check 3: Check for manifest entries missing from disk
  for (let key of manifestKeys) {
    if (!directories.includes(key)) {
      errors.push(`Manifest contains baseline migration "${key}" that is missing from disk`)
    }
  }

  // Check 4: If established, verify required release provenance and approval metadata
  if (status === 'ESTABLISHED') {
    if (!baselineRecord.releaseId) errors.push('Established baseline missing releaseId in db/FIRST_PRODUCTION_BASELINE.json')
    if (!baselineRecord.commitSha) errors.push('Established baseline missing commitSha in db/FIRST_PRODUCTION_BASELINE.json')
    if (!baselineRecord.approvalDate) errors.push('Established baseline missing approvalDate in db/FIRST_PRODUCTION_BASELINE.json')
    if (!baselineRecord.approvers) errors.push('Established baseline missing approvers in db/FIRST_PRODUCTION_BASELINE.json')
    if (!baselineRecord.workflowRunId) errors.push('Established baseline missing workflowRunId in db/FIRST_PRODUCTION_BASELINE.json')
    if (!fs.existsSync(baselineLockFile)) {
      errors.push('Established baseline requires db/production-baseline.lock.json')
    }
  }

  return {
    passed: errors.length === 0,
    status,
    manifestPath: targetManifest,
    totalMigrations: directories.length,
    baselineMigrations: manifestKeys.length,
    errors,
    metadata: baselineRecord,
  }
}

if (process.argv[1] && process.argv[1].endsWith('verify-baseline.ts')) {
  let result = verifyBaseline()
  console.log('=================================================================')
  console.log(`MMS Production Baseline Verification: ${result.status}`)
  console.log(`Manifest: ${path.relative(defaultRepoRoot, result.manifestPath)}`)
  console.log(`Total Migrations: ${result.totalMigrations} (Baseline: ${result.baselineMigrations})`)
  console.log('=================================================================')

  if (!result.passed) {
    console.error('\n❌ Baseline Verification FAILED:')
    for (let err of result.errors) {
      console.error(`  - ${err}`)
    }
    process.exit(1)
  }

  if (result.status === 'NOT_ESTABLISHED') {
    console.log('\n✅ Preview verification passed: all migrations match preview manifest.')
    console.log('Notice: FIRST_PRODUCTION_BASELINE is NOT_ESTABLISHED (MMS remains in pre-production).')
  } else {
    console.log('\n✅ Established baseline verification passed: baseline migrations are immutable.')
  }
  console.log('=================================================================')
}
