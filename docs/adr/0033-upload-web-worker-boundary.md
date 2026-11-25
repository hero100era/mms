# ADR-0033: Web/Worker Privilege Boundary for Upload Routes and RPC Migration

- Status: proposed
- Date: 2026-11-20
- Context: Card H-05 / ADR-0021 / ADR-0023
- Related: ADR-0021 (separate worker and sealer deployments), ADR-0023 (upload state machine and scan authority)

## Context

Under ADR-0021, the MMS deployment separates runtime roles into `web` (serves HTTP requests, holds only PostgREST credentials), `worker` (runs outbox jobs, Entra sync, quarantine sweeps, and malware scans), and `sealer` (audit horizon sealing).

Currently, `apps/web/app/actions/uploads/` imports `upload-repository.ts` and `jobs/malware-scanner.ts`. These modules invoke `getWorkerPool()`, which connects directly to PostgreSQL as the `worker` login role. As a consequence, in a split deployment (`MMS_RUNTIME_ROLE=web`), the web process must either hold `worker` database credentials or fail when processing upload preparation, direct upload streams, and scan triggers.

In `db/src/private/70_uploads_and_quarantine.sql`, the underlying functions:
- `private.upload_prepare(...)`
- `private.upload_mark_uploaded(...)`
- `private.upload_mark_verdict(...)`
- `private.document_version_record_scan(...)`

are private schema functions not callable via PostgREST. While `api.document_create_version` and `api.document_version_promote` exist in `db/src/api/40_survey_and_documents.sql`, there are no corresponding `api.upload_prepare`, `api.upload_mark_uploaded`, or `api.upload_enqueue_scan` RPCs exposed through the PostgREST interface.

## Decision

1. **Immediate Code Decoupling via Gateway Facade (`apps/web/app/storage/upload-gateway.ts`)**:
   Introduce `UploadStateGateway` to decouple upload actions and services from direct database pool implementations.
   In local development and unified mode (`MMS_RUNTIME_ROLE=all`), the gateway delegates to `upload-repository.ts` using the local worker pool.

2. **Target Architecture & DB RPC Migration**:
   To enforce complete privilege separation where `MMS_RUNTIME_ROLE=web` holds zero `worker` credentials, the following RPC migration is planned under `db/src/api/` and `db/src/auth/`:

   - **`api.upload_prepare(p_upload_id uuid, p_entity_type text, p_entity_id uuid, p_doc_type text, p_file_name text, p_quarantine_path text, p_expires_at timestamptz)`**:
     Calls `private.upload_prepare` under caller privilege checks.
   - **`api.upload_mark_uploaded(p_upload_id uuid, p_sha256 bytea, p_byte_size bigint, p_mime_type text)`**:
     Calls `private.upload_mark_uploaded`.
   - **`api.upload_enqueue_scan(p_version_id uuid)`**:
     Enqueues a `malware_scan` job into the outbox for background execution by the worker tier, returning HTTP 202 Accepted to the client.

3. **Production Enforcement**:
   Once the migration is reviewed and applied via `npm run db:plan`, `scripts/check-gateway-boundary.mjs` will statically assert that no file under `apps/web/app/actions/` or `apps/web/app/middleware/` imports `jobs/worker-client.ts` or `jobs/malware-scanner.ts`.
