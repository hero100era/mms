// Server-only. Tier 2 off-DB log forwarder shipping audit and pgaudit streams to external sinks.
import * as crypto from 'node:crypto'
import type { Pool } from 'pg'
import { Alerter, defaultAlerter } from './alerter.ts'
import { canonicalizeJson, sha256Hex } from './canonical.ts'
import { getSealerPool } from './sealer-client.ts'

export interface ForwardRecord {
  table: 'change_log' | 'event' | 'pgaudit'
  id: string
  txId?: string
  occurredAt: string
  data: Record<string, unknown>
}

export interface ForwardBatch {
  batchId: string
  sinkId: string
  sequenceNumber: number
  fromChangeLogId: string
  toChangeLogId: string
  fromEventId: string
  toEventId: string
  recordCount: number
  records: ForwardRecord[]
  batchSha256: string
  generatedAt: string
}

export interface LogForwarderSink {
  readonly sinkId: string
  forwardBatch(batch: ForwardBatch): Promise<void>
}

export class MemoryLogForwarderSink implements LogForwarderSink {
  readonly sinkId: string
  readonly batches: ForwardBatch[] = []
  shouldFail = false
  failureMessage = 'Simulated off-DB forwarder network failure'

  constructor(sinkId = 'memory-sink') {
    this.sinkId = sinkId
  }

  async forwardBatch(batch: ForwardBatch): Promise<void> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage)
    }
    this.batches.push(batch)
  }

  clear(): void {
    this.batches.length = 0
    this.shouldFail = false
  }

  getAllRecords(): ForwardRecord[] {
    return this.batches.flatMap((b) => b.records)
  }
}

export interface ForwarderWatermark {
  sinkId: string
  lastChangeLogId: string
  lastEventId: string
  lastTxId?: string
  lastForwardedAt: string
  forwardedBatchCount: number
  forwardedRecordCount: number
  lastBatchHash?: string
}

export interface ForwardResult {
  forwarded: boolean
  batch?: ForwardBatch
  recordCount: number
  lagSeconds: number
  lagRecords: number
}

export interface ForwarderOptions {
  pool?: Pool
  sink: LogForwarderSink
  alerter?: Alerter
  batchSize?: number
  maxLagSecondsThreshold?: number
  maxLagRecordsThreshold?: number
}

/**
 * LogForwarder pulls unforwarded audit rows from the database and ships them
 * off-database to an immutable append-only sink.
 */
export class LogForwarder {
  private pool: Pool
  private sink: LogForwarderSink
  private alerter: Alerter
  private batchSize: number
  private maxLagSecondsThreshold: number
  private maxLagRecordsThreshold: number

  constructor(options: ForwarderOptions) {
    this.pool = options.pool ?? getSealerPool()
    this.sink = options.sink
    this.alerter = options.alerter ?? defaultAlerter
    this.batchSize = options.batchSize ?? 500
    this.maxLagSecondsThreshold = options.maxLagSecondsThreshold ?? 300 // 5 minutes
    this.maxLagRecordsThreshold = options.maxLagRecordsThreshold ?? 1000
  }

  async getWatermark(existingClient?: { query: Pool['query'] }): Promise<ForwarderWatermark> {
    let client = existingClient ?? (await this.pool.connect())
    try {
      let res = await client.query<{
        sink_id: string
        last_change_log_id: string
        last_event_id: string
        last_tx_id: string | null
        last_forwarded_at: string
        forwarded_batch_count: string
        forwarded_record_count: string
        last_batch_hash: string | null
      }>(
        `SELECT sink_id, last_change_log_id::text, last_event_id::text, last_tx_id::text,
                last_forwarded_at::text, forwarded_batch_count::text, forwarded_record_count::text,
                last_batch_hash
         FROM audit_trail.forwarder_watermark
         WHERE sink_id = $1`,
        [this.sink.sinkId],
      )

      if (res.rows.length === 0) {
        return {
          sinkId: this.sink.sinkId,
          lastChangeLogId: '0',
          lastEventId: '0',
          lastForwardedAt: new Date(0).toISOString(),
          forwardedBatchCount: 0,
          forwardedRecordCount: 0,
        }
      }

      let row = res.rows[0]
      return {
        sinkId: row.sink_id,
        lastChangeLogId: row.last_change_log_id,
        lastEventId: row.last_event_id,
        lastTxId: row.last_tx_id ?? undefined,
        lastForwardedAt: row.last_forwarded_at,
        forwardedBatchCount: Number(row.forwarded_batch_count),
        forwardedRecordCount: Number(row.forwarded_record_count),
        lastBatchHash: row.last_batch_hash ?? undefined,
      }
    } finally {
      if (!existingClient && typeof (client as any).release === 'function') {
        (client as any).release()
      }
    }
  }

