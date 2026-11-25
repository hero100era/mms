# MMS Unified Implementation Plan: Architecture, Rectification & Domain Delivery

This document is the **Unified Implementation Plan** for the Maritime Management System (MMS). It integrates the foundational architecture and auth delivery stream, the codebase review baseline, the security and data integrity rectification roadmap, the native local acceptance test environment, and the maritime domain foundation into a single, cohesive reference and traceability framework.

---

## 1. Structure of the Unified Plan

The unified plan is organized into modular parts, each maintaining detailed specifications while rolling up into this master roadmap:

```
docs/plans/
├── README.md                              # This document: Master roadmap, lifecycle & traceability matrix
├── auth-implementation-plan.md            # Part 1: Target architecture & auth foundation (Cards F-, O-, A-, I-, S-, H-)
├── rectification-implementation-plan.md   # Part 2: Rectification roadmap & release gates (Phases R0–R10, Gates A–F)
├── r8-6-implementation-plan.md            # Part 3: Native local acceptance test environment (Phase R8.6)
├── rectification-decisions.md             # Part 4: Execution tracking, decision register & stop conditions
└── review-baseline.md                     # Part 5: Phase R0 baseline snapshot & toolchain version evidence
```

### Plan Components

1. **[Part 1: Target Architecture & Auth Foundation](auth-implementation-plan.md)**
   - **Target Architecture (§1–§11):** Bounded schema model (`core`, `iam`, `auth`, `audit`, `party`, `fleet`, `survey`), database conventions, narrow-waist Remix 3 BFF, PostgREST data plane, tiered audit (transactional + WORM), and declarative `pgschema` migrations.
   - **Foundational Delivery Stream (§12):** 19 critical-path cards across Foundation (`F-01`–`F-04`), Organization (`O-01`–`O-04`), Authority (`A-01`–`A-04`), Identity & Sessions (`I-01`–`I-10`), and Survey Request Walking Skeleton (`S-01`–`S-04`), backed by a 16-card Hardening Backlog (`H-01`–`H-16`).

2. **[Part 2: Rectification Roadmap & Release Gates](rectification-implementation-plan.md)**
   - **Rectification Roadmap:** Authoritative plan derived from the comprehensive code review (`mms-source-review.txt`), structuring technical corrections into forward-only, test-driven phases:
     - **Phase R0:** Reproducible baseline and snapshot evidence.
     - **Phase R1:** Security-critical corrections (definer guards, grant minimization, CSP, trusted proxies, OAuth bindings, break-glass forbidden matrix).
     - **Phase R2:** Database concurrency and integrity (document uniqueness, revision allocation, upload state machine, atomic workflow transitions, temporal exclusion).
     - **Phase R3:** Type-safe application boundaries (Remix context, PostgREST contract typing, role/authority metadata, stable domain error codes).
     - **Phase R4:** Input validation and HTTP correctness (shared validation, standardized responses, streaming body limits).
     - **Phase R5:** UI foundation & design system (MMS dashboard shell, WCAG 2.2 AA design system, UUID administration replacement).
     - **Phase R6:** Authorization model consolidation (10-dimensional authorization matrix, diagnostic decision explanation, segregation of duties).
     - **Phase R7:** Operational services and resilience (runtime role separation, durable outbox leasing, production malware quarantine sweep, WORM audit verification, backup/restore drills).
     - **Phase R8:** CI/CD and supply chain (CI gates, migration gates, strict version pinning).
     - **Phase R9:** Maritime domain foundation (canonical party/vessel identity, survey job separation, surveyor qualifications, controlled certificates, class notations).
     - **Phase R10:** Final adversarial acceptance verification across all security and operational dimensions.
   - **Release Gates:** Six sequential gating milestones (**Gate A** through **Gate F**).

3. **[Part 3: Native Local Acceptance Test Environment](r8-6-implementation-plan.md)**
   - **Phase R8.6 Specification:** Comprehensive 44-section blueprint establishing a canonical local test environment using native PostgreSQL 18.6 and native PostgREST 16.5 without requiring Docker or container runtimes.
   - **Acceptance Harness:** Deterministic database reset (`npm run testenv:reset`), synthetic organization and vessel fixtures, development-only persona logins (`dev-login`), dedicated background worker and audit sealer runner scripts, and Feature Acceptance Cards.

