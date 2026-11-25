# MMS Unified Implementation Plan — Part 2: Rectification Roadmap & Release Gates

> **Master Plan:** [MMS Unified Implementation Plan (docs/plans/README.md)](README.md)  
> **Scope:** Phases R0 through R10, Release Gates A through F, Definition of Done, and standard task completion protocols.  
> **Prerequisites:** [Part 1: Target Architecture & Auth Foundation](auth-implementation-plan.md) and [Part 5: Review Baseline (R0)](review-baseline.md).

## 1. Purpose

This document is the authoritative rectification plan for the MMS repository snapshot reviewed in `mms-source-review.txt`.

It is written for execution by coding agents, including agents that require explicit instructions, narrow task boundaries, concrete validation commands, and clear stop conditions.

The plan does not replace the existing domain and security ADRs. Where this plan conflicts with an accepted ADR, the agent must stop and request a human decision instead of silently changing the architecture.

## 2. Target State

MMS will remain an npm-workspaces monorepo with:

- `apps/web` as the only deployable Remix 3.2.0 application.
- PostgreSQL 18 as the authoritative data and authorization layer.
- PostgREST as the application data plane.
- Reviewed, forward-only production migrations generated with `pgschema` and applied by the project migration runner.
- Database-enforced organizational scope, authority, temporal validity, and row-level security.
- Distinct concepts for HR job title, organizational position, application role, operational authority, and surveyor/auditor qualification.
- Transactional audit events, reconciliation, cryptographic sealing, and WORM evidence.
- Quarantine-first document upload and malware scanning.
- Entra ID for internal staff, controlled external identities, MFA, step-up authentication, and audited break-glass access.

The existing architecture must be evolved, not replaced.

## 3. Mandatory Agent Rules

Every agent executing this plan must:

1. Read `AGENTS.md` before changing code.
2. Read `.agents/skills/remix/SKILL.md` before changing Remix code.
3. Read the relevant ADRs, schema files, migration checks, and existing tests before implementation.
4. Use the exact Remix version pinned by `apps/web/package.json` and `package-lock.json`.
5. Inspect installed Remix 3.2.0 documentation before using an unfamiliar Remix API.
6. Make the smallest change that completes the assigned task.
7. Preserve database enforcement. UI or controller checks may supplement database controls but must never replace them.
8. Never equate a job title with an application role or regulated authority.
9. Never give `int_sysadmin` implicit business approval authority.
10. Never give break-glass sessions authority to approve, sign, release, or certify regulated records.
11. Never bypass RLS by using the administrator pool in an ordinary request path.
12. Never add `SECURITY DEFINER` without:
    - `SET search_path = ''`;
    - fully qualified object names;
    - explicit caller authorization;
    - `REVOKE EXECUTE ... FROM PUBLIC`;
    - narrow grants; and
    - adversarial pgTAP tests.
13. Never use `session_user` or `current_user` inside a `SECURITY DEFINER` function to identify the application caller.
14. Never expose raw database errors, SQL, schema names, credentials, token material, or filesystem paths to users.
15. Never hand-edit a merged/locked migration. Create a new migration.
16. Never weaken a test merely to make a task pass.
17. Never introduce a new convention without an ADR proposal and human approval.
18. Run all validation commands assigned to the task.
19. Record any unverified behavior in the task completion report.
20. Stop when a task's stop condition is met.

## 4. Severity and Execution Order

- **P0:** immediate security or integrity risk. Complete before feature work.
- **P1:** release-blocking architecture, authorization, concurrency, or operational defect.
- **P2:** maintainability, UX, observability, and production-hardening work.
- **P3:** future domain expansion.

Execute phases in order. Tasks inside a phase may run in parallel only when their dependencies do not overlap.

## 5. Definition of Done for Every Task

A task is complete only when:

- the implementation is committed in the intended files;
- relevant tests cover successful and rejected paths;
- type checking passes;
- existing tests remain green;
- database migration checks pass when the database changes;
- documentation is updated when runtime behavior or operations change;
- no temporary compatibility path, TODO, disabled test, or debug logging remains; and
- the agent reports changed files, commands run, results, assumptions, and residual risks.

---

# Phase R0: Reproducible Baseline

## R0.1 Record the reviewed baseline

**Priority:** P0  
**Dependencies:** none

### Files

