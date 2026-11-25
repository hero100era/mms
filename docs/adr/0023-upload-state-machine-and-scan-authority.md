# ADR-0023: Upload state machine and scan-verdict authority (R2.3, R4.3)

- Status: proposed (decisions taken 2026-11-06, pending security review)
- Date: 2026-11-06

## Context

`docs/plans/rectification-implementation-plan.md` R2.3 requires explicit upload states, idempotent
finalization, a server-persisted quarantine path, a token bound to
upload id / filename / entity / document type / expiry / maximum size, cleanup of
expired objects and a storage/database reconciliation job. R4.3 requires request
and upload size limits and stops if the Remix/storage adapter cannot stream
safely.

Current state (verified): there are **no upload tables and no upload RPCs** in
`db/src`. The lifecycle lives entirely in TypeScript
(`apps/web/app/storage/service.ts`, `apps/web/app/actions/uploads/controller.tsx`).
`finalizeUpload` is not idempotent, the upload token HMACs only
`uploadId:expiresAtMs`, `arrayBuffer()` buffers the whole body, and a caller can
pass a non-quarantine `p_storage_path` to `api.document_create_version` to obtain
`scan_status = 'clean'` without any recorded scan. `api.document_version_promote`
also promotes a `pending` version without checking a scan verdict, and
`db/tests/survey_request.sql` currently asserts that behaviour.

Worse, `createMalwareScanner()` **falls through to `MockMalwareScannerClient`**
when `MALWARE_SCANNER_TYPE` is unset or unrecognised (`storage/scanner.ts:394-402`).
The mock's verdict comes from rules installed by tests, so in a misconfigured
deployment "scan" returns `clean` and the file is promoted. The failure mode is
not "no scan"; it is "a scan that is always green". `finalizeUpload` also accepts
`skipScan`, and `isDevEnvironment()` promotes and deletes the quarantine copy by
default outside production.

## Decisions

Taken by the product/security owner on 2026-11-06. Option (a) from the analysis,
with the refusal path spelled out in §3.

### 1. Where the upload state lives

A durable `core.upload` row with an explicit state. Promotion reads the row, never
a path string.

States: `prepared`, `uploaded`, `pending_scan`, `clean`, `infected`, `error`,
`abandoned`.

- `prepared` — a destination was issued and an upload row exists (no bytes yet).
- `uploaded` — bytes are in quarantine and the server-computed digest is recorded.
- `pending_scan` — enqueued for the malware scanner.
- `clean` / `infected` / `error` — terminal verdicts from an approved scanner
  engine.
- `abandoned` — expired before a verdict; the object was swept.

`uploadId` is the primary key and therefore the idempotency key. `finalizeUpload`
is `update ... where upload_id = $1 and upload_state = 'pending_scan'`; the
client-supplied `quarantinePath` is ignored except as a consistency assertion.
Replaying a finalize returns the existing result instead of creating a second
version. This is the specific fix for the S-03 retry path, which today fails with
`quarantine_file_not_found` after a successful promotion, and can create a
duplicate version if it is retried before promotion.

### 2. Server-computed SHA-256 only

The digest that lands on `core.document_version.sha256` is the one the server
computed from bytes it read itself (`inspectQuarantineFile`), carried on the
upload row. A caller cannot supply a digest. The upload row is the binding
between "these bytes" and "this document version" that a caller-supplied string
never was.

### 3. Rejection keeps the record and destroys the artifact

This is the decision that differs from "save no record at all", and the
reasoning is recorded here so it is not re-litigated casually.

| Object | On malware | On malformed / failed upload |
| --- | --- | --- |
| The bytes in quarantine | **Purged immediately** | Purged on sweep |
| The `core.upload` row | **Kept**, state `infected` | Kept, state `error`/`abandoned` |
| The `core.document` / `core.document_version` row | **Never created** | **Never created** |
| `audit_trail.malware_scan_run` row | Kept (`infected`, threat, engine, hash) | Kept (`error`) |
| `audit_trail.event` row | Kept (`MALWARE_DETECTED`, CRITICAL) | Kept (`core.upload.failed`) |
| Download reachability | None | None |

The requirement "no record about the file is saved" is honoured where it matters
to the business and to R2.3: **an upload that never passes the scanner can never
become a document.** It gets no `core.document` row, no `core.document_version`
row, no entry in `api.document_versions`, and therefore no reachable download and
no attachment any survey reviewer can see. The document pipeline is untouched by
infection.

