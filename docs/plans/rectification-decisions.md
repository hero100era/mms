# MMS Unified Implementation Plan — Part 4: Execution Tracking & Decision Register

> **Master Plan:** [MMS Unified Implementation Plan (docs/plans/README.md)](README.md)  
> **Companion Document to:** [Part 2: Rectification Plan](rectification-implementation-plan.md)  
> **Scope:** Executed tasks, release blocker status, stop conditions, and governance decisions required.

## Purpose

This is the execution record and decision companion to [rectification-implementation-plan.md](rectification-implementation-plan.md). It records
what was executed in this pass, where execution stopped, and the human decisions
needed before the remaining phases can start. It is not an ADR; where the plan or
`AGENTS.md` requires an ADR or a human decision, this document proposes the ADR
and stops rather than inventing a convention.

Related evidence: [review-baseline.md](review-baseline.md) (R0),
[../runbooks/request-context.md](../runbooks/request-context.md) (R1.4).

## Executed in this pass

| Task | Status | Evidence |
| --- | --- | --- |
| R0.1 reviewed baseline | Done | `docs/plans/review-baseline.md`; 484/484 snapshot files identical; Remix 3.2.0 locked |
| R0.2 baseline evidence | Done | `docs/plans/review-baseline.md`; all commands exit 0 |
| R1.1 caller-role checks | Done | `private.is_emergency()`, `private.is_worker_or_admin()`, guard added to `private.record_malware_scan_run`, 8 duplicated guards consolidated; NULL-claim fail-open closed; **`private.emit_event` is no longer directly executable by capability roles (closed a forged `db_role` / audit-attribution hole)**; all five plan-required adversarial cases in `rectification_r1_1.sql` |
| R1.2 grant minimisation | Done | 9 over-broad EXECUTE grants revoked (incl. `document_create_version` from viewer/compliance and `emit_event` from sysadmin/compliance); pgTAP ACL matrix |
| R1.3 complete CSP | Done | `remix/middleware/csp` + request nonces, all 10 required directives, no `unsafe-eval`/wildcards, Google Fonts removed, HSTS gating fixed, 6 new tests |
| R1.4 trusted proxy | Done | chain size/length/validity caps, `Forwarded` explicitly untrusted, 7 new tests, runbook |
| R1.5 OAuth / return paths / intents | Done (contained fixes) | `safeReturnTo` hardened, Entra issuer↔tenant binding, link intents bound to session id + single-use id + user id, unknown purposes rejected; new tests |
| R1.6 break-glass | Done (ADR-0022 proposed) | 4-hour DB cap, deactivation revokes sessions, expiry fails closed per request: re-verified. **Added**: `iam.break_glass_forbidden_action` matrix + `private.assert_not_break_glass` enforced ahead of every `assert_authority`; `auth.break_glass_drill_record` writes drill evidence; `break_glass_alert` outbox rows are now actually consumed and unknown kinds fail loudly |
| R2.1 logical document uniqueness | Done | `core.document_logical_uk`, atomic `INSERT ... ON CONFLICT`, title belongs to the logical document |
| R2.2 revision allocation | Done | logical-row `FOR UPDATE`, deterministic `document_revision_conflict` (40001), version + audit event in one transaction; **two-connection concurrency test added** |
| R2.3 upload state machine & storage consistency | Done | Quarantine-first upload pipeline, non-dev quarantine lock (423), promotion requiring clean scan verdict by approved engine, dev-only auto-promote isolation; `uploads.test.ts` & `malware-scan.test.ts` |
| R2.4 workflow atomicity | Done (idempotency keys deferred) | state predicate + `row_count = 1` on all five transitions, `workflow_conflict` (40001); idempotency keys need ADR-0024 |
| R2.5 temporal validity | Done | explicit `[)` bounds CHECK on all four temporal tables (empty ranges allowed for deprovisioning), subject-row locks in coverage/position/assignment/membership paths |
| R3.1 typed application context | Done | `apps/web/app/actions/context.ts` typed accessors (`getAuth`, `requireAuth`, `getPgrst`, `getSession`, `render`); eliminated `(context as any)` in controllers |
| R3.2 typed PostgREST contracts | Done | `@mms/pgrst-client` mappings for RPC arguments, return types and database views (`ApiViews`, `ApiRpcs`) |
| R3.3 centralized role metadata | Done | `api.assignable_roles` RPC in migration `20261107T142942Z_r3-3-assignable-roles`; hardcoded `<option>` lists removed from admin UI |
| R3.4 stable domain error codes | Done | `apps/web/app/actions/errors.ts` mapping SQLSTATE / PostgREST errors to `DomainErrorCode` and HTTP status codes (400, 401, 403, 404, 409, 423) |
| R4.1 shared validation layer | Done | `apps/web/app/actions/validation.ts` (`ensureText`, `validateUuid`, `validateEmail`, `validateReason`, `validateEnum`, `validatePagination`) with field-level `ValidationError` |
| R4.2 standardize action responses | Done | RFC 9457 Problem Details (`application/problem+json`) with domain error codes, titles, type URIs, correlation IDs (`RequestIdKey`) in `apps/web/app/actions/errors.ts`; strict `Cache-Control: no-store` on sensitive paths in `request-context.ts`; form state preservation on validation errors; 12 integration tests in `r4-2-response.test.ts` |
| R4.3 request-body and upload limits | Done | Max body limits (1 MiB JSON, 2 MiB forms) via `bodyLimits` middleware; category upload limits (100 MiB drawings, 25 MiB specifications, 10 MiB default); streaming quarantine upload (`putQuarantineStream`) with on-the-fly SHA-256 and byte limit abort; chunk-by-chunk early abort in `readJsonWithLimit`; pre-buffer metadata checks on `inspectQuarantineFile` and `getStorageFile`; 10 tests in `r4-3-body-limits.test.ts` |
| R5.1 starter UI removed | Done | MMS shell replaces the Remix starter; `prompt-button.tsx` deleted; 8 tests assert no starter surface and no inline style attributes |
| R5.2 MMS design system & CSP cleanup | Done | Converted 364 legacy inline `style=` attributes across `apps/web/app/actions/` to `css()` mixins; removed temporary `'unsafe-inline'` CSP exception |
| R5.3 replace raw UUID administration | Done | Replaced raw text inputs in `PositionsPage` with authorized `<select name="unit_id">` and `<select name="job_title_code">`; replaced raw inputs in `AssignmentsPage` with authorized `<select name="scope_unit_id">`; required explicit visible reasons (min 5 chars) for grants, revocations, and position changes; resolved unit names/codes in tables; error handling with RFC 9457 negotiation on revocation; 8 tests in `r5-3-admin-controls.test.ts` |
| R6.1 consolidated authorization matrix | Done | `docs/security/authorization-matrix.md` encoding all 10 authorization dimensions and 6 architectural archetypes; `iam.authority_rule_sysadmin_ck` enforces sysadmin cannot hold business approval authority; expanded `iam.break_glass_forbidden_action` seed |
| R6.2 authority decision explanation | Done | `private.explain_authority` / `api.explain_authority` diagnostics returning non-sensitive reason codes (`ok`, `creator_cannot_approve`, `sysadmin_cannot_approve`, `out_of_scope`, `min_grade_insufficient`, `amount_exceeded`, `qualification_required`, `break_glass_forbidden`) restricted to authorized internal roles; pgTAP and TypeScript tests |
| R6.3 segregation of duties (SoD) | Done (ADR-0026 proposed) | Four-eyes survey acceptance (`creator_cannot_approve`); position proposal confirmation restriction (`cannot_confirm_own_proposal`); qualification self-grant prohibition (`cannot_grant_self`); sysadmin barred from operational triage; break-glass prohibited operations; positive and adversarial tests in `authorization_matrix.sql` (39 tests) and `r6-sod.test.ts` (6 tests) |
| R7.1 process separation | Done | Web (`apps/web/server.ts`), worker (`apps/web/worker.ts`), and sealer (`apps/web/sealer.ts`) isolated into dedicated runtimes; enforced by `assertPlan()` in `apps/web/app/jobs/runtime.ts` |
| R7.2 durable outbox leasing & dead-letter | Done (ADR-0027 proposed) | `FOR UPDATE SKIP LOCKED` outbox claims; durable leases with `leased_by` and `lease_expires_at`; heartbeat extension (`heartbeatJob`); recovery of expired leases from crashed workers; exponential backoff retries with `last_error_class = 'transient'`; dead-letter escalation (`dead_letter`) on max attempts or fatal job kinds; 7 tests in `r7-2-outbox-leasing.test.ts` |
| R7.3 productionize malware scanning | Done | Hardened ClamAV TCP streaming client with fail-closed timeout watchdog; Azure Defender index tag scanner client; immutable file SHA-256, engine, and signatures recorded in `audit_trail.malware_scan_run` and `core.document_version`; consecutive scanner failure alerting (`MALWARE_SCANNER_FAILURE`, CRITICAL); automated quarantine retention sweep (`runQuarantineSweep` / `quarantine_sweep_expired`) marking stale uploads `abandoned` and purging blobs; 4 tests in `r7-3-malware-quarantine.test.ts` |
| R7.4 protect audit and WORM evidence | Done | Automated reconciliation and verification schedulers in `apps/web/sealer.ts`; `ZERO_RECORD_ANOMALY` detection in `verifyAuditSeals` and `reconcileAuditEvents`; CLI `--alert` and `--alert-zero-records` flags in `scripts/verify-audit_trail.ts` and `scripts/reconcile-audit_trail.ts`; `docs/runbooks/audit-worm.md`; 4 tests in `r7-4-worm-audit_trail.test.ts` |
| R7.5 backup and restore operations | Done | RPO and RTO defined in `docs/runbooks/backup-restore.md` (RPO <= 5 min primary, RPO = 0 sealed WORM audit, RTO <= 60 min); `scripts/restore-drill.sh` hardened with scratch database safety validation (refusing production/source matching and requiring `_drill`, `_scratch`, or `_restore` suffix), post-restore pgTAP invariant verification, and seal correspondence check against WORM store |
| R8.1 / R8.2 release migration gate | Done | `scripts/check-release-gate.ts` & `npm run release:check` verifying all 84 migrations are locked in `db/migrations.lock.json`, review checklists are completed, and rollback / forward-fix strategies exist; tested in `r7-5-r8-release-gate.test.ts` |
| R8.3 toolchain pins & supply chain | Done | TypeScript `7.0.2`, `@types/node` `26.6.6`, `engines.node: ^24.7.0 || ^26.0.0`; `.github/dependabot.yml` policy; regression test forbids floating ranges |
| R8.5 hardened baseline closure | Done | Synchronous denial + asynchronous cleanup for break-glass (`private.pre_request` immediate rejection, `auth.break_glass_sweep_expired` cleanup); quarterly drill threshold normalized to 92 days; durable outbox security alert retry via `private.enqueue_security_alert` & `OutboxAlertSink`; obsolete R2 documentation contradictions resolved |
| R9 domain foundation | Proposed ADRs | ADR-0028 (party/vessel), ADR-0029 (survey jobs/deficiencies), ADR-0030 (qualifications/certificates); awaiting Gate A–E sign-off |
| R10 adversarial suite | Deferred | Requires R9 implementation and human security sign-off |

