# ADR-0015: Entra deprovisioning sync worker and staff revocation lifecycle

- Status: accepted (Card H-04)
- Date: 2026-11-01

## Context

MMS staff authenticate exclusively through Microsoft Entra ID (OIDC with tenant pinning, PKCE, and RS256 signature verification).
In accordance with Decision Q1b and §7.7 of `docs/plans/auth-implementation-plan.md`:
1. MMS HR and sysadmin manage internal positions, roles, and org units, while Microsoft Entra gates access through the IT-managed app role `MMS.User`.
2. Section 14 (Security checklist and Revocation SLA) mandates:
   `MMS.User removed | Within 24 h (H-04)`
3. When staff leave the organization or change assignments, IT removes `MMS.User` in Microsoft Entra, or disables (`accountEnabled: false`) or deletes the user account in Entra ID.
4. If a staff member had an active session in MMS prior to IT removing `MMS.User`, that session would remain valid until absolute expiration (up to 12 hours) unless the backend detects the deprovisioning and revokes the session.
5. In addition, leaving the user in `iam.app_user` with `status = 'active'` and unrevoked role assignments would violate least privilege and leave orphaned assignments in the database.

## Decision

Implement the Entra Deprovisioning Sync Worker (Card H-04) with an auditable synchronization lifecycle:

### 1. Entra Directory Client & Status Detection

- Introduce the `EntraDirectoryClient` interface with:
  - `DefaultEntraDirectoryClient`: Production client communicating with Microsoft Graph API (`https://graph.microsoft.com/v1.0`) using OAuth 2.0 client credentials (`https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token`) with `client_id`, `client_secret`, and scope `https://graph.microsoft.com/.default`. Handles rate-limiting (HTTP 429 with `Retry-After`) and transient service errors (HTTP 503) using exponential backoff.
  - Dynamically resolves the app role GUID by discovering the Service Principal manifest via `GET /servicePrincipals?$filter=appId eq '{client_id}'` or via explicit `MMS_ENTRA_APP_ROLE_ID`.
  - Distinguishes API errors from business authorization checks: HTTP failures on `/appRoleAssignments` throw exceptions and do NOT falsely treat transient outages as role revocation.
  - `MockEntraDirectoryClient`: Deterministic in-memory provider for unit, integration, and E2E testing without external cloud network dependencies.
- Synchronize all internal staff members (`iam.app_user` where `kind = 'internal'` and `status in ('active', 'suspended')` via `private.entra_sync_list_staff()`).
- Fault-isolated batch execution: directory errors on individual users do not abort the synchronization pass, guaranteeing that subsequent terminated users in the directory are deprovisioned within the 24-hour Revocation SLA.
- A staff member is marked for deprovisioning if any of the following conditions is met:
  1. The user account has been deleted in Entra ID (404 Not Found or `deletedDateTime` is populated).
  2. The user account has been disabled in Entra ID (`accountEnabled === false`).
  3. The user no longer possesses the configured Entra app role `MMS.User`.

### 2. Atomic Database Deprovisioning Lifecycle (`private.deprovision_staff_user`)

- Execute deprovisioning through security definer function `private.deprovision_staff_user(user_id, reason, details)`:
  - Caller authority check: restricts execution strictly to `session_user in ('worker', 'int_sysadmin')`.
  - Comprehensive position closure: updates `iam.staff_position` to close active valid range (`valid = tstzrange(lower(valid), now())`) and invalidate scheduled future positions (`lower(valid) >= now()` -> `'empty'::tstzrange`), preventing post-termination privilege accrual.
  - Active assignment revocation: updates `iam.role_assignment` to set `revoked_at = now()`, `revoked_by = v_worker_id`, `revoke_reason = reason` for all unrevoked assignments.
  - Accurate session revocation count: counts active sessions prior to user deactivation.
  - User deactivation: updates `iam.app_user` to set `status = 'deactivated'`.
  - Session termination: the existing database trigger `private.app_user_revoke_sessions` automatically revokes all active sessions in `iam.session` with `revoke_reason = 'user_deactivated'`.
  - Re-validation enforcement: `private.pre_request` immediately rejects subsequent requests from this user with `PT401 session_invalid`.
  - Regulated audit event: emits `auth.user.deactivated` (retention class `RC-1`) capturing actor, subject, tenant ID, object ID, position closure, and assignment revocation count.
  - Idempotent: invocation on an already-deactivated user is a safe no-op.

### 3. Append-Only Run Ledger (`audit_trail.entra_sync_run`)

- Record every synchronization run in `audit_trail.entra_sync_run` (`status in ('clean', 'deprovisioned', 'failed')`, `users_checked`, `users_deprovisioned`, `deprovisioned_user_ids`, `error_message`, `detail`).
- Row-Level Security:
  - `SELECT` granted to `int_compliance`, `int_sysadmin`, and `worker`.
  - `INSERT` granted to `worker` and `int_sysadmin`.
  - Trigger `entra_sync_run_append_only` blocks all `UPDATE` and `DELETE` operations, ensuring an untamperable audit record for SOC 2 and ISO 27001 compliance reviews.

### 4. Re-Provisioning Safeguard

- If a previously deprovisioned staff user is legitimately re-hired and assigned `MMS.User` in Microsoft Entra, their successful OIDC login through `auth.resolve_entra` restores `status = 'active'`.
- In accordance with Decision Q1b, restored staff hold NO role assignments until MMS HR explicitly assigns a position; they are directed to the `/no-access` informational page until provisioned.

### 5. Multi-Mode Execution Architecture

- **Periodic Scheduler**: `startEntraSyncScheduler(intervalMs)` runs in `server.ts` to guarantee compliance with the 24-hour Revocation SLA.
- **Outbox Job**: Poller handles `kind = 'entra_deprovision_sync'` in `apps/web/app/jobs/poller.ts`.
- **Programmatic API**: `runEntraDeprovisionSync()` allows manual or scripted execution by operators and test suites.

## Consequences

- Satisfies the 24-hour SLA requirement for `MMS.User` deprovisioning.
- Prevents privilege retention by terminated personnel across sessions, roles, and positions.
- Full provenance recorded across `audit_trail.change_log`, `audit_trail.event`, and `audit_trail.entra_sync_run`.