  async checkLag(existingClient?: { query: Pool['query'] }): Promise<{ lagSeconds: number; lagRecords: number; hasWarning: boolean }> {
    let client = existingClient ?? (await this.pool.connect())
    let watermark = await this.getWatermark(client)
    try {
      let res = await client.query<{
        max_change_id: string | null
        max_event_id: string | null
        latest_time: string | null
      }>(
        `SELECT (SELECT MAX(id)::text FROM audit_trail.change_log) AS max_change_id,
                (SELECT MAX(id)::text FROM audit_trail.event) AS max_event_id,
                GREATEST(
                  (SELECT MAX(occurred_at) FROM audit_trail.change_log),
                  (SELECT MAX(occurred_at) FROM audit_trail.event)
                )::text AS latest_time`,
      )

      let maxChangeId = BigInt(res.rows[0]?.max_change_id ?? '0')
      let maxEventId = BigInt(res.rows[0]?.max_event_id ?? '0')
      let unforwardedChanges = maxChangeId - BigInt(watermark.lastChangeLogId)
      let unforwardedEvents = maxEventId - BigInt(watermark.lastEventId)
      let lagRecords = Number((unforwardedChanges > 0n ? unforwardedChanges : 0n) + (unforwardedEvents > 0n ? unforwardedEvents : 0n))

      let latestTime = res.rows[0]?.latest_time ? new Date(res.rows[0].latest_time).getTime() : Date.now()
      let lastForwardedTime = new Date(watermark.lastForwardedAt).getTime()
      let lagSeconds = Math.max(0, Math.floor((latestTime - lastForwardedTime) / 1000))

      let hasWarning =
        (lagRecords > this.maxLagRecordsThreshold) ||
        (lagRecords > 0 && lagSeconds > this.maxLagSecondsThreshold)

      if (hasWarning) {
        await this.alerter.emit(
          'FORWARDER_LAG_EXCEEDED',
          'WARNING',
          'LogForwarder',
          `Log forwarder ${this.sink.sinkId} lag exceeded: ${lagRecords} unforwarded records, ${lagSeconds}s lag.`,
          { sinkId: this.sink.sinkId, lagRecords, lagSeconds },
        )
      }

      return { lagSeconds, lagRecords, hasWarning }
    } finally {
      if (!existingClient && typeof (client as any).release === 'function') {
        (client as any).release()
      }
    }
  }

