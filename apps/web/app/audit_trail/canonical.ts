import * as crypto from 'node:crypto'

/**
 * Implements RFC 8785 (JSON Canonicalization Scheme - JCS).
 * Deterministically serializes values with lexicographically sorted keys (by UTF-16 code units)
 * and compact formatting without insignificant whitespace.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${value}`)
    }
    return JSON.stringify(value)
  }

  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString())
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString())
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return JSON.stringify(Buffer.from(value).toString('hex'))
  }

  if (Array.isArray(value)) {
    let elements = value.map((item) => canonicalizeJson(item === undefined ? null : item))
    return `[${elements.join(',')}]`
  }

  if (typeof value === 'object') {
    let obj = value as Record<string, unknown>
    // Sort keys lexicographically by UTF-16 code units (standard JavaScript .sort() order)
    let keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    let entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`)
    return `{${entries.join(',')}}`
  }

  throw new TypeError(`Unsupported type for canonical JSON: ${typeof value}`)
}

export interface CanonicalRecord {
  type: 'change_log' | 'event'
  data: Record<string, unknown>
}

export interface SealManifest {
  format: 'mms-audit-seal-v1'
  sealed_at: string
  from_xid: string
  to_xid: string
  change_log_count: number
  event_count: number
  prev_seal_hash: string
  batch_hash: string
}

/**
 * Serializes an individual change_log or event record line.
 */
export function serializeRecordLine(record: CanonicalRecord): string {
  return canonicalizeJson({
    data: record.data,
    table: record.type,
    type: 'record',
  })
}

/**
 * Computes SHA-256 hex digest of a string or buffer.
 */
export function sha256Hex(content: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Computes the batch hash over the concatenated canonical record lines.
 */
export function computeBatchHash(recordLines: string[]): string {
  if (recordLines.length === 0) {
    // Empty batch hash: SHA-256 of empty string
    return sha256Hex('')
  }
  let payload = recordLines.join('\n') + '\n'
  return sha256Hex(payload)
}

export interface SealHashParams {
  prev_seal_hash: string
  batch_hash: string
  from_xid: string
  to_xid: string
  change_log_count: number
  event_count: number
  sealed_at: string
}

/**
 * Computes chained seal hash:
 * sha256(prev_seal_hash:batch_hash:from_xid:to_xid:change_log_count:event_count:sealed_at)
 */
export function computeSealHash(params: SealHashParams): string {
  let message = [
    params.prev_seal_hash,
    params.batch_hash,
    params.from_xid,
    params.to_xid,
    params.change_log_count.toString(),
    params.event_count.toString(),
    params.sealed_at,
  ].join(':')

  return sha256Hex(message)
}

/**
 * Serializes the manifest header line.
 */
export function serializeManifestLine(manifest: SealManifest): string {
  return canonicalizeJson(manifest)
}

export const GENESIS_PREV_SEAL_HASH = '0000000000000000000000000000000000000000000000000000000000000000'
