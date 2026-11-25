// The seal artifact protocol: one interface, one implementation.
//
// Before this module the protocol was restated by hand in four places:
//
//   sealer.ts:166-187           wrote the bytes (its own column list + ORDER BY)
//   verifier.ts:296-320         re-read them to prove the sealer honest
//   log-forwarder.ts:238-276    shipped a different column set, also called "canonical"
//   reconciler.ts:151-180       shipped a third column set, also called "canonical"
//
// The writer and the reader only agreed because someone copied carefully: a
// column added to one SELECT and not the other changes the bytes, the batch hash,
// and the verifier reports BATCH_HASH_MISMATCH against an integrity-preserving
// database. Nothing type-checks between them. That is the leak this module closes.
//
// Everything the artifact needs is *derived* from the column tuples below:
//
//   - the SQL column list, via `selectList()`
//   - the row shape the database returns, via `WideRow<...>`
//   - the per-record line, via `line()`
//   - the batch hash and its framing, via `batchHash()` / `BATCH_JOIN`
//   - the manifest, via `manifest()`
//   - the reader, via `parse()` -- so the verifier does not re-derive the format
//
// Adding an audited column is one edit in the tuple, and the type of
// `SealRecord` moves with it, so the manifest hash and the verifier both see it.
import * as crypto from 'node:crypto'

import {
  canonicalizeJson,
  computeSealHash,
  type SealManifest,
  sha256Hex,
  GENESIS_PREV_SEAL_HASH,
} from './canonical.ts'

/** The `audit_trail.change_log` columns that participate in a seal, in one place. */
export const CHANGE_LOG_COLUMNS = [
  'id',
  'occurred_at',
  'tx_id',
  'schema_name',
  'table_name',
  'op',
  'row_id',
  'old_row',
  'new_row',
  'changed_cols',
  'actor_id',
  'actor_label',
  'db_role',
  'session_id',
  'auth_method',
  'on_behalf_of',
  'initiated_by',
  'request_id',
  'trace_id',
  'source',
  'client_ip',
  'reason',
] as const

/** The `audit_trail.event` columns that participate in a seal, in one place. */
export const EVENT_COLUMNS = [
  'id',
  'occurred_at',
  'tx_id',
  'event_type',
  'outcome',
  'actor_id',
  'session_id',
  'db_role',
  'auth_method',
  'on_behalf_of',
  'initiated_by',
  'actor_title',
  'actor_grade',
  'actor_unit_id',
  'authority_rule_id',
  'subject_type',
  'subject_id',
  'subject_revision',
  'scope_unit_id',
  'request_id',
  'trace_id',
  'source',
  'client_ip',
  'user_agent',
  'reason',
  'detail',
] as const

export type ChangeLogColumn = (typeof CHANGE_LOG_COLUMNS)[number]
export type EventColumn = (typeof EVENT_COLUMNS)[number]

/** The record a row becomes inside an artifact line. */
export type SealRecord = {
  table: 'change_log' | 'event'
  data: Record<string, unknown>
}

export type RawSealRow =
  | { table: 'change_log'; data: Record<ChangeLogColumn, unknown> }
  | { table: 'event'; data: Record<EventColumn, unknown> }

/** Both column families, so a reader does not need to know which table it sliced. */
export const SEAL_COLUMNS = {
  change_log: CHANGE_LOG_COLUMNS,
  event: EVENT_COLUMNS,
} as const

export type SealTable = keyof typeof SEAL_COLUMNS

// The check "the artifact contains the same bytes sealer.ts wrote" is a single
// exported function below. Everything else draws on it.

/**
 * The canonical SELECT list for a table, derived from its column tuple.
 *
 * `id` and `tx_id` are cast to text and `client_ip` to inet text so the row shape
 * matches the JSON payload the artifact carries; the ORDER BY is fixed by the
 * protocol (ADR-0012 section 1.4) and must not vary between readers.
 */
export function selectList(table: SealTable): string {
  const cast = (column: string): string =>
    column === 'id' || column === 'tx_id'
      ? column + '::text'
      : column === 'client_ip'
        ? column + '::text'
        : column
  return SEAL_COLUMNS[table].map(cast).join(', ')
}