- `README.md`
- `docs/plans/rectification-implementation-plan.md` or this document's final repository location
- Optional new file: `docs/plans/review-baseline.md`

### Steps

1. Record the Git commit SHA being rectified.
2. Record exact versions of Node.js, npm, Remix, TypeScript, PostgreSQL, PostgREST, and `pgschema`.
3. Record required external services and environment variables without storing secrets.
4. Confirm whether the lockfile resolves Remix 3.2.0.
5. Document the supported local-development topology and production topology separately.

### Acceptance criteria

- The baseline can be recreated by another developer from a clean clone.
- The document contains no secret values.

### Stop condition

Stop if the checked-out source differs materially from the reviewed snapshot or if Remix is no longer 3.2.0. Request a re-review of affected tasks.

## R0.2 Execute and preserve baseline evidence

**Priority:** P0  
**Dependencies:** R0.1

### Commands

```sh
node --version
npm --version
npm ci
npm run typecheck
npm test
npm run check:boundary
npm run doctor
npm run db:bootstrap
npm run db:check
npm run db:spike
npm run db:test
```

### Steps

1. Use a fresh PostgreSQL 18 database.
2. Save command output as CI artifacts or a local review record.
3. Classify each failure as environment, pre-existing defect, flaky test, or genuine regression.
4. Do not fix unrelated failures inside this task.

### Acceptance criteria

- A baseline report lists every command and exit status.
- All pre-existing failures have an owner and task reference.

---

# Phase R1: Security-Critical Corrections

## R1.1 Replace unsafe caller-role checks in `SECURITY DEFINER` functions

**Priority:** P0  
**Dependencies:** R0.2

### Primary areas

- `db/src/private/`
- malware scanning functions
- quarantine worker functions
- all `SECURITY DEFINER` functions found by the audit below
- corresponding migrations and pgTAP tests

### Audit commands

```sh
grep -RniE 'security definer|session_user|current_user|current_setting\(.role' db/src db/migrations
npm run db:lint
```

### Steps

1. Inventory every `SECURITY DEFINER` function.
2. For each function, identify the actual caller classes: gateway role, worker, sealer, bootstrap administrator, or human application role.
3. Replace checks based on `session_user`, `current_user`, or ad hoc `current_setting('role')` parsing with the repository's canonical helpers, such as `private.caller_role()` and `private.is_worker()`.
4. If canonical helpers do not cover sealer/bootstrap callers, extend them in one reviewed location instead of duplicating role logic.
5. Ensure every function uses `SET search_path = ''` and fully qualified names.
6. Revoke PUBLIC execute and grant only the minimum roles.
7. Create a new migration. Do not modify locked migrations.
8. Add pgTAP tests for allowed and denied callers.

### Required adversarial tests

- A JWT claim naming `worker` does not make a gateway caller a trusted worker.
- An unrelated internal role cannot call worker-only scan functions.
- `int_sysadmin` succeeds only where explicitly intended.
- Function ownership does not grant application authority.
- Direct invocation without valid claims fails closed.

### Validation

```sh
npm run db:lint
npm run db:check
npm run db:test
npm run db:verify
```

### Acceptance criteria

- No prohibited caller-identity check remains in desired schema.
- The schema lint rejects future regressions.
- Tests prove both positive and negative cases.

## R1.2 Minimize RPC and table grants

**Priority:** P0  
**Dependencies:** R1.1

### Steps

1. Generate an inventory of all grants on `api`, `private`, `iam`, `audit`, `core`, `party`, and `survey` objects.
2. Compare each grant to the real workflow requiring it.
3. Remove EXECUTE grants from roles that are always rejected inside the function.
4. Specifically review document promotion, malware-scan recording, external-user administration, staff positions, role assignments, audit operations, and break-glass functions.
5. Preserve internal function authorization as defense in depth.
6. Add pgTAP tests asserting the final ACLs.

### Acceptance criteria

- Every exposed RPC has an explicit role justification.
- `PUBLIC` has no unintended execute privilege.
- External, viewer, HR, finance, compliance, sysadmin, worker, and sealer surfaces are separately tested.

## R1.3 Implement a complete Content Security Policy

**Priority:** P1  
**Dependencies:** R0.2

### Primary files

- `apps/web/app/middleware/security-headers.ts`
- `apps/web/app/router.ts`
- `apps/web/app/actions/document.tsx`
- `apps/web/app/actions/home-page.tsx`
- related tests

