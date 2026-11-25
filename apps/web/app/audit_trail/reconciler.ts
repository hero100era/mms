// Server-only. Tier 2 daily event reconciliation cross-referencing controlled-column changes.
import type { Pool } from 'pg'
import { Alerter, defaultAlerter } from './alerter.ts'
import { getSealerPool } from './sealer-client.ts'

export type DiscrepancyType =
  | 'missing_event'
  | 'mismatched_event_type'
  | 'event_failure_outcome'
  | 'unauthorized_mutation'

export interface DiscrepancyRecord {
  changeLogId: string
  txId: string
  schemaName: string
  tableName: string
  columnName: string
  rowId?: string
  discrepancyType: DiscrepancyType
  details: Record<string, unknown>
}

export interface ReconciliationReport {
  runId: string
  runAt: string
  windowStart: string
  windowEnd: string
  fromXid?: string
  toXid?: string
  checkedChangeCount: number
  checkedEventCount: number
  discrepancyCount: number
  status: 'clean' | 'discrepancies_found' | 'failed'
  discrepancies: DiscrepancyRecord[]
}

export interface ReconcileOptions {
  pool?: Pool
  windowStart?: Date
  windowEnd?: Date
  fromXid?: string
  toXid?: string
  alerter?: Alerter
  alertOnZeroRecords?: boolean
}

interface ControlledColumnRow {
  schema_name: string
  table_name: string
  column_name: string
  regulated_event_type: string | null
  description: string
}

interface ChangeLogRow {
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
  db_role: string
  source: string
  reason: string | null
}

interface EventRow {
  id: string
  tx_id: string
  event_type: string
  outcome: string
  actor_id: string | null
  subject_type: string | null
  subject_id: string | null
  reason: string | null
}

/**
 * Executes Tier 2 daily event reconciliation.
 * Cross-references all changes to controlled columns in audit_trail.change_log against audit_trail.event.
 */