/** The protocol's record ordering, shared by writer and every reader. */
export function orderBy(): string {
  return 'tx_id ASC, id ASC'
}

/** One complete row query for the sealing protocol. */
export function readQuery(table: SealTable, where: string): string {
  return 'SELECT ' + selectList(table) + '\n' +
    '           FROM audit_trail.' + table + '\n' +
    '           WHERE ' + where + '\n' +
    '           ORDER BY ' + orderBy()
}

// ---------------------------------------------------------------------------
// Artifact bytes (ADR-0012 section 2). The writer and the reader call these same
// functions, so "canonical" means one thing in this codebase rather than three.
// ---------------------------------------------------------------------------

/** One canonical record line: `{"data":...,"table":...,"type":"record"}`. */
export function line(record: SealRecord): string {
  return canonicalizeJson({
    data: record.data,
    table: record.table,
    type: 'record',
  })
}

/** Batch hash over the concatenated record lines (trailing newline included). */
export function batchHash(recordLines: readonly string[]): string {
  if (recordLines.length === 0) return sha256Hex('')
  return sha256Hex(recordLines.join('\n') + '\n')
}

/**
 * Artifact framing: manifest line, then one line per record, newline-terminated.
 * Empty batches carry the manifest line alone.
 */
export function artifact(manifest: SealManifest, recordLines: readonly string[]): string {
  const manifestLine = canonicalizeJson(manifest)
  return recordLines.length > 0
    ? manifestLine + '\n' + recordLines.join('\n') + '\n'
    : manifestLine + '\n'
}

/** Build the manifest for a batch, so the hash inputs cannot be transposed. */
export function manifest(params: {
  sealedAt: string
  fromXid: string
  toXid: string
  changeLogCount: number
  eventCount: number
  prevSealHash: string
  batchHash: string
}): SealManifest {
  return {
    format: 'mms-audit-seal-v1',
    sealed_at: params.sealedAt,
    from_xid: params.fromXid,
    to_xid: params.toXid,
    change_log_count: params.changeLogCount,
    event_count: params.eventCount,
    prev_seal_hash: params.prevSealHash,
    batch_hash: params.batchHash,
  }
}

/** The chained seal hash and digest, re-exported so callers need not reach past this interface. */
export { computeSealHash, GENESIS_PREV_SEAL_HASH, sha256Hex }

export type ParsedArtifact = {
  manifest: SealManifest
  records: SealRecord[]
  /** sha256 of the bytes as written, recomputed from this parse alone */
  wormSha256: string
}

/**
 * Reads an artifact back into the manifest, its records and the digest of the
 * exact bytes given. Throws on anything this module would not have written, which
 * is what lets the verifier say WORM_SHA256_MISMATCH / MANIFEST_CORRUPTED with a
 * reason instead of re-deriving the format and quietly agreeing with itself.
 */
export function parse(bytes: Buffer | Uint8Array): ParsedArtifact {
  const wormSha256 = sha256Hex(bytes)
  const text = Buffer.from(bytes).toString('utf8')
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0] === '') {
    throw new Error('seal artifact is empty')
  }
  const manifestLine = lines[0]!
  let parsedManifest: SealManifest
  try {
    parsedManifest = JSON.parse(manifestLine) as SealManifest
  } catch {
    throw new Error('seal artifact manifest line is not JSON')
  }
  if (parsedManifest.format !== 'mms-audit-seal-v1') {
    throw new Error('unexpected seal artifact format: ' + String(parsedManifest.format))
  }

  const records: SealRecord[] = []
  for (const lineText of lines.slice(1)) {
    if (lineText === '') continue
    const value = JSON.parse(lineText) as { data?: unknown; table?: unknown; type?: unknown }
    if (
      value.type !== 'record' ||
      (value.table !== 'change_log' && value.table !== 'event') ||
      typeof value.data !== 'object' ||
      value.data === null
    ) {
      throw new Error('seal artifact record line has an unexpected shape')
    }
    records.push({ table: value.table, data: value.data as Record<string, unknown> })
  }

  if (batchHash(records.map(line)) !== parsedManifest.batch_hash) {
    throw new Error('seal artifact batch_hash does not match its records')
  }
  return { manifest: parsedManifest, records, wormSha256 }
}
