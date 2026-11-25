# MMS Product Owner Acceptance Test Guide

## 1. Overview

The MMS Native Local Acceptance Test Environment enables Product Owners, reviewers, and developers to independently verify MMS features against realistic business personas, organizational boundaries, and regulatory controls.

The entire environment runs **natively** on your workstation:
- **Native PostgreSQL 18.6** (no Docker required)
- **Native PostgREST 16.5**
- **Native Remix Web Application**
- **Native Outbox Worker & Audit Sealer**

---

## 2. Fast-Start Workflow

When receiving a feature branch or release candidate for acceptance testing:

```bash
# 1. Update source and dependencies
git pull
npm ci

# 2. Check native environment prerequisites and invariants
npm run testenv:check

# 3. Deterministically reconstruct the disposable acceptance database
npm run testenv:reset

# 4. Start the MMS Web application
npm run dev
```

Then open your browser to:
[http://localhost:3000/dev/login](http://localhost:3000/dev/login)

---

## 3. Selecting a Test Persona

The `/dev/login` page displays the 15 canonical test personas covering all MMS archetypes:

### External Customers
- **External Customer A** (`customer.a@test.mms.local`): Organization `TEST ABC SHIPPING LTD`. Authorized for vessels `MV TEST ALPHA` and `MV TEST BRAVO`.
- **External Customer B** (`customer.b@test.mms.local`): Organization `TEST XYZ MARITIME LTD`. Authorized for vessel `MV TEST CHARLIE`.

### Station Operations & Survey
- **Shanghai Surveyor** (`surveyor.shanghai@test.mms.local`): Station `SHA`. Holds active qualification `TEST_GENERAL_SURVEY`.
- **Shanghai Auditor** (`auditor.shanghai@test.mms.local`): Station `SHA`. Inspection/auditing role.
- **Shanghai Station Manager** (`manager.shanghai@test.mms.local`): Station `SHA`. Manages survey triage, assignments, and approvals.
- **Singapore Surveyor** (`surveyor.singapore@test.mms.local`): Station `SIN`. Holds active qualification `TEST_SPECIAL_SURVEY`. Isolated from Shanghai surveys.
- **Expired Qualification Surveyor** (`surveyor.expired@test.mms.local`): Station `SHA`. Qualification `TEST_GENERAL_SURVEY` is expired. Used to verify safety locks on unauthorized certificate/report release.

### Regional & Centralized Centres
- **Asia Coordinator** (`coordinator.asia@test.mms.local`): Region `ASIA-RO`. Cross-station operational coordination.
- **Asia MTS Specialist** (`mts.asia@test.mms.local`): Unit `MTS-ASIA`. Technical marine support for covered fleet.
- **Plan Approval Central Engineer** (`planapproval.central@test.mms.local`): Unit `PA-CENTRAL`. Engineering plan evaluation and approval.

### Global Oversight & Corporate Support
- **HO Compliance Officer** (`compliance.ho@test.mms.local`): Worldwide audit and compliance oversight. Read-only oversight; no implicit operational approval.
- **Test HR Officer** (`hr.test@test.mms.local`): Staff directory and organizational role administration (`/admin/positions`). Segregation of duties prevents survey approvals.
- **Test Finance Officer** (`finance.test@test.mms.local`): Financial operations; strictly separated from survey workflow.
- **Test Sysadmin** (`sysadmin.test@test.mms.local`): IT platform administration (`/admin/assignments`). Strictly prohibited from regulated maritime approvals.

### Emergency Access
- **Test Break Glass** (`breakglass.test@test.mms.local`): Emergency account; signs in dormant until activated with a justified emergency reason.

---

## 4. Executing Feature Acceptance Cards

Every feature delivered to acceptance includes a **Feature Acceptance Card** (see [docs/testing/feature-test-template.md](feature-test-template.md)).

Follow these steps for each card:
1. **Log in as the specified Persona** via `/dev/login`.
2. **Execute the Positive Path**: Verify the feature works as specified and transitions state cleanly.
3. **Execute the Negative Path (Organizational Isolation)**: Log in as a different station or company persona and verify the resource is hidden or access is denied (404/403).
4. **Execute the Role / Segregation of Duties Path**: Attempt the operation under an unauthorized role (e.g. Sysadmin attempting survey approval) and verify rejection.
5. **Inspect Side Effects**:
   - Outbox notifications: inspect via `/dev/mailbox`.
   - Audit trail: verify change capture via `npm run audit_trail:verify` or `npm run sealer:test`.

---

## 5. Acceptance Environment Commands Reference

| Command | Purpose |
|---|---|
| `npm run testenv:check` | Verifies Node.js, PostgreSQL 18.6, PostgREST 16.5, timezone UTC, and database invariants. |
| `npm run testenv:reset` | Destructively recreates `mms_acceptance`, applies all migrations, and seeds test fixtures. |
| `npm run testenv:status` | Displays live status of services, background processes, and database role isolation. |
| `npm run testenv:stop` | Terminates MMS test web/worker/sealer processes without stopping host PostgreSQL. |
| `npm run db:seed:test` | Seeds deterministic test fixtures into disposable acceptance databases. |
| `npm run postgrest:check` | Confirms PostgREST daemon health and OpenAPI cache state. |
| `npm run postgrest:test` | Executes direct PostgREST security checks against live database. |
| `npm run worker:test` | Exercises outbox leasing, execution, and retry exhaustion to dead-letter state. |
| `npm run sealer:test` | Exercises audit horizon sealing, cryptographic hash chaining, and WORM artifact verification. |
| `npm run test:e2e` | Runs complete end-to-end acceptance suite (E2E-001 through E2E-004 + PostgREST). |

---

## 6. Resetting After Testing

To reset the acceptance environment back to a clean state after completing acceptance tests:

```bash
npm run testenv:reset
```
This drops and recreates `mms_acceptance`, applies migrations from scratch, and seeds standard baseline fixtures.
