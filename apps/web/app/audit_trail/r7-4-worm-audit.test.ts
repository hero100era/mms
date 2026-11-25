import assert from 'node:assert/strict'
import { test, describe, beforeEach } from 'node:test'
import { verifyAuditSeals } from './verifier.ts'
import { reconcileAuditEvents } from './reconciler.ts'
import { Alerter, MemoryAlertSink } from './alerter.ts'
import { MemoryWormStorage } from './worm-storage.ts'
import {
  artifact,
  manifest,
  batchHash,
  computeSealHash,
  GENESIS_PREV_SEAL_HASH,
  sha256Hex,
} from './seal-artifact.ts'

describe('Phase R7.4: Audit Reconciliation, Verification & WORM Protection', () => {
  let memorySink: MemoryAlertSink
  let alerter: Alerter

  beforeEach(() => {
    memorySink = new MemoryAlertSink()
    alerter = new Alerter([memorySink])
  })

  test('1. verifyAuditSeals alerts on zero seals when alertOnZeroRecords is true', async () => {
    let mockPool: any = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('FROM audit_trail.seal')) {
            return { rows: [] }
          }
          return { rows: [] }
        },
        release: () => {},
      }),
    }

    let report = await verifyAuditSeals({
      pool: mockPool,
      wormStorage: new MemoryWormStorage(),
      alerter,
      alertOnZeroRecords: true,
      verifyLiveDatabase: false,
    })

    assert.equal(report.status, 'PASS')
    assert.equal(report.totalSeals, 0)

    let alerts = memorySink.findByType('ZERO_RECORD_ANOMALY')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].severity, 'WARNING')
    assert.match(alerts[0].message, /zero seals in audit_trail\.seal/)
  })

  test('2. verifyAuditSeals alerts when seals contain zero records and alertOnZeroRecords is true', async () => {
    let wormStorage = new MemoryWormStorage()
    let sealId = '1'
    let wormUri = `worm://audit-bucket/seals/${sealId}.json`

    let bHash = batchHash([])
    let sealedAt = new Date().toISOString()
    let man = manifest({
      sealedAt,
      fromXid: '100',
      toXid: '100',
      changeLogCount: 0,
      eventCount: 0,
      prevSealHash: GENESIS_PREV_SEAL_HASH,
      batchHash: bHash,
    })
    let artifactContent = artifact(man, [])
    let artifactBytes = Buffer.from(artifactContent, 'utf8')
    let wormSha256 = sha256Hex(artifactBytes)

    let sealHash = computeSealHash({
      prev_seal_hash: GENESIS_PREV_SEAL_HASH,
      batch_hash: bHash,
      from_xid: '100',
      to_xid: '100',
      change_log_count: 0,
      event_count: 0,
      sealed_at: sealedAt,
    })

    await wormStorage.write(wormUri, artifactBytes)

    let mockPool: any = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('WHERE id <')) {
            return { rows: [] }
          }
          if (sql.includes('FROM audit_trail.seal')) {
            return {
              rows: [
                {
                  id: sealId,
                  from_xid: '100',
                  to_xid: '100',
                  prev_seal_hash: GENESIS_PREV_SEAL_HASH,
                  batch_hash: bHash,
                  seal_hash: sealHash,
                  worm_uri: wormUri,
                  worm_sha256: wormSha256,
                  change_log_count: 0,
                  event_count: 0,
                  sealed_at: new Date(sealedAt),
                  sealed_by: 'audit_sealer',
                },
              ],
            }
          }
          return { rows: [] }
        },
        release: () => {},
      }),
    }

    let report = await verifyAuditSeals({
      pool: mockPool,
      wormStorage,
      alerter,
      alertOnZeroRecords: true,
      verifyLiveDatabase: false,
    })

    assert.equal(report.totalSeals, 1)
    assert.equal(report.validSeals, 1)

    let alerts = memorySink.findByType('ZERO_RECORD_ANOMALY')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].severity, 'WARNING')
    assert.match(alerts[0].message, /zero change_log and event records/)
  })

  test('3. reconcileAuditEvents alerts on zero records when alertOnZeroRecords is true', async () => {
    let mockPool: any = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            return { rows: [{ locked: true }] }
          }
          if (sql.includes('pg_advisory_unlock')) {
            return { rows: [{ unlocked: true }] }
          }
          if (sql.includes('FROM audit_trail.change_log')) {
            return { rows: [] }
          }
          if (sql.includes('INSERT INTO audit_trail.reconciliation_run')) {
            return { rows: [{ id: 'mock-run-id' }] }
          }
          return { rows: [] }
        },
        release: () => {},
      }),
    }

    let report = await reconcileAuditEvents({
      pool: mockPool,
      alerter,
      alertOnZeroRecords: true,
      windowStart: new Date(Date.now() - 3600 * 1000),
      windowEnd: new Date(),
    })

    assert.equal(report.status, 'clean')
    assert.equal(report.checkedChangeCount, 0)

    let alerts = memorySink.findByType('ZERO_RECORD_ANOMALY')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].severity, 'WARNING')
    assert.match(alerts[0].message, /checked 0 changes and 0 events/)
  })

  test('4. verifyAuditSeals detects hash mismatch and missing WORM blobs', async () => {
    let wormStorage = new MemoryWormStorage()
    let sealId = '2'
    let wormUri = `worm://audit-bucket/seals/${sealId}.json`

    let mockPool: any = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('FROM audit_trail.seal')) {
            return {
              rows: [
                {
                  id: sealId,
                  from_xid: '200',
                  to_xid: '205',
                  prev_seal_hash: '0'.repeat(64),
                  batch_hash: 'a'.repeat(64),
                  seal_hash: 'b'.repeat(64),
                  worm_uri: wormUri,
                  worm_sha256: 'c'.repeat(64),
                  change_log_count: 5,
                  event_count: 2,
                  sealed_at: new Date(),
                  sealed_by: 'audit_sealer',
                },
              ],
            }
          }
          return { rows: [] }
        },
        release: () => {},
      }),
    }

    // WORM storage does NOT have the blob written, so it will detect missing WORM blob
    let report = await verifyAuditSeals({
      pool: mockPool,
      wormStorage,
      alerter,
      verifyLiveDatabase: false,
    })

    assert.equal(report.status, 'FAIL')
    assert.equal(report.errors.length >= 1, true)
    assert.ok(report.errors.some((e) => e.kind === 'WORM_OBJECT_NOT_FOUND'))

    let tamperAlerts = memorySink.findByType('SEAL_TAMPER_DETECTED')
    assert.ok(tamperAlerts.length >= 1)
  })
})