### Steps

1. Read the installed Remix 3.2.0 CSP and content-security-policy documentation.
2. Use the first-party Remix 3.2.0 CSP/header APIs where suitable.
3. Implement request-specific nonces for executable scripts and styles when required.
4. Set, at minimum:
   - `default-src 'self'`;
   - restrictive `script-src`;
   - restrictive `style-src`;
   - `img-src` limited to required origins and data/blob only if justified;
   - `font-src` limited to required origins;
   - `connect-src` for the BFF's actual browser connections;
   - `object-src 'none'`;
   - `base-uri 'self'`;
   - `form-action 'self'`;
   - `frame-ancestors 'none'`;
   - `upgrade-insecure-requests` in production if deployment supports it.
5. Remove Google Fonts from the starter page or self-host approved fonts. Prefer system fonts for the first MMS shell.
6. Retain HSTS only when the request is known to be HTTPS through the trusted proxy configuration.
7. Add tests proving nonce presence, header presence, and no unsafe wildcard/default fallback.

### Acceptance criteria

- Application pages work with CSP enabled without browser console violations.
- No `unsafe-eval` is used.
- `unsafe-inline` is absent unless a documented Remix limitation requires a temporary exception approved by security review.

## R1.4 Verify trusted-proxy and client-IP handling

**Priority:** P1  
**Dependencies:** R0.2

### Primary files

- request-context middleware
- authentication throttling
- session creation
- audit metadata
- deployment documentation

### Steps

1. Document which reverse proxy sets `Forwarded` or `X-Forwarded-For`.
2. Ensure forwarded headers are trusted only when the immediate peer is an approved proxy or the configured hop count is correct.
3. Do not accept client-supplied `X-Client-Ip` as authoritative at the public boundary.
4. Ensure login throttling cannot be bypassed by forging headers.
5. Ensure all tests that inject forwarded addresses explicitly configure trusted-proxy behavior.

### Required tests

- Direct untrusted request with forged forwarding headers.
- Single trusted proxy.
- Multiple proxies with configured hop count.
- Malformed and oversized forwarding headers.

## R1.5 Harden OAuth, return paths, and identity-link intents

**Priority:** P1  
**Dependencies:** R0.2

### Steps

1. Verify state, nonce, issuer, audience, tenant, subject, and PKCE behavior against installed Remix auth APIs.
2. Ensure `safeReturnTo` permits only same-application relative paths.
3. Bind link and step-up intents to session ID, user ID, provider, purpose, creation time, expiry, and a single-use identifier.
4. Rotate the session ID after login, linking, step-up, role change, break-glass activation, and password reset.
5. Ensure an Entra email address alone never links or authenticates an account.
6. Add replay, expired-intent, provider-confusion, tenant-confusion, and cross-user tests.

## R1.6 Revalidate break-glass restrictions

**Priority:** P1  
**Dependencies:** R1.1, R1.2

### Steps

1. Create an explicit matrix of operations forbidden to break-glass authority.
2. Enforce prohibitions in database authority functions, not only UI/controllers.
3. Prohibit regulated approvals, certificate/report signing, survey conclusion, audit conclusion, qualification approval, financial approval, and HR decisions.
4. Confirm activation has a maximum four-hour database-enforced validity.
5. Ensure deactivation and expiry revoke all active sessions and tokens.
6. Ensure alerts are written transactionally to the outbox.
7. Ensure a failed alert transport is retried and operationally visible.
8. Add a quarterly drill workflow and evidence record.

### Acceptance criteria

- Break glass can restore platform administration.
- Break glass cannot exercise business authority.
- Expired windows fail closed even with an old session cookie.

---

# Phase R2: Database Concurrency and Integrity

## R2.1 Make logical documents unique

**Priority:** P1  
**Dependencies:** R1 complete

### Target invariant

One logical document exists for each:

```text
(entity_type, entity_id, doc_type)
```

### Steps

1. Confirm whether duplicates already exist in test/fixture data.
2. Define a unique constraint or unique index for the logical identity.
3. Decide how titles behave across revisions. The document title belongs to the logical document; filenames and MIME data belong to versions.
4. Change document creation to use an atomic insert/upsert pattern.
5. Handle a concurrent insert without returning an internal error.
6. Add a migration and backfill/duplicate-resolution procedure if needed.

