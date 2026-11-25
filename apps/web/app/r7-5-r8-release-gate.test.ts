import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { runReleaseGateCheck } from '../../../scripts/check-release-gate.ts'

describe('Phase R7.5 & Phase R8: Backup/Restore Safety & Release Migration Gate', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..')
  const scriptPath = path.join(repoRoot, 'scripts', 'restore-drill.sh')

  test('1. runReleaseGateCheck verifies all migrations are locked and candidate reviews completed', () => {
    let result = runReleaseGateCheck({ checkCandidateReviews: true })
    assert.equal(result.errors.length, 0, `Expected release gate to pass, got errors: ${result.errors.join(', ')}`)
    assert.equal(result.passed, true)
    assert.ok(result.totalMigrations >= 83)
    assert.equal(result.lockedMigrations, result.totalMigrations)
  })

  test('2. restore-drill.sh rejects execution when scratch database equals source database', () => {
    let res = spawnSync(
      'bash',
      [scriptPath],
      {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://postgres@localhost:55432/mms_dev',
          RESTORE_DRILL_DATABASE: 'mms_dev',
        },
      },
    )

    assert.notEqual(res.status, 0)
    let stderr = res.stderr.toString('utf8')
    assert.match(stderr, /scratch database 'mms_dev' cannot match source database 'mms_dev'/)
  })

  test('3. restore-drill.sh rejects collision even when DATABASE_URL has query parameters (?host=/tmp)', () => {
    let res = spawnSync(
      'bash',
      [scriptPath],
      {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://postgres@localhost:55432/mms_drill?host=/tmp',
          RESTORE_DRILL_DATABASE: 'mms_drill',
        },
      },
    )

    assert.notEqual(res.status, 0)
    let stderr = res.stderr.toString('utf8')
    assert.match(stderr, /scratch database 'mms_drill' cannot match source database 'mms_drill'/)
  })

  test('4. restore-drill.sh rejects scratch database without safe suffix (_drill, _scratch, _restore)', () => {
    let res = spawnSync(
      'bash',
      [scriptPath],
      {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://postgres@localhost:55432/mms_dev',
          RESTORE_DRILL_DATABASE: 'production_main',
        },
      },
    )

    assert.notEqual(res.status, 0)
    let stderr = res.stderr.toString('utf8')
    assert.match(stderr, /scratch database 'production_main' must (be a safe SQL identifier ending in|end in) _drill, _scratch, or _restore/)
  })
})