Fifteen forward-only migrations were generated with `npm run db:plan`, reviewed and
locked:

- `20261106T025945Z_r1-r2-rectification`
- `20261106T030554Z_r1-worker-guard-canonical`
- `20261106T031114Z_r2-document-upsert-return`
- `20261106T034303Z_r1-6-break-glass-matrix`
- `20261106T035206Z_r2-workflow-temporal`
- `20261106T035456Z_r2-temporal-bounds-allow-empty`
- `20261106T040210Z_r2-row-count-fix`
- `20261106T050532Z_r1-2-document-create-acl`
- `20261106T053409Z_r1-1-emit-event-owner-only`
- `20261106T150811Z_r2-3-upload-state-machine`
- `20261106T154537Z_r1-1-worker-guard-grants`
- `20261107T142942Z_r3-3-assignable-roles`
- `20261108T050904Z_r6-r7-authorization-and-outbox`
- `20261108T063008Z_r7-3-malware-and-quarantine`
- `20261108T085334Z_r8-5-closure`

Nine ADRs are proposed (none accepted yet):
- ADR-0022 (break-glass forbidden operations)
- ADR-0023 (upload state machine and scan authority)
- ADR-0024 (idempotency and domain error codes)
- ADR-0025 (MMS shell, design system and CSP nonce-only styles)
- ADR-0026 (authorization matrix and segregation of duties)
- ADR-0027 (durable outbox leasing and dead-letter queue)
- ADR-0028 (canonical party and vessel identity architecture)
- ADR-0029 (operational survey job separation and deficiency lifecycle)
- ADR-0030 (competence authorizations, controlled maritime certificates, and class notations)