### Required tests

- Two concurrent first uploads create one document.
- Distinct `doc_type` values create distinct documents.
- A title update does not create a duplicate logical document.

## R2.2 Serialize document revision allocation

**Priority:** P1  
**Dependencies:** R2.1

### Target invariant

```text
UNIQUE(document_id, revision_no)
```

### Steps

1. Add/confirm the unique constraint.
2. Lock the logical `core.document` row before calculating the next revision.
3. Calculate `max(revision_no) + 1` only while holding that lock, or replace it with an equally safe per-document counter.
4. Keep the version insert and audit event in one transaction.
5. Return a deterministic conflict if an impossible duplicate reaches the unique constraint.

### Required concurrency test

Use two independent PostgreSQL connections and barriers so both transactions attempt revision creation concurrently. Assert revisions are distinct and sequential and neither file overwrites the other.

## R2.3 Protect storage/database consistency

**Priority:** P1  
**Dependencies:** R2.1, R2.2

### Steps

1. Model upload states explicitly, for example prepared, uploaded, pending scan, clean, infected, error, abandoned.
2. Ensure finalization is idempotent by upload ID.
3. Persist the expected quarantine path server-side. Do not accept the client path as authority.
4. Bind upload token to upload ID, safe filename, entity, document type, expiry, maximum size, and intended content constraints.
5. Add cleanup for expired/abandoned quarantine objects.
6. Ensure database success plus storage failure, and storage success plus database failure, are recoverable through a reconciliation job.
7. Never mark a file clean merely because it was moved.
8. Promotion must require a recorded clean scan by an approved scanner identity.

### Required tests

- Repeated finalize request is idempotent.
- Replayed upload token after completion is rejected.
- Concurrent finalize calls create one version.
- Scanner failure leaves the object quarantined.
- Database rollback does not expose promoted content.

## R2.4 Enforce workflow transitions atomically

**Priority:** P1  
**Dependencies:** R1 complete

### Scope

- survey request state changes
- transfer
- clarification
- acceptance/rejection
- future survey/audit/certificate state machines

### Steps

1. Lock the workflow row in each transition RPC.
2. Validate expected current state after locking.
3. Update using a state predicate and verify exactly one row changed.
4. Emit the audit event in the same transaction.
5. Add idempotency keys where external retries are expected.
6. Return stable domain error codes rather than human message parsing.

### Required tests

- Concurrent accept and reject.
- Transfer racing with accept.
- Duplicate submission.
- Retry after network timeout.
- Unauthorized transition with a valid row ID.

## R2.5 Revalidate temporal exclusion constraints

**Priority:** P1  
**Dependencies:** R0.2

### Scope

- staff position validity
- role assignment validity
- organization membership
- operational coverage
- qualifications and authorizations when introduced

### Steps

1. Ensure ranges use a consistent `[)` convention.
2. Add exclusion constraints preventing overlapping active records where overlap is invalid.
3. Lock the subject record before closing and opening periods.
4. Test backdated, future-dated, same-instant, and daylight-saving-independent timestamps.
5. Store all timestamps as `timestamptz` and display in user locale only at the presentation layer.

---

# Phase R3: Type-Safe Application Boundaries

## R3.1 Type the Remix application context

**Priority:** P1  
**Dependencies:** R1 complete

### Steps

1. Inspect Remix 3.2.0 router and render middleware types.
2. Define typed context keys for authentication, PostgREST client, request metadata, and renderer/session access.
3. Remove avoidable `(context as any)` and `context.get(...) as any` casts.
4. Do not introduce a large wrapper framework. Follow Remix's existing context model.
5. Add compile-time tests or type assertions for controller usage.

### Acceptance criteria

- Controllers do not use `any` for routine context access.
- A missing middleware-provided dependency is a type error or a controlled runtime error.

## R3.2 Create typed PostgREST contracts

**Priority:** P1  
**Dependencies:** R3.1

### Primary package

- `packages/pgrst-client`

### Steps

1. Define explicit row/result types for each API view and RPC used by the web app.
2. Define exact argument types for RPCs.
3. Add a typed mapping between function name and argument/result type.
4. Change `rpc` and `select` calls in controllers to use the mapping.
5. Keep runtime validation at trust boundaries. TypeScript types alone are not input validation.
6. Add tests for error parsing, empty responses, non-JSON errors, abort signals, and malformed successful responses if runtime schemas are used.