It is *not* honoured for the upload attempt, deliberately. A rejected or
infected upload is a security event, and the audit trail in this repository is
append-only, sealed, and already models denials (`authz.denied.*`). Deleting the
trace of a malware submission would mean: no evidence for the incident response,
no answer to an auditor asking "was this file ever scanned and what did the
scanner say", no way to detect a repeat attempt by the same user, and no way to
distinguish "an attack was refused" from "no attack occurred". The upload row
itself carries no file content and no document, so keeping it does not create
reachable stored data: it is a tombstone with hash, filename, engine, threat,
actor and time.

### 4. Fail closed when no real scanner is configured

`createMalwareScanner()` must not silently fall back to the mock. Selection
becomes explicit and fail-closed on the production path:

- `MALWARE_SCANNER_TYPE` must name `clamav` or `defender` when the runtime is
  production (or `MMS_FORCE_PROD_STORAGE=1`). Missing or unrecognised → startup
  error, the same way `session-cookie.ts` refuses production without
  `MMS_SESSION_SECRET`.
- The mock is constructible only in test/development and only when named
  explicitly; there is no implicit default.
- `skipScan` is removed from the production surface. In development it remains
  available behind the explicit mock selection.

### 5. Transport and limits

- Reject an upload over **100 MiB** (104 857 600 bytes) as a request-body limit in
  the upload action, before reading the whole body, and enforce the same
  documented maximum in storage and in the token (`maxBytes`).
- Keep `arrayBuffer()` for the local/development storage adapter, where the body
  limit above bounds memory. For Azure Blob, the browser uploads directly with a
  write-only SAS, so the BFF never buffers the file; the size is enforced by
  `maxBytes` in the signed upload intent and by a post-upload check on
  `inspectQuarantineFile`, not by BFF memory.
- A request exceeding the limit is rejected with a stable error code, not a
  generic 500.

### 6. Upload token binding

The token is an HMAC over a canonical, length-prefixed serialisation of
`uploadId`, sanitized `fileName`, `entityType`, `entityId`, `docType`,
`expiresAtMs` and `maxBytes`. Comparison stays constant-time. A token cannot be
replayed for a different filename consequence or entity.

### 7. Reconciliation, cleanup and retention

- Expired or abandoned uploads (`prepared`/`uploaded` past `expiresAt`, no verdict)
  are swept to `abandoned` and their quarantine object is removed.
- The reconciliation job reports objects under `quarantine/` with no matching
  non-terminal upload row, and upload rows in a terminal state whose object
  still exists (it does not silently delete either: it reports, and a human
  or automatic retry acts on it).
- Quarantine retention policy and storage lifecycle rules are an operations
  decision recorded in the runbook; the database is authoritative for state,
  storage lifecycle rules are defence in depth.

### 8. Scan-verdict authority

`private.document_version_record_scan` remains the only writer of a scan
verdict. `api.document_create_version` stops inferring `clean` from
`p_storage_path`: it requires the referenced upload to be in state `clean`, and
copies the server-computed hash from the upload row. `api.document_version_promote`
refuses a version whose `scan_status` is not `clean`.
`p_scanner_engine` becomes an allowlist lookup against
`private.approved_scanner_engine`, not free text.

## Consequences

- `db/tests/survey_request.sql` and `apps/web/app/actions/uploads.test.ts` change
  contract: promotion of a never-scanned quarantined version must now be
  **rejected**, and tests must assert the rejected path. This is a
  rectification of a test that encoded the unsafe behaviour, not a weakening of
  a test.
- `api.document_create_version` stops inferring `clean` from `p_storage_path`.
- A migration changes `SECURITY DEFINER` bodies, grants, an allowlist table and
  adds `core.upload`: this requires the `security-review` label and two
  reviewers, per `AGENTS.md`.
- `db:test` and `db:verify` are mandatory for this change, because a
  `db:check`-only run does not compile PL/pgSQL bodies.

## Open questions (not blocking §1-§7)

- Whether quarantine blobs are deleted immediately on `infected` or retained
  (encrypted, non-executable) for law-enforcement evidence. This ADR's default
  is **delete the bytes immediately** based on the "no record" requirement
  strongly; if a retention obligation later applies, it retracts §3.
- Exact streaming implementation at the storage adapter boundary.

## Review

Requires ADR approval tracked by the `security-review` label, and two human
reviewers. Implementation may proceed on the §1/§2/§4/§5/§6 items, which are
independent of the storage-adapter streaming detail,
but nothing may be applied to production until reviewed.