## Validation (all green)

```
npm run typecheck        0
npm test                 0   (177 web tests + 6 pgrst-client + 6 totp = 189 tests, no failures)
npm run check:boundary   0   (234 assets)
npm run doctor           0   (0 warnings, 0 advice for project/actions)
npm run db:lint          0
npm run db:check         0   (84 migrations, C1/C3/C5, round-trip clean)
npm run db:spike         0
npm run db:test          0   (23 pgTAP files incl. authorization_matrix.sql,
                              break_glass.sql, rectification_r1_1.sql,
                              rectification_r1_6.sql, rectification_r1_r2.sql,
                              rectification_r2_5.sql)
npm run db:verify        0
npm run release:check    0   (84/84 migrations locked and verified)
```

## Environment findings from this pass

These are **pre-existing**, reproducible on the untouched baseline commit, and cost
real debugging time. They are environment/harness defects, not source regressions.

1. **A stale PostgREST schema cache makes every positive-path integration test
   fail with 403.** After any migration, PostgREST keeps serving the old schema
   until it is told to reload. The actions then catch the PostgREST error and
   return `{error:"unauthorized"}` (403), which looks like an authorization bug.
   Fix: `psql "$DATABASE_URL" -c "notify pgrst, 'reload schema'"` after
   `db:migrate`. Recommend wiring that NOTIFY into `db/scripts/migrate.ts`.