## R3.3 Centralize role and authority metadata

**Priority:** P1  
**Dependencies:** R3.2

### Steps

1. Make the database API the authoritative source of assignable roles and role descriptions.
2. Remove hardcoded role `<option>` lists from admin pages.
3. Return only roles the current administrator may grant.
4. Keep these distinct:
   - HR job title;
   - job family;
   - organization position;
   - database/application role;
   - authority code;
   - qualification/authorization.
5. Add tests proving a title or grade does not itself grant a regulated authority.

## R3.4 Replace message-string error decisions with stable codes

**Priority:** P1  
**Dependencies:** R3.2

### Steps

1. Define domain error codes and SQLSTATE conventions.
2. Ensure database functions raise stable machine-readable codes.
3. Preserve safe user-facing fallback messages.
4. Log error correlation IDs, not secrets or raw tokens.
5. Remove authorization decisions based on substring matching where a code can be supplied.
6. Add controller tests for 400, 401, 403, 404, 409, and 500 mapping.

---

# Phase R4: Input Validation and HTTP Correctness

## R4.1 Add a shared validation layer

**Priority:** P1  
**Dependencies:** R3.2

### Required validators

- UUID
- email normalization
- non-empty reason with domain-specific length limits
- timestamps and date ranges
- enum values
- pagination limits
- organization/unit identifiers
- filenames and document types
- role and scope combinations
- upload sizes and expiry windows

### Steps

1. Use one small validation library or project-local typed validators. Do not create a second framework.
2. Validate form and JSON bodies before RPC calls.
3. Reject unknown fields for sensitive actions where feasible.
4. Clamp pagination and expiry values.
5. Return field-level validation errors without echoing unsafe input.
6. Keep database checks as final authority.

### Acceptance criteria

- No sensitive RPC receives unvalidated raw `FormDataEntryValue`.
- File values cannot accidentally flow into text RPC arguments.

## R4.2 Standardize action responses

**Priority:** P2  
**Dependencies:** R4.1

### Steps

1. Define when an endpoint returns HTML, JSON, redirect, or problem details.
2. Use correct status codes.
3. Apply `Cache-Control: no-store` to authentication, profile, admin, and sensitive pages.
4. Ensure post/redirect/get for successful HTML forms.
5. Preserve validation values safely on failure.
6. Attach/request a correlation ID for logs and support diagnostics.

## R4.3 Add request-body and upload limits

**Priority:** P1  
**Dependencies:** R4.1

### Steps

1. Configure maximum ordinary form/JSON body sizes.
2. Configure maximum upload size per allowed document category.
3. Reject oversized uploads before buffering the entire body when supported.
4. Do not use an in-memory `arrayBuffer()` path for production-scale documents without a documented maximum.
5. Stream quarantine uploads to approved storage in production.
6. Record byte count and cryptographic hash while streaming.

### Stop condition

Stop if the selected Remix/storage adapter cannot stream safely. Propose an ADR comparing Azure Blob direct upload, BFF streaming, and signed upload approaches.

---

# Phase R5: UI Foundation

## R5.1 Remove the Remix starter surface

**Priority:** P2  
**Dependencies:** R1.3

### Primary files

- `apps/web/app/actions/home-page.tsx`
- `apps/web/app/actions/document.tsx`
- starter public components/assets

### Steps

1. Remove Remix/Shopify marketing links, Discord links, AI coding prompts, and starter copyright.
2. Replace the page with an MMS dashboard shell.
3. Display only navigation authorized for the active role.
4. Do not expose raw role codes as the primary user-facing labels.
5. Preserve a small server-rendered, progressively enhanced implementation.

## R5.2 Establish the MMS design system

**Priority:** P2  
**Dependencies:** R5.1

### Components

- page shell
- primary navigation
- breadcrumbs
- headings and sections
- form fields and validation summaries
- buttons and destructive confirmations
- status badges
- tables with pagination and empty states
- alerts and notifications
- accessible modal/dialog only when necessary

### Requirements

- WCAG 2.2 AA target.
- Keyboard-accessible workflows.
- Visible focus.
- Correct labels and error association.
- Responsive layout down to 320 CSS px.
- Light/dark support only if it does not delay core workflows.
- No dependence on color alone.

