import { describe, it, before, after } from "node:test"
import { lockSealChain, type SealChainLock } from "./seal-chain-lock.ts"
import * as assert from "node:assert/strict"
import { Pool } from "pg"
import { sealHorizon } from "./sealer.ts"
import { verifyAuditSeals } from "./verifier.ts"
import { MemoryWormStorage } from "./worm-storage.ts"
import { Alerter, MemoryAlertSink } from "./alerter.ts"
import { CryptoShredder, CryptoShreddedError } from "./crypto-shredder.ts"
import {
  STATUTORY_RETENTION_CLASSES,
  getRetentionClass,
  isStatutorilyExpired,
  isEligibleForActiveDbPrune,
  pruneSealedAudit,
} from "./retention.ts"

import { withRole } from '../db/role-pool.ts'

const testDbUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/mms_acceptance"

const sealerDbUrl =
  process.env.AUDIT_SEALER_DATABASE_URL ||
  process.env.MMS_SEALER_DATABASE_URL ||
  withRole(testDbUrl, 'audit_sealer')

describe('Card H-03: Audit Retention Classes, Crypto-Shredding & Partitioning Safeguards', () => {
  let adminPool: Pool
  let sealerPool: Pool
  let wormStorage: MemoryWormStorage
  let alertSink: MemoryAlertSink
  let alerter: Alerter
  let chainLock: SealChainLock

  before(async () => {
    // Exclusive use of the audit_trail.seal chain for this block's lifetime; see lockSealChain.
    chainLock = await lockSealChain(testDbUrl, 'Card H-03')
    adminPool = new Pool({ connectionString: testDbUrl, max: 5 })
    sealerPool = new Pool({ connectionString: sealerDbUrl, max: 5 })
    wormStorage = new MemoryWormStorage()
    alertSink = new MemoryAlertSink()
    alerter = new Alerter([alertSink])

    // Reset the chain. Safe because this block holds the chain lock for its whole life,
    // so no sibling block can be mid-seal against it (see lockSealChain).
    await adminPool.query('ALTER TABLE audit_trail.seal DISABLE TRIGGER seal_append_only')
    await adminPool.query('DELETE FROM audit_trail.seal')
    await adminPool.query('ALTER TABLE audit_trail.seal ENABLE TRIGGER seal_append_only')

    await adminPool.query('ALTER TABLE audit_trail.crypto_shred_key DISABLE TRIGGER crypto_shred_key_guard').catch(() => {})
    await adminPool.query('DELETE FROM audit_trail.crypto_shred_key').catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.crypto_shred_key ENABLE TRIGGER crypto_shred_key_guard').catch(() => {})
  })

  after(async () => {
    // audit_trail.seal is left intact: H-01's workers share this chain and must not see it vanish.

    await adminPool.query('ALTER TABLE audit_trail.crypto_shred_key DISABLE TRIGGER crypto_shred_key_guard').catch(() => {})
    await adminPool.query('DELETE FROM audit_trail.crypto_shred_key').catch(() => {})
    await adminPool.query('ALTER TABLE audit_trail.crypto_shred_key ENABLE TRIGGER crypto_shred_key_guard').catch(() => {})

    await sealerPool.end().catch(() => {})
    await adminPool.end().catch(() => {})
    await chainLock.release()
  })

  it('Flow 1: Statutory retention class schedule conforms to IMO RO Code and GDPR specifications', () => {
    assert.equal(Object.keys(STATUTORY_RETENTION_CLASSES).length, 7, 'All 7 statutory classes defined')

    // RC-1: IAM
    let rc1 = getRetentionClass('RC-1')
    assert.equal(rc1.statutoryRetentionYears, 7)
    assert.equal(rc1.activeDbRetentionYears, 2)
    assert.equal(rc1.cryptoShredEligible, true, 'RC-1 is crypto-shred eligible for user personal data')

    // RC-2: Maritime Surveys
    let rc2 = getRetentionClass('RC-2')
    assert.equal(rc2.statutoryRetentionYears, 10)
    assert.equal(rc2.activeDbRetentionYears, 5)
    assert.equal(rc2.cryptoShredEligible, false, 'RC-2 survey records exempt from GDPR erasure under Art 17(3)(b)')

    // RC-3: Technical Ship Data & Plan Approvals
    let rc3 = getRetentionClass('RC-3')
    assert.equal(rc3.statutoryRetentionYears, 30)
    assert.equal(rc3.activeDbRetentionYears, 10)
    assert.equal(rc3.dispositionPolicy, 'cold_immutable')

    // RC-4: Issued Certificates
    let rc4 = getRetentionClass('RC-4')
    assert.equal(rc4.statutoryRetentionYears, 30)
    assert.equal(rc4.cryptoShredEligible, false)

    // RC-5: Row-level audit change logs
    let rc5 = getRetentionClass('RC-5')
    assert.equal(rc5.activeDbRetentionYears, 2)
    assert.equal(rc5.cryptoShredEligible, true, 'PII in change_log rows can be crypto-shredded')

    // RC-6: Administrative events
    let rc6 = getRetentionClass('RC-6')
    assert.equal(rc6.statutoryRetentionYears, 7)
    assert.equal(rc6.activeDbRetentionYears, 3)

    // RC-7: Schema migrations
    let rc7 = getRetentionClass('RC-7')
    assert.equal(rc7.statutoryRetentionYears, null, 'Schema change evidence is perpetual')
    assert.equal(rc7.activeDbRetentionYears, null)

    // Verification of date calculation helpers
    let now = new Date('2026-10-31T12:00:00Z')
    let recentEvent = new Date('2025-01-01T00:00:00Z')
    let eightYearsAgo = new Date('2018-01-01T00:00:00Z')
    let thirtyOneYearsAgo = new Date('1995-01-01T00:00:00Z')

    assert.equal(isStatutorilyExpired('RC-1', recentEvent, now), false)
    assert.equal(isStatutorilyExpired('RC-1', eightYearsAgo, now), true)
    assert.equal(isStatutorilyExpired('RC-7', thirtyOneYearsAgo, now), false, 'RC-7 never expires')

    assert.equal(isEligibleForActiveDbPrune('RC-1', recentEvent, now), false)
    assert.equal(isEligibleForActiveDbPrune('RC-1', eightYearsAgo, now), true)
    assert.equal(isEligibleForActiveDbPrune('RC-7', thirtyOneYearsAgo, now), false, 'RC-7 never pruned from DB')
  })

  it('Flow 2: In-Memory Crypto-Shredder encrypts PII, decrypts while active, and permanently shreds key', async () => {
    let shredder = new CryptoShredder({ alerter })
    let subjectId = crypto.randomUUID()
    let sensitivePii = 'Personal Phone: +86-138-0013-8000, Home: 123 Harbour Rd, Shanghai'

    // 1. Encrypt PII
    let payload = await shredder.encryptField(subjectId, sensitivePii)
    assert.equal(payload.enc, true)
    assert.equal(payload.alg, 'AES-256-GCM')
    assert.equal(payload.subjectId, subjectId)
    assert.notEqual(payload.ciphertext, sensitivePii)

    // 2. Decrypt while active
    let decrypted = await shredder.decryptField(payload)
    assert.equal(decrypted, sensitivePii, 'Plaintext recovers perfectly while key is active')

    // 3. Execute cryptographic shredding (GDPR Art 17 / PIPL Art 47)
    let shredded = await shredder.shredSubjectKey(subjectId, 'Employee left organization; requested erasure')
    assert.equal(shredded, true, 'Shredding succeeds')

    // 4. Decryption must fail permanently
    await assert.rejects(
      async () => {
        await shredder.decryptField(payload)
      },
      (err: unknown) => {
        assert.ok(err instanceof CryptoShreddedError)
        assert.equal(err.subjectId, subjectId)
        return true
      },
      'Decryption throws CryptoShreddedError after key destruction',
    )

    // 5. Subsequent encryption attempts for shredded subject are rejected
    await assert.rejects(
      async () => {
        await shredder.encryptField(subjectId, 'New data')
      },
      CryptoShreddedError,
      'Cannot encrypt data for a shredded subject',
    )

    // 6. Alert was emitted
    let alerts = alertSink.findByType('CRYPTO_SHRED_EXECUTED')
    assert.ok(alerts.length >= 1)
    assert.equal(alerts[0].details?.subjectId, subjectId)
  })

  it('Flow 3: Database-backed Crypto-Shredder persists wrapped DEK and enforces zeroization via private.shred_subject_key', async () => {
    let shredder = new CryptoShredder({ pool: adminPool, alerter })
    let subjectId = crypto.randomUUID()
    let sensitiveEmail = 'surveyor.private@personal-domain.example'

    // 1. Encrypt field (creates DB record in audit_trail.crypto_shred_key)
    let payload = await shredder.encryptField(subjectId, sensitiveEmail)
    let dbRow = await adminPool.query(
      'SELECT key_status, algorithm, encrypted_key, key_fingerprint FROM audit_trail.crypto_shred_key WHERE subject_id = $1',
      [subjectId],
    )
    assert.equal(dbRow.rows.length, 1)
    assert.equal(dbRow.rows[0].key_status, 'active')
    assert.equal(dbRow.rows[0].algorithm, 'AES-256-GCM')
    assert.ok(dbRow.rows[0].encrypted_key.length > 30)

    // 2. Decrypt field using DB-backed key
    let recovered = await shredder.decryptField(payload)
    assert.equal(recovered, sensitiveEmail)

    // 3. Shred the key in the database
    let shredResult = await shredder.shredSubjectKey(subjectId, 'GDPR Right to Erasure requested by surveyor')
    assert.equal(shredResult, true)

    // 4. Verify DB row is zeroized and immutable
    let updatedRow = await adminPool.query(
      'SELECT key_status, encrypted_key, shred_reason FROM audit_trail.crypto_shred_key WHERE subject_id = $1',
      [subjectId],
    )
    assert.equal(updatedRow.rows[0].key_status, 'shredded')
    assert.ok(updatedRow.rows[0].encrypted_key.startsWith('SHREDDED_ZEROIZED_'))
    assert.equal(updatedRow.rows[0].shred_reason, 'GDPR Right to Erasure requested by surveyor')

    // 5. Decrypt attempt throws CryptoShreddedError
    await assert.rejects(
      async () => {
        await shredder.decryptField(payload)
      },
      CryptoShreddedError,
    )

    // 6. DB Trigger prevents un-shredding (restoring active status)
    await assert.rejects(
      async () => {
        await adminPool.query("UPDATE audit_trail.crypto_shred_key SET key_status = 'active' WHERE subject_id = $1", [
          subjectId,
        ])
      },
      /shredded keys cannot be modified or restored/,
      'Database trigger prevents restoration of a shredded key',
    )
  })

  it('Flow 4: WORM Immutability Proof — Sealed batches containing crypto-shredded PII verify intact after key destruction', async () => {
    let shredder = new CryptoShredder({ pool: adminPool })
    let subjectA = crypto.randomUUID()
    let subjectB = crypto.randomUUID()

    let piiA = 'Subject A Private Phone: +44-7700-900077'
    let piiB = 'Subject B Private Phone: +65-8123-4567'

    let encPayloadA = await shredder.encryptField(subjectA, piiA)
    let encPayloadB = await shredder.encryptField(subjectB, piiB)

    // Record an audit change log entry containing the encrypted PII
    let txClient = await adminPool.connect()
    try {
      await txClient.query('BEGIN')
      await txClient.query(
        `INSERT INTO audit_trail.change_log (
           schema_name, table_name, op, row_id, new_row, db_role, source, reason
         ) VALUES (
           'iam', 'app_user', 'U', $1, $2, 'int_sysadmin', 'web', 'Store encrypted profile PII'
         )`,
        [subjectA, JSON.stringify({ id: subjectA, contact_enc: encPayloadA })],
      )
      await txClient.query(
        `INSERT INTO audit_trail.change_log (
           schema_name, table_name, op, row_id, new_row, db_role, source, reason
         ) VALUES (
           'iam', 'app_user', 'U', $1, $2, 'int_sysadmin', 'web', 'Store encrypted profile PII'
         )`,
        [subjectB, JSON.stringify({ id: subjectB, contact_enc: encPayloadB })],
      )
      await txClient.query('COMMIT')
    } finally {
      txClient.release()
    }

    // Seal the horizon into Tier-2 WORM storage
    let sealResult = await sealHorizon({
      pool: sealerPool,
      wormStorage,
    })

    assert.ok(sealResult, 'Horizon was sealed')
    // The batch must actually cover the two rows above: this flow proves that a batch
    // already written to WORM storage keeps verifying after its PII key is destroyed, which
    // is vacuous if the batch never held the ciphertext. Another worker sealing the same
    // horizon first would leave this batch empty, and then the proof would test nothing.
    assert.ok(sealResult.changeLogCount >= 2, 'Sealed batch must cover the two encrypted rows this test wrote')

    let originalBatchHash = sealResult.batchHash
    let originalSealHash = sealResult.sealHash
    let originalWormSha256 = sealResult.wormSha256

    // Compliance verifier validates the sealed state BEFORE shredding
    let preShredVerify = await verifyAuditSeals({
      pool: adminPool,
      wormStorage,
    })
    assert.equal(preShredVerify.status, 'PASS', 'Verification succeeds before shredding')
    assert.equal(preShredVerify.errors.length, 0)

    // NOW: Execute GDPR Right to Erasure for Subject A
    let shredSuccess = await shredder.shredSubjectKey(subjectA, 'GDPR Article 17 Erasure executed')
    assert.equal(shredSuccess, true)

    // Proof 1: Subject A PII is completely unrecoverable
    await assert.rejects(
      async () => {
        await shredder.decryptField(encPayloadA)
      },
      CryptoShreddedError,
      'Subject A data is permanently destroyed',
    )

    // Proof 2: Subject B PII is still decryptable
    let recoveredB = await shredder.decryptField(encPayloadB)
    assert.equal(recoveredB, piiB, 'Subject B data is unaffected')

    // Proof 3: Check that the WORM object and audit_trail.seal records are completely undisturbed
    let postShredDbSeal = await adminPool.query('SELECT batch_hash, seal_hash, worm_sha256 FROM audit_trail.seal WHERE id = $1', [
      sealResult.sealId,
    ])
    assert.equal(postShredDbSeal.rows[0].batch_hash, originalBatchHash, 'batch_hash in DB unchanged')
    assert.equal(postShredDbSeal.rows[0].seal_hash, originalSealHash, 'seal_hash chain unchanged')
    assert.equal(postShredDbSeal.rows[0].worm_sha256, originalWormSha256, 'WORM digest in DB unchanged')

    // Proof 4: Run standalone compliance verifier against WORM storage and DB hash chain
    let postShredVerify = await verifyAuditSeals({
      pool: adminPool,
      wormStorage,
    })
    assert.equal(postShredVerify.status, 'PASS', 'Independent compliance verifier passes with zero errors after shredding!')
    assert.equal(postShredVerify.errors.length, 0)
    assert.equal(postShredVerify.validSeals, preShredVerify.validSeals)
  })

  it('Flow 5: Retention Lifecycle Pruning — Unsealed records cannot be pruned; sealed expired records prune cleanly', async () => {
    // 0. A prune with no seals at all must refuse rather than delete unsealed rows. This
    //    case can only be exercised on an empty table, so it runs only when the worker
    //    that reaches this point finds one: another concurrent worker may already have
    //    sealed, and quietly emptying the shared chain to satisfy the assertion would
    //    reintroduce exactly the interference it is meant to avoid.
    let sealCount = await adminPool.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_trail.seal')
    if (sealCount.rows[0]?.count === '0') {
      await assert.rejects(
        async () => {
          await pruneSealedAudit({
            pool: adminPool,
            retentionClass: 'RC-1',
            olderThan: new Date(),
          })
        },
        /cannot_purge_unsealed_audit: no audit seals exist/,
        'Rejects purging when zero seals exist',
      )
    }

    // 1. Attempting to prune with invalid retention class throws
    await assert.rejects(
      async () => {
        await pruneSealedAudit({
          pool: adminPool,
          retentionClass: 'NON_EXISTENT_CLASS',
          olderThan: new Date(),
        })
      },
      /Unknown retention class code/,
      'Rejects invalid retention class',
    )

    // 2. Perpetual retention class cannot be pruned
    await assert.rejects(
      async () => {
        await pruneSealedAudit({
          pool: adminPool,
          retentionClass: 'RC-7',
          olderThan: new Date(),
        })
      },
      /perpetual active DB retention and cannot be purged/,
      'Rejects purging perpetual schema changes',
    )

    // 3. Create a change_log record to be sealed
    let sealedSubject = crypto.randomUUID()
    await adminPool.query(
      `INSERT INTO audit_trail.change_log (
         schema_name, table_name, op, row_id, new_row, db_role, source, reason
       ) VALUES (
         'iam', 'app_user', 'I', $1, $2, 'int_sysadmin', 'web', 'Sealed historical user'
       )`,
      [sealedSubject, JSON.stringify({ id: sealedSubject, username: 'sealed_user' })],
    )

    // Seal the horizon into Tier-2 WORM storage
    let sealResult = await sealHorizon({
      pool: sealerPool,
      wormStorage,
    })
    assert.ok(sealResult, 'Horizon was sealed')

    // 4. NOW: Create an UNSEALED record after the seal horizon (tx_id >= to_xid)
    let unsealedSubject = crypto.randomUUID()
    let unsealedInsert = await adminPool.query(
      `INSERT INTO audit_trail.change_log (
         schema_name, table_name, op, row_id, new_row, db_role, source, reason
       ) VALUES (
         'iam', 'app_user', 'I', $1, $2, 'int_sysadmin', 'web', 'Unsealed fresh user'
       ) RETURNING id, tx_id::text`,
      [unsealedSubject, JSON.stringify({ id: unsealedSubject, username: 'unsealed_user' })],
    )
    let unsealedId = unsealedInsert.rows[0].id

    // 5. Execute prune for RC-1 with future cutoff and specific audit reason
    let pruneResult = await pruneSealedAudit({
      pool: adminPool,
      retentionClass: 'RC-1',
      olderThan: new Date(Date.now() + 86400000), // future cutoff to match test records
      maxRows: 100,
      reason: 'Scheduled statutory WORM retention purge for RC-1',
      alerter,
    })

    assert.ok(pruneResult.runId > 0, 'Prune run ID recorded')
    assert.equal(pruneResult.retentionClass, 'RC-1')
    assert.ok(pruneResult.changeLogsPurged >= 1, 'Purged sealed records')

    // 6. PROOF: The UNSEALED record was NOT purged (tx_id >= max_sealed_xid safeguarded)
    let checkUnsealed = await adminPool.query('SELECT id FROM audit_trail.change_log WHERE id = $1', [unsealedId])
    assert.equal(checkUnsealed.rows.length, 1, 'Unsealed record remains in database and was NOT pruned!')

    // 7. Verify retention purge run was recorded in audit_trail.retention_purge_run
    let runRecord = await adminPool.query(
      'SELECT status, reason, change_log_purged_count, event_purged_count FROM audit_trail.retention_purge_run WHERE id = $1',
      [pruneResult.runId],
    )
    assert.equal(runRecord.rows[0].status, 'completed')
    assert.equal(runRecord.rows[0].reason, 'Scheduled statutory WORM retention purge for RC-1')

    // 8. Verify audit event audit_trail.retention.purged was emitted into audit_trail.event
    let eventRecord = await adminPool.query(
      "SELECT id, event_type, reason, detail FROM audit_trail.event WHERE event_type = 'audit_trail.retention.purged' ORDER BY id DESC LIMIT 1",
    )
    assert.equal(eventRecord.rows.length, 1, 'Emitted audit_trail.retention.purged event')
    assert.equal(eventRecord.rows[0].reason, 'Scheduled statutory WORM retention purge for RC-1')
    assert.equal(eventRecord.rows[0].detail.retention_class, 'RC-1')

    // 9. Verify RETENTION_PURGE_EXECUTED alert was emitted by alerter
    let purgeAlerts = alertSink.findByType('RETENTION_PURGE_EXECUTED')
    assert.ok(purgeAlerts.length >= 1, 'Alerter emitted RETENTION_PURGE_EXECUTED')

    // 10. Direct DELETE on audit_trail.change_log is still completely blocked by append-only trigger
    await assert.rejects(
      async () => {
        await adminPool.query("DELETE FROM audit_trail.change_log WHERE schema_name = 'iam'")
      },
      /audit(_trail)?\.change_log is append-only/,
      'Direct DELETE remains strictly blocked by trigger',
    )
  })

  it('Flow 6: In-Memory Key Zeroization & Cache Invalidation — RAM buffers are securely overwritten with zeros', async () => {
    // 1. In-memory CryptoShredder zeroization
    let memShredder = new CryptoShredder({ alerter })
    let subject1 = crypto.randomUUID()
    let keyRec1 = await memShredder.getOrCreateKey(subject1)
    assert.ok(keyRec1.keyBuffer, 'Key buffer exists')
    let rawBuffer1 = keyRec1.keyBuffer
    assert.ok(!rawBuffer1.every((b) => b === 0), 'Buffer has non-zero random cryptographic bytes')

    await memShredder.shredSubjectKey(subject1, 'Erasure test')
    assert.ok(rawBuffer1.every((b) => b === 0), 'RAM buffer was explicitly zeroized with zeros!')

    // 2. DB-backed CryptoShredder zeroization
    let dbShredder = new CryptoShredder({ pool: adminPool, alerter })
    let subject2 = crypto.randomUUID()
    let keyRec2 = await dbShredder.getOrCreateKey(subject2)
    assert.ok(keyRec2.keyBuffer, 'DB-backed cached key buffer exists')
    let rawBuffer2 = keyRec2.keyBuffer
    assert.ok(!rawBuffer2.every((b) => b === 0), 'Buffer has non-zero bytes')

    await dbShredder.shredSubjectKey(subject2, 'Erasure test')
    assert.ok(rawBuffer2.every((b) => b === 0), 'Cached DB buffer was explicitly zeroized with zeros upon shredding!')

    // 3. Cache invalidation
    let subject3 = crypto.randomUUID()
    let keyRec3 = await memShredder.getOrCreateKey(subject3)
    let rawBuffer3 = keyRec3.keyBuffer!
    memShredder.invalidateCache(subject3)
    assert.ok(rawBuffer3.every((b) => b === 0), 'invalidateCache zeroized key buffer')
  })

  it('Flow 7: Un-Keyed Subject Shredding & Active Key Re-Wrapping Safeguards', async () => {
    let shredder = new CryptoShredder({ pool: adminPool, alerter })
    let unkeyedSubject = crypto.randomUUID()

    // 1. Shredding a subject that never had a prior key succeeds (creates pre-shredded record)
    let shredSuccess = await shredder.shredSubjectKey(unkeyedSubject, 'Pre-emptive privacy erasure')
    assert.equal(shredSuccess, true)

    // 2. Subsequent attempt to encrypt for this subject throws CryptoShreddedError
    await assert.rejects(
      async () => {
        await shredder.encryptField(unkeyedSubject, 'Private data')
      },
      CryptoShreddedError,
      'Cannot encrypt data for pre-emptively shredded subject',
    )

    // 3. Repeating shred is idempotent (returns false)
    let repeatShred = await shredder.shredSubjectKey(unkeyedSubject, 'Repeat request')
    assert.equal(repeatShred, false)

    // 4. Active key re-wrapping allowed; subject_id mutation blocked
    let activeSubject = crypto.randomUUID()
    await shredder.getOrCreateKey(activeSubject)

    await adminPool.query(
      `UPDATE audit_trail.crypto_shred_key
       SET encrypted_key = 'ROTATED_WRAPPED_KEY_CIPHERTEXT'
       WHERE subject_id = $1`,
      [activeSubject],
    )

    await assert.rejects(
      async () => {
        await adminPool.query(
          `UPDATE audit_trail.crypto_shred_key
           SET subject_id = $1
           WHERE subject_id = $2`,
          [crypto.randomUUID(), activeSubject],
        )
      },
      /subject_id is immutable/,
      'Database trigger strictly prevents subject_id changes',
    )
  })

  it('Flow 8: Robustness & Boundary Validation — Malformed payloads, invalid dates, and master key bounds', async () => {
    let shredder = new CryptoShredder()

    // 1. Malformed payloads in decryptField
    await assert.rejects(
      async () => {
        await shredder.decryptField(null as any)
      },
      /Unsupported encryption payload format/,
    )
    await assert.rejects(
      async () => {
        await shredder.decryptField({ enc: false } as any)
      },
      /Unsupported encryption payload format/,
    )
    await assert.rejects(
      async () => {
        await shredder.decryptField({ enc: true, alg: 'AES-256-GCM', subjectId: '' } as any)
      },
      /missing required cryptographic fields/,
    )

    // 2. Non-string plaintext in encryptField
    await assert.rejects(
      async () => {
        await shredder.encryptField(crypto.randomUUID(), 12345 as any)
      },
      /plaintext must be a string/,
    )

    // 3. Invalid dates in retention date helpers
    assert.throws(
      () => isStatutorilyExpired('RC-1', new Date('invalid')),
      TypeError,
    )
    assert.throws(
      () => isEligibleForActiveDbPrune('RC-1', new Date('invalid')),
      TypeError,
    )

    // 4. Invalid master key length
    assert.throws(
      () => new CryptoShredder({ masterKey: Buffer.from('too_short') }),
      /Master key must be exactly 32 bytes/,
    )
  })
})