2. **`uploads.test.ts` and `malware-scan.test.ts` sent no browser provenance
   headers.** `cop()` runs before `csrf()` and rejects an unsafe request that has
   neither `Sec-Fetch-Site` nor a matching `Origin` with a 403 that is *not* a
   CSRF/token failure. A browser always sends both, so the tests now send them
   through a small `router.fetch` wrapper (the same pattern `controller.test.ts`
   already uses for `x-forwarded-for`).
3. **`db:reset` alone is not enough to run the app suite.** The integration tests
   need the organisation fixtures, so the documented order is
   `db:reset`/`db:migrate` → `db:fixtures` → `npm test`.
4. **`db:check` does not compile PL/pgSQL bodies.** A `GET DIAGNOSTICS
   v = rowcount` typo (the item is `ROW_COUNT`) passed `db:check`, `db:spike` and
   the C1/C3/C5 gate while every transition function failed to compile. Only
   `db:test` caught it. C5 drift checking and PL/pgSQL compilation are not the
   same gate; treat `db:test` as mandatory for any function-body change.

## Stop conditions and decisions required

### Security review gate (release blocker for production deployment)

`AGENTS.md` requires the **`security-review` label and two human reviewers** for
changes to grants, RLS/policies, `SECURITY DEFINER` functions, the `auth` schema,
authority rules or the token signer. All 15 rectification migrations (`20261106T025945Z_r1-r2-rectification`
through `20261108T085334Z_r8-5-closure`) touch `SECURITY DEFINER` bodies, and several
touch grants, authority rules, and the `auth` schema.

**Human approval is mandatory here.** Do not let an automated agent mark this
complete by changing documentation checklists from `[ ] Security reviewed` to
`[x] Security reviewed`.

**Governance disposition:**
- This is a **production release blocker**: production deployments must not apply
  these migrations until two human reviewers have reviewed the diffs, verified definer
  safety, and applied the `security-review` sign-off.
- Per `docs/plans/rectification-implementation-plan.md:867`, Phase R9 implementation must not start
  until R1–R8 release gates are green. ADRs 0028–0030 remain strictly `proposed` and
  await Gate A–E sign-off and PO approval before domain tables/RPCs are developed.

### CSP temporary exception (R1.3 acceptance criteria - RESOLVED in R5.2)

`style-src-attr 'unsafe-inline'` was removed in R5.2. All 364 legacy inline `style="…"`
attributes across `apps/web/app/actions/` were converted to nonced `css()` mixins,
enabling strict CSP without unsafe-inline for styles.

### R1.6 / R8.5 — Break-glass lifecycle closure (resolved)

The break-glass security model is fully resolved and implemented in `20261106T034303Z_r1-6-break-glass-matrix`
and `20261108T085334Z_r8-5-closure`:

1. **Synchronous denial, asynchronous cleanup**:
   At request time, a break-glass session must satisfy:
   `session active AND break-glass activation active AND current timestamp < activation expiry`.
   `private.pre_request()` enforces this directly: the instant the emergency window lapses (or if
   the account is dormant), requests are synchronously denied with `PT403 break_glass_dormant`.
   Security does not depend on a background scheduler firing on time. Asynchronous cleanup is
   handled by `auth.break_glass_sweep_expired()`, which revokes lingering session rows in `iam.session`,
   resets account activation in `iam.break_glass_account`, and emits `auth.breakglass.deactivated` audit events.
2. **Quarterly drill threshold**:
   Normalized to an explicit 92-day quarterly threshold (`last_drill_at is null or last_drill_at <= now() - interval '92 days'`).
   Automated check via `auth.break_glass_drill_overdue()` and `apps/web/app/jobs/break-glass-alerts.ts`
   reports accounts overdue for drills.
3. **Durable security alert retry via core.outbox**:
   Security-critical events (break-glass activation, drill overdue, audit-seal failure,
   reconciliation discrepancy, malware detection, WORM failure) commit transactionally to `core.outbox`
   via `private.enqueue_security_alert()`. Delivery is processed through the R7.2 durable leasing,
   heartbeat, exponential backoff retry, and dead-letter queue architecture (`OutboxAlertSink` in
   `apps/web/app/audit/alerter.ts`). No ad-hoc alert queue is needed.
4. **Forbidden-operations matrix**:
   `iam.break_glass_forbidden_action` enumerates regulated approvals (statutory certificates, survey/audit
   conclusions, qualification approvals, financial approvals, HR confirmations) barred from emergency sessions,
   enforced by `private.assert_not_break_glass()` before any authority evaluation.

### R2.3 — Upload lifecycle & storage consistency (done)

