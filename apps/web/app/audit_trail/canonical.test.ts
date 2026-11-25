import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  canonicalizeJson,
  computeBatchHash,
  computeSealHash,
  GENESIS_PREV_SEAL_HASH,
  serializeRecordLine,
  serializeManifestLine,
  sha256Hex,
} from './canonical.ts'

test('canonicalizeJson conforms to RFC 8785 (JCS)', () => {
  // 1. Primitive types
  assert.equal(canonicalizeJson(null), 'null')
  assert.equal(canonicalizeJson(undefined), 'null')
  assert.equal(canonicalizeJson(true), 'true')
  assert.equal(canonicalizeJson(false), 'false')
  assert.equal(canonicalizeJson(123), '123')
  assert.equal(canonicalizeJson('hello world'), '"hello world"')

  // 2. Lexicographical key sorting by UTF-16 code units
  let unsorted = { z: 1, b: 2, a: 3, aa: 4, B: 5 }
  assert.equal(canonicalizeJson(unsorted), '{"B":5,"a":3,"aa":4,"b":2,"z":1}')

  // 3. Compact formatting (no spaces after colon or comma)
  let nested = {
    array: [3, 2, 1],
    obj: { y: 'val', x: 42 },
  }
  assert.equal(canonicalizeJson(nested), '{"array":[3,2,1],"obj":{"x":42,"y":"val"}}')

  // 4. Undefined keys omitted, array undefined converted to null
  let withUndefined = { kept: 'yes', dropped: undefined }
  assert.equal(canonicalizeJson(withUndefined), '{"kept":"yes"}')
  assert.equal(canonicalizeJson(['a', undefined, 'b']), '["a",null,"b"]')

  // 5. Date objects formatted to standard ISO-8601 strings
  let date = new Date('2026-10-31T12:00:00.000Z')
  assert.equal(canonicalizeJson({ time: date }), '{"time":"2026-10-31T12:00:00.000Z"}')
})

test('computeBatchHash is deterministic and handles empty batches', () => {
  let emptyHash = computeBatchHash([])
  assert.equal(emptyHash, sha256Hex(''))
  assert.equal(emptyHash.length, 64)

  let line1 = serializeRecordLine({
    type: 'change_log',
    data: { id: 1, op: 'I', table: 'ship' },
  })
  let line2 = serializeRecordLine({
    type: 'event',
    data: { id: 2, event_type: 'survey.created' },
  })

  let batchHash1 = computeBatchHash([line1, line2])
  let batchHash2 = computeBatchHash([line1, line2])
  assert.equal(batchHash1, batchHash2)
  assert.notEqual(batchHash1, emptyHash)
})

test('computeSealHash produces chained cryptographic digests', () => {
  let hash1 = computeSealHash({
    prev_seal_hash: GENESIS_PREV_SEAL_HASH,
    batch_hash: sha256Hex('batch1'),
    from_xid: '100',
    to_xid: '200',
    change_log_count: 5,
    event_count: 2,
    sealed_at: '2026-10-31T12:00:00.000Z',
  })
  assert.equal(hash1.length, 64)

  // Chained next seal uses hash1 as prev_seal_hash
  let hash2 = computeSealHash({
    prev_seal_hash: hash1,
    batch_hash: sha256Hex('batch2'),
    from_xid: '200',
    to_xid: '300',
    change_log_count: 3,
    event_count: 1,
    sealed_at: '2026-10-31T12:15:00.000Z',
  })
  assert.equal(hash2.length, 64)
  assert.notEqual(hash1, hash2)
})

test('serializeManifestLine outputs canonical manifest string', () => {
  let line = serializeManifestLine({
    format: 'mms-audit-seal-v1',
    sealed_at: '2026-10-31T12:00:00.000Z',
    from_xid: '100',
    to_xid: '200',
    change_log_count: 1,
    event_count: 1,
    prev_seal_hash: GENESIS_PREV_SEAL_HASH,
    batch_hash: 'abc',
  })

  assert.ok(line.includes('"format":"mms-audit-seal-v1"'))
  assert.ok(line.startsWith('{'))
  assert.ok(line.endsWith('}'))
})
