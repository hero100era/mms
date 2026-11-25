import type { Pool, PoolClient } from 'pg'
import { type SealManifest } from './canonical.ts'
import {
  artifact,
  batchHash as computeBatchHash,
  computeSealHash,
  GENESIS_PREV_SEAL_HASH,
  line,
  manifest as buildManifest,
  orderBy,
  parse as parseSealArtifact,
  selectList,
  sha256Hex,
} from './seal-artifact.ts'
import { getSealerPool } from './sealer-client.ts'
import { type WormStorage, getWormStorage } from './worm-storage.ts'

export class AuditSealGapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditSealGapError'
  }
}

import type { Alerter } from './alerter.ts'

export interface SealHorizonOptions {
  pool?: Pool
  wormStorage?: WormStorage
  maxLagThreshold?: number // default 50000
  forceHorizonXid?: string // for controlled test environments
  sealedBy?: string
  allowEmptySeal?: boolean // default false
  alerter?: Alerter
}

export interface SealResult {
  sealed: boolean
  sealId?: string
  fromXid: string
  toXid: string
  changeLogCount: number
  eventCount: number
  batchHash: string
  prevSealHash: string
  sealHash: string
  wormUri: string
  wormSha256: string
  lagWarning?: string
  reason?: string
}

export interface LagCheckResult {
  currentXid: string
  horizonXid: string
  lagXids: bigint
  hasWarning: boolean
  warningMessage?: string
}

/**
 * Checks the transaction lag between current transaction counter and the lowest active snapshot xmin.
 */
export async function checkHorizonLag(
  client: PoolClient | Pool,
  maxLagThreshold = 50000,
): Promise<LagCheckResult> {
  let res = await client.query<{ current_xid: string; horizon_xid: string }>(
    `SELECT COALESCE(pg_current_xact_id_if_assigned()::text, pg_snapshot_xmax(pg_current_snapshot())::text) AS current_xid,
            pg_snapshot_xmin(pg_current_snapshot())::text AS horizon_xid`,
  )
  let currentXid = res.rows[0].current_xid
  let horizonXid = res.rows[0].horizon_xid
  let lagXids = BigInt(currentXid) - BigInt(horizonXid)

  let hasWarning = lagXids > BigInt(maxLagThreshold)
  let warningMessage = hasWarning
    ? `Audit horizon lag warning: current transaction ${currentXid} is ${lagXids} transactions ahead of horizon ${horizonXid}. An active transaction may be blocking sealing.`
    : undefined

  return {
    currentXid,
    horizonXid,
    lagXids,
    hasWarning,
    warningMessage,
  }
}

/**
 * Executes Tier-2 horizon audit sealing under the audit_sealer role in REPEATABLE READ isolation.
 * Guarantees late-commit immunity, idempotent resumable export, gap detection, and hash chaining.
 */
