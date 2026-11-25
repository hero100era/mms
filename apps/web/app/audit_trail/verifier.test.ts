import { describe, it, before, after } from "node:test"
import { lockSealChain, type SealChainLock } from "./seal-chain-lock.ts"
import * as assert from "node:assert/strict"
import { Pool } from "pg"
import { sealHorizon } from "./sealer.ts"
import { verifyAuditSeals } from "./verifier.ts"
import { MemoryWormStorage } from "./worm-storage.ts"
import { Alerter, MemoryAlertSink } from "./alerter.ts"
import { reconcileAuditEvents } from "./reconciler.ts"
import { LogForwarder, MemoryLogForwarderSink } from "./log-forwarder.ts"

import { withRole } from '../db/role-pool.ts'

const testDbUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/mms_acceptance"

const sealerDbUrl =
  process.env.AUDIT_SEALER_DATABASE_URL ||
  process.env.MMS_SEALER_DATABASE_URL ||
  withRole(testDbUrl, 'audit_sealer')

describe('Card H-02: pgaudit, Off-DB Log Forwarding, Alerts & Daily Event Reconciliation', () => {
  let adminPool: Pool
  let sealerPool: Pool
  let alertSink: MemoryAlertSink
  let alerter: Alerter
  let chainLock: SealChainLock

  before(async () => {
    // Exclusive use of the audit_trail.seal chain for this block's lifetime; see lockSealChain.
    chainLock = await lockSealChain(testDbUrl, 'Card H-02')
    adminPool = new Pool({ connectionString: testDbUrl, max: 5 })
    sealerPool = new Pool({ connectionString: sealerDbUrl, max: 5 })
    alertSink = new MemoryAlertSink()
    alerter = new Alerter([alertSink])

    // Cleanup previous test reconciliation runs, probe changes and forwarder watermarks
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_discrepancy DISABLE TRIGGER reconciliation_discrepancy_append_only')
    await adminPool.query('DELETE FROM audit_trail.reconciliation_discrepancy')
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_discrepancy ENABLE TRIGGER reconciliation_discrepancy_append_only')

    await adminPool.query('ALTER TABLE audit_trail.reconciliation_run DISABLE TRIGGER reconciliation_run_append_only')
    await adminPool.query('DELETE FROM audit_trail.reconciliation_run')
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_run ENABLE TRIGGER reconciliation_run_append_only')

    await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only')
    await adminPool.query("DELETE FROM audit_trail.change_log WHERE row_id >= 'e2000000-0000-0000-0000-000000000000' AND row_id < 'e2000000-ffff-ffff-ffff-ffffffffffff'")
    await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only')

    await adminPool.query('ALTER TABLE audit_trail.event DISABLE TRIGGER event_append_only')
    await adminPool.query("DELETE FROM audit_trail.event WHERE actor_id >= 'e2000000-0000-0000-0000-000000000000' AND actor_id < 'e2000000-ffff-ffff-ffff-ffffffffffff'")
    await adminPool.query('ALTER TABLE audit_trail.event ENABLE TRIGGER event_append_only')

    await adminPool.query("DELETE FROM audit_trail.forwarder_watermark WHERE sink_id LIKE 'test-%'")
    await adminPool.query("DELETE FROM iam.staff_position WHERE user_id >= 'e2000000-0000-0000-0000-000000000000' AND user_id < 'e2000000-ffff-ffff-ffff-ffffffffffff'")
    await adminPool.query("DELETE FROM iam.staff_position WHERE set_by >= 'e2000000-0000-0000-0000-000000000000' AND set_by < 'e2000000-ffff-ffff-ffff-ffffffffffff'")
    await adminPool.query("DELETE FROM iam.app_user WHERE id >= 'e2000000-0000-0000-0000-000000000000' AND id < 'e2000000-ffff-ffff-ffff-ffffffffffff'")
  })

  after(async () => {
    await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only').catch(() => {})
    await adminPool.query("DELETE FROM audit_trail.change_log WHERE row_id >= 'e2000000-0000-0000-0000-000000000000' AND row_id < 'e2000000-ffff-ffff-ffff-ffffffffffff'").catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only').catch(() => {})

    await adminPool.query('ALTER TABLE audit_trail.event DISABLE TRIGGER event_append_only').catch(() => {})
    await adminPool.query("DELETE FROM audit_trail.event WHERE actor_id >= 'e2000000-0000-0000-0000-000000000000' AND actor_id < 'e2000000-ffff-ffff-ffff-ffffffffffff'").catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.event ENABLE TRIGGER event_append_only').catch(() => {})

    await adminPool.query("DELETE FROM iam.staff_position WHERE user_id >= 'e2000000-0000-0000-0000-000000000000' AND user_id < 'e2000000-ffff-ffff-ffff-ffffffffffff'").catch(() => {})
    await adminPool.query("DELETE FROM iam.staff_position WHERE set_by >= 'e2000000-0000-0000-0000-000000000000' AND set_by < 'e2000000-ffff-ffff-ffff-ffffffffffff'").catch(() => {})
    await adminPool.query("DELETE FROM audit_trail.forwarder_watermark WHERE sink_id LIKE 'test-%'").catch(() => {})
    // audit_trail.seal is left intact: H-01's workers share this chain and must not see it vanish.
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_discrepancy DISABLE TRIGGER reconciliation_discrepancy_append_only').catch(() => {})
    await adminPool.query('DELETE FROM audit_trail.reconciliation_discrepancy').catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_discrepancy ENABLE TRIGGER reconciliation_discrepancy_append_only').catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_run DISABLE TRIGGER reconciliation_run_append_only').catch(() => {})
    await adminPool.query('DELETE FROM audit_trail.reconciliation_run').catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.reconciliation_run ENABLE TRIGGER reconciliation_run_append_only').catch(() => {})
    await adminPool.end().catch(() => {})
    await sealerPool.end().catch(() => {})
    await chainLock.release()
  })

  it('Flow 1: Alerter framework emits structured alerts and maintains history by severity and type', async () => {
    alertSink.clear()
    alerter.clear()

    await alerter.emit('RECONCILIATION_DISCREPANCY', 'CRITICAL', 'TestModule', 'Test critical alert', { key: 'val1' })
    await alerter.emit('FORWARDER_LAG_EXCEEDED', 'WARNING', 'TestModule', 'Test lag warning', { lag: 120 })
    await alerter.emit('RECONCILIATION_DISCREPANCY', 'INFO', 'TestModule', 'Test info message', { count: 10 })

    assert.equal(alertSink.alerts.length, 3)
    let criticals = alertSink.findBySeverity('CRITICAL')
    assert.equal(criticals.length, 1)
    assert.equal(criticals[0].type, 'RECONCILIATION_DISCREPANCY')
    assert.equal(criticals[0].message, 'Test critical alert')
    assert.deepEqual(criticals[0].details, { key: 'val1' })

    let warnings = alertSink.findBySeverity('WARNING')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].type, 'FORWARDER_LAG_EXCEEDED')

    let infos = alertSink.findBySeverity('INFO')
    assert.equal(infos.length, 1)

    assert.equal(alerter.getHistory().length, 3)
  })

  it('Flow 2: Clean transactions pass reconciliation with 0 discrepancies and emit INFO alert', async () => {
    alertSink.clear()
    alerter.clear()

    let cleanUserId = 'e2000000-0000-0000-0000-000000000010'
    let client = await adminPool.connect()
    let txId: string
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO iam.app_user (id, kind, display_name, email, status)
        VALUES ($1, 'external', 'Clean User', 'clean_user@example.com', 'active')
      `, [cleanUserId])

      await client.query(`
        INSERT INTO audit_trail.event (event_type, outcome, actor_id, db_role, source, detail)
        VALUES ('auth.user.created', 'success', $1, 'auth_gateway', 'web', '{"action":"create"}'::jsonb)
      `, [cleanUserId])

      let res = await client.query('SELECT pg_current_xact_id()::text AS tx_id')
      txId = res.rows[0].tx_id
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    let report = await reconcileAuditEvents({
      pool: sealerPool,
      alerter,
      fromXid: txId,
      toXid: (BigInt(txId) + 1n).toString(),
    })

    assert.equal(report.status, 'clean')
    assert.equal(report.discrepancyCount, 0)
    assert.equal(report.discrepancies.length, 0)
    assert.ok(report.checkedChangeCount > 0, 'Must have verified controlled-column changes')
    assert.ok(report.checkedEventCount > 0, 'Must have verified matching events')

    let runQuery = await adminPool.query(
      'SELECT id, status, checked_change_count, discrepancy_count FROM audit_trail.reconciliation_run WHERE id = $1',
      [report.runId],
    )
    assert.equal(runQuery.rows.length, 1)
    assert.equal(runQuery.rows[0].status, 'clean')
    assert.equal(runQuery.rows[0].discrepancy_count, 0)

    let infoAlerts = alertSink.findBySeverity('INFO')
    assert.ok(infoAlerts.some((a) => a.type === 'RECONCILIATION_DISCREPANCY' && a.message.includes('Daily reconciliation clean')))
  })

  it('Flow 3: Reconciliation detects missing event when controlled column is mutated directly (simulated superuser tamper)', async () => {
    alertSink.clear()
    alerter.clear()

    let testUserId = 'e2000000-0000-0000-0000-000000000001'

    await adminPool.query(`
      INSERT INTO iam.app_user (id, kind, display_name, email, status)
      VALUES ($1, 'external', 'Direct Mutator', 'direct_mutator@example.com', 'active')
    `, [testUserId])

    let updateRes = await adminPool.query(`
      UPDATE iam.app_user
      SET status = 'suspended'
      WHERE id = $1
      RETURNING pg_current_xact_id()::text as tx_id
    `, [testUserId])
    let directTxId = updateRes.rows[0].tx_id

    let changeRes = await adminPool.query(
      `SELECT id, tx_id::text, changed_cols FROM audit_trail.change_log WHERE tx_id = $1::xid8 AND table_name = 'app_user'`,
      [directTxId],
    )
    assert.equal(changeRes.rows.length, 1)
    assert.ok(changeRes.rows[0].changed_cols.includes('status'))

    let eventRes = await adminPool.query(
      `SELECT id FROM audit_trail.event WHERE tx_id = $1::xid8`,
      [directTxId],
    )
    assert.equal(eventRes.rows.length, 0, 'No event should exist for direct UPDATE')

    let report = await reconcileAuditEvents({
      pool: sealerPool,
      alerter,
      fromXid: directTxId,
      toXid: (BigInt(directTxId) + 1n).toString(),
    })

    assert.equal(report.status, 'discrepancies_found')
    assert.ok(report.discrepancyCount >= 1)
    let disc = report.discrepancies.find((d) => d.txId === directTxId && d.columnName === 'status')
    assert.ok(disc, 'Must detect discrepancy on status column for directTxId')
    assert.equal(disc.discrepancyType, 'missing_event')
    assert.equal(disc.tableName, 'app_user')
    assert.equal(disc.schemaName, 'iam')

    let discDb = await adminPool.query(
      'SELECT id, discrepancy_type, schema_name, table_name, column_name FROM audit_trail.reconciliation_discrepancy WHERE run_id = $1 AND tx_id = $2::xid8',
      [report.runId, directTxId],
    )
    assert.equal(discDb.rows.length, 1)
    assert.equal(discDb.rows[0].discrepancy_type, 'missing_event')

    let criticalAlerts = alertSink.findBySeverity('CRITICAL')
    assert.ok(
      criticalAlerts.some((a) => a.type === 'RECONCILIATION_DISCREPANCY' && a.message.includes('discrepancy')),
      'Must emit CRITICAL RECONCILIATION_DISCREPANCY alert',
    )
  })

  it('Flow 4: Reconciliation detects mismatched event type when event in transaction does not match controlled column requirement', async () => {
    alertSink.clear()
    alerter.clear()

    let testUserId = 'e2000000-0000-0000-0000-000000000002'

    await adminPool.query(`
      INSERT INTO iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      VALUES ('e2000000-0000-0000-0000-000000000099', 'internal', 'Creator User', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099', 'active')
      ON CONFLICT (id) DO NOTHING
    `)
    await adminPool.query(`
      INSERT INTO iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      VALUES ($1, 'internal', 'Position Probe', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'active')
      ON CONFLICT (id) DO NOTHING
    `, [testUserId])

    let client = await adminPool.connect()
    let txId: string
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO iam.staff_position (user_id, unit_id, job_title_code, job_family, set_by, valid, reason)
        VALUES (
          $1,
          (SELECT id FROM core.org_unit LIMIT 1),
          'surveyors',
          'survey',
          'e2000000-0000-0000-0000-000000000099',
          tstzrange(now(), null),
          'Initial position'
        )
      `, [testUserId])

      await client.query(`
        INSERT INTO audit_trail.event (event_type, outcome, actor_id, db_role, source, detail)
        VALUES ('auth.session.created', 'success', $1, 'int_sysadmin', 'web', '{"note":"spoofed"}'::jsonb)
      `, [testUserId])

      let res = await client.query('SELECT pg_current_xact_id()::text AS tx_id')
      txId = res.rows[0].tx_id
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    let report = await reconcileAuditEvents({
      pool: sealerPool,
      alerter,
      fromXid: txId,
      toXid: (BigInt(txId) + 1n).toString(),
    })

    assert.equal(report.status, 'discrepancies_found')
    let mismatch = report.discrepancies.find(
      (d) => d.txId === txId && d.discrepancyType === 'mismatched_event_type',
    )
    assert.ok(mismatch, 'Must detect mismatched_event_type for wrong event')
    assert.equal(mismatch.tableName, 'staff_position')
  })

  it('Flow 5: Reconciliation detects event failure outcome when event outcome != success', async () => {
    alertSink.clear()
    alerter.clear()

    let testUserId = 'e2000000-0000-0000-0000-000000000003'

    let client = await adminPool.connect()
    let txId: string
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO iam.app_user (id, kind, display_name, email, status)
        VALUES ($1, 'external', 'Failed Event Probe', 'failed_probe@example.com', 'active')
      `, [testUserId])

      await client.query(`
        UPDATE iam.app_user SET status = 'suspended' WHERE id = $1
      `, [testUserId])

      await client.query(`
        INSERT INTO audit_trail.event (event_type, outcome, actor_id, db_role, source, detail)
        VALUES ('auth.user.suspended', 'failure', $1, 'int_sysadmin', 'web', '{"error":"simulated failure"}'::jsonb)
      `, [testUserId])

      let res = await client.query('SELECT pg_current_xact_id()::text AS tx_id')
      txId = res.rows[0].tx_id
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    let report = await reconcileAuditEvents({
      pool: sealerPool,
      alerter,
      fromXid: txId,
      toXid: (BigInt(txId) + 1n).toString(),
    })

    assert.equal(report.status, 'discrepancies_found')
    let failureDisc = report.discrepancies.find(
      (d) => d.txId === txId && d.discrepancyType === 'event_failure_outcome',
    )
    assert.ok(failureDisc, 'Must detect event_failure_outcome when event failed')
  })

  it('Flow 6: Off-DB LogForwarder ships batches to external sink and updates watermark', async () => {
    let sink = new MemoryLogForwarderSink('test-sink-1')
    let forwarder = new LogForwarder({
      pool: sealerPool,
      sink,
      alerter,
      batchSize: 50,
    })

    let initialWatermark = await forwarder.getWatermark()
    assert.equal(initialWatermark.sinkId, 'test-sink-1')
    assert.equal(initialWatermark.lastChangeLogId, '0')
    assert.equal(initialWatermark.forwardedBatchCount, 0)

    let result1 = await forwarder.forwardNextBatch()
    assert.ok(result1.forwarded, 'Must forward initial batch')
    assert.ok(result1.recordCount > 0)
    assert.equal(sink.batches.length, 1)

    let batch1 = sink.batches[0]
    assert.equal(batch1.sequenceNumber, 1)
    assert.equal(batch1.sinkId, 'test-sink-1')
    assert.ok(batch1.batchSha256.length === 64, 'Batch SHA-256 must be valid hex hash')

    let updatedWatermark = await forwarder.getWatermark()
    assert.equal(updatedWatermark.forwardedBatchCount, 1)
    assert.equal(updatedWatermark.lastChangeLogId, batch1.toChangeLogId)
    assert.equal(updatedWatermark.lastEventId, batch1.toEventId)
    assert.equal(updatedWatermark.lastBatchHash, batch1.batchSha256)

    let result2 = await forwarder.forwardNextBatch()
    if (result2.forwarded) {
      assert.equal(sink.batches.length, 2)
      assert.equal(sink.batches[1].sequenceNumber, 2)
      assert.ok(BigInt(sink.batches[1].fromChangeLogId) >= BigInt(batch1.toChangeLogId))
    }
  })

  it('Flow 7: LogForwarder lag monitoring detects backlog and emits FORWARDER_LAG_EXCEEDED warning', async () => {
    alertSink.clear()
    alerter.clear()

    let sink = new MemoryLogForwarderSink('test-lag-sink')
    let forwarder = new LogForwarder({
      pool: sealerPool,
      sink,
      alerter,
      maxLagRecordsThreshold: 2,
      maxLagSecondsThreshold: 0,
    })

    await adminPool.query(`
      INSERT INTO audit_trail.forwarder_watermark (sink_id, last_change_log_id, last_event_id, last_forwarded_at)
      VALUES ('test-lag-sink', 0, 0, now() - interval '10 minutes')
      ON CONFLICT (sink_id) DO UPDATE SET last_change_log_id = 0, last_event_id = 0, last_forwarded_at = now() - interval '10 minutes'
    `)

    let lagCheck = await forwarder.checkLag()
    assert.ok(lagCheck.hasWarning, 'Must flag lag warning when unforwarded records exceed threshold')
    assert.ok(lagCheck.lagRecords > 2)

    let lagAlerts = alertSink.findByType('FORWARDER_LAG_EXCEEDED')
    assert.equal(lagAlerts.length, 1)
    assert.equal(lagAlerts[0].severity, 'WARNING')
  })

  it('Flow 8: LogForwarder emits FORWARDER_DELIVERY_FAILURE on external sink error and halts watermark advance', async () => {
    alertSink.clear()
    alerter.clear()

    let sink = new MemoryLogForwarderSink('test-failing-sink')
    sink.shouldFail = true

    let forwarder = new LogForwarder({
      pool: sealerPool,
      sink,
      alerter,
    })

    let initialWatermark = await forwarder.getWatermark()

    await assert.rejects(
      async () => {
        await forwarder.forwardNextBatch()
      },
      /Simulated off-DB forwarder network failure/,
    )

    let failureAlerts = alertSink.findByType('FORWARDER_DELIVERY_FAILURE')
    assert.equal(failureAlerts.length, 1)
    assert.equal(failureAlerts[0].severity, 'CRITICAL')

    let postFailWatermark = await forwarder.getWatermark()
    assert.equal(postFailWatermark.lastChangeLogId, initialWatermark.lastChangeLogId)
    assert.equal(postFailWatermark.forwardedBatchCount, initialWatermark.forwardedBatchCount)
  })

  it('Flow 9: AuditSealer emits SEAL_LAG_EXCEEDED warning alert when horizon lag threshold is breached', async () => {
    alertSink.clear()
    alerter.clear()

    let wormStorage = new MemoryWormStorage()

    let sealResult = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      alerter,
      maxLagThreshold: -1,
      allowEmptySeal: true,
    })

    assert.ok(sealResult.sealed)
    assert.ok(sealResult.lagWarning)

    let lagAlerts = alertSink.findByType('SEAL_LAG_EXCEEDED')
    assert.equal(lagAlerts.length, 1)
    assert.equal(lagAlerts[0].severity, 'WARNING')
  })

  it('Flow 10: AuditSealer emits WORM_COLLISION_OR_CORRUPTION critical alert when WORM object write fails', async () => {
    alertSink.clear()
    alerter.clear()

    let wormStorage = new MemoryWormStorage()

    let res1 = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      alerter,
      allowEmptySeal: true,
    })
    assert.ok(res1.sealed)

    let nextHorizon = (BigInt(res1.toXid) + 100n).toString()
    let collisionUri = `worm/audit_trail/seals/seal_${res1.toXid}_${nextHorizon}.jsonl`
    await wormStorage.write(collisionUri, Buffer.from('TAMPERED_PRE_EXISTING_CONTENT'))

    await assert.rejects(
      async () => {
        await sealHorizon({
          pool: sealerPool,
          wormStorage,
          alerter,
          forceHorizonXid: nextHorizon,
          allowEmptySeal: true,
        })
      },
      /WormStorageCollisionError/,
    )

    let collisionAlerts = alertSink.findByType('WORM_COLLISION_OR_CORRUPTION')
    assert.equal(collisionAlerts.length, 1)
    assert.equal(collisionAlerts[0].severity, 'CRITICAL')
  })

  it('Flow 11: AuditVerifier emits SEAL_TAMPER_DETECTED critical alert when verification fails', async () => {
    alertSink.clear()
    alerter.clear()

    let wormStorage = new MemoryWormStorage()

    let sealRes = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      alerter,
      allowEmptySeal: true,
    })
    assert.ok(sealRes.sealed)

    wormStorage._tamperForTest(sealRes.wormUri, Buffer.from('CORRUPTED_BYTES_IN_WORM'))

    let report = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      alerter,
      verifyLiveDatabase: true,
      fromSealId: sealRes.sealId,
      toSealId: sealRes.sealId,
    })

    assert.equal(report.status, 'FAIL')
    let tamperAlerts = alertSink.findByType('SEAL_TAMPER_DETECTED')
    assert.equal(tamperAlerts.length, 1)
    assert.equal(tamperAlerts[0].severity, 'CRITICAL')
  })

  it('Flow 12: Append-only defense blocks UPDATE and DELETE on audit_trail.reconciliation_run and discrepancy tables', async () => {
    await assert.rejects(
      async () => {
        await adminPool.query("UPDATE audit_trail.reconciliation_run SET status = 'failed'")
      },
      /audit reconciliation records are append-only/,
    )

    await assert.rejects(
      async () => {
        await adminPool.query('DELETE FROM audit_trail.reconciliation_run')
      },
      /audit reconciliation records are append-only/,
    )
  })

  it('Flow 13: Reconciliation rejects unrelated events for columns with wildcard pattern requirements', async () => {
    alertSink.clear()
    alerter.clear()

    let testUserId = 'e2000000-0000-0000-0000-000000000050'
    let client = await adminPool.connect()
    let txId: string
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO iam.app_user (id, kind, display_name, email, status)
        VALUES ($1, 'external', 'Spoofed Event User', 'spoofed@example.com', 'active')
      `, [testUserId])

      // Attempt to spoof using an unrelated event (auth.session.created instead of auth.user.*)
      await client.query(`
        INSERT INTO audit_trail.event (event_type, outcome, actor_id, db_role, source, detail)
        VALUES ('auth.session.created', 'success', $1, 'auth_gateway', 'web', '{"spoofed":true}'::jsonb)
      `, [testUserId])

      let res = await client.query('SELECT pg_current_xact_id()::text AS tx_id')
      txId = res.rows[0].tx_id
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    let report = await reconcileAuditEvents({
      pool: sealerPool,
      alerter,
      fromXid: txId,
      toXid: (BigInt(txId) + 1n).toString(),
    })

    assert.equal(report.status, 'discrepancies_found')
    let disc = report.discrepancies.find((d) => d.txId === txId && d.columnName === 'status')
    assert.ok(disc, 'Must detect discrepancy on status for unrelated event')
    assert.equal(disc.discrepancyType, 'mismatched_event_type')
  })

  it('Flow 14: Reconciliation detects direct DELETE on controlled entity without audit event', async () => {
    alertSink.clear()
    alerter.clear()

    let deleteUserId = 'e2000000-0000-0000-0000-000000000060'
    await adminPool.query(`
      INSERT INTO iam.app_user (id, kind, display_name, email, status)
      VALUES ($1, 'external', 'Delete Target', 'delete_target@example.com', 'active')
    `, [deleteUserId])

    // Superuser direct DELETE without event
    let delRes = await adminPool.query(`
      DELETE FROM iam.app_user
      WHERE id = $1
      RETURNING pg_current_xact_id()::text AS tx_id
    `, [deleteUserId])
    let delTxId = delRes.rows[0].tx_id

    let report = await reconcileAuditEvents({
      pool: sealerPool,
      alerter,
      fromXid: delTxId,
      toXid: (BigInt(delTxId) + 1n).toString(),
    })

    assert.equal(report.status, 'discrepancies_found')
    let delDisc = report.discrepancies.find((d) => d.txId === delTxId)
    assert.ok(delDisc, 'Must flag unauthorized DELETE of controlled entity')
    assert.equal(delDisc.discrepancyType, 'missing_event')
    assert.equal(delDisc.details.op, 'D')
  })

  it('Flow 15: LogForwarder functions correctly with batchSize = 1', async () => {
    let sink = new MemoryLogForwarderSink('test-sink-batch-1')
    let forwarder = new LogForwarder({
      pool: sealerPool,
      sink,
      alerter,
      batchSize: 1,
    })

    let result = await forwarder.forwardNextBatch()
    if (result.forwarded) {
      assert.equal(result.recordCount, 1, 'Must forward exactly 1 record per batch')
      assert.equal(sink.batches.length, 1)
      assert.equal(sink.batches[0].records.length, 1)
    }
  })

  it('Flow 16: LogForwarder sorts numeric IDs with BigInt monotonicity rather than string sorting', async () => {
    let sink = new MemoryLogForwarderSink('test-sink-sort')
    let forwarder = new LogForwarder({
      pool: sealerPool,
      sink,
      alerter,
      batchSize: 50,
    })

    let result = await forwarder.forwardNextBatch()
    if (result.forwarded && result.batch && result.batch.records.length >= 2) {
      // Find two records from the same table and timestamp
      let records = result.batch.records
      for (let i = 0; i < records.length - 1; i++) {
        let a = records[i]
        let b = records[i + 1]
        if (a.occurredAt === b.occurredAt && a.table === b.table) {
          assert.ok(
            BigInt(a.id) <= BigInt(b.id),
            `Record ID ${a.id} must be <= ${b.id} numerically`,
          )
        }
      }
    }
  })

  it('Flow 17: Verifier supports slice verification with fromSealId and toSealId boundaries', async () => {
    let wormStorage = new MemoryWormStorage()

    let seal1 = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      allowEmptySeal: true,
    })
    let seal2 = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      forceHorizonXid: (BigInt(seal1.toXid) + 50n).toString(),
      allowEmptySeal: true,
    })

    assert.ok(seal1.sealId)
    assert.ok(seal2.sealId)

    // Verify only the second seal in isolation
    let sliceReport = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      verifyLiveDatabase: true,
      fromSealId: seal2.sealId,
      toSealId: seal2.sealId,
    })

    // A bare PASS/FAIL mismatch says nothing about which check tripped, and this flow
    // has three independent ones: the chain, the WORM digest, and a live-DB reconciliation.
    // Report them so an intermittent failure is diagnosable from its log alone.
    assert.equal(
      sliceReport.status,
      'PASS',
      `Single seal slice verification must pass: ${JSON.stringify(sliceReport.sealDetails[0]?.errors ?? [])}`,
    )
    assert.equal(sliceReport.totalSeals, 1)
    assert.equal(sliceReport.sealDetails[0].sealId, seal2.sealId)
  })

  it('Flow 18: Concurrent reconciliation executions are prevented via advisory lock', async () => {
    let client = await adminPool.connect()
    try {
      // Acquire the advisory lock on client
      await client.query("SELECT pg_advisory_lock(hashtext('mms_audit_reconciliation'))")

      // Attempting to run reconcileAuditEvents should reject because lock is held
      await assert.rejects(
        async () => {
          await reconcileAuditEvents({ pool: sealerPool })
        },
        /Another reconciliation run is already in progress/,
      )
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('mms_audit_reconciliation'))").catch(() => {})
      client.release()
    }
  })
})