4. **[Part 4: Execution Status & Decision Register](rectification-decisions.md)**
   - **Real-Time Execution Log:** Current delivery status for each task across Phases R0 through R8.6.
   - **Decision Register:** Formal dispositions for architectural questions (Q1–Q18) and ADR approvals.
   - **Governance & Stop Conditions:** Production release blockers and criteria required before Phase R9 domain development commences.

5. **[Part 5: Review Baseline & Evidence](review-baseline.md)**
   - **Evidence Ledger:** Byte-for-byte verification of 484 snapshot files against the reviewed git commit, establishing the clean baseline for Phase R0.
   - **Toolchain Pins:** Runtime verification of Node.js, Remix 3.3.0, PostgreSQL 18.6, PostgREST 16.5, and pgschema 1.14.1.

---

## 2. Master Delivery & Rectification Lifecycle

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Architectural Foundation & Authentication Delivery                      │
│ - Target schema boundaries & security definers (§1-§11)                          │
│ - Foundation (F), Organization (O), Authority (A), Identity (I) Cards            │
│ - Survey Request Walking Skeleton (SLICE-01 / Cards S-01..S-04)                  │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ STAGE 2: Baseline Review & Reproducibility (Phase R0)                            │
│ - Snapshot match verification (484/484 files identical)                          │
│ - Toolchain version locking & CI validation                                     │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ STAGE 3: Core Rectification & Release Gates (Phases R1–R8)                       │
│ - Gate A (Security Foundation): Caller checks, minimal grants, CSP, break-glass   │
│ - Gate B (Data Integrity): Document uniqueness, revision lock, workflow atomicity │
│ - Gate C (App Boundary): Typed context, typed PostgREST, domain error codes      │
│ - Gate D (UI Shell): MMS dashboard shell, WCAG AA design system, admin controls  │
│ - Gate E (Operational Resilience): Role separation, outbox leasing, WORM audit    │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ STAGE 4: Native Local Acceptance Test Environment (Phase R8.6)                   │
│ - Native PostgreSQL 18.6 + native PostgREST 16.5 cluster setup & reset           │
│ - Deterministic synthetic fixtures & dev persona authentication                  │
│ - Separate native worker & sealer execution daemons                              │
│ - Product-owner acceptance cards & E2E verification                              │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ STAGE 5: Maritime Domain Foundation & Final Adversarial Gate (Phases R9–R10)     │
│ - Gate F (Domain Readiness): ADRs 0028, 0029, 0030 sign-off                      │
│ - Canonical vessel/party identity, survey jobs, surveyor qualifications, certs   │
│ - Comprehensive adversarial verification across all authorization dimensions     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Master Traceability Matrix

This matrix maps requirements, original cards, rectification tasks, governing ADRs, code artifacts, test suites, and current status.