export async function sealHorizon(options: SealHorizonOptions = {}): Promise<SealResult> {
  let pool = options.pool ?? getSealerPool()
  let wormStorage = options.wormStorage ?? getWormStorage()
  let maxLagThreshold = options.maxLagThreshold ?? 50000
  let client = await pool.connect()

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ')

    // 0. Cross-process mutual exclusion on the seal chain head
    let lockRes = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('mms_audit_sealer_horizon')) AS locked`,
    )
    if (!lockRes.rows[0]?.locked) {
      await client.query('ROLLBACK')
      return {
        sealed: false,
        reason: 'sealer_lock_busy',
        fromXid: '',
        toXid: '',
        changeLogCount: 0,
        eventCount: 0,
        batchHash: '',
        prevSealHash: '',
        sealHash: '',
        wormUri: '',
        wormSha256: '',
      }
    }

    // 1. Snapshot Horizon Determination
    let lagCheck = await checkHorizonLag(client, maxLagThreshold)
    if (lagCheck.hasWarning && options.alerter) {
      await options.alerter.emit(
        'SEAL_LAG_EXCEEDED',
        'WARNING',
        'AuditSealer',
        lagCheck.warningMessage ?? 'Audit horizon lag warning',
        {
          currentXid: lagCheck.currentXid,
          horizonXid: lagCheck.horizonXid,
          lagXids: lagCheck.lagXids.toString(),
        },
      )
    }
    let horizonXid = options.forceHorizonXid ?? lagCheck.horizonXid

    // 2. Query latest seal for sequential chaining & gap detection
    let latestRes = await client.query<{ id: string; to_xid: string; seal_hash: string }>(
      'SELECT id, to_xid::text, seal_hash FROM audit_trail.seal ORDER BY id DESC LIMIT 1',
    )

    let fromXid: string
    let prevSealHash: string

    if (latestRes.rows.length === 0) {
      // Genesis Seal: find the minimum unsealed xid in audit tables
      let minRes = await client.query<{ min_xid: string | null }>(
        `SELECT LEAST(
          COALESCE((SELECT MIN(tx_id) FROM audit_trail.change_log), $1::xid8),
          COALESCE((SELECT MIN(tx_id) FROM audit_trail.event), $1::xid8)
        )::text AS min_xid`,
        [horizonXid],
      )
      fromXid = minRes.rows[0]?.min_xid ?? horizonXid
      prevSealHash = GENESIS_PREV_SEAL_HASH
    } else {
      fromXid = latestRes.rows[0].to_xid
      prevSealHash = latestRes.rows[0].seal_hash
    }

    // 3. Verify horizon advancement
    let advanceRes = await client.query<{ no_advance: boolean }>(
      'SELECT ($1::xid8 >= $2::xid8) AS no_advance',
      [fromXid, horizonXid],
    )

    if (advanceRes.rows[0].no_advance) {
      await client.query('ROLLBACK')
      return {
        sealed: false,
        reason: 'no_horizon_advance',
        fromXid,
        toXid: horizonXid,
        changeLogCount: 0,
        eventCount: 0,
        batchHash: '',
        prevSealHash,
        sealHash: '',
        wormUri: '',
        wormSha256: '',
        lagWarning: lagCheck.warningMessage,
      }
    }

    // 4. Fetch all rows in the interval [fromXid, horizonXid) ordered by (tx_id, id)
    // The column list and ordering are the shared seal-artifact protocol, not a copy:
    // verifier.ts re-reads through the same functions, so the two cannot drift.
    let changeLogRes = await client.query<Record<string, unknown>>(
      `SELECT ${selectList('change_log')}
       FROM audit_trail.change_log
       WHERE tx_id >= $1::xid8 AND tx_id < $2::xid8
       ORDER BY ${orderBy()}`,
      [fromXid, horizonXid],
    )

    let eventRes = await client.query<Record<string, unknown>>(
      `SELECT ${selectList('event')}
       FROM audit_trail.event
       WHERE tx_id >= $1::xid8 AND tx_id < $2::xid8
       ORDER BY ${orderBy()}`,
      [fromXid, horizonXid],
    )

    let changeLogRows = changeLogRes.rows
    let eventRows = eventRes.rows

    if (changeLogRows.length === 0 && eventRows.length === 0 && !options.allowEmptySeal) {
      await client.query('ROLLBACK')
      return {
        sealed: false,
        reason: 'no_records_to_seal',
        fromXid,
        toXid: horizonXid,
        changeLogCount: 0,
        eventCount: 0,
        batchHash: '',
        prevSealHash,
        sealHash: '',
        wormUri: '',
        wormSha256: '',
        lagWarning: lagCheck.warningMessage,
      }
    }

    // 5. Serialize canonical RFC 8785 lines
    let changeLogLines = changeLogRows.map((row) =>
      line({ table: 'change_log', data: row }),
    )
    let eventLines = eventRows.map((row) =>
      line({ table: 'event', data: row }),
    )
    let recordLines = [...changeLogLines, ...eventLines]
    let batchHash = computeBatchHash(recordLines)

    let sealedAt = new Date().toISOString()
    let sealHash = computeSealHash({
      prev_seal_hash: prevSealHash,
      batch_hash: batchHash,
      from_xid: fromXid,
      to_xid: horizonXid,
      change_log_count: changeLogRows.length,
      event_count: eventRows.length,
      sealed_at: sealedAt,
    })

    let manifest: SealManifest = buildManifest({
      sealedAt,
      fromXid,
      toXid: horizonXid,
      changeLogCount: changeLogRows.length,
      eventCount: eventRows.length,
      prevSealHash,
      batchHash,
    })

    let artifactContent = artifact(manifest, recordLines)
    let artifactBuffer = Buffer.from(artifactContent, 'utf8')
    let wormSha256 = sha256Hex(artifactBuffer)

    let wormUri = `worm/audit_trail/seals/seal_${fromXid}_${horizonXid}.jsonl`

    // 6. Idempotent pre-commit export to WORM storage
    // Object MUST be written and verified before the database transaction commits!
    // If a prior attempt wrote the WORM object for the exact same horizon and batch
    // before a transient DB commit failure, reuse its sealed_at & sha256 rather than
    // colliding on a newly generated timestamp.
    try {
      await wormStorage.write(wormUri, artifactBuffer)
    } catch (err) {
      let recovered = false
      if (err instanceof Error && err.name === 'WormStorageCollisionError') {
        let existingBytes = await wormStorage.read(wormUri)
        if (existingBytes) {
          try {
            let parsed = parseSealArtifact(existingBytes)
            let m = parsed.manifest
            if (
              m.from_xid === fromXid &&
              m.to_xid === horizonXid &&
              m.prev_seal_hash === prevSealHash &&
              m.batch_hash === batchHash &&
              m.change_log_count === changeLogRows.length &&
              m.event_count === eventRows.length
            ) {
              sealedAt = m.sealed_at
              sealHash = computeSealHash({
                prev_seal_hash: prevSealHash,
                batch_hash: batchHash,
                from_xid: fromXid,
                to_xid: horizonXid,
                change_log_count: changeLogRows.length,
                event_count: eventRows.length,
                sealed_at: sealedAt,
              })
              wormSha256 = sha256Hex(existingBytes)
              recovered = true
            }
          } catch {
            // Fall through to emit critical collision alert
          }
        }
      }
      if (!recovered) {
        if (options.alerter) {
          await options.alerter.emit(
            'WORM_COLLISION_OR_CORRUPTION',
            'CRITICAL',
            'AuditSealer',
            `WORM export failed or collision detected at ${wormUri}: ${err instanceof Error ? err.message : String(err)}`,
            { wormUri, error: String(err) },
          )
        }
        throw err
      }
    }

    // 7. Insert the audit_trail.seal row
    let insertRes = await client.query<{ id: string }>(
      `INSERT INTO audit_trail.seal (
         sealed_at, sealed_by, from_xid, to_xid,
         change_log_count, event_count, batch_hash,
         prev_seal_hash, seal_hash, worm_uri, worm_sha256
       ) VALUES (
         $1, $2, $3::xid8, $4::xid8,
         $5, $6, $7,
         $8, $9, $10, $11
       ) RETURNING id::text`,
      [
        sealedAt,
        options.sealedBy ?? 'audit_sealer',
        fromXid,
        horizonXid,
        changeLogRows.length,
        eventRows.length,
        batchHash,
        prevSealHash,
        sealHash,
        wormUri,
        wormSha256,
      ],
    )

    await client.query('COMMIT')

    return {
      sealed: true,
      sealId: insertRes.rows[0].id,
      fromXid,
      toXid: horizonXid,
      changeLogCount: changeLogRows.length,
      eventCount: eventRows.length,
      batchHash,
      prevSealHash,
      sealHash,
      wormUri,
      wormSha256,
      lagWarning: lagCheck.warningMessage,
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Ignore rollback failure if already rolled back
    }
    throw error
  } finally {
    client.release()
  }
}