export async function reconcileAuditEvents(
  options: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  let pool = options.pool ?? getSealerPool()
  let alerter = options.alerter ?? defaultAlerter
  let windowEnd = options.windowEnd ?? new Date()
  let windowStart = options.windowStart ?? new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000)

  let client = await pool.connect()
  try {
    // Acquire advisory lock to prevent concurrent reconciliation runs
    let lockRes = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('mms_audit_reconciliation')) AS locked`,
    )
    if (!lockRes.rows[0].locked) {
      throw new Error('Another reconciliation run is already in progress.')
    }

    let fromXid = options.fromXid
    let toXid = options.toXid

    if (fromXid && !toXid) {
      let snapRes = await client.query<{ horizon_xid: string }>(
        'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon_xid',
      )
      toXid = snapRes.rows[0].horizon_xid
    }

    // If neither horizon nor explicit windowStart was given, resume from last run to prevent time gaps
    if (!fromXid && !options.windowStart) {
      let lastRunRes = await client.query<{ window_end: string; to_xid: string | null }>(
        'SELECT window_end::text, to_xid::text FROM audit_trail.reconciliation_run ORDER BY id DESC LIMIT 1',
      )
      let snapRes = await client.query<{ horizon_xid: string }>(
        'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon_xid',
      )
      if (lastRunRes.rows.length > 0) {
        windowStart = new Date(lastRunRes.rows[0].window_end)
        if (lastRunRes.rows[0].to_xid) {
          fromXid = lastRunRes.rows[0].to_xid
          toXid = snapRes.rows[0].horizon_xid
        } else {
          let minRes = await client.query<{ min_xid: string | null }>(
            'SELECT COALESCE(MIN(tx_id), $1::xid8)::text AS min_xid FROM audit_trail.change_log WHERE occurred_at >= $2',
            [snapRes.rows[0].horizon_xid, windowStart.toISOString()],
          )
          fromXid = minRes.rows[0]?.min_xid ?? snapRes.rows[0].horizon_xid
          toXid = snapRes.rows[0].horizon_xid
        }
      } else {
        let minRes = await client.query<{ min_xid: string | null }>(
          'SELECT COALESCE(MIN(tx_id), $1::xid8)::text AS min_xid FROM audit_trail.change_log WHERE occurred_at >= $2',
          [snapRes.rows[0].horizon_xid, windowStart.toISOString()],
        )
        fromXid = minRes.rows[0]?.min_xid ?? snapRes.rows[0].horizon_xid
        toXid = snapRes.rows[0].horizon_xid
      }
    }

    // 1. Fetch catalog of controlled columns
    let controlledRes = await client.query<ControlledColumnRow>(
      `SELECT schema_name, table_name, column_name, regulated_event_type, description
       FROM audit_trail.controlled_column`,
    )
    let controlledColumns = controlledRes.rows

    // Map: "schema.table" -> Map<column_name, regulated_event_type>
    let controlledMap = new Map<string, Map<string, string | null>>()
    for (let col of controlledColumns) {
      let key = `${col.schema_name}.${col.table_name}`
      let colMap = controlledMap.get(key)
      if (!colMap) {
        colMap = new Map()
        controlledMap.set(key, colMap)
      }
      colMap.set(col.column_name, col.regulated_event_type)
    }

    // 2. Fetch change_log rows within window or horizon (including DELETE operations)
    let changeSql = `
      SELECT id::text, tx_id::text, occurred_at::text, schema_name, table_name, op,
             row_id::text, old_row, new_row, changed_cols, actor_id::text, db_role, source, reason
      FROM audit_trail.change_log
      WHERE op IN ('I', 'U', 'D')
    `
    let queryParams: unknown[] = []
    if (fromXid && toXid) {
      changeSql += ` AND tx_id >= $1::xid8 AND tx_id < $2::xid8`
      queryParams.push(fromXid, toXid)
    } else {
      changeSql += ` AND occurred_at >= $1 AND occurred_at <= $2`
      queryParams.push(windowStart.toISOString(), windowEnd.toISOString())
    }
    changeSql += ` ORDER BY tx_id, id`

    let changeRes = await client.query<ChangeLogRow>(changeSql, queryParams)
    let changes = changeRes.rows

    if (changes.length === 0 && (options.alertOnZeroRecords ?? false)) {
      await alerter.emit(
        'ZERO_RECORD_ANOMALY',
        'WARNING',
        'AuditReconciler',
        `Audit reconciliation checked 0 changes and 0 events across window ${windowStart.toISOString()} .. ${windowEnd.toISOString()}.`,
        { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
      )
    }

    // Collect all tx_ids for batch event fetching
    let txIds = Array.from(new Set(changes.map((c) => c.tx_id)))
    let eventRes = txIds.length > 0
      ? await client.query<EventRow>(
          `SELECT id::text, tx_id::text, event_type, outcome, actor_id::text,
                  subject_type, subject_id::text, reason
           FROM audit_trail.event
           WHERE tx_id = ANY($1::xid8[])`,
          [txIds],
        )
      : { rows: [] as EventRow[] }

    // Map: tx_id -> EventRow[]
    let eventMap = new Map<string, EventRow[]>()
    for (let evt of eventRes.rows) {
      let list = eventMap.get(evt.tx_id)
      if (!list) {
        list = []
        eventMap.set(evt.tx_id, list)
      }
      list.push(evt)
    }

    let discrepancies: DiscrepancyRecord[] = []
    let seenDiscrepancyKeys = new Set<string>()
    let checkedChangeCount = 0

    // 3. Cross-reference changes against controlled columns and events
    for (let change of changes) {
      let tableKey = `${change.schema_name}.${change.table_name}`
      let tableControlled = controlledMap.get(tableKey)
      if (!tableControlled) continue

      let changedCols =
        change.changed_cols ??
        (change.new_row
          ? Object.keys(change.new_row)
          : change.old_row
            ? Object.keys(change.old_row)
            : [])
      let modifiedControlledCols = changedCols.filter((col) => tableControlled.has(col))
      if (modifiedControlledCols.length === 0) continue

      checkedChangeCount++
      let txEvents = eventMap.get(change.tx_id) ?? []

      for (let col of modifiedControlledCols) {
        let expectedEventType = tableControlled.get(col)

        // Rule A: Missing event
        if (txEvents.length === 0) {
          let discKey = `${change.tx_id}:${change.id}:${col}:missing_event`
          if (!seenDiscrepancyKeys.has(discKey)) {
            seenDiscrepancyKeys.add(discKey)
            discrepancies.push({
              changeLogId: change.id,
              txId: change.tx_id,
              schemaName: change.schema_name,
              tableName: change.table_name,
              columnName: col,
              rowId: change.row_id ?? undefined,
              discrepancyType: 'missing_event',
              details: {
                reason: 'Controlled column modified without transactional audit_trail.event',
                op: change.op,
                db_role: change.db_role,
                source: change.source,
                actor_id: change.actor_id,
                change_reason: change.reason,
              },
            })
          }
          continue
        }

        // Rule B: Event outcome failure
        let successfulEvents = txEvents.filter((e) => e.outcome === 'success')
        if (successfulEvents.length === 0) {
          let discKey = `${change.tx_id}:${change.id}:${col}:event_failure_outcome`
          if (!seenDiscrepancyKeys.has(discKey)) {
            seenDiscrepancyKeys.add(discKey)
            discrepancies.push({
              changeLogId: change.id,
              txId: change.tx_id,
              schemaName: change.schema_name,
              tableName: change.table_name,
              columnName: col,
              rowId: change.row_id ?? undefined,
              discrepancyType: 'event_failure_outcome',
              details: {
                reason: 'Controlled column committed but all transactional events failed or were denied',
                op: change.op,
                events: txEvents.map((e) => ({ type: e.event_type, outcome: e.outcome })),
              },
            })
          }
          continue
        }

        // Rule C: Mismatched event type
        if (expectedEventType) {
          let expectedPatterns = expectedEventType.split(',').map((p) => p.trim())
          let hasMatchingEvent = successfulEvents.some((e) => {
            return expectedPatterns.some((pattern) => {
              if (pattern.endsWith('.*')) {
                return e.event_type.startsWith(pattern.slice(0, -1))
              }
              if (pattern.endsWith('*')) {
                return e.event_type.startsWith(pattern.slice(0, -1))
              }
              return e.event_type === pattern
            })
          })

          if (!hasMatchingEvent) {
            let discKey = `${change.tx_id}:${change.id}:${col}:mismatched_event_type`
            if (!seenDiscrepancyKeys.has(discKey)) {
              seenDiscrepancyKeys.add(discKey)
              discrepancies.push({
                changeLogId: change.id,
                txId: change.tx_id,
                schemaName: change.schema_name,
                tableName: change.table_name,
                columnName: col,
                rowId: change.row_id ?? undefined,
                discrepancyType: 'mismatched_event_type',
                details: {
                  expected_event_type: expectedEventType,
                  actual_events: successfulEvents.map((e) => e.event_type),
                  op: change.op,
                },
              })
            }
          }
        } else {
          // If expectedEventType is null, require domain alignment
          let domainMatches = successfulEvents.some((e) => {
            return (
              e.event_type.startsWith(`${change.schema_name}.`) ||
              e.subject_type === change.table_name
            )
          })
          if (!domainMatches) {
            let discKey = `${change.tx_id}:${change.id}:${col}:mismatched_event_type`
            if (!seenDiscrepancyKeys.has(discKey)) {
              seenDiscrepancyKeys.add(discKey)
              discrepancies.push({
                changeLogId: change.id,
                txId: change.tx_id,
                schemaName: change.schema_name,
                tableName: change.table_name,
                columnName: col,
                rowId: change.row_id ?? undefined,
                discrepancyType: 'mismatched_event_type',
                details: {
                  reason: 'No event in transaction belongs to entity domain or schema',
                  actual_events: successfulEvents.map((e) => e.event_type),
                  op: change.op,
                },
              })
            }
          }
        }
      }
    }

    let status: 'clean' | 'discrepancies_found' =
      discrepancies.length === 0 ? 'clean' : 'discrepancies_found'

    // 4. Record run in audit_trail.reconciliation_run
    let runRes = await client.query<{ id: string }>(
      `INSERT INTO audit_trail.reconciliation_run
        (window_start, window_end, from_xid, to_xid, checked_change_count, checked_event_count, discrepancy_count, status, detail)
       VALUES
        ($1, $2, $3::xid8, $4::xid8, $5, $6, $7, $8, $9)
       RETURNING id::text`,
      [
        windowStart.toISOString(),
        windowEnd.toISOString(),
        fromXid ?? null,
        toXid ?? null,
        checkedChangeCount,
        eventRes.rows.length,
        discrepancies.length,
        status,
        JSON.stringify({ controlled_column_count: controlledColumns.length }),
      ],
    )
    let runId = runRes.rows[0].id

    // 5. Record each discrepancy in audit_trail.reconciliation_discrepancy
    for (let disc of discrepancies) {
      await client.query(
        `INSERT INTO audit_trail.reconciliation_discrepancy
          (run_id, change_log_id, tx_id, schema_name, table_name, column_name, row_id, discrepancy_type, details)
         VALUES
          ($1, $2, $3::xid8, $4, $5, $6, $7::uuid, $8, $9)`,
        [
          runId,
          disc.changeLogId,
          disc.txId,
          disc.schemaName,
          disc.tableName,
          disc.columnName,
          disc.rowId ?? null,
          disc.discrepancyType,
          JSON.stringify(disc.details),
        ],
      )
    }

    // 6. Security alerting
    if (discrepancies.length > 0) {
      await alerter.emit(
        'RECONCILIATION_DISCREPANCY',
        'CRITICAL',
        'EventReconciler',
        `Reconciliation detected ${discrepancies.length} discrepancy(ies) across ${checkedChangeCount} checked controlled-column changes.`,
        {
          runId,
          discrepancyCount: discrepancies.length,
          discrepancies: discrepancies.slice(0, 10),
        },
      )
    } else {
      await alerter.emit(
        'RECONCILIATION_DISCREPANCY',
        'INFO',
        'EventReconciler',
        `Daily reconciliation clean: verified ${checkedChangeCount} controlled-column changes against ${eventRes.rows.length} events.`,
        { runId, checkedChangeCount, checkedEventCount: eventRes.rows.length },
      )
    }

    return {
      runId,
      runAt: new Date().toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      fromXid,
      toXid,
      checkedChangeCount,
      checkedEventCount: eventRes.rows.length,
      discrepancyCount: discrepancies.length,
      status,
      discrepancies,
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('mms_audit_reconciliation'))`).catch(() => {})
    client.release()
  }
}