  async forwardNextBatch(): Promise<ForwardResult> {
    let client = await this.pool.connect()
    try {
      // Mutual exclusion per sink to prevent concurrent duplicate forward batches
      let lockRes = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('mms_log_forwarder_' || $1)) AS locked`,
        [this.sink.sinkId],
      )
      if (!lockRes.rows[0].locked) {
        throw new Error(`Another forwarder for sink ${this.sink.sinkId} is already running.`)
      }

      let watermark = await this.getWatermark(client)

      // Capture snapshot xmin horizon so late-committing transactions are never skipped
      let horizonRes = await client.query<{ horizon_xid: string }>(
        `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon_xid`,
      )
      let horizonXid = horizonRes.rows[0].horizon_xid

      // Dynamically allocate limits so batchSize = 1 or uneven tables do not stall
      let changeLimit = Math.max(1, Math.ceil(this.batchSize / 2))

      // 1. Fetch unforwarded change_log rows below the safe xid8 horizon
      let changesRes = await client.query<{
        id: string
        tx_id: string
        occurred_at: string
        schema_name: string
        table_name: string
        op: string
        row_id: string | null
        old_row: Record<string, unknown> | null
        new_row: Record<string, unknown> | null
        changed_cols: string[] | null
        actor_id: string | null
        actor_label: string | null
        db_role: string
        reason: string | null
      }>(
        `SELECT id::text, tx_id::text, occurred_at::text, schema_name, table_name, op,
                row_id::text, old_row, new_row, changed_cols, actor_id::text, actor_label,
                db_role, reason
         FROM audit_trail.change_log
         WHERE id > $1::bigint
           AND tx_id < $3::xid8
         ORDER BY id ASC
         LIMIT $2`,
        [watermark.lastChangeLogId, changeLimit, horizonXid],
      )

      // 2. Fetch unforwarded event rows with remaining batch capacity below safe horizon
      let eventLimit = Math.max(0, this.batchSize - changesRes.rows.length)
      if (changesRes.rows.length === 0 && this.batchSize > 0) {
        eventLimit = this.batchSize
      }

      let eventsRes = eventLimit > 0
        ? await client.query<{
            id: string
            tx_id: string
            occurred_at: string
            event_type: string
            outcome: string
            actor_id: string | null
            subject_type: string | null
            subject_id: string | null
            reason: string | null
            detail: Record<string, unknown>
          }>(
            `SELECT id::text, tx_id::text, occurred_at::text, event_type, outcome,
                    actor_id::text, subject_type, subject_id::text, reason, detail
             FROM audit_trail.event
             WHERE id > $1::bigint
               AND tx_id < $3::xid8
             ORDER BY id ASC
             LIMIT $2`,
            [watermark.lastEventId, eventLimit, horizonXid],
          )
        : { rows: [] }

      if (changesRes.rows.length === 0 && eventsRes.rows.length === 0) {
        let lag = await this.checkLag(client)
        return {
          forwarded: false,
          recordCount: 0,
          lagSeconds: lag.lagSeconds,
          lagRecords: lag.lagRecords,
        }
      }

      let records: ForwardRecord[] = []
      let toChangeLogId = watermark.lastChangeLogId
      let toEventId = watermark.lastEventId
      let maxTxId = watermark.lastTxId

      for (let row of changesRes.rows) {
        records.push({
          table: 'change_log',
          id: row.id,
          txId: row.tx_id,
          occurredAt: row.occurred_at,
          data: {
            schema_name: row.schema_name,
            table_name: row.table_name,
            op: row.op,
            row_id: row.row_id,
            old_row: row.old_row,
            new_row: row.new_row,
            changed_cols: row.changed_cols,
            actor_id: row.actor_id,
            actor_label: row.actor_label,
            db_role: row.db_role,
            reason: row.reason,
          },
        })
        toChangeLogId = row.id
        if (!maxTxId || BigInt(row.tx_id) > BigInt(maxTxId)) {
          maxTxId = row.tx_id
        }
      }

      for (let row of eventsRes.rows) {
        records.push({
          table: 'event',
          id: row.id,
          txId: row.tx_id,
          occurredAt: row.occurred_at,
          data: {
            event_type: row.event_type,
            outcome: row.outcome,
            actor_id: row.actor_id,
            subject_type: row.subject_type,
            subject_id: row.subject_id,
            reason: row.reason,
            detail: row.detail,
          },
        })
        toEventId = row.id
        if (!maxTxId || BigInt(row.tx_id) > BigInt(maxTxId)) {
          maxTxId = row.tx_id
        }
      }

      // Sort deterministically by (occurredAt, table, numeric id)
      records.sort((a, b) => {
        let timeComp = a.occurredAt.localeCompare(b.occurredAt)
        if (timeComp !== 0) return timeComp
        let tableComp = a.table.localeCompare(b.table)
        if (tableComp !== 0) return tableComp
        let aId = BigInt(a.id)
        let bId = BigInt(b.id)
        return aId < bId ? -1 : aId > bId ? 1 : 0
      })

      // Calculate RFC 8785 canonical hash of the batch
      let canonicalContent = records.map((r) => canonicalizeJson(r)).join('\n')
      let batchSha256 = sha256Hex(canonicalContent)

      let batch: ForwardBatch = {
        batchId: crypto.randomUUID(),
        sinkId: this.sink.sinkId,
        sequenceNumber: watermark.forwardedBatchCount + 1,
        fromChangeLogId: watermark.lastChangeLogId,
        toChangeLogId,
        fromEventId: watermark.lastEventId,
        toEventId,
        recordCount: records.length,
        records,
        batchSha256,
        generatedAt: new Date().toISOString(),
      }

      // 3. Ship to external sink (pre-commit)
      try {
        await this.sink.forwardBatch(batch)
      } catch (err) {
        await this.alerter.emit(
          'FORWARDER_DELIVERY_FAILURE',
          'CRITICAL',
          'LogForwarder',
          `Failed shipping batch ${batch.sequenceNumber} to ${this.sink.sinkId}: ${err instanceof Error ? err.message : String(err)}`,
          { sinkId: this.sink.sinkId, batchId: batch.batchId, error: String(err) },
        )
        throw err
      }

      // 4. Update watermark in database
      await client.query(
        `INSERT INTO audit_trail.forwarder_watermark
          (sink_id, last_change_log_id, last_event_id, last_tx_id, last_forwarded_at,
           forwarded_batch_count, forwarded_record_count, last_batch_hash, updated_at)
         VALUES
          ($1, $2, $3, $4::xid8, now(), $5, $6, $7, now())
         ON CONFLICT (sink_id) DO UPDATE SET
          last_change_log_id = EXCLUDED.last_change_log_id,
          last_event_id = EXCLUDED.last_event_id,
          last_tx_id = EXCLUDED.last_tx_id,
          last_forwarded_at = EXCLUDED.last_forwarded_at,
          forwarded_batch_count = EXCLUDED.forwarded_batch_count,
          forwarded_record_count = EXCLUDED.forwarded_record_count,
          last_batch_hash = EXCLUDED.last_batch_hash,
          updated_at = now()`,
        [
          this.sink.sinkId,
          toChangeLogId,
          toEventId,
          maxTxId ?? null,
          watermark.forwardedBatchCount + 1,
          watermark.forwardedRecordCount + records.length,
          batchSha256,
        ],
      )

      let lag = await this.checkLag(client)
      return {
        forwarded: true,
        batch,
        recordCount: records.length,
        lagSeconds: lag.lagSeconds,
        lagRecords: lag.lagRecords,
      }
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext('mms_log_forwarder_' || $1))`, [this.sink.sinkId])
        .catch(() => {})
      client.release()
    }
  }
}
