# ADR-0012: Tier-2 audit sealing protocol, WORM export and verification

- Status: proposed (Card H-01)
- Date: 2026-10-31

## Context

ADR-0007 established the two-tier audit architecture for MMS:
- Tier 1: transactional recording of row changes (`audit_trail.change_log`) and business events (`audit_trail.event`), attributed to `iam.app_user.id` and monotonic PostgreSQL transaction ID `tx_id` (`xid8`).
- Tier 2: tamper-evident cryptographic sealing, immutable Write-Once-Read-Many (WORM) export, and independent verification by the Head Office Compliance department.

Under statutory classification and flag state oversight (IACS, ISO/IEC 17020, RO agreements), MMS must prove that historical records cannot be altered or deleted after the fact, even by database administrators.

Section 8.5 of the MMS Implementation Plan requires the sealing and verification protocol to be formally specified before implementation.

## Decision

Adopt the **Tier-2 Horizon Sealing Protocol (version `mms-audit-seal-v1`)** executed by dedicated login service role `audit_sealer`.

### 1. Horizon Boundaries & Snapshot Isolation

1. **Isolation Level**: Sealing transactions run in `REPEATABLE READ`.
2. **Horizon Selection**: The transaction captures the active snapshot xmin:
   ```sql
   SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon_xid;
   ```
3. **Transaction Range**: Rows are sealed in the half-open interval `[from_xid, to_xid)` where:
   - `from_xid` is the previous seal's `to_xid` (or the minimum unsealed `tx_id` for genesis seal).
   - `to_xid = horizon_xid`.
   - Records are selected strictly with `tx_id >= from_xid AND tx_id < to_xid`, ordered deterministically by `(tx_id, id)`.
4. **Late-Commit Immunity**: Because `pg_snapshot_xmin` is the lowest transaction ID active at snapshot time, all transactions with `tx_id < horizon_xid` have already committed or aborted. No transaction with `tx_id < horizon_xid` can commit later. Any long-running transaction with `tx_id >= horizon_xid` is deferred to subsequent sealing intervals when it completes.

### 2. Canonical Serialization & Manifest Format

1. **RFC 8785 Canonical JSON**:
   Every record line is serialized using the JSON Canonicalization Scheme (JCS, RFC 8785):
   - Object keys sorted lexicographically by UTF-16 code units.
   - Whitespace stripped (no spaces around `:`, `,`).
   - Floats and numbers formatted per ECMAScript 6+ standard.
   - Line delimiter: `\n`.
2. **Artifact Manifest Format**:
   The exported artifact is a `.jsonl` stream consisting of:
   - **Line 1 (Manifest Header)**:
     ```json
     {"batch_hash":"...","change_log_count":N,"event_count":M,"format":"mms-audit-seal-v1","from_xid":"...","prev_seal_hash":"...","sealed_at":"...","to_xid":"..."}
     ```
   - **Lines 2..(N+1)**:
     Canonical change log records:
     `{"data":{...},"table":"change_log","type":"record"}`
   - **Lines (N+2)..(N+M+1)**:
     Canonical event records:
     `{"data":{...},"table":"event","type":"record"}`
3. **Cryptographic Hashes**:
   - `batch_hash`: SHA-256 (64 hex characters) computed over the concatenated canonical record lines.
   - `prev_seal_hash`: The `seal_hash` of the preceding `audit_trail.seal` row (or `0000000000000000000000000000000000000000000000000000000000000000` for genesis).
   - `seal_hash`: SHA-256 (64 hex characters) computed over:
     `sha256(prev_seal_hash + ":" + batch_hash + ":" + from_xid + ":" + to_xid + ":" + change_log_count + ":" + event_count + ":" + sealed_at)`

### 3. Idempotent, Resumable Export & WORM Boundary

1. **Write-Once-Read-Many Storage**: Sealed batches are exported to WORM object storage (Azure Immutable Blob with time-based retention policy / AWS S3 Object Lock / dedicated WORM container).
2. **Pre-Commit Export Order**:
   - The sealer constructs the canonical export artifact and computes `worm_sha256`.
   - The sealer writes the artifact to WORM storage at path:
     `worm/audit/seals/seal_{from_xid}_{to_xid}.jsonl`
   - Only after WORM storage confirms persistence does the sealer execute the database transaction inserting the row into `audit_trail.seal`.
3. **Resumable Recovery**:
   - If a crash occurs between WORM write and database commit, re-running the sealer detects that the WORM object already exists.
   - If the pre-existing WORM object's SHA-256 matches the recomputed batch, the export is reused and the database commit succeeds.
   - If the hash differs, the sealer halts and triggers an alert (`WORM_COLLISION_OR_CORRUPTION`).

### 4. Gap Detection & Continuity Enforcement

1. **Sequential Chain**: Each seal must begin exactly where the previous seal ended: `current.from_xid == previous.to_xid`.
2. **No Skipped Batches**: If a gap is detected, the sealer refuses to jump ahead and requires sealing the missing horizon first.
3. **Monitored Lag**: Sealer monitors lag `pg_current_xact_id() - pg_snapshot_xmin()`. If long-running transactions stall horizon advancement beyond configured thresholds, alerts are emitted.

### 5. Independent Verification Algorithm (HO Compliance)

A standalone verifier CLI operates independently of operational DB credentials:
1. Validates the hash chain across all `audit_trail.seal` rows (`seal[i].prev_seal_hash == seal[i-1].seal_hash`).
2. Confirms horizon continuity (`seal[i].from_xid == seal[i-1].to_xid`).
3. For each seal:
   - Fetches artifact from WORM storage.
   - Validates `sha256(worm_bytes) == seal.worm_sha256`.
   - Re-computes `batch_hash` from the canonical lines; asserts match with `seal.batch_hash`.
   - Re-computes `seal_hash`; asserts match with `seal.seal_hash`.
   - (When live DB is accessible) Asserts 1-to-1 equivalence between WORM rows and database `audit_trail.*` rows within `[from_xid, to_xid)`.

### 6. Stated Residual Risk

A privileged database superuser with raw disk or replication access who alters unsealed rows **before** the horizon sealer executes cannot be detected by cryptographic sealing alone (since the seal would hash the already-tampered state).
- **Mitigation & Detection**: This residual risk is explicitly mitigated by pgaudit (Card H-02) and external append-only log forwarders shipping raw transaction stream logs off-database in near-real-time.

## Consequences

- Cryptographic tamper evidence is established from database transaction logs to cloud WORM storage.
- Head Office Compliance can independently prove evidentiary integrity without relying on DB admin assurances.
- Late-committing transactions do not cause missing audit records.
- Database administrators cannot tamper with exported WORM evidence.