## R5.3 Replace raw UUID administration

**Priority:** P2  
**Dependencies:** R3.3, R5.2

### Steps

1. Replace unit UUID inputs with authorized unit lookup/select controls.
2. Replace role code entry with database-provided grantable roles.
3. Show unit code, name, type, locality, and relevant hierarchy.
4. Show the exact resulting scope before confirmation.
5. Require a reason for grants, revocations, position changes, transfers, and re-invitations.
6. Do not hardcode a revoke reason in a hidden field.

---

# Phase R6: Authorization Model Consolidation

## R6.1 Publish the authorization matrix

**Priority:** P1  
**Dependencies:** R3.3

### Required dimensions

- role
- authority
- organizational scope type
- organizational unit/resource relationship
- staff position validity
- qualification validity
- workflow state
- record ownership/assignment
- step-up requirement
- segregation-of-duties restriction

### Required organizational cases

- station manager: own office surveyors and auditors
- centralized Plan Approval Centre: assigned/global plan-approval scope
- centralized MTS: one or multiple configured regions/areas
- HO Compliance: worldwide oversight without implicit operational approval
- sysadmin: platform administration without HR or regulated approval authority
- external customer: authorized organizations and their records only

## R6.2 Add authority-decision explanation

**Priority:** P2  
**Dependencies:** R6.1

### Steps

1. Implement a safe internal diagnostic that explains an allow/deny decision using non-sensitive reason codes.
2. Restrict detailed diagnostics to authorized support/compliance roles.
3. Do not reveal hidden records to a caller through denial details.
4. Use the diagnostic in tests and support tooling, not as a bypass.

## R6.3 Create segregation-of-duties controls

**Priority:** P1  
**Dependencies:** R6.1

### Minimum controls

- creator cannot approve the same controlled record where four-eyes review is required;
- sysadmin cannot approve regulated business records by virtue of sysadmin role;
- HR position administration does not grant survey/audit authority;
- qualification approver cannot self-approve;
- break-glass cannot approve/sign/release;
- certificate issuer and cancellation/revocation roles are explicitly controlled.

### Required tests

Add one positive and at least two negative tests per controlled workflow.

---

# Phase R7: Operational Services and Resilience

## R7.1 Separate runtime roles cleanly

**Priority:** P1  
**Dependencies:** R1 complete

### Runtime processes

- web/BFF
- background worker
- audit sealer
- scheduled jobs

### Steps

1. Production web processes must not automatically start all schedulers.
2. Each process uses a distinct database login with minimum privileges.
3. Each process exposes health/readiness signals suitable for its responsibility.
4. Prevent duplicate job execution with database advisory locks or a durable leasing mechanism.
5. Define graceful shutdown and in-flight job behavior.

## R7.2 Harden the outbox

**Priority:** P1  
**Dependencies:** R7.1

### Steps

1. Use durable claim/lease semantics with `FOR UPDATE SKIP LOCKED` or equivalent.
2. Track attempt count, next-attempt time, last error class, and dead-letter state.
3. Redact secrets and invitation/reset tokens from logs.
4. Ensure tokens in outbox payloads are encrypted or otherwise protected according to the deployment threat model.
5. Add idempotency keys for external side effects.
6. Add operational metrics and alerts for queue age and dead letters.

## R7.3 Productionize malware scanning

**Priority:** P1  
**Dependencies:** R1.1, R2.3, R7.1

### Steps

1. Select and document the production scanner, such as Microsoft Defender for Storage or a managed ClamAV service.
2. Record engine name, signature version, scan time, outcome, and immutable file hash.
3. Deny download while pending, infected, or error unless a narrowly authorized forensic workflow exists.
4. Define retry and timeout policy.
5. Define quarantine retention and deletion policy.
6. Alert on infected documents and repeated scanner errors.

## R7.4 Protect audit and WORM evidence

**Priority:** P1  
**Dependencies:** R7.1

### Steps

1. Use storage with real immutability/retention controls in production.
2. Separate sealer credentials from web and worker credentials.
3. Store seal verification keys and rotation metadata in an approved secret/key service.
4. Schedule reconciliation and verification jobs.
5. Alert on gaps, hash mismatch, WORM write failure, or zero-record anomaly.
6. Document residual risks, including privileged database host compromise.

## R7.5 Backup and restore operations

