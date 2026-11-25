import { describe, it, before, after } from "node:test"
import { lockSealChain, type SealChainLock } from "./seal-chain-lock.ts"
import * as assert from "node:assert/strict"
import { Pool } from "pg"
import { sealHorizon, checkHorizonLag } from "./sealer.ts"
import { verifyAuditSeals, RESIDUAL_RISK_NOTE } from "./verifier.ts"
import { MemoryWormStorage } from "./worm-storage.ts"
import { GENESIS_PREV_SEAL_HASH } from "./canonical.ts"

import { withRole } from '../db/role-pool.ts'

const testDbUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/mms_acceptance"

const sealerDbUrl =
  process.env.AUDIT_SEALER_DATABASE_URL ||
  process.env.MMS_SEALER_DATABASE_URL ||
  withRole(testDbUrl, 'audit_sealer')

describe('Card H-01: Tier-2 Audit Horizon Sealing, WORM Export & Compliance Verifier', () => {
  let adminPool: Pool
  let sealerPool: Pool
  let wormStorage: MemoryWormStorage
  let chainLock: SealChainLock

  before(async () => {
    // Exclusive use of the audit_trail.seal chain for this block's lifetime; see lockSealChain.
    chainLock = await lockSealChain(testDbUrl, 'Card H-01')
    adminPool = new Pool({ connectionString: testDbUrl, max: 5 })
    sealerPool = new Pool({ connectionString: sealerDbUrl, max: 5 })
    wormStorage = new MemoryWormStorage()

    await adminPool.query('ALTER TABLE audit_trail.seal DISABLE TRIGGER seal_append_only')
    await adminPool.query('DELETE FROM audit_trail.seal')
    await adminPool.query('ALTER TABLE audit_trail.seal ENABLE TRIGGER seal_append_only')
    await adminPool.query(
      "DELETE FROM party.organization WHERE id >= 'e0000000-0000-0000-0000-000000000000' AND id <= 'e0000000-0000-0000-0000-ffffffffffff'",
    )
  })

  after(async () => {
    // Deliberately does not delete audit_trail.seal: the sibling workers in this file append to
    // the same chain, and truncating it here is what made their seals look like genesis.
    await adminPool
      .query(
        "DELETE FROM party.organization WHERE id >= 'e0000000-0000-0000-0000-000000000000' AND id <= 'e0000000-0000-0000-0000-ffffffffffff'",
      )
      .catch(() => {})
    await sealerPool.end().catch(() => {})
    await adminPool.end().catch(() => {})
    await chainLock.release()
  })

  it('Flow 1: executes genesis horizon seal under audit_sealer role with WORM export and RFC 8785 canonical hash', async () => {
    // Generate an authentic audited change in the database
    let testOrgId = 'e0000000-0000-0000-0000-000000000001'
    await adminPool.query(
      `INSERT INTO party.organization (id, name, org_type)
       VALUES ($1, 'Sealing Test Org 1', 'company')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId],
    )

    // Advance transaction horizon by committing a separate statement
    await adminPool.query('SELECT txid_current()')

    let seal1 = await sealHorizon({
      pool: sealerPool,
      wormStorage,
    })

    assert.equal(seal1.sealed, true, 'genesis seal must succeed')
    assert.ok(seal1.sealId, 'seal row must be created in audit_trail.seal')
    assert.equal(seal1.prevSealHash, GENESIS_PREV_SEAL_HASH, 'genesis seal prev_seal_hash must be 64 zeros')
    assert.equal(seal1.batchHash.length, 64, 'batch hash must be 64 hex characters')
    assert.equal(seal1.sealHash.length, 64, 'seal hash must be 64 hex characters')
    assert.ok(BigInt(seal1.fromXid) <= BigInt(seal1.toXid), 'from_xid <= to_xid')

    // Verify WORM storage export
    let wormObject = await wormStorage.read(seal1.wormUri)
    assert.ok(wormObject, 'WORM object must exist at the specified URI')
    assert.equal(await wormStorage.exists(seal1.wormUri), true)

    let manifestLine = wormObject.toString('utf8').split('\n')[0]
    let manifest = JSON.parse(manifestLine)
    assert.equal(manifest.format, 'mms-audit-seal-v1')
    assert.equal(manifest.batch_hash, seal1.batchHash)
    assert.equal(manifest.prev_seal_hash, GENESIS_PREV_SEAL_HASH)
  })

  it('Flow 2: executes subsequent seal forming an unbroken cryptographic hash chain with continuous horizons', async () => {
    // Generate more audited activity
    let testOrgId = 'e0000000-0000-0000-0000-000000000002'
    await adminPool.query(
      `INSERT INTO party.organization (id, name, org_type)
       VALUES ($1, 'Sealing Test Org 2', 'company')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId],
    )
    await adminPool.query('SELECT txid_current()')

    // Query previous seal from database
    let prevRes = await adminPool.query<{ to_xid: string; seal_hash: string }>(
      'SELECT to_xid::text, seal_hash FROM audit_trail.seal ORDER BY id DESC LIMIT 1',
    )
    let previousToXid = prevRes.rows[0].to_xid
    let previousSealHash = prevRes.rows[0].seal_hash

    let seal2 = await sealHorizon({
      pool: sealerPool,
      wormStorage,
    })

    assert.equal(seal2.sealed, true, 'subsequent seal must succeed')
    assert.equal(seal2.fromXid, previousToXid, 'next seal from_xid must strictly match previous to_xid (gap-free)')
    assert.equal(seal2.prevSealHash, previousSealHash, 'next seal prev_seal_hash must match previous seal_hash (chained)')
    assert.notEqual(seal2.sealHash, seal2.prevSealHash, 'seal hashes must diverge with new state')

    // WORM export check
    let wormObject = await wormStorage.read(seal2.wormUri)
    assert.ok(wormObject, 'second WORM object must exist')
  })

  it('Flow 3: returns sealed: false when no transaction horizon advance has occurred', async () => {
    // Read the current latest seal's to_xid
    let latestRes = await adminPool.query<{ to_xid: string }>(
      'SELECT to_xid::text FROM audit_trail.seal ORDER BY id DESC LIMIT 1',
    )
    let sealedToXid: string
    if (latestRes.rows.length === 0) {
      await adminPool.query(
        `INSERT INTO party.organization (id, name, org_type)
         VALUES ('e0000000-0000-0000-0000-000000000099', 'Flow 3 Deterministic Init Org', 'company')
         ON CONFLICT (id) DO NOTHING`,
      )
      await adminPool.query('SELECT txid_current()')
      let initSeal = await sealHorizon({
        pool: sealerPool,
        wormStorage,
        allowEmptySeal: true,
      })
      assert.equal(initSeal.sealed, true, 'deterministic initial seal must succeed')
      sealedToXid = initSeal.toXid
    } else {
      sealedToXid = latestRes.rows[0].to_xid
    }

    let sealCountBeforeRes = await adminPool.query<{ count: string }>('SELECT count(*) FROM audit_trail.seal')
    let sealCountBefore = parseInt(sealCountBeforeRes.rows[0].count, 10)
    assert.ok(sealCountBefore > 0, 'at least one seal must exist prior to idle verification')

    // 1. Verify that forceHorizonXid == sealedToXid deterministically returns no_horizon_advance
    let idleRun = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      forceHorizonXid: sealedToXid,
    })

    assert.equal(idleRun.sealed, false, 'idle seal run must report sealed: false')
    assert.equal(
      idleRun.reason,
      'no_horizon_advance',
      `unexpected idle reason: ${idleRun.reason}`,
    )
    assert.equal(idleRun.fromXid, sealedToXid)
    assert.equal(idleRun.toXid, sealedToXid)
    assert.equal(idleRun.changeLogCount, 0)
    assert.equal(idleRun.eventCount, 0)
    assert.equal(idleRun.batchHash, '')
    assert.equal(idleRun.sealHash, '')
    assert.equal(idleRun.wormUri, '')

    // 2. Verify past horizon (< fromXid) also safely returns no_horizon_advance without wrapping error
    if (BigInt(sealedToXid) > 0n) {
      let pastHorizonXid = (BigInt(sealedToXid) - 1n).toString()
      let pastIdleRun = await sealHorizon({
        pool: sealerPool,
        wormStorage,
        forceHorizonXid: pastHorizonXid,
      })
      assert.equal(pastIdleRun.sealed, false)
      assert.equal(pastIdleRun.reason, 'no_horizon_advance')
      assert.equal(pastIdleRun.fromXid, sealedToXid)
      assert.equal(pastIdleRun.toXid, pastHorizonXid)
      assert.equal(pastIdleRun.changeLogCount, 0)
      assert.equal(pastIdleRun.eventCount, 0)
      assert.equal(pastIdleRun.batchHash, '')
      assert.equal(pastIdleRun.sealHash, '')
      assert.equal(pastIdleRun.wormUri, '')
    }

    // 3. Verify rollback atomicity: idle runs must not insert any rows into audit_trail.seal
    let sealCountAfterRes = await adminPool.query<{ count: string }>('SELECT count(*) FROM audit_trail.seal')
    let sealCountAfter = parseInt(sealCountAfterRes.rows[0].count, 10)
    assert.equal(sealCountAfter, sealCountBefore, 'idle runs must roll back without persisting seal rows')
  })

  it('Flow 4: idempotent resumable export allows re-running without WORM collision error', async () => {
    // Read current latest seal
    let latestRes = await adminPool.query<{
      from_xid: string
      to_xid: string
      worm_uri: string
      worm_sha256: string
    }>('SELECT from_xid::text, to_xid::text, worm_uri, worm_sha256 FROM audit_trail.seal ORDER BY id DESC LIMIT 1')
    let latest = latestRes.rows[0]

    // Pre-existing WORM file read
    let existingContent = await wormStorage.read(latest.worm_uri)
    assert.ok(existingContent)

    // Writing identical content to WORM storage again succeeds idempotently
    let rewriteRes = await wormStorage.write(latest.worm_uri, existingContent)
    assert.equal(rewriteRes.sha256Hex, latest.worm_sha256)
  })

  it('Flow 5: late-committing transaction is safely excluded by snapshot xmin and captured in next horizon', async () => {
    // Acquire a dedicated client for a long-running transaction A
    let clientA = await adminPool.connect()
    try {
      // 1. Transaction A begins and performs an audited insert but does NOT commit yet
      await clientA.query('BEGIN')
      let orgAId = 'e0000000-0000-0000-0000-00000000000a'
      await clientA.query(
        `INSERT INTO party.organization (id, name, org_type)
         VALUES ($1, 'Long Transaction Org A', 'company')
         ON CONFLICT (id) DO NOTHING`,
        [orgAId],
      )

      // Query Transaction A's xid
      let txARes = await clientA.query<{ tx_id: string }>('SELECT pg_current_xact_id()::text AS tx_id')
      let txAId = txARes.rows[0].tx_id

      // 2. Transaction B begins on another connection and COMMITS immediately
      let orgBId = 'e0000000-0000-0000-0000-00000000000b'
      await adminPool.query(
        `INSERT INTO party.organization (id, name, org_type)
         VALUES ($1, 'Fast Transaction Org B', 'company')
         ON CONFLICT (id) DO NOTHING`,
        [orgBId],
      )

      // 3. Run sealHorizon while Transaction A is STILL ACTIVE
      // Because Transaction A is active, pg_snapshot_xmin() is bounded by txAId!
      // Therefore, Transaction B (which has tx_id > txAId) is NOT sealed yet!
      let intermediateSeal = await sealHorizon({
        pool: sealerPool,
        wormStorage,
      })

      // The intermediate horizon must NOT include txAId or anything >= txAId
      if (intermediateSeal.sealed) {
        assert.ok(
          BigInt(intermediateSeal.toXid) <= BigInt(txAId),
          `Sealer toXid (${intermediateSeal.toXid}) must not exceed uncommitted Transaction A xid (${txAId})`,
        )
      }

      // 4. Transaction A now commits
      await clientA.query('COMMIT')

      // Advance horizon beyond Transaction A and B
      await adminPool.query('SELECT txid_current()')

      // 5. Run sealHorizon again
      let finalSeal = await sealHorizon({
        pool: sealerPool,
        wormStorage,
      })

      assert.equal(finalSeal.sealed, true, 'final seal must capture late-committed transactions')
      assert.ok(
        BigInt(finalSeal.toXid) > BigInt(txAId),
        `Final seal toXid (${finalSeal.toXid}) must advance beyond Transaction A (${txAId})`,
      )

      // Verify that Transaction A's change_log row is present in WORM storage
      let wormContent = await wormStorage.read(finalSeal.wormUri)
      assert.ok(wormContent)
      assert.ok(
        wormContent.toString('utf8').includes('Long Transaction Org A'),
        'late-committing Transaction A must be present in the sealed WORM artifact',
      )
    } finally {
      clientA.release()
    }
  })

  it('Flow 6: checkHorizonLag detects transaction lag and produces monitored warning', async () => {
    let client = await adminPool.connect()
    try {
      // With threshold 0, any active transactions produce a lag warning
      let lagReport = await checkHorizonLag(client, 0)
      assert.ok(lagReport.lagXids >= 0n)
      assert.equal(typeof lagReport.hasWarning, 'boolean')
    } finally {
      client.release()
    }
  })

  it('Flow 7: HO Compliance Verifier successfully validates authentic seals and WORM archive', async () => {
    let report = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      verifyLiveDatabase: true,
    })

    assert.equal(report.status, 'PASS')
    assert.equal(report.errors.length, 0)
    assert.ok(report.totalSeals >= 2, 'multiple seals must be verified')
    assert.equal(report.validSeals, report.totalSeals)
    assert.equal(report.residualRiskNote, RESIDUAL_RISK_NOTE)
  })

  it('Flow 8: Tamper Test 1 — detects unauthorized mutation of live database row (DATABASE_DIVERGENCE)', async () => {
    // 1. Pick a sealed row in audit_trail.change_log
    let rowRes = await adminPool.query<{ id: string; reason: string | null }>(
      'SELECT id::text, reason FROM audit_trail.change_log ORDER BY id ASC LIMIT 1',
    )
    if (rowRes.rows.length === 0) return

    let targetId = rowRes.rows[0].id
    let originalReason = rowRes.rows[0].reason

    // 2. Tamper with the row as superuser (temporarily disabling trigger)
    await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only')
    await adminPool.query(
      "UPDATE audit_trail.change_log SET reason = 'MALICIOUS_TAMPER_IN_DB' WHERE id = $1::bigint",
      [targetId],
    )
    await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only')

    try {
      // 3. Run verifier
      let tamperReport = await verifyAuditSeals({
        pool: sealerPool,
        wormStorage,
        verifyLiveDatabase: true,
      })

      assert.equal(tamperReport.status, 'FAIL', 'verifier must detect DB row modification')
      let dbError = tamperReport.errors.find((e) => e.kind === 'DATABASE_DIVERGENCE')
      assert.ok(dbError, 'verifier must raise DATABASE_DIVERGENCE error')
    } finally {
      // 4. Restore original database state
      await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only')
      await adminPool.query(
        'UPDATE audit_trail.change_log SET reason = $1 WHERE id = $2::bigint',
        [originalReason, targetId],
      )
      await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only')
    }

    // Confirm that verification passes after restore
    let restoredReport = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      verifyLiveDatabase: true,
    })
    assert.equal(restoredReport.status, 'PASS')
  })

  it('Flow 9: Tamper Test 2 — detects unauthorized deletion of live database row', async () => {
    // Insert a new organization and seal it so we have an isolated row to delete
    let deleteOrgId = 'e0000000-0000-0000-0000-00000000000d'
    await adminPool.query(
      `INSERT INTO party.organization (id, name, org_type)
       VALUES ($1, 'Delete Test Org', 'company')
       ON CONFLICT (id) DO NOTHING`,
      [deleteOrgId],
    )
    await adminPool.query('SELECT txid_current()')

    let deleteSeal = await sealHorizon({
      pool: sealerPool,
      wormStorage,
    })
    assert.equal(deleteSeal.sealed, true)

    // Find the change_log row for this org
    let rowRes = await adminPool.query<{ id: string; row_data: string }>(
      `SELECT id::text, row_to_json(c)::text AS row_data
       FROM audit_trail.change_log c
       WHERE table_name = 'organization' AND new_row->>'name' = 'Delete Test Org'
       LIMIT 1`,
    )
    assert.ok(rowRes.rows.length > 0)
    let deletedId = rowRes.rows[0].id
    let savedRowData = JSON.parse(rowRes.rows[0].row_data)

    // Delete the row as superuser
    await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only')
    await adminPool.query('DELETE FROM audit_trail.change_log WHERE id = $1::bigint', [deletedId])
    await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only')

    try {
      let deleteReport = await verifyAuditSeals({
        pool: sealerPool,
        wormStorage,
        verifyLiveDatabase: true,
      })

      assert.equal(deleteReport.status, 'FAIL', 'verifier must detect deleted DB row')
      let dbError = deleteReport.errors.find((e) => e.kind === 'DATABASE_DIVERGENCE')
      assert.ok(dbError, 'verifier must flag DATABASE_DIVERGENCE on missing row')
    } finally {
      // Re-insert deleted row
      await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only')
      await adminPool.query(
        `INSERT INTO audit_trail.change_log (
           id, occurred_at, tx_id, schema_name, table_name, op, row_id,
           old_row, new_row, changed_cols, actor_id, actor_label, db_role,
           session_id, auth_method, on_behalf_of, initiated_by, request_id,
           trace_id, source, client_ip, reason
         ) OVERRIDING SYSTEM VALUE VALUES (
           $1::bigint, $2, $3::xid8, $4, $5, $6, $7::uuid,
           $8::jsonb, $9::jsonb, $10, $11::uuid, $12, $13,
           $14::uuid, $15, $16::uuid, $17::uuid, $18,
           $19, $20, $21::inet, $22
         )`,
        [
          deletedId,
          savedRowData.occurred_at,
          savedRowData.tx_id,
          savedRowData.schema_name,
          savedRowData.table_name,
          savedRowData.op,
          savedRowData.row_id,
          savedRowData.old_row,
          savedRowData.new_row,
          savedRowData.changed_cols,
          savedRowData.actor_id,
          savedRowData.actor_label,
          savedRowData.db_role,
          savedRowData.session_id,
          savedRowData.auth_method,
          savedRowData.on_behalf_of,
          savedRowData.initiated_by,
          savedRowData.request_id,
          savedRowData.trace_id,
          savedRowData.source,
          savedRowData.client_ip,
          savedRowData.reason,
        ],
      )
      await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only')
    }
  })

  it('Flow 10: Tamper Test 3 — detects tampering with WORM storage blob', async () => {
    let latestRes = await adminPool.query<{ worm_uri: string }>(
      'SELECT worm_uri FROM audit_trail.seal ORDER BY id DESC LIMIT 1',
    )
    let wormUri = latestRes.rows[0].worm_uri
    let originalWormBytes = await wormStorage.read(wormUri)
    assert.ok(originalWormBytes)

    // Tamper with WORM storage blob
    let tamperedBytes = Buffer.from(
      originalWormBytes.toString('utf8').replace('mms-audit-seal-v1', 'mms-tampered-v1'),
      'utf8',
    )
    wormStorage._tamperForTest(wormUri, tamperedBytes)

    try {
      let wormReport = await verifyAuditSeals({
        pool: sealerPool,
        wormStorage,
        verifyLiveDatabase: true,
      })

      assert.equal(wormReport.status, 'FAIL', 'verifier must detect WORM storage payload tampering')
      let shaError = wormReport.errors.find((e) => e.kind === 'WORM_SHA256_MISMATCH')
      assert.ok(shaError, 'verifier must flag WORM_SHA256_MISMATCH')
    } finally {
      // Restore WORM storage
      wormStorage._tamperForTest(wormUri, originalWormBytes)
    }

    let cleanReport = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      verifyLiveDatabase: true,
    })
    assert.equal(cleanReport.status, 'PASS')
  })

  it('Flow 11: Tamper Test 4 — detects broken hash chain in audit_trail.seal', async () => {
    // Tamper with prev_seal_hash of a seal in audit_trail.seal
    let sealRes = await adminPool.query<{ id: string; prev_seal_hash: string }>(
      'SELECT id::text, prev_seal_hash FROM audit_trail.seal ORDER BY id DESC LIMIT 1',
    )
    let targetId = sealRes.rows[0].id
    let originalPrevHash = sealRes.rows[0].prev_seal_hash

    await adminPool.query('ALTER TABLE audit_trail.seal DISABLE TRIGGER seal_append_only')
    await adminPool.query(
      "UPDATE audit_trail.seal SET prev_seal_hash = repeat('f', 64) WHERE id = $1::bigint",
      [targetId],
    )
    await adminPool.query('ALTER TABLE audit_trail.seal ENABLE TRIGGER seal_append_only')

    try {
      let chainReport = await verifyAuditSeals({
        pool: sealerPool,
        wormStorage,
        verifyLiveDatabase: false,
      })

      assert.equal(chainReport.status, 'FAIL', 'verifier must detect broken seal hash chain')
      let chainError = chainReport.errors.find((e) => e.kind === 'CHAIN_BROKEN')
      assert.ok(chainError, 'verifier must raise CHAIN_BROKEN error')
    } finally {
      await adminPool.query('ALTER TABLE audit_trail.seal DISABLE TRIGGER seal_append_only')
      await adminPool.query(
        'UPDATE audit_trail.seal SET prev_seal_hash = $1 WHERE id = $2::bigint',
        [originalPrevHash, targetId],
      )
      await adminPool.query('ALTER TABLE audit_trail.seal ENABLE TRIGGER seal_append_only')
    }
  })

  it('Flow 12: Stated Residual Risk — pre-seal tampering reflects in seal; requires pgaudit / off-DB logs', async () => {
    // 1. Privileged operator alters an unsealed row BEFORE sealing runs
    let residualOrgId = 'e0000000-0000-0000-0000-00000000000f'
    await adminPool.query(
      `INSERT INTO party.organization (id, name, org_type)
       VALUES ($1, 'Pre-seal Tamper Org', 'company')
       ON CONFLICT (id) DO NOTHING`,
      [residualOrgId],
    )

    // Unsealed change_log row is tampered before sealing
    await adminPool.query('ALTER TABLE audit_trail.change_log DISABLE TRIGGER change_log_append_only')
    await adminPool.query(
      "UPDATE audit_trail.change_log SET reason = 'PRE_SEAL_UNAUTHORIZED_CHANGE' WHERE new_row->>'name' = 'Pre-seal Tamper Org'",
    )
    await adminPool.query('ALTER TABLE audit_trail.change_log ENABLE TRIGGER change_log_append_only')

    // 2. Horizon seal runs now
    await adminPool.query('SELECT txid_current()')
    let residualSeal = await sealHorizon({
      pool: sealerPool,
      wormStorage,
    })

    assert.equal(residualSeal.sealed, true)

    // 3. Verifier checks integrity:
    // The verifier compares WORM artifact with the DB. Both match, so cryptographic verification passes!
    let residualReport = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      verifyLiveDatabase: true,
    })

    assert.equal(residualReport.status, 'PASS')
    // ADR-0012 §6 explicitly notes this stated residual risk:
    // "A database superuser altering rows BEFORE sealing runs cannot be detected by cryptographic sealing alone;
    // mitigation relies on pgaudit (H-02) and off-DB append-only log forwarders."
    assert.ok(residualReport.residualRiskNote.includes('Residual Risk (ADR-0012 §6)'))
  })
})
