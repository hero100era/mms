import type { Pool } from 'pg'
import type { Alerter } from './alerter.ts'

export interface RetentionClassDefinition {
  classCode: string
  name: string
  description: string
  statutoryRetentionYears: number | null // null indicates perpetual
  activeDbRetentionYears: number | null // null indicates perpetual
  dispositionPolicy: 'cold_archive' | 'cold_immutable' | 'seal_and_worm' | 'perpetual'
  requiresWorm: boolean
  cryptoShredEligible: boolean
}

export const STATUTORY_RETENTION_CLASSES: Record<string, RetentionClassDefinition> = {
  'RC-1': {
    classCode: 'RC-1',
    name: 'Identity and Access',
    description: 'Authentication attempts, session histories, role assignment changes, user status transitions',
    statutoryRetentionYears: 7,
    activeDbRetentionYears: 2,
    dispositionPolicy: 'cold_archive',
    requiresWorm: true,
    cryptoShredEligible: true,
  },
  'RC-2': {
    classCode: 'RC-2',
    name: 'Operational Surveys & Triage',
    description: 'Operational survey triage, attendances, non-conformities, Conditions of Class (CoC), deficiencies',
    statutoryRetentionYears: 10,
    activeDbRetentionYears: 5,
    dispositionPolicy: 'cold_archive',
    requiresWorm: true,
    cryptoShredEligible: false,
  },
  'RC-3': {
    classCode: 'RC-3',
    name: 'Technical Ship Data & Plan Approvals',
    description: 'Ship particulars, hull/machinery specifications, approved drawings, technical stability calculations',
    statutoryRetentionYears: 30,
    activeDbRetentionYears: 10,
    dispositionPolicy: 'cold_immutable',
    requiresWorm: true,
    cryptoShredEligible: false,
  },
  'RC-4': {
    classCode: 'RC-4',
    name: 'Issued Statutory & Class Certificates',
    description: 'Formal interim/full-term class and statutory certificates, statements of compliance, certified reports',
    statutoryRetentionYears: 30,
    activeDbRetentionYears: 10,
    dispositionPolicy: 'cold_immutable',
    requiresWorm: true,
    cryptoShredEligible: false,
  },
  'RC-5': {
    classCode: 'RC-5',
    name: 'Row-Level Audit Change Log',
    description: 'Granular row modification diffs captured by private.audit_capture() on all domain tables',
    statutoryRetentionYears: 30,
    activeDbRetentionYears: 2,
    dispositionPolicy: 'seal_and_worm',
    requiresWorm: true,
    cryptoShredEligible: true,
  },
  'RC-6': {
    classCode: 'RC-6',
    name: 'Administrative Events',
    description: 'Structural organizational changes: unit creation/closure, MTS coverage, routing rule changes, user account suspension',
    statutoryRetentionYears: 7,
    activeDbRetentionYears: 3,
    dispositionPolicy: 'cold_archive',
    requiresWorm: true,
    cryptoShredEligible: false,
  },
  'RC-7': {
    classCode: 'RC-7',
    name: 'Database Schema Changes & Migration Ledgers',
    description: 'Migration ledger (public.schema_migrations), Git history, pgaudit DDL logs',
    statutoryRetentionYears: null,
    activeDbRetentionYears: null,
    dispositionPolicy: 'perpetual',
    requiresWorm: true,
    cryptoShredEligible: false,
  },
}

export function getRetentionClass(code: string): RetentionClassDefinition {
  let def = STATUTORY_RETENTION_CLASSES[code]
  if (!def) {
    throw new Error(`Unknown retention class code: ${code}`)
  }
  return def
}