**Priority:** P1  
**Dependencies:** R7.4

### Steps

1. Define RPO and RTO with the product owner.
2. Schedule encrypted backups and point-in-time recovery where supported.
3. Run restore drills on a defined cadence.
4. Verify database invariants and WORM/seal correspondence after restore.
5. Store drill evidence and remediation actions.
6. Ensure the scratch database name and target are validated before destructive commands.

---

# Phase R8: CI/CD and Supply Chain

## R8.1 Strengthen CI gates

**Priority:** P1  
**Dependencies:** R1-R4

### Required jobs

1. dependency install using `npm ci`;
2. type checking;
3. unit/integration tests;
4. browser/server boundary check;
5. Remix doctor;
6. fresh-database bootstrap and migration;
7. schema lint and drift checks;
8. pgTAP security/invariant tests;
9. migration round-trip checks where applicable;
10. secret scanning;
11. dependency vulnerability review;
12. generated artifact/provenance capture.

### Steps

1. Pin GitHub Actions by immutable commit SHA where organizational policy requires it.
2. Verify downloaded `pgschema` checksums from a trusted pinned source.
3. Avoid long-lived cloud credentials; use workload identity/OIDC.
4. Prevent pull requests from receiving production secrets.
5. Upload test and migration reports as artifacts.

## R8.2 Add migration deployment gates

**Priority:** P1  
**Dependencies:** R2 complete

### Steps

1. Require review for grants, RLS, policies, `SECURITY DEFINER`, auth, signer, audit, and destructive changes.
2. Ensure every migration has review metadata completed, not blank checkboxes.
3. Detect unlocked or edited historical migrations.
4. Test upgrading from the last released database, not only bootstrapping a fresh database.
5. Require an explicit rollback/forward-fix note for each release migration.
6. Back up before high-risk production migrations.

## R8.3 Pin toolchain versions consistently

**Priority:** P2  
**Dependencies:** R0.2

### Steps

1. Replace `typescript: latest` in workspace packages with the repository-approved exact version.
2. Align Node versions across `engines`, CI, local tooling, and deployment.
3. Keep Remix pinned exactly per ADR.
4. Add Renovate or Dependabot with controlled update groups and required tests.
5. Do not auto-merge runtime/framework/database driver updates.

---

# Phase R9: Maritime Domain Foundation

Do not start this phase until R1-R8 release gates are green.

## R9.1 Establish canonical party and vessel identity

**Priority:** P3

### Model

- organization/company
- organization identifiers
- company relationships and memberships
- vessel
- IMO number and other identifiers
- flag and registry history
- owner, manager, DOC company, ISM/ISPS relationships with temporal validity

### Requirements

- IMO number uniqueness and validation where applicable.
- Temporal history, not destructive replacement.
- Source/provenance for authoritative data.
- Merge/duplicate handling with audit evidence.

## R9.2 Establish survey/audit service request and job separation

### Distinguish

- customer request
- triage/acceptance
- office routing
- survey/audit job
- assignment
- attendance/work execution
- findings/deficiencies
- review
- approval/release
- billing event

Do not overload `survey_request` to become the operational job, report, or certificate.

## R9.3 Model qualifications and authorizations

### Required distinctions

- employee/contractor identity
- job title
- competence/qualification record
- authority scope
- ship type/product/service scope
- flag/statutory authorization
- class authorization
- geographic/office assignment
- validity period
- suspension/revocation
- evidence and approver

### Rule

A role such as `int_surveyor` permits access to surveyor functions but does not prove the holder is authorized for a specific survey, ship type, flag, notation, or certificate.

## R9.4 Model deficiencies and conditions

Support at least:

- finding/deficiency type
- source survey/audit
- regulatory/class reference
- severity
- due date
- postponement/extension authority
- corrective evidence
- verification
- closure
- history and audit

## R9.5 Model certificates as controlled records

### Separate

- certificate template/type
- certificate instance
- scope and subject
- issue basis
- issue date
- expiry date
- endorsements
- extensions
- suspensions
- withdrawals/cancellations
- replacement/reissue
- digital signature/seal
- public verification data

### Critical controls

- certificate issuance requires satisfied prerequisites;
- signatory authorization is checked at signing time;
- class/statutory linkage is represented explicitly, not inferred from UI;
- out-of-window or exceptional extensions require recorded legal basis, authority, reason, evidence, and expiry;
- amendments never erase the previous issued artifact.