Resolved and implemented in migration `20261106T150811Z_r2-3-upload-state-machine`, `apps/web/app/storage/service.ts`,
and `apps/web/app/actions/uploads/controller.tsx` (ADR-0023):
- Dedicated `core.upload` state machine (`quarantined`, `clean`, `infected`, `abandoned`).
- Quarantined files are locked (HTTP 423) outside development until an approved scanner engine
  records a clean verdict via `upload_mark_verdict`.
- Streaming quarantine upload with on-the-fly SHA-256 and byte-limit abort (`putQuarantineStream`).
- Re-promotions verified against scan verdicts in `audit_trail.malware_scan_run`.

### R2.4 — Workflow transitions (atomicity done, business idempotency deferred)

Concurrency correctness and workflow transition atomicity are fully implemented:
- All survey transition RPCs carry a state predicate on the `UPDATE` plus an exactly-one-row
  `row_count` check raising `workflow_conflict` (40001) if another transaction interceded.
- Operations run inside `FOR UPDATE` serial locks with in-transaction audit trail emission.
- Duplicate HTTP retry semantics and state transitions fail safely with `workflow_conflict`.

Business operation idempotency keys (ADR-0024):
- Client-supplied `Idempotency-Key` headers for replay caching remain deferred to ADR-0024.
- Because basic database concurrency correctness is guaranteed by state predicates and row count checks,
  this deferral does not block baseline stability or R9 development.

### R2.5 — Temporal exclusion (done)

Resolved and implemented in migration `20261106T035456Z_r2-temporal-bounds-allow-empty`:
- All four temporal tables (`iam.staff_position`, `iam.role_assignment`, `iam.membership`, `core.org_coverage`)
  enforce explicit `[)` bounds checks and `EXCLUDE USING gist` non-overlapping constraints.
- Empty ranges are permitted for clean deprovisioning.
- Explicit subject-row locks protect concurrent grants and revocations.

### R3 / R4 — typed boundaries, input validation, and HTTP responses (done)

- **R3.1 typed context**: `apps/web/app/actions/context.ts` provides typed accessors (`getAuth`, `requireAuth`, `getPgrst`, `getSession`, `render`, `getRequestId`).
- **R3.2 typed PostgREST contracts**: `@mms/pgrst-client` defines row types, RPC arguments, and return types (`ApiViews`, `ApiRpcs`).
- **R3.3 centralized role metadata**: `api.assignable_roles` RPC in migration `20261107T142942Z_r3-3-assignable-roles`; hardcoded `<option>` lists removed from admin pages.
- **R3.4 stable domain error codes**: `apps/web/app/actions/errors.ts` maps PostgREST/SQL errors to `DomainErrorCode` and HTTP status codes.
- **R4.1 shared validation layer**: `apps/web/app/actions/validation.ts` validates UUIDs, emails, enums, reasons, pagination, and filenames, returning field-level errors without raw `FormDataEntryValue` leakage.
- **R4.2 action response standardization**: RFC 9457 Problem Details (`application/problem+json`) with domain error codes, titles, type URIs, and correlation IDs (`RequestIdKey`). Strict `Cache-Control: no-store` on sensitive paths (`/login`, `/profile`, `/admin/*`, `/break-glass`). Post/Redirect/Get flow with safe preservation of form validation errors.
- **R4.3 request body and upload limits**: Maximum limits configured for JSON (1 MiB) and forms (2 MiB) via `bodyLimits()` middleware. Category upload limits enforced (100 MiB drawings, 25 MiB specifications, 10 MiB default). Direct chunked streaming quarantine upload (`putQuarantineStream`) computes SHA-256 and byte size on the fly, aborting immediately if limits are breached.

### R5 — UI foundation and administration controls (done)

- **R5.1 starter UI removed**: MMS dashboard shell installed; starter links, cards, and `prompt-button.tsx` deleted.
- **R5.2 design system and CSP cleanup**: Converted 364 legacy inline `style=` attributes across `apps/web/app/actions/` to `css()` mixins; removed temporary `'unsafe-inline'` CSP exception.
- **R5.3 replace raw UUID administration**: Replaced raw text inputs in `PositionsPage` with authorized `<select name="unit_id">` (displaying unit code, name, type) and `<select name="job_title_code">` (displaying title, family, grade). Replaced raw inputs in `AssignmentsPage` with authorized `<select name="scope_unit_id">`. Replaced hardcoded revoke reasons with required user-supplied reason inputs (min 5 characters). Position and assignment tables resolve and display organizational unit codes and names instead of raw UUIDs.

### R6 — Authorization Model Consolidation (done)