| Task / Card ID | Phase / Stream | Description / Scope | Governing ADRs & Standards | Primary Code & Schema Artifacts | Verification & Test Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **F-01..F-04** | Foundation | Monorepo setup, Remix 3 pin, pgschema spike, bootstrap roles | ADR-0001, ADR-0002, ADR-0010 | `package.json`, `apps/web/`, `db/bootstrap/` | `npm run check`, `npm run db:spike` | **Done** |
| **I-01..I-04** | Identity Core | IAM schema, `auth` definer functions, JWT signer, BFF session storage | ADR-0004, ADR-0005, ADR-0006 | `db/src/iam/`, `db/src/auth/`, `apps/web/app/auth/` | `db/tests/iam.sql`, `db/tests/auth.sql` | **Done** |
| **I-05..I-07** | Auth Flows | Microsoft Entra login, positions & authority rules, external user provisioning | ADR-0008, ADR-0009 | `apps/web/app/auth/entra.ts`, `api.staff_position_set` | `db/tests/authority.sql`, `db/tests/external_auth.sql` | **Done** |
| **I-08..I-10** | External Auth & RLS | OAuth linking, password reset/logout, 79-rule IAM RLS matrix | ADR-0009, ADR-0018 | `auth.link_identity`, `db/tests/rls_matrix.csv` | `db/tests/rls_matrix.sql`, `oauth.test.ts` | **Done** |
| **A-02..A-03** | Audit Foundation | Regulated functions, authority snapshots, compliance control matrix | IMO RO Code, IACS PR17, ADR-0007 | `audit_trail.event`, `private.emit_event`, `docs/compliance/` | `db/tests/completeness.sql` | **Done** |
| **S-01..S-04** | SLICE-01 | Survey request lifecycle: draft, submit, station triage, transfer, upload SAS | ADR-0008, ADR-0023, `docs/domain/` | `survey.survey_request`, `apps/web/app/actions/survey/` | `db/tests/survey_request.sql`, `survey.test.ts` | **Done** |
| **R0.1..R0.2** | Phase R0 | Review baseline snapshot match (484 files) & toolchain pin verification | `review-baseline.md` | `docs/plans/review-baseline.md`, `.tool-versions` | All test commands exit 0 | **Done** |
| **R1.1** | Phase R1 (Gate A) | Consolidated `private.caller_role()`, closed NULL-claim fail-open, removed caller `emit_event` | ADR-0017 | `db/src/private/main.sql` | `db/tests/rectification_r1_1.sql` (5 adversarial cases) | **Done** |
| **R1.2** | Phase R1 (Gate A) | Revoked 9 overbroad EXECUTE grants from capability roles | ADR-0011 | `db/src/api/main.sql` | `db/tests/rectification_r1_r2.sql` | **Done** |
| **R1.3** | Phase R1 (Gate A) | Strict nonce-based CSP, 10 required directives, Google Fonts removed | ADR-0025 | `apps/web/app/middleware/security-headers.ts` | `security-headers.test.ts` (6 tests) | **Done** |
| **R1.4** | Phase R1 (Gate A) | Trusted proxy parsing, hop count caps, ignore untrusted `Forwarded` | `docs/runbooks/request-context.md` | `apps/web/app/middleware/request-context.ts` | `request-context.test.ts` (7 tests) | **Done** |
| **R1.5** | Phase R1 (Gate A) | Safe return-to URLs, Entra tenant-issuer binding, single-use link intents | ADR-0004 | `apps/web/app/auth/entra.ts`, `apps/web/app/actions/utils.ts` | `oauth.test.ts` | **Done** |
| **R1.6 / H-10** | Phase R1 (Gate A) | Break-glass forbidden operations matrix, mandatory reason & drill recording | ADR-0020, ADR-0022, `docs/runbooks/break-glass.md` | `iam.break_glass_forbidden_action`, `assert_not_break_glass` | `db/tests/rectification_r1_6.sql` (5 tests) | **Done** |
| **R2.1** | Phase R2 (Gate B) | Logical document uniqueness across entity, doc-type, and title | `core.document_logical_uk` | `db/src/core/main.sql`, `api.document_create_version` | `db/tests/rectification_r1_r2.sql` | **Done** |
| **R2.2** | Phase R2 (Gate B) | Deterministic serialized revision allocation (`FOR UPDATE` on document) | SQLSTATE 40001 | `api.document_create_version` | Two-connection concurrency test | **Done** |
| **R2.3 / H-05** | Phase R2 (Gate B) | Upload state machine: quarantine path isolation, HMAC token binding, upload lock | ADR-0016, ADR-0023 | `core.upload`, `apps/web/app/storage/service.ts` | `uploads.test.ts`, `db/tests/rectification_r1_r2.sql` | **Done** |
| **R2.4** | Phase R2 (Gate B) | Idempotent survey request state machine transitions & stable error codes | ADR-0024 | `api.survey_request_*`, `apps/web/app/actions/errors.ts` | `workflow-concurrency.test.ts` | **Done** |
| **R2.5** | Phase R2 (Gate B) | Temporal GiST exclusion constraint validation and empty range handling | Invariant I14 | `iam.role_assignment`, `iam.staff_position` | `db/tests/rectification_r2_5.sql` | **Done** |
| **R3.1..R3.4** | Phase R3 (Gate C) | Typed Remix context, typed PostgREST client, centralized authority catalog, error codes | ADR-0024 | `apps/web/app/actions/context.ts`, `packages/pgrst-client/` | `context.test.ts`, `errors.test.ts` | **Done** |
| **R4.1..R4.3** | Phase R4 (Gate C) | Shared validation schemas, standardized JSON action responses, streaming body limits | ADR-0023 | `apps/web/app/actions/validation.ts`, `middleware/body-limits.ts` | `r4-2-response.test.ts`, `r4-3-body-limits.test.ts` | **Done** |
| **R5.1..R5.3** | Phase R5 (Gate D) | MMS dashboard shell, WCAG 2.2 AA design system, proposal workflow replacing raw UUIDs | ADR-0025 | `apps/web/app/actions/admin-pages.tsx`, `actions/helpers.tsx` | `r5-3-admin-controls.test.ts` | **Done** |
| **R6.1..R6.3** | Phase R6 (Gate D) | Consolidated 10-dimension authorization matrix, `explain_authority`, SoD rules | ADR-0026, `docs/security/authorization-matrix.md` | `iam.authority_rule`, `api.explain_authority`, SoD checks | `db/tests/authorization_matrix.sql`, `r6-sod.test.ts` | **Done** |
| **R7.1** | Phase R7 (Gate E) | Clean runtime database user separation (`auth_gateway`, `app_user`, `worker`, `sealer`) | ADR-0021 | `apps/web/app/auth/gateway-client.ts`, `worker-client.ts` | Connection pool role assertion tests | **Done** |
| **R7.2** | Phase R7 (Gate E) | Durable outbox leasing, exponential retries, lease expiry, dead-letter state | ADR-0027 | `core.outbox`, `private.job_poll`, `private.job_complete` | `r7-2-outbox-leasing.test.ts` | **Done** |
| **R7.3** | Phase R7 (Gate E) | Background quarantine sweep worker, 24h transient purge, scan verdict audit | ADR-0016 | `apps/web/app/jobs/quarantine-sweep.ts` | `r7-3-malware-quarantine.test.ts` | **Done** |
| **R7.4 / H-01** | Phase R7 (Gate E) | Tier-2 WORM audit sealing, zero-record anomaly detection, CLI verification | ADR-0012, `docs/runbooks/audit-worm.md` | `apps/web/app/audit/`, `scripts/verify-audit_trail.ts` | `r7-4-worm-audit_trail.test.ts` | **Done** |
| **R7.5 / H-12** | Phase R7 (Gate E) | Backup & restore procedures, RPO <= 5m / RTO <= 60m, restore drill script | `docs/runbooks/backup-restore.md` | `scripts/restore-drill.sh` | Restore drill execution & pgTAP verification | **Done** |
| **R8.1..R8.3** | Phase R8 (Gate E) | Hardened CI workflows, migration lint gates C1–C8, exact toolchain pins | ADR-0002, ADR-0010 | `.github/workflows/ci.yml`, `version-pins.test.ts` | `npm run check`, `apps/web/app/version-pins.test.ts` | **Done** |
| **R8.6** | Phase R8.6 | Canonical native local acceptance environment (PG 18.6, PGRST 16.5, fixtures) | `docs/testing/native-environment.md` | `scripts/testenv-*.ts`, `npm run testenv:*` | Native acceptance test run & diagnostics | **Done** |
| **R9.1..R9.7** | Phase R9 (Gate F) | Canonical vessel/party identity, survey jobs, qualifications, certificates, notations | ADR-0028, ADR-0029, ADR-0030 | `fleet.*`, `survey.survey_job`, `qual.*`, `cert.*` | Domain pgTAP test suites (pending Gate E review) | *Proposed* |
| **R10.1..R10.4** | Phase R10 | Final adversarial verification (authorization, authentication, document, operations) | Phase R10 Specification | Adversarial acceptance test matrix | Comprehensive test suite run (after R9) | *Pending* |

