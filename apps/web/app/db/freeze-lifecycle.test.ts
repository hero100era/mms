import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it } from 'node:test'

import { run } from '../../../../db/scripts/lib.ts'
import { executeBaselineFreeze } from '../../../../db/scripts/freeze-baseline.ts'
import { verifyBaseline } from '../../../../db/scripts/verify-baseline.ts'

function createSampleMigration(dir: string, name: string, sqlContent: string) {
  let mPath = path.join(dir, name)
  fs.mkdirSync(mPath, { recursive: true })
  fs.writeFileSync(path.join(mPath, 'schema.sql'), sqlContent)
  fs.writeFileSync(
    path.join(mPath, 'REVIEW.md'),
    `# Review for ${name}\n\n- [x] Verified schema\n- [x] Rollback plan: drop tables\n`,
  )
  return mPath
}

function computeDirHash(dir: string): string {
  let files = fs.readdirSync(dir).sort()
  let hash = createHash('sha256')
  for (let file of files) {
    let full = path.join(dir, file)
    if (!fs.statSync(full).isFile()) continue
    hash.update(file)
    hash.update('\0')
    hash.update(fs.readFileSync(full))
    hash.update('\0')
  }
  return hash.digest('hex')
}

describe('FIRST_PRODUCTION_BASELINE Freeze Lifecycle Integration Test', () => {
  it('verifies the entire one-way baseline transition without touching real repository', async () => {
    let realRepoRoot = path.resolve(import.meta.dirname, '../../../../')
    let tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-freeze-lifecycle-test-'))

    try {
      // Setup temporary git repository
      run('git', ['init'], { cwd: tempDir })
      run('git', ['config', 'user.name', 'Test Runner'], { cwd: tempDir })
      run('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      let dbDir = path.join(tempDir, 'db')
      let migrationsDir = path.join(dbDir, 'migrations')
      let docsReviewDir = path.join(tempDir, 'docs', 'review')
      fs.mkdirSync(migrationsDir, { recursive: true })
      fs.mkdirSync(docsReviewDir, { recursive: true })

      // Create a normalized sample baseline migration
      let m1 = '20261030T111331Z_f04-poc'
      let m1Path = createSampleMigration(
        migrationsDir,
        m1,
        'create schema if not exists audit_trail;\ncreate table audit_trail.test (id uuid primary key);\n',
      )
      let m1Hash = computeDirHash(m1Path)

      let lock = { [m1]: m1Hash }
      fs.writeFileSync(path.join(dbDir, 'migrations.lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
      fs.writeFileSync(
        path.join(docsReviewDir, 'production-baseline-preview.lock.json'),
        `${JSON.stringify(lock, null, 2)}\n`,
      )

      let initialRecord = {
        baseline: 'FIRST_PRODUCTION_BASELINE',
        status: 'NOT_ESTABLISHED',
        policy: 'PRE_PRODUCTION_NORMALIZATION',
        previewManifest: 'docs/review/production-baseline-preview.lock.json',
        totalNormalizedMigrations: 1,
        firstMigration: m1,
        lastMigration: m1,
        schemas: {
          technicalAudit: 'audit_trail',
          reservedMaritimeCompanyAudit: 'audit',
        },
      }
      fs.writeFileSync(
        path.join(dbDir, 'FIRST_PRODUCTION_BASELINE.json'),
        `${JSON.stringify(initialRecord, null, 2)}\n`,
      )

      run('git', ['add', '-A'], { cwd: tempDir })
      run('git', ['commit', '-m', 'initial baseline prototype migration'], { cwd: tempDir })

      // 1. Initial State: NOT_ESTABLISHED and preview matches
      let initialVerify = verifyBaseline({ repoRoot: tempDir })
      assert.equal(initialVerify.status, 'NOT_ESTABLISHED')
      assert.equal(initialVerify.passed, true)
      assert.equal(fs.existsSync(path.join(dbDir, 'production-baseline.lock.json')), false)

      // 2. Local freeze without protected release context MUST fail
      await assert.rejects(
        async () => {
          await executeBaselineFreeze({ repoRoot: tempDir })
        },
        /FATAL: Baseline freeze cannot be established through local CLI execution/,
      )
      assert.equal(fs.existsSync(path.join(dbDir, 'production-baseline.lock.json')), false)

      // 3. Create annotated tag and execute freeze under protected test mode
      let tagName = 'v1.0.0-test'
      run('git', ['tag', '-a', tagName, '-m', 'Release v1.0.0-test: FIRST_PRODUCTION_BASELINE'], { cwd: tempDir })

      let oldEnv = { ...process.env }
      process.env.MMS_FREEZE_TEST_MODE = 'true'
      process.env.MMS_FREEZE_TEST_WORKTREE = tempDir
      process.env.MMS_RELEASE_ID = 'REL-TEST-1.0.0'
      process.env.MMS_RELEASE_APPROVERS = 'SecAuditor1,SecAuditor2'
      process.env.MMS_RELEASE_TAG = tagName
      process.env.MMS_FREEZE_SKIP_GATES = 'true'

      try {
        await executeBaselineFreeze({ repoRoot: tempDir })
      } finally {
        process.env = oldEnv
      }

      // 4. Verify authoritative lock created and baseline record changed to ESTABLISHED
      assert.equal(fs.existsSync(path.join(dbDir, 'production-baseline.lock.json')), true)
      let establishedRecord = JSON.parse(fs.readFileSync(path.join(dbDir, 'FIRST_PRODUCTION_BASELINE.json'), 'utf8'))
      assert.equal(establishedRecord.status, 'ESTABLISHED')
      assert.equal(establishedRecord.releaseId, 'REL-TEST-1.0.0')
      assert.equal(establishedRecord.approvers, 'SecAuditor1,SecAuditor2')
      assert.equal(establishedRecord.tag, tagName)

      // 5. Read-only verification succeeds
      let establishedVerify = verifyBaseline({ repoRoot: tempDir })
      assert.equal(establishedVerify.status, 'ESTABLISHED')
      assert.equal(establishedVerify.passed, true)
      assert.equal(establishedVerify.baselineMigrations, 1)

      // 6. Second freeze fails without modifying files (one-way transition)
      let baselineLockContentBefore = fs.readFileSync(path.join(dbDir, 'production-baseline.lock.json'), 'utf8')
      let testEnv2 = {
        ...process.env,
        MMS_FREEZE_TEST_MODE: 'true',
        MMS_FREEZE_TEST_WORKTREE: tempDir,
        MMS_RELEASE_ID: 'REL-TEST-2.0.0',
        MMS_RELEASE_APPROVERS: 'OtherUser',
        MMS_RELEASE_TAG: tagName,
      }
      let oldEnv2 = { ...process.env }
      process.env = testEnv2
      try {
        await assert.rejects(
          async () => {
            await executeBaselineFreeze({ repoRoot: tempDir })
          },
          /FATAL: Production baseline is ALREADY FROZEN/,
        )
      } finally {
        process.env = oldEnv2
      }
      let baselineLockContentAfter = fs.readFileSync(path.join(dbDir, 'production-baseline.lock.json'), 'utf8')
      assert.equal(baselineLockContentBefore, baselineLockContentAfter)

      // 7. A modified historical migration fails verification
      let schemaFile = path.join(m1Path, 'schema.sql')
      let originalSql = fs.readFileSync(schemaFile, 'utf8')
      fs.writeFileSync(schemaFile, originalSql + '\n-- modified historical migration\n')
      let tamperedVerify = verifyBaseline({ repoRoot: tempDir })
      assert.equal(tamperedVerify.passed, false)
      assert.ok(tamperedVerify.errors.some((e) => e.includes('does not match manifest hash')))
      fs.writeFileSync(schemaFile, originalSql) // restore

      // 8. A missing baseline migration fails verification
      let m1Bak = path.join(migrationsDir, `${m1}.bak`)
      fs.renameSync(m1Path, m1Bak)
      let missingVerify = verifyBaseline({ repoRoot: tempDir })
      assert.equal(missingVerify.passed, false)
      assert.ok(missingVerify.errors.some((e) => e.includes('missing from disk') || e.includes('less than frozen baseline')))
      fs.renameSync(m1Bak, m1Path) // restore

      // 9. A new forward migration remains possible through the normal process
      let m2 = '20261120T120000Z_r9-forward-change'
      let m2Path = createSampleMigration(
        migrationsDir,
        m2,
        'create table audit_trail.forward_event (id uuid primary key);\n',
      )
      let m2Hash = computeDirHash(m2Path)
      let updatedLock = { ...lock, [m2]: m2Hash }
      fs.writeFileSync(path.join(dbDir, 'migrations.lock.json'), `${JSON.stringify(updatedLock, null, 2)}\n`)

      let forwardVerify = verifyBaseline({ repoRoot: tempDir })
      assert.equal(forwardVerify.status, 'ESTABLISHED')
      assert.equal(forwardVerify.passed, true)
      assert.equal(forwardVerify.totalMigrations, 2)
      assert.equal(forwardVerify.baselineMigrations, 1)

      // 10. Failed gate (e.g. dirty working tree) leaves baseline unchanged
      let freshTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-freeze-gate-fail-'))
      try {
        run('git', ['init'], { cwd: freshTemp })
        run('git', ['config', 'user.name', 'Test Runner'], { cwd: freshTemp })
        run('git', ['config', 'user.email', 'test@example.com'], { cwd: freshTemp })
        let freshDb = path.join(freshTemp, 'db')
        let freshMig = path.join(freshDb, 'migrations')
        let freshReview = path.join(freshTemp, 'docs', 'review')
        fs.mkdirSync(freshMig, { recursive: true })
        fs.mkdirSync(freshReview, { recursive: true })
        let fmPath = createSampleMigration(freshMig, m1, 'create table t (id int);\n')
        let fmHash = computeDirHash(fmPath)
        fs.writeFileSync(path.join(freshDb, 'migrations.lock.json'), JSON.stringify({ [m1]: fmHash }))
        fs.writeFileSync(path.join(freshReview, 'production-baseline-preview.lock.json'), JSON.stringify({ [m1]: fmHash }))
        fs.writeFileSync(path.join(freshDb, 'FIRST_PRODUCTION_BASELINE.json'), JSON.stringify(initialRecord))
        run('git', ['add', '-A'], { cwd: freshTemp })
        run('git', ['commit', '-m', 'initial commit'], { cwd: freshTemp })
        run('git', ['tag', '-a', 'v1.0.0-fresh', '-m', 'tag'], { cwd: freshTemp })

        // Inject dirty working tree
        fs.writeFileSync(path.join(freshTemp, 'untracked_dirty.txt'), 'dirty working tree')

        let gateFailEnv = {
          ...process.env,
          MMS_FREEZE_TEST_MODE: 'true',
          MMS_FREEZE_TEST_WORKTREE: freshTemp,
          MMS_RELEASE_ID: 'REL-FAIL',
          MMS_RELEASE_APPROVERS: 'Tester',
          MMS_RELEASE_TAG: 'v1.0.0-fresh',
          MMS_FREEZE_SKIP_GATES: 'true',
        }
        let oldGateEnv = { ...process.env }
        process.env = gateFailEnv
        try {
          await assert.rejects(
            async () => {
              await executeBaselineFreeze({ repoRoot: freshTemp })
            },
            /Git working tree is dirty/,
          )
        } finally {
          process.env = oldGateEnv
        }

        // Assert baseline lock was NOT created and record remains NOT_ESTABLISHED
        assert.equal(fs.existsSync(path.join(freshDb, 'production-baseline.lock.json')), false)
        let freshRec = JSON.parse(fs.readFileSync(path.join(freshDb, 'FIRST_PRODUCTION_BASELINE.json'), 'utf8'))
        assert.equal(freshRec.status, 'NOT_ESTABLISHED')
      } finally {
        fs.rmSync(freshTemp, { recursive: true, force: true })
      }

      // 11. Crucial Invariant: The real repository baseline was NEVER established by this test
      let realBaselineRecord = JSON.parse(
        fs.readFileSync(path.join(realRepoRoot, 'db', 'FIRST_PRODUCTION_BASELINE.json'), 'utf8'),
      )
      assert.equal(realBaselineRecord.status, 'NOT_ESTABLISHED')
      assert.equal(fs.existsSync(path.join(realRepoRoot, 'db', 'production-baseline.lock.json')), false)
      assert.equal(
        fs.existsSync(path.join(realRepoRoot, 'docs', 'review', 'production-baseline-preview.lock.json')),
        true,
      )
      let realVerify = verifyBaseline({ repoRoot: realRepoRoot })
      assert.equal(realVerify.status, 'NOT_ESTABLISHED')
      assert.equal(realVerify.passed, true)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