- **R6.1 published authorization matrix**: `docs/security/authorization-matrix.md` and `docs/adr/0026-authorization-matrix-and-segregation-of-duties.md`. Formally published the 10 authorization dimensions (role, authority, scope type, unit relationship, staff position validity, qualification validity, workflow state, record ownership/assignment, step-up requirement, segregation-of-duties restriction) and 6 architectural archetypes (Station Manager, PAC, MTS, HO Compliance, Sysadmin, External Customer).
- **R6.2 authority decision explanation diagnostics**: Safe internal diagnostic functions `private.explain_authority` and `api.explain_authority` (restricted to authorized roles: compliance, manager, sysadmin, hr, coordinator, surveyor, auditor, finance) explaining allow/deny decisions with non-sensitive reason codes (`ok`, `creator_cannot_approve`, `cannot_confirm_own_proposal`, `cannot_grant_self`, `cannot_revoke_self`, `sysadmin_cannot_approve`, `break_glass_forbidden`, `out_of_scope`, `qualification_required`, `amount_exceeded`, `min_grade_insufficient`, `position_ineligible`, `rule_not_found`, `no_position`). Typed PostgREST contracts added in `@mms/pgrst-client`.
- **R6.3 segregation-of-duties controls**:
  - Creator cannot approve same controlled record where four-eyes review is required: `api.survey_request_accept`, `api.survey_request_request_clarification`, `api.survey_request_reject` enforce `creator_cannot_approve` when `created_by = private.uid()`.
  - Proposer/subject cannot confirm own position proposal: `api.position_proposal_confirm` enforces `cannot_confirm_own_proposal` when `proposed_by = private.uid() or user_id = private.uid()`.
  - Qualification approver cannot self-grant or self-revoke: `api.staff_qualification_grant` enforces `cannot_grant_self`; `api.staff_qualification_revoke` enforces `cannot_revoke_self`.
  - Sysadmin cannot approve regulated business records: `iam.authority_rule_sysadmin_ck` check constraint prevents inserting business approval rules for `int_sysadmin`; `api.position_proposal_confirm`, `api.position_proposal_reject`, `api.staff_qualification_grant`, `api.staff_qualification_revoke` revoke execute from `int_sysadmin`; proposal controller gates restrict confirm/reject to `int_hr`.
  - Break-glass cannot approve/sign/release: `iam.break_glass_forbidden_action` catalog and `private.assert_not_break_glass` reject regulated operations during emergency sessions.

### R7.1 — Process Separation (done)

- Web (`apps/web/server.ts`), worker (`apps/web/worker.ts`), and sealer (`apps/web/sealer.ts`) are split into distinct processes with separate connection pools and roles (`worker`, `audit_sealer`, `web_anon`/user roles).
- Process separation enforced via `assertPlan(runtimePlan())` in `apps/web/app/jobs/runtime.ts`.

### R7.2 — Durable Outbox Leasing & Dead-Letter State Machine (done)

- **ADR-0027 durable outbox leasing**: `docs/adr/0027-durable-outbox-leasing-and-dead-letter.md`.
- **Durable lease and claim semantics**: `core.outbox` table expanded with `leased_by`, `lease_expires_at`, `max_attempts`, `last_error_class`, and `'dead_letter'` status. `private.job_poll` uses `FOR UPDATE SKIP LOCKED` and reclaims expired leases. `private.job_begin` populates worker leases and tracks attempts. `private.job_heartbeat` extends active leases.
- **Retry with exponential backoff & dead-letter escalation**: `private.job_complete` reschedules transient errors to `pending` with exponential backoff (`next_at`), escalating to `'dead_letter'` upon reaching `max_attempts` or on fatal unhandled errors. `apps/web/app/jobs/poller.ts` wires backoff and dead-lettering, running durable polling in background schedulers.

### R7.3 — Productionize Malware Scanning & Quarantine Retention Sweep (done)

- **Hardened TCP ClamAV protocol**: `ClamAvScannerClient` hardened with fail-closed overall timeout watchdog timer, strict regex protocol parsing, prioritized threat evaluation (`FOUND` and `ERROR` prioritized over `OK` to prevent compound or multiline bypasses), immediate resolution of unrecognized delimited messages without timeout lag, and socket timeout guards; unparseable or hung connections fail closed.
- **Scanner metadata**: Engine version, signature version, scan timestamp, and immutable SHA-256 hash recorded in `audit_trail.malware_scan_run` and `core.document_version` across both worker scan and BFF `finalizeUpload` paths.
- **Failure alerting**: Consecutive scanner failure tracking (`SCANNER_FAILURE_ALERT_THRESHOLD = 3`) emitting `MALWARE_SCANNER_FAILURE` (`CRITICAL`) to security alert sinks.
- **Quarantine retention sweep**: `private.quarantine_sweep_expired(interval)` marks expired uploads (`expires_at < clock_timestamp()` or created past retention) as `'abandoned'` using `FOR UPDATE SKIP LOCKED`. `runQuarantineSweep` cleans up storage blobs, reports failed removals in `failedUploads`, and runs in background schedulers (`apps/web/server.ts`, `apps/web/worker.ts`).
- **Tests**: 5 integration tests in `apps/web/app/jobs/r7-3-malware-quarantine.test.ts` and 18 protocol tests in `apps/web/app/storage/scanner.test.ts`.