## R9.6 Model class notation and status history

- notation catalog and version
- assigned notation
- effective/suspended/withdrawn periods
- prerequisites
- related survey/certificate decision
- public and internal status views

## R9.7 Add plan approval, MTS, suppliers, material/components, and newbuilding as separate bounded modules

Each module must receive its own ADR/domain model before implementation. Shared concepts should be reused only when semantics genuinely match.

---

# Phase R10: Final Adversarial Verification

## R10.1 Authorization scenarios

Automate at least the following:

1. Shanghai surveyor attempts to access another station's record.
2. Station manager attempts to mutate another station's job.
3. Station manager can oversee surveyors and auditors in the manager's own office.
4. Central Plan Approval Centre user accesses only assigned/authorized plans.
5. MTS engineer accesses configured regional or multi-region scope only.
6. HO Compliance reads worldwide oversight data without operational approval authority.
7. Sysadmin attempts to read HR-only grade/manager data.
8. External customer attempts another organization's vessel/request/document.
9. User activates one role and tries to use scope from an inactive role.
10. Expired assignment, membership, position, coverage, qualification, and authority are denied.
11. Surveyor attempts work outside qualification scope.
12. Creator attempts four-eyes approval.
13. Break-glass attempts certificate/report approval or signing.
14. Forged JWT role/organization/scope claim.
15. Direct PostgREST call bypassing the web UI.

## R10.2 Authentication scenarios

- OAuth state/nonce replay
- wrong Entra tenant
- unlinked external identity with matching email
- password-only external session before MFA
- TOTP replay within configured policy
- expired invitation/reset token
- concurrent reset requests
- role change during live session
- account disablement during live session
- session fixation attempt
- forged forwarded IP

## R10.3 Document scenarios

- forged quarantine path
- upload token replay
- oversized upload
- extension/MIME mismatch
- malformed PDF/archive bomb according to allowed file policy
- infected file
- scanner unavailable
- concurrent first upload
- concurrent revision
- download before clean scan
- cross-organization download
- deleted/expired storage object reconciliation

## R10.4 Operational scenarios

- worker crash after claiming an outbox item
- duplicate worker instances
- sealer WORM write failure
- audit gap detected
- database failover/restart
- expired signing key configuration
- key rotation with overlapping JWKS
- restore from backup with WORM verification
- unavailable PostgREST
- unavailable Entra/Google provider

---

# Release Gates

## Gate A: Security foundation

Required before feature expansion:

- R1 complete
- no unsafe `SECURITY DEFINER` caller checks
- least-privilege grants verified
- CSP active
- trusted-proxy handling tested
- OAuth/linking and break-glass tests green

## Gate B: Data integrity

Required before production data:

- R2 complete
- concurrency tests green
- idempotent uploads/transitions
- migration upgrade path tested

## Gate C: Maintainable application boundary

Required before adding many controllers:

- R3 and R4 complete
- routine controller `any` removed
- typed RPC contracts
- shared validation and stable error mapping

## Gate D: Usable product shell

Required before user acceptance testing:

- R5 complete
- starter UI removed
- accessible MMS shell
- no raw UUID administration for ordinary workflows

## Gate E: Production readiness

Required before production deployment:

- R7 and R8 complete
- monitored runtime separation
- durable outbox
- production malware scanning
- immutable audit evidence
- backup/restore drill
- release migration gate

## Gate F: Maritime controlled-record readiness

Required before issuing real certificates or reports:

- R9 domain models approved
- qualification and signatory authority enforced
- four-eyes controls implemented
- certificate lifecycle and immutable issued artifacts implemented
- R10 adversarial suite green
- legal/compliance review completed

---

# Standard Task Completion Report

Every coding agent must finish with:

```text
Task:
Commit/branch:
Files changed:
Migrations added:
Tests added or changed:
Commands run and results:
Security/authorization impact:
Data migration impact:
Assumptions:
Unverified items:
Residual risks:
Follow-up task IDs:
```

# Final Instruction to Agents

Do not optimize for the largest amount of code produced. Optimize for preserving MMS invariants, least privilege, traceability, reviewability, and safe forward evolution. When a requirement is ambiguous, do not invent maritime business rules. Record the decision needed, propose an ADR, and stop at the smallest safe boundary.