---

## 4. Release Gates Dashboard

All six release gates define clear, non-negotiable exit criteria:

### Gate A: Security Foundation (Passed)
- `SECURITY DEFINER` functions enforce `private.caller_role()` or `private.is_worker_or_admin()`.
- Non-admin capability roles cannot execute `private.emit_event()` directly.
- Overbroad API schema `EXECUTE` grants revoked.
- Strict CSP nonce enforced on all HTML documents; Google Fonts removed.
- Ingress trusted-proxy header validation rejects spoofed client IPs.
- Emergency break-glass matrix rejects regulated approvals and requires drill logging.
- **Verification:** `npm run check` exits 0; `db/tests/rectification_r1_1.sql` and `rectification_r1_6.sql` pass.

### Gate B: Data Integrity (Passed)
- Logical documents enforce unique natural keys (`core.document_logical_uk`).
- Version allocation locked with `FOR UPDATE` on the parent document.
- Upload states strictly tracked in database with HMAC token verification.
- State machine transitions update exactly one row and verify state predicates.
- Temporal GiST exclusion constraints enforced on positions, roles, and coverage.
- **Verification:** `db/tests/rectification_r1_r2.sql` and `rectification_r2_5.sql` pass; concurrency tests pass.

### Gate C: Application Boundaries (Passed)
- Strongly-typed Remix request context (`MmsContext`).
- Typed PostgREST client wrappers for all RPCs and views.
- Domain error codes mapped to standard HTTP statuses (400, 401, 403, 404, 409, 423, 500).
- Request body and file upload streaming limits enforced before buffering.
- **Verification:** `npm run typecheck`, `packages/pgrst-client/test/`, `r4-2-response.test.ts`, `r4-3-body-limits.test.ts`.