### R7.4 — Protect Audit and WORM Evidence (done)

- **Automated reconciliation and verification**: Automated schedulers in `apps/web/sealer.ts` (`reconcileScheduler` every 1 hour, `verifyScheduler` every 6 hours).
- **Anomaly detection**: Zero-record anomaly alerting (`ZERO_RECORD_ANOMALY`, `WARNING`) in both `verifyAuditSeals` (when zero seals exist or when seals cover horizons with zero change logs and events) and `reconcileAuditEvents` (when zero records are checked).
- **CLI flags**: `scripts/verify-audit_trail.ts` and `scripts/reconcile-audit_trail.ts` support `--alert` and `--alert-zero-records`.
- **Runbook**: `docs/runbooks/audit-worm.md` documenting seal verification key storage in KMS/HSM, key rotation metadata schema, dual-window verification, gap detection, and anomaly response.
- **Tests**: 4 unit/integration tests in `apps/web/app/audit/r7-4-worm-audit_trail.test.ts`.

### R7.5 — Backup and Restore Operations (done)

- **RPO and RTO runbook**: `docs/runbooks/backup-restore.md` documenting recovery objectives (Primary RPO <= 5 min, WORM Audit RPO = 0, RTO <= 60 min), backup storage topology, and validation drills.
- **Scratch database safety**: `scripts/restore-drill.sh` validates that scratch database cannot match source/production database (using URL-aware parsing to preserve query parameters like `?host=/tmp`) and strictly enforces safe suffixes (`_drill`, `_scratch`, `_restore`).
- **Post-restore invariants**: Post-restore drill executes `npm run db:verify` and `npm run audit_trail:verify` to guarantee cryptographic seal correspondence.

### R8.1 / R8.2 / R8.3 — CI/CD, Supply Chain & Release Migration Gate (done)

- **Release migration gate check**: `scripts/check-release-gate.ts` and `npm run release:check` verify that all 83 historical migrations are locked in `db/migrations.lock.json`, review checklists are completed (no uncompleted checkboxes `- [ ]`), and rollback/forward-fix strategies exist.
- **CI enforcement**: `.github/workflows/ci.yml` updated to execute `npm run release:check` in both `check` and `db` jobs, and `npm run db:verify` in the database pipeline.
- **Supply chain & dependency policy**: Added `.github/dependabot.yml` configuring controlled weekly updates, grouping non-critical dependencies, and strictly preventing auto-merging or floating of critical infrastructure and pinned drivers (`remix`, `@remix-run/*`, `typescript`, `pg`).
- **Tests**: 4 tests in `apps/web/app/r7-5-r8-release-gate.test.ts` and 6 tests in `apps/web/app/version-pins.test.ts`.

### R9 — Maritime Domain Foundation (ADRs proposed; awaiting Gate A–E sign-off)

In strict accordance with `AGENTS.md` and `docs/plans/rectification-implementation-plan.md` §R9, domain coding is gated behind human review of Gates A–E and formal ADR acceptance. Nine ADRs are now formally proposed:
1. **ADR-0028: Canonical Party and Vessel Identity Architecture** (R9.1): IMO check-digit verification algorithm, temporal vessel flag/name/registry history (`fleet.ship_name_history`, `fleet.ship_flag_history`), canonical organization identifiers (IMO Company Number, LEI, Tax ID), comprehensive ship party maritime roles (DOC company, ISM manager, ISPS operator, bareboat charterer, registered owner), and controlled entity merge protocol.
2. **ADR-0029: Operational Survey Job Separation and Deficiency Lifecycle** (R9.2, R9.4): Decoupling customer service requests (`survey.survey_request`) from operational attendance jobs (`survey.survey_job`), specialist assignments (`survey.job_assignment`), physical attendance tracking (`survey.attendance_record`), regulatory deficiency & condition of class lifecycle (`survey.deficiency`) with strict extension/postponement authorization, four-eyes technical review, and milestone billing.
3. **ADR-0030: Competence Authorizations, Controlled Maritime Certificates, and Class Notations** (R9.3, R9.5, R9.6): Surveyor competence catalog and statutory flag delegations (`qual.statutory_authorization`) distinct from generic application roles, execution-time eligibility checking, controlled certificate lifecycle (`cert.certificate_instance`) with prerequisite verification, signing-time authority validation, immutable signed artifacts, and class notation history (`fleet.ship_notation_history`).

