import type { Pool } from 'pg'
import {
  type SealManifest,
  computeSealHash,
  GENESIS_PREV_SEAL_HASH,
  sha256Hex,
} from './canonical.ts'
import {
  batchHash as runBatchHash,
  line as runLine,
  orderBy,
  parse as parseSealArtifact,
  selectList,
} from './seal-artifact.ts'
import { getSealerPool } from './sealer-client.ts'
import { type WormStorage, getWormStorage } from './worm-storage.ts'

export type TamperErrorKind =
  | 'CHAIN_BROKEN'
  | 'HORIZON_GAP'
  | 'WORM_OBJECT_NOT_FOUND'
  | 'WORM_SHA256_MISMATCH'
  | 'MANIFEST_CORRUPTED'
  | 'BATCH_HASH_MISMATCH'
  | 'SEAL_HASH_MISMATCH'
  | 'RECORD_COUNT_MISMATCH'
  | 'DATABASE_DIVERGENCE'

export interface VerificationError {
  sealId: string
  kind: TamperErrorKind
  message: string
  expected?: string
  actual?: string
}

export interface SealVerificationDetail {
  sealId: string
  fromXid: string
  toXid: string
  changeLogCount: number
  eventCount: number
  batchHash: string
  sealHash: string
  wormUri: string
  valid: boolean
  errors: VerificationError[]
}

export interface VerificationReport {
  status: 'PASS' | 'FAIL'
  totalSeals: number
  validSeals: number
  errors: VerificationError[]
  sealDetails: SealVerificationDetail[]
  residualRiskNote: string
}

import type { Alerter } from './alerter.ts'

export interface VerifyAuditSealsOptions {
  pool?: Pool
  wormStorage?: WormStorage
  verifyLiveDatabase?: boolean
  fromSealId?: string
  toSealId?: string
  alerter?: Alerter
  alertOnZeroRecords?: boolean
}

export const RESIDUAL_RISK_NOTE =
  'Residual Risk (ADR-0012 §6): A database superuser altering rows BEFORE sealing runs cannot be detected by cryptographic sealing alone; mitigation relies on pgaudit and off-DB append-only log forwarders.'

/**
 * Independent Verification Engine for Head Office Compliance.
 * Verifies cryptographic hash chains, WORM storage authenticity, RFC 8785 canonical batches,
 * and live database row correspondence.
 */
