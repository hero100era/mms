# Runbook: Tier-2 Audit Sealing and WORM Evidence (Phase R7.4)

This runbook documents the architecture, key storage, rotation metadata, automated verification, gap detection, and anomaly alerting for MMS Tier-2 audit evidence.

## 1. Architecture and Credential Separation

Tier-2 audit integrity protects regulatory evidence (IMO/IACS surveys, certificates, position assignments, break-glass activations) from retroactive tampering:

1. **Transactional Change Logging:** Trigger `private.audit_capture()` captures pre- and post-image states into `audit_trail.change_log` under table-level row locks.
2. **Explicit Business Events:** Operations emit tamper-evident events to `audit_trail.event` via `private.emit_event()`.
3. **Transaction Horizon Sealing:** The dedicated `sealer` deployment connects solely as database role `audit_sealer`. Neither the web BFF (`web_anon`) nor the background worker (`worker`) holds credentials or grants for `audit_trail.seal`.
4. **WORM Storage:** Sealed manifests and RFC 8785 canonical JSONL record batches are written to immutable Write-Once-Read-Many (WORM) storage (Azure Blob Storage with Immutability Policy / AWS S3 Object Lock Compliance Mode).

## 2. Seal Verification Key Storage and Rotation Metadata

### Storage in Key Management Service (Azure Key Vault / AWS KMS)

- Seal verification and signing keys are stored in a managed Hardware Security Module (HSM) with `exportable: false`.
- The sealer role accesses only the cryptographic signing operation (`crypto.sign`) or mounts the verified certificate bundle via CSI secret driver.
- The web BFF and compliance verifier only hold public keys to verify digital signatures.

### Key Metadata Schema

Every seal verification key records mandatory rotation metadata:

| Attribute | Format | Description |
|---|---|---|
| `kid` | `mms-seal-YYYYqN` | Unique key identifier (e.g. `mms-seal-2026q4`) |
| `kty` | `RSA` or `EC` | Cryptographic key family (RSA 3072 or EC P-256) |
| `alg` | `RS256` or `ES256` | Signing algorithm |
| `created_at` | ISO-8601 UTC | Timestamp of key generation in KMS/HSM |
| `activated_at` | ISO-8601 UTC | Timestamp when sealer began signing with this key |
| `retire_at` | ISO-8601 UTC | Timestamp when active signing transitioned to next key |
| `expires_at` | ISO-8601 UTC | Certificate expiration (min 365 days past retirement) |

### Key Rotation Procedure

1. **Publish First:** Generate new key in Key Vault `mms-seal-2027q1`. Add public key to the sealer's verification keyring (`MMS_SEAL_ADDITIONAL_JWKS`).
2. **Transition Sealer:** Set `MMS_SEAL_ACTIVE_KID=mms-seal-2027q1`. Restart the sealer service (`npm run start:sealer`).
3. **Retire Old Key (Never Delete):** The previous public key `mms-seal-2026q4` remains permanently readable by `verifyAuditSeals` to validate historical seals across the 5-to-10-year regulatory retention window.

## 3. Automated Verification and Reconciliation

The sealer deployment (`apps/web/sealer.ts`) schedules automated integrity monitoring:

- **Sealing Horizon Cadence:** Every `MMS_SEAL_INTERVAL_SECONDS` (default 900s / 15 minutes), advances the snapshot horizon and writes sealed evidence to WORM storage.
- **Audit Reconciliation (`reconcileAuditEvents`):** Hourly cross-reference between controlled-column mutations in `audit_trail.change_log` and regulated events in `audit_trail.event`.
- **Cryptographic Verification (`verifyAuditSeals`):** Periodic end-to-end check of the hash chain, WORM blob SHA-256 digests, and live database correspondence.

Manual / CI verification commands:

```sh
# Verify all seals against live database and WORM storage
npm run audit_trail:verify

# Verify with automated alert dispatching
node scripts/verify-audit_trail.ts --alert --alert-zero-records

# Reconcile controlled column changes over the past 24 hours
npm run audit_trail:reconcile

# Reconcile with alert dispatching
node scripts/reconcile-audit_trail.ts --hours 24 --alert --alert-zero-records
```

## 4. Anomaly Detection and Security Alerts

The verification engine detects four classes of integrity violations:

### A. Horizon and Chain Gaps (`HORIZON_GAP`, `CHAIN_BROKEN`)
- **Detection:** `seal.from_xid !== prevSeal.to_xid` or `seal.prev_seal_hash !== prevSeal.seal_hash`.
- **Alert:** `SEAL_TAMPER_DETECTED` (Severity: `CRITICAL`).
- **Action:** Halt sealing pipeline. Inspect Postgres WAL and replica lag. Investigate unauthorized `DELETE` or `TRUNCATE` attempts on `audit_trail.seal`.

### B. WORM Hash Mismatches (`WORM_SHA256_MISMATCH`, `BATCH_HASH_MISMATCH`, `SEAL_HASH_MISMATCH`)
- **Detection:** The SHA-256 digest of the WORM blob differs from `audit_trail.seal.worm_sha256` or the recomputed root hash differs from `audit_trail.seal.seal_hash`.
- **Alert:** `SEAL_TAMPER_DETECTED` / `WORM_COLLISION_OR_CORRUPTION` (Severity: `CRITICAL`).
- **Action:** Indicates tampering on the storage layer. Trigger incident response. Pull cold immutable backup from Legal Hold container.

### C. Live Database Row Divergence (`DATABASE_DIVERGENCE`)
- **Detection:** Live database rows in `audit_trail.change_log` or `audit_trail.event` inside a sealed horizon `[from_xid..to_xid)` differ from the sealed batch hash.
- **Alert:** `SEAL_TAMPER_DETECTED` (Severity: `CRITICAL`).
- **Action:** A database user modified historical audit records post-sealing. The WORM artifact provides the authoritative non-repudiable legal evidence.

### D. Zero-Record Anomaly (`ZERO_RECORD_ANOMALY`)
- **Detection:**
  - `report.totalSeals === 0` during compliance verification; or
  - Consecutive seals exhibit 0 change logs and 0 events during operating hours.
- **Alert:** `ZERO_RECORD_ANOMALY` (Severity: `WARNING`).
- **Action:** Check trigger health (`upload_audit_capture`, `change_capture`) and verify that database transaction activity is generating expected audit rows.

## 5. Residual Risk Note (ADR-0012 §6)

A database superuser modifying rows *before* the transaction commits and before the horizon sealer runs cannot be detected by cryptographic sealing alone. Mitigation relies on host-level `pgaudit`, remote append-only syslog forwarders, and cloud managed database IAM roles.
