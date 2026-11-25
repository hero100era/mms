# Refactoring Audit Notes (Task 0.2)

This document audits duplicate and hotspot files across the codebase in preparation for Phases 1–4 of `refactor_implementation_plan.md`.

---

## 1. Malware Scanning Logic: `storage/scanner.ts` vs. `jobs/malware-scanner.ts`

### Findings
- **`apps/web/app/storage/scanner.ts` (507 lines):**
  - Defines core scanner interfaces and types: `MalwareScanStatus`, `MalwareScanResult`, `MalwareScannerClient`.
  - Implements clients: `MockMalwareScannerClient`, `ClamAvScannerClient`, `AzureDefenderScannerClient`.
  - Implements scanner factory and registry: `createMalwareScanner`, `getMalwareScanner`, `setMalwareScanner`.
- **`apps/web/app/jobs/malware-scanner.ts` (429 lines):**
  - Duplicates scanner failure alerting and tracking: `recordScannerFailure`, `SCANNER_FAILURE_ALERT_THRESHOLD`.
  - Mixes database RPC / schema calls into background job worker:
    - `dbUploadPrepare` (calls `private.upload_prepare`)
    - `dbUploadMarkUploaded` (calls `private.upload_mark_uploaded`)
    - `dbUploadMarkVerdict` (calls `private.upload_mark_verdict`)
    - `recordMalwareScanRun` (calls `private.record_malware_scan_run`)
    - `recordScan` (calls `private.document_version_record_scan`)
  - Cross-layer leak: `apps/web/app/actions/uploads/controller.tsx` directly imports `dbUploadPrepare`, `dbUploadMarkUploaded`, `dbUploadMarkVerdict`, and `recordMalwareScanRun` from `jobs/malware-scanner.ts`.
- **Symbols to Extract / Refactor:**
  1. Extract DB upload state machine calls (`dbUploadPrepare`, `dbUploadMarkUploaded`, `dbUploadMarkVerdict`, `recordMalwareScanRun`) into a dedicated data/storage service module (`apps/web/app/storage/db-upload.ts` or `apps/web/app/storage/upload-repository.ts`).
  2. In `jobs/malware-scanner.ts`, delegate scan execution to `storage/scanner.ts` and keep only job polling, scheduling, and batch dispatching.
  3. Keep `storage/scanner.ts` under 400 lines by separating `ClamAvScannerClient` or test mocks into colocated client files if needed.

---

## 2. Microsoft Entra ID Client & Mapping: `auth/entra.ts` vs. `jobs/entra-sync.ts`

### Findings
- **`apps/web/app/auth/entra.ts` (201 lines):**
  - Contains Entra OIDC client configuration: `config()`, `entraConfigured()`, `entraTenantId()`, `entraLogoutUrl()`, `validateAppBaseUrl()`, `getAppBaseUrl()`.
  - Defines `EntraClaims`, `EntraConfig`, authority resolution, and token validation.
- **`apps/web/app/jobs/entra-sync.ts` (579 lines):**
  - Duplicates authority resolution: `getAuthority(tenantId)` reproduces `process.env.MMS_ENTRA_AUTHORITY ?? 'https://login.microsoftonline.com/${tid}'`.
  - Reads matching env vars: `MMS_ENTRA_TENANT_ID`, `MMS_ENTRA_CLIENT_ID`, `MMS_ENTRA_CLIENT_SECRET`, `MMS_ENTRA_AUTHORITY`.
  - Implements custom Graph retry wrapper (`fetchWithGraphRetry`), access token cache, app role resolution, and directory status fetch.
- **Symbols to Extract / Refactor:**
  1. Extract common Entra configuration, token acquisition, and Graph API client into `apps/web/app/auth/entra-client.ts`:
     - `getEntraAuthority(tenantId?: string)`
     - `fetchWithGraphRetry(url, init, maxRetries)`
     - `acquireGraphAccessToken(tenantId, clientId, clientSecret, authority)`
  2. Keep `auth/entra.ts` focused on OIDC user authentication and `jobs/entra-sync.ts` focused on the background synchronization worker.

---

## 3. Monolithic Action & Page Files: `survey-pages.tsx`, `auth-pages.tsx`, `admin-pages.tsx`, `helpers.tsx`

### Findings
- **`apps/web/app/actions/survey-pages.tsx` (1,425 lines):**
  - Combines 5 entire page views: `SurveyListPage`, `NewSurveyRequestPage`, `SurveyDetailPage`, `TriageQueuePage`, `TriageDetailPage`.
  - Inlines 280+ styles and presentational helpers: `formatDateTime`, `statusBadgeColor`, `renderTimeline`, `renderFileAttachments`.
  - Target: Split into `apps/web/app/actions/survey/pages/` and `apps/web/app/actions/survey/presenters.ts`, with re-exports in `survey-pages.tsx`.
- **`apps/web/app/actions/uploads/controller.tsx` (907 lines):**
  - Monolithic file handling init, chunk upload, direct SAS generation, status polling, and download streaming.
  - Mixes validation, HTTP parsing, storage operations, and database RPCs in one controller.
  - Target: Extract validation into `validation.ts` and route action handlers into `handlers.ts`, leaving `controller.tsx` under 150 lines.
- **`apps/web/app/actions/auth-pages.tsx` (740 lines):**
  - Houses 9 different views: `LoginPage`, `DevLoginPage`, `ChooseRolePage`, `ForgotPasswordPage`, `ResetPasswordPage`, `InvitePage`, `ProfilePage`, `MfaPage`, `MfaEnrolPage`, `StepUpPage`, `BreakGlassPage`, `NoAccessPage`.
  - Target: Split into distinct page components under `apps/web/app/actions/auth/pages/`, re-exporting from `auth-pages.tsx`.
- **`apps/web/app/actions/admin-pages.tsx` (455 lines):**
  - Combines `PositionsPage`, `AssignmentsPage`, and `PositionProposalsPage`.
  - Target: Split into `apps/web/app/actions/admin/pages/`, re-exporting from `admin-pages.tsx`.
- **`apps/web/app/actions/helpers.tsx` (262 lines):**
  - Contains shared auth/session helpers and renders fallback error/login pages.
  - Imports `auth-pages.tsx`, causing large transitive graph inclusion.
  - Target: Keep lightweight, decouple from full page imports where feasible.