### Gate D: Usable Product Shell (Passed)
- Remix starter templates removed and replaced by authenticated MMS dashboard shell.
- Design system implements WCAG 2.2 AA accessibility, keyboard navigation, and responsive layouts.
- Raw UUID input inputs replaced with type-ahead selectors and proposal workflows.
- 10-dimensional authorization matrix published with safe diagnostic explanations.
- Segregation of duties enforced: record creators cannot approve; sysadmins cannot hold business roles.
- **Verification:** `r5-3-admin-controls.test.ts`, `r6-sod.test.ts`, `db/tests/authorization_matrix.sql`.

### Gate E: Production Resilience (Passed)
- Clean separation of database users: BFF pool, background worker, audit sealer, and migrator.
- Outbox implements leasing with timeouts, exponential backoff, and dead-letter queue.
- Quarantine sweep service purges unpromoted transient files after 24 hours.
- Audit sealer verifies WORM hash chains, detects zero-record gaps, and generates daily digests.
- Backup and restore procedures tested with automated restore drills and pgTAP invariant checks.
- Canonical local test environment operational on native PostgreSQL 18.6 and PostgREST 16.5.
- **Verification:** `npm run testenv:check`, `r7-2-outbox-leasing.test.ts`, `r7-4-worm-audit_trail.test.ts`, `scripts/restore-drill.sh`.

### Gate F: Maritime Controlled Records (Awaiting Human Review & Gate E Sign-Off)
- Human review and formal acceptance of ADR-0028 (Party & Vessel Identity), ADR-0029 (Survey Job Separation), and ADR-0030 (Qualifications & Controlled Certificates).
- Implementation of canonical IMO number check-digit verification and temporal vessel registry history.
- Decoupling customer requests from operational attendance jobs and regulatory deficiencies.
- Database enforcement of surveyor competence catalogs and controlled certificate lifecycles.
- **Stop Condition:** In accordance with `AGENTS.md` and Part 2 §R9, domain table creation is strictly blocked until Gate E receives two human reviewer approvals.

---

## 5. Traceability Guide for Agents & Engineers

When implementing, modifying, or reviewing features in MMS:
1. **Identify the Task/Card:** Reference the Task ID (e.g. `R6.1`, `R8.6.14`) or Card ID (e.g. `A-02`, `H-05`) in commit messages, PR descriptions, and ADRs.
2. **Consult Governing Specifications:** Follow the cross-references in the [Master Traceability Matrix](#3-master-traceability-matrix) to inspect the corresponding section in [Part 1](auth-implementation-plan.md), [Part 2](rectification-implementation-plan.md), or [Part 3](r8-6-implementation-plan.md).
3. **Verify Against Invariants:** Ensure all database changes uphold the 15 core architectural invariants (Part 1 §5.2) and pass all schema lint checks (`npm run db:check`).
4. **Run Verification Commands:** Validate changes locally using the native acceptance environment (`npm run testenv:reset && npm run check`).
5. **Record Governance Decisions:** If proposing new conventions, do not invent patterns in code; author a `proposed` ADR in `docs/adr/` and record the open question in [Part 4: Rectification Status and Decisions](rectification-decisions.md).