export function isStatutorilyExpired(
  classCode: string,
  occurredAt: Date,
  referenceDate: Date = new Date(),
): boolean {
  if (!(occurredAt instanceof Date) || isNaN(occurredAt.getTime())) {
    throw new TypeError('occurredAt must be a valid Date')
  }
  if (!(referenceDate instanceof Date) || isNaN(referenceDate.getTime())) {
    throw new TypeError('referenceDate must be a valid Date')
  }
  let def = getRetentionClass(classCode)
  if (def.statutoryRetentionYears === null) {
    return false // perpetual retention
  }
  let cutoff = new Date(occurredAt)
  cutoff.setFullYear(cutoff.getFullYear() + def.statutoryRetentionYears)
  return referenceDate.getTime() >= cutoff.getTime()
}

export function isEligibleForActiveDbPrune(
  classCode: string,
  occurredAt: Date,
  referenceDate: Date = new Date(),
): boolean {
  if (!(occurredAt instanceof Date) || isNaN(occurredAt.getTime())) {
    throw new TypeError('occurredAt must be a valid Date')
  }
  if (!(referenceDate instanceof Date) || isNaN(referenceDate.getTime())) {
    throw new TypeError('referenceDate must be a valid Date')
  }
  let def = getRetentionClass(classCode)
  if (def.activeDbRetentionYears === null) {
    return false // never purged from active DB
  }
  let cutoff = new Date(occurredAt)
  cutoff.setFullYear(cutoff.getFullYear() + def.activeDbRetentionYears)
  return referenceDate.getTime() >= cutoff.getTime()
}

export interface PruneAuditOptions {
  pool: Pool
  retentionClass: string
  olderThan: Date
  maxRows?: number
  reason?: string
  alerter?: Alerter
}

export interface PruneAuditResult {
  runId: number
  retentionClass: string
  cutoffTime: string
  maxSealedXid: string
  changeLogsPurged: number
  eventsPurged: number
}

/**
 * Prunes expired audit records from the active database.
 * Safety invariants enforced by database definer function:
 * 1. Only records older than the cutoff time are purged.
 * 2. Only records that have already been SEALED into audit_trail.seal (WORM exported) are purged.
 * 3. Execution is logged in audit_trail.retention_purge_run and emits audit event.
 * 4. Append-only triggers prevent any unprivileged or direct DELETE statements.
 */
export async function pruneSealedAudit(options: PruneAuditOptions): Promise<PruneAuditResult> {
  let { pool, retentionClass, olderThan, maxRows = 1000, reason, alerter } = options
  let def = getRetentionClass(retentionClass)

  if (def.activeDbRetentionYears === null) {
    throw new Error(`Retention class ${retentionClass} has perpetual active DB retention and cannot be purged.`)
  }

  let client = await pool.connect()
  try {
    let res = await client.query(
      'SELECT private.purge_sealed_audit_records($1, $2, $3, $4) as result',
      [
        retentionClass,
        olderThan.toISOString(),
        maxRows,
        reason ?? 'Lifecycle retention purge of sealed audit records',
      ],
    )

    let raw = res.rows[0]?.result
    if (!raw) {
      throw new Error('Retention purge definer function returned null result')
    }

    let result: PruneAuditResult = {
      runId: Number(raw.run_id),
      retentionClass: raw.retention_class,
      cutoffTime: raw.cutoff_time,
      maxSealedXid: raw.max_sealed_xid,
      changeLogsPurged: Number(raw.change_logs_purged),
      eventsPurged: Number(raw.events_purged),
    }

    if (alerter) {
      await alerter.emit(
        'RETENTION_PURGE_EXECUTED',
        'INFO',
        'RetentionManager',
        `Retention lifecycle purge executed for class ${retentionClass}: ${result.changeLogsPurged} change logs, ${result.eventsPurged} events removed from active DB (WORM preserved).`,
        {
          runId: result.runId,
          retentionClass,
          changeLogsPurged: result.changeLogsPurged,
          eventsPurged: result.eventsPurged,
          maxSealedXid: result.maxSealedXid,
        },
      )
    }

    return result
  } finally {
    client.release()
  }
}