### R10 — Final Adversarial Verification (pending R9 implementation)

- R10: The comprehensive adversarial test suite across authorization, authentication, document handling, and operational failure scenarios is the final release gate following R9 domain completion.

## Residual risks of this pass

1. `style-src-attr 'unsafe-inline'` was eliminated in R5.2; CSP nonces protect all emitted `<style>` elements without `'unsafe-inline'` in attributes.
2. `private.is_worker_or_admin()` still allows an `int_sysadmin` JWT claim; that
   is the existing ADR-0018 delegated-admin policy, not a new weakening, but a
   forged `role` claim would pass the internal guard. `private.pre_request()`
   validates claims against the session on the PostgREST path; the guard is
   defence in depth for direct calls only. The same reasoning covers
   `private.assert_not_break_glass`, which trusts the signed `src` claim — in the
   fail-closed direction only, since a forged claim can add denials but never
   remove them.
3. `MMS_TRUSTED_PROXY_HOPS > 0` remains a deployment trust declaration: a
   process reachable directly by clients while hops are configured lets clients
   choose their apparent IP. Documented in the runbook; no code can detect an
   untrusted network path.
4. **Idempotency keys are not implemented** (ADR-0024). The transitions are now
   atomic under concurrency, but a client that retries after a timeout can still
   produce a second successful transition where the state machine allows it.
5. **Scan-verdict authority resolved**: `core.upload` state machine constraint
   `upload_verdict_ck` and `upload_clean_version_ck` strictly enforce that only an
   approved scanner engine (`private.is_approved_scanner`) may settle clean/infected verdicts,
   and clean uploads must reference the created `document_version_id`.
6. `npm ci` initially failed in this environment (registry mirror + root-owned
   npm cache); resolved with `--registry=https://registry.npmjs.org --cache
   /tmp/npm-cache-mms2`. Recorded in the baseline as an environment issue.
7. Toolchain pins are now exact (R8.3), but the local runtime is still Node
   26.12.0 while the declared line is `^24.7.0`, and local PostgREST is 16.4
   while compose pins 16.5. CI uses the declared versions; a developer on the
   local versions is outside the tested matrix.
8. **`db:check` cannot catch a broken PL/pgSQL body.** A function-body typo
   passed every gate except `db:test`. Until that is addressed in the pipeline,
   `db:test` and `db:verify` must be treated as mandatory rather than advisory
   for any schema change.

---

## Production Baseline Freeze & Migration Immutability (`FIRST_PRODUCTION_BASELINE`)

### Milestone Status: NOT_ESTABLISHED (Pre-Production Normalization Complete)
- **Milestone:** `FIRST_PRODUCTION_BASELINE` (ADR-0032)
- **Status:** `NOT_ESTABLISHED`
- **Normalized Baseline Scope:** 84 migrations (`20261030T111331Z_f04-poc` through `20261108T085334Z_r8-5-closure`)
- **Authoritative Preview:** Verified at `docs/review/production-baseline-preview.lock.json` via `npm run db:baseline:verify`.
- **Pre-Production Architecture:** All 84 prototype migrations cleanly target `audit_trail` (technical audit); `audit` is reserved for Company Audit.
- **Formal Freeze Transition:** Production baseline will be established upon approved release via `.github/workflows/baseline-freeze.yml` in protected GitHub Environment `production-release` with required reviewers. That operation is strictly one-way and irreversible: it verifies complete lock coverage, enforces clean working tree, proves annotated tag authenticity, executes scratch database replay, runs full gates, and generates `db/production-baseline.lock.json`. Once established, migrations 1–84 become permanently immutable.

### Rationale & Normalization Decision (2026-11-20)
- **Technical Audit vs. Maritime Company Audit:**
  The schema namespace `audit_trail` is established as the final architectural home for technical change logging, WORM sealing, reconciliation, and event logging. The namespace `audit` is reserved exclusively for the future maritime Company Audit business domain (`audit.programme`, `audit.job`, `audit.assignment`, `audit.report`, `audit.finding`, `audit.corrective_action`).
- **Clean Baseline vs. Fictitious Upgrade Path:**
  Because MMS has never been deployed to production and no deployed environment exists that requires renaming a legacy schema, the artificial forward migration (`20261118T083000Z_r8-6-rename-audit-to-trail`) and its reverse-rename upgrade test were removed.
- All prototype migrations (84 migrations) consistently create and reference `audit_trail` from initial creation.
- Stale AST dumps (`plan/` subdirectories) were removed from all migration directories to eliminate divergence between executable SQL and plan artifacts.
- `db/migrations.lock.json` and `docs/review/production-baseline-preview.lock.json` are locked and verified across empty-database replay, schema drift, pgTAP, and application gates.