export async function verifyAuditSeals(
  options: VerifyAuditSealsOptions = {},
): Promise<VerificationReport> {
  let pool = options.pool ?? getSealerPool()
  let wormStorage = options.wormStorage ?? getWormStorage()
  let verifyLiveDb = options.verifyLiveDatabase ?? true

  let client = await pool.connect()
  try {
    let query = `
      SELECT id::text, sealed_at, sealed_by, from_xid::text, to_xid::text,
             change_log_count, event_count, batch_hash, prev_seal_hash,
             seal_hash, worm_uri, worm_sha256
      FROM audit_trail.seal
    `
    let whereClauses: string[] = []
    let queryParams: unknown[] = []
    if (options.fromSealId) {
      queryParams.push(options.fromSealId)
      whereClauses.push(`id >= $${queryParams.length}::bigint`)
    }
    if (options.toSealId) {
      queryParams.push(options.toSealId)
      whereClauses.push(`id <= $${queryParams.length}::bigint`)
    }
    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(' AND ')}`
    }
    query += ` ORDER BY id ASC`

    let sealRes = await client.query<{
      id: string
      sealed_at: Date
      sealed_by: string
      from_xid: string
      to_xid: string
      change_log_count: number
      event_count: number
      batch_hash: string
      prev_seal_hash: string
      seal_hash: string
      worm_uri: string
      worm_sha256: string
    }>(query, queryParams)

    let seals = sealRes.rows
    let allErrors: VerificationError[] = []
    let sealDetails: SealVerificationDetail[] = []

    for (let index = 0; index < seals.length; index++) {
      let seal = seals[index]
      let sealErrors: VerificationError[] = []

      // 1. Verify Hash Chain Continuity
      if (index === 0) {
        let precedingRes = await client.query<{ id: string; to_xid: string; seal_hash: string }>(
          'SELECT id::text, to_xid::text, seal_hash FROM audit_trail.seal WHERE id < $1::bigint ORDER BY id DESC LIMIT 1',
          [seal.id],
        )
        if (precedingRes.rows.length === 0) {
          if (seal.prev_seal_hash !== GENESIS_PREV_SEAL_HASH) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'CHAIN_BROKEN',
              message: `Genesis seal prev_seal_hash must be ${GENESIS_PREV_SEAL_HASH}`,
              expected: GENESIS_PREV_SEAL_HASH,
              actual: seal.prev_seal_hash,
            })
          }
        } else {
          let prevSeal = precedingRes.rows[0]
          if (seal.prev_seal_hash !== prevSeal.seal_hash) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'CHAIN_BROKEN',
              message: `Seal prev_seal_hash does not match previous seal_hash`,
              expected: prevSeal.seal_hash,
              actual: seal.prev_seal_hash,
            })
          }
          if (seal.from_xid !== prevSeal.to_xid) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'HORIZON_GAP',
              message: `Horizon gap detected: from_xid ${seal.from_xid} does not equal previous to_xid ${prevSeal.to_xid}`,
              expected: prevSeal.to_xid,
              actual: seal.from_xid,
            })
          }
        }
      } else {
        let prevSeal = seals[index - 1]
        if (seal.prev_seal_hash !== prevSeal.seal_hash) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'CHAIN_BROKEN',
            message: `Seal prev_seal_hash does not match previous seal_hash`,
            expected: prevSeal.seal_hash,
            actual: seal.prev_seal_hash,
          })
        }

        // Horizon Continuity / Gap Check
        if (seal.from_xid !== prevSeal.to_xid) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'HORIZON_GAP',
            message: `Horizon gap detected: from_xid ${seal.from_xid} does not equal previous to_xid ${prevSeal.to_xid}`,
            expected: prevSeal.to_xid,
            actual: seal.from_xid,
          })
        }
      }

      // 2. Read and Verify WORM Storage Artifact
      let wormContent = await wormStorage.read(seal.worm_uri)
      if (!wormContent) {
        sealErrors.push({
          sealId: seal.id,
          kind: 'WORM_OBJECT_NOT_FOUND',
          message: `WORM storage object not found at URI: ${seal.worm_uri}`,
        })
      } else {
        // Validate WORM payload SHA-256
        let actualWormSha256 = sha256Hex(wormContent)
        if (actualWormSha256 !== seal.worm_sha256) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'WORM_SHA256_MISMATCH',
            message: `WORM artifact SHA-256 digest does not match database record (possible payload tampering in storage)`,
            expected: seal.worm_sha256,
            actual: actualWormSha256,
          })
        }

        // Parse through the shared protocol module. The verifier deliberately does
        // not re-derive the framing: parse() is the same function the sealer's bytes
        // must satisfy -- and carries its own canonical batch-hash check -- so
        // "canonical" means one thing in this codebase rather than two that agree.
        try {
          let parsed = parseSealArtifact(wormContent)
          let manifest = parsed.manifest

          let expectedRecords = seal.change_log_count + seal.event_count
          if (parsed.records.length !== expectedRecords) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'RECORD_COUNT_MISMATCH',
              message: `Record count (${parsed.records.length}) does not match seal counts (${expectedRecords})`,
              expected: String(expectedRecords),
              actual: String(parsed.records.length),
            })
          }

          // Cross-check every manifest header field against the audit_trail.seal row
          if (
            manifest.from_xid !== seal.from_xid ||
            manifest.to_xid !== seal.to_xid ||
            manifest.prev_seal_hash !== seal.prev_seal_hash ||
            manifest.change_log_count !== seal.change_log_count ||
            manifest.event_count !== seal.event_count
          ) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'MANIFEST_CORRUPTED',
              message: `WORM manifest metadata does not match audit_trail.seal row`,
              expected: `${seal.from_xid}..${seal.to_xid} (${seal.change_log_count}/${seal.event_count})`,
              actual: `${manifest.from_xid}..${manifest.to_xid} (${manifest.change_log_count}/${manifest.event_count})`,
            })
          }

          if (manifest.sealed_at && Math.abs(new Date(manifest.sealed_at).getTime() - seal.sealed_at.getTime()) > 1000) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'MANIFEST_CORRUPTED',
              message: `WORM manifest sealed_at does not match audit_trail.seal.sealed_at`,
              expected: seal.sealed_at.toISOString(),
              actual: manifest.sealed_at,
            })
          }

          // parse() already proved the batch hash; corroborate against the seal row
          if (manifest.batch_hash !== seal.batch_hash) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'BATCH_HASH_MISMATCH',
              message: `Recomputed batch hash does not match seal batch_hash`,
              expected: seal.batch_hash,
              actual: manifest.batch_hash,
            })
          }

          // Recompute Seal Hash using the DB seal row timestamp (verified above)
          let recomputedSealHash = computeSealHash({
            prev_seal_hash: seal.prev_seal_hash,
            batch_hash: seal.batch_hash,
            from_xid: seal.from_xid,
            to_xid: seal.to_xid,
            change_log_count: seal.change_log_count,
            event_count: seal.event_count,
            sealed_at: manifest.sealed_at || seal.sealed_at.toISOString(),
          })

          if (recomputedSealHash !== seal.seal_hash) {
            sealErrors.push({
              sealId: seal.id,
              kind: 'SEAL_HASH_MISMATCH',
              message: `Recomputed seal hash does not match seal_hash in database`,
              expected: seal.seal_hash,
              actual: recomputedSealHash,
            })
          }
        } catch (parseErr) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'MANIFEST_CORRUPTED',
            message: `Artifact does not satisfy the seal protocol: ${(parseErr as Error).message}`,
          })
        }

      }

      // 3. Verify Against Live Database Rows (if requested and not yet retention-purged)
      let isPurgedByRetention = false
      if (verifyLiveDb) {
        let purgeRes = await client.query<{ pruned: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM audit_trail.retention_purge_run
              WHERE status = 'completed'
                AND max_sealed_xid >= $1::xid8
                AND cutoff_time >= $2::timestamptz
                AND (change_log_purged_count > 0 OR event_purged_count > 0)
           ) AS pruned`,
          [seal.to_xid, seal.sealed_at.toISOString()],
        )
        isPurgedByRetention = Boolean(purgeRes.rows[0]?.pruned)
      }

      if (verifyLiveDb && !isPurgedByRetention) {
        let dbChangeLogRes = await client.query<Record<string, unknown>>(
          `SELECT ${selectList('change_log')}
           FROM audit_trail.change_log
           WHERE tx_id >= $1::xid8 AND tx_id < $2::xid8
           ORDER BY ${orderBy()}`,
          [seal.from_xid, seal.to_xid],
        )

        let dbEventRes = await client.query<Record<string, unknown>>(
          `SELECT ${selectList('event')}
           FROM audit_trail.event
           WHERE tx_id >= $1::xid8 AND tx_id < $2::xid8
           ORDER BY ${orderBy()}`,
          [seal.from_xid, seal.to_xid],
        )

        if (dbChangeLogRes.rows.length !== seal.change_log_count) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'DATABASE_DIVERGENCE',
            message: `Live database change_log row count (${dbChangeLogRes.rows.length}) does not match sealed count (${seal.change_log_count})`,
            expected: String(seal.change_log_count),
            actual: String(dbChangeLogRes.rows.length),
          })
        }

        if (dbEventRes.rows.length !== seal.event_count) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'DATABASE_DIVERGENCE',
            message: `Live database event row count (${dbEventRes.rows.length}) does not match sealed count (${seal.event_count})`,
            expected: String(seal.event_count),
            actual: String(dbEventRes.rows.length),
          })
        }

        // Reconstruct canonical lines from live DB and verify batch hash
        let dbChangeLines = dbChangeLogRes.rows.map((r) =>
          runLine({ table: 'change_log', data: r }),
        )
        let dbEventLines = dbEventRes.rows.map((r) =>
          runLine({ table: 'event', data: r }),
        )
        let dbRecordLines = [...dbChangeLines, ...dbEventLines]
        let dbBatchHash = runBatchHash(dbRecordLines)

        if (dbBatchHash !== seal.batch_hash) {
          sealErrors.push({
            sealId: seal.id,
            kind: 'DATABASE_DIVERGENCE',
            message: `Live database rows have diverged from sealed batch hash (unauthorized modification or deletion in live database)`,
            expected: seal.batch_hash,
            actual: dbBatchHash,
          })
        }
      }

      let isValid = sealErrors.length === 0
      sealDetails.push({
        sealId: seal.id,
        fromXid: seal.from_xid,
        toXid: seal.to_xid,
        changeLogCount: seal.change_log_count,
        eventCount: seal.event_count,
        batchHash: seal.batch_hash,
        sealHash: seal.seal_hash,
        wormUri: seal.worm_uri,
        valid: isValid,
        errors: sealErrors,
      })

      allErrors.push(...sealErrors)
    }

    let validCount = sealDetails.filter((s) => s.valid).length
    if (allErrors.length > 0 && options.alerter) {
      await options.alerter.emit(
        'SEAL_TAMPER_DETECTED',
        'CRITICAL',
        'AuditVerifier',
        `Audit verifier detected ${allErrors.length} tamper/divergence error(s) across ${seals.length} seal(s).`,
        { totalSeals: seals.length, validSeals: validCount, errors: allErrors },
      )
    }

    if (options.alerter && (options.alertOnZeroRecords ?? false)) {
      if (seals.length === 0) {
        await options.alerter.emit(
          'ZERO_RECORD_ANOMALY',
          'WARNING',
          'AuditVerifier',
          'Audit verifier found zero seals in audit_trail.seal; no evidence exists to analyze.',
          { totalSeals: 0 },
        )
      } else {
        let zeroRecordSeals = sealDetails.filter((s) => s.changeLogCount === 0 && s.eventCount === 0)
        if (zeroRecordSeals.length > 0) {
          await options.alerter.emit(
            'ZERO_RECORD_ANOMALY',
            'WARNING',
            'AuditVerifier',
            `Audit verifier detected ${zeroRecordSeals.length} seal(s) with zero change_log and event records.`,
            { zeroRecordSeals: zeroRecordSeals.map((s) => s.sealId) },
          )
        }
      }
    }

    return {
      status: allErrors.length === 0 ? 'PASS' : 'FAIL',
      totalSeals: seals.length,
      validSeals: validCount,
      errors: allErrors,
      sealDetails,
      residualRiskNote: RESIDUAL_RISK_NOTE,
    }
  } finally {
    client.release()
  }
}
