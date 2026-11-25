# MMS Unified Implementation Plan — Part 3: Native Local Acceptance Test Environment

> **Master Plan:** [MMS Unified Implementation Plan (docs/plans/README.md)](README.md)  
> **Phase:** R8.6 (Cards R8.6.1 through R8.6.32)  
> **Prerequisites:** [Part 2: Rectification Plan (Phase R8)](rectification-implementation-plan.md)  
> **Scope:** Canonical native PostgreSQL 18.6 + PostgREST 16.5 local acceptance harness, synthetic fixtures, dev-login personas, background worker/sealer daemons, and Feature Acceptance Cards.

## 1. Purpose

Create a deterministic local acceptance-test environment for MMS so developers, product owners, reviewers, and coding agents can verify each implemented feature against realistic identities, organizational scopes, authorization rules, workflow states, document handling, background processing, and failure conditions.

The canonical R8.6 environment shall use:

- Native PostgreSQL 18.6
- Native PostgREST 16.5
- Native Node.js runtime
- Native Remix application process
- Separate native MMS worker process
- Separate native audit-sealer process
- Test-only scanner adapter
- Local notification/mail capture where required

Docker, Podman, or another container runtime must not be required for normal MMS development or product-owner acceptance testing.

Containers may be used only as an optional mechanism for isolated disposable CI and migration tests.

---

## 2. Architectural Principles

The canonical development environment shall resemble the intended production runtime architecture as closely as reasonably possible.

```text
Browser
   |
   v
MMS Remix Web :3000
   |
   v
PostgREST :3001
   |
   v
PostgreSQL 18.6 :5432

Additional independent processes:

MMS Worker
Audit Sealer
Test Malware Scanner
Test Notification/Mail Sink
```

Production may later place these components on separate servers, but the logical runtime and database identities must remain equivalent.

### Mandatory principles

1. MMS application behavior must not depend on PostgreSQL being inside Docker, outside Docker, on localhost, or on the same server as Remix.
2. Connection information must come from configuration.
3. PostgreSQL remains the final authorization and integrity authority.
4. Separate runtime database identities must be preserved locally.
5. R8.6 must not weaken any accepted R0-R8.5 security, audit, migration, or segregation-of-duties invariant.
6. R8.6 must not implement R9 maritime business functionality merely to create test fixtures.

---

## 3. Production Deployment Assumption

For the current architecture, assume the preferred production topology is:

```text
Application Server
├── Reverse proxy
├── MMS Remix
├── PostgREST
└── MMS Worker

            |
       private TLS
            |
            v

Database Server
└── PostgreSQL 18.x

Separate where appropriate:
├── Audit sealer
├── backup services
├── monitoring
└── immutable audit storage
```

PostgreSQL shall be treated as first-class infrastructure because MMS places important security and integrity controls inside PostgreSQL, including RLS, organizational scope, authorities, workflow invariants, audit controls, temporal authorization, and concurrency controls.

R8.6 does not define the final production HA, backup, disaster-recovery, WORM-storage, or deployment architecture.

---

## 4. Environment Separation

A developer may use one native PostgreSQL installation, but MMS environments must use separate databases.

Recommended databases:

```text
postgres
mms_dev
mms_test
mms_acceptance
```

| Database | Purpose | Destructive reset |
|---|---|---|
| `postgres` | PostgreSQL administrative database | Never |
| `mms_dev` | Normal development | Manual only |
| `mms_test` | Automated integration tests | Allowed |
| `mms_acceptance` | Deterministic acceptance environment | Allowed |

Agents shall not create one PostgreSQL installation per environment unless a documented technical reason requires it.

---

# 5. R8.6.1 Native Prerequisite Verification

**Priority:** P1  
**Dependencies:** R0-R8.5 hardened baseline

Create a version-controlled prerequisite checker.

Suggested command:

```bash
npm run testenv:check
```

It must verify at least:

```text
Node.js              expected project version
npm                  supported project version
PostgreSQL           approved PostgreSQL 18.x
PostgreSQL reachable yes
PostgREST            16.5 baseline / approved version
PostgREST reachable  yes
database encoding    UTF8
database timezone    UTC
required extensions  available/present
required DB roles    present
test environment     positively identified
migration state      identifiable
```

### PostgreSQL version policy

- PostgreSQL 18.6 is the R8.6 baseline.
- A later PostgreSQL 18 patch release may be accepted only after compatibility approval and corresponding baseline/documentation update.
- PostgreSQL 19.x or another major version must be rejected until the project explicitly approves the upgrade.

### Failure behavior

Errors must be actionable, for example:

```text
ERROR: PostgreSQL 17 detected.
MMS baseline requires an approved PostgreSQL 18.x release.
```

Do not emit only a generic `Environment invalid` message.

### Acceptance criteria

- The checker identifies every required native dependency.
- It exits non-zero when an incompatible prerequisite is detected.
- It does not print credentials or token material.

---

# 6. R8.6.2 Test Environment Configuration

Create or update:

```text
.env.test.example
```

The checked-in example must contain no working credentials.

Document configuration for:

```text
APP_ENV
DATABASE_URL
POSTGREST_URL
migration/bootstrap connection
PostgREST authenticator
worker connection
audit-sealer connection
test storage root
test scanner
notification sink
application base URL
dev-login configuration
```

Use existing MMS naming conventions where they already exist.

### Unsafe test switches

Examples may include:

```text
ALLOW_DEV_LOGIN=true
ALLOW_TEST_SCANNER=true
ALLOW_TEST_STORAGE=true
```

Production startup must fail if an unsafe test-only facility is enabled.

### Required test

```text
APP_ENV=production
ALLOW_DEV_LOGIN=true
```

Expected result:

```text
startup failure
```

A warning is insufficient.

---

# 7. R8.6.3 Preserve Database Identity Separation

Even if every process runs on one development workstation, use distinct PostgreSQL identities.

At minimum distinguish:

```text
migration/bootstrap administrator
PostgREST authenticator/gateway
worker
audit sealer
application roles
```

Do not implement local testing by connecting every process as `postgres` or another superuser.

### Required verification

Add an automated or scripted diagnostic demonstrating the effective database identity used by each test runtime without disclosing secrets.

### Acceptance criteria

- Web/API access does not use a superuser.
- Worker uses its existing restricted identity.
- Audit sealer uses its existing restricted identity.
- RLS is not bypassed for normal acceptance testing.

---

# 8. R8.6.4 Protect Destructive Test Operations

Create a durable marker identifying disposable databases.

Before any destructive action such as:

```text
DROP DATABASE
TRUNCATE
fixture reset
acceptance database recreation
```

the script must verify all of:

```text
APP_ENV is local/test
database name is expected
database host is approved/disposable
disposable marker exists
production marker is absent
```

### Hard prohibition

`testenv:reset` must never destroy:

```text
postgres
mms_dev
production database
unknown database
database without disposable marker
```

If positive identification fails, abort.

### Required tests

Test at least:

1. Correct `mms_acceptance` target succeeds.
2. `postgres` target fails.
3. `mms_dev` target fails.
4. Unknown database fails.
5. Missing disposable marker fails.
6. Production `APP_ENV` fails.
7. Database host mismatch fails when host allow-listing is enabled.

---

# 9. R8.6.5 Deterministic Acceptance Reset

Implement:

```bash
npm run testenv:reset
```

Required sequence:

```text
run safety checks
       ↓
terminate only acceptance DB sessions
       ↓
drop mms_acceptance
       ↓
create blank mms_acceptance
       ↓
bootstrap required roles/extensions
       ↓
apply every repository migration
       ↓
run schema/database checks
       ↓
load deterministic fixtures
       ↓
run acceptance smoke pgTAP
       ↓
verify PostgREST connectivity
       ↓
report ready
```

The reset must rebuild the database through normal MMS bootstrap/migration mechanisms.

Do not restore a prebuilt database snapshot merely because it is faster.

### Critical invariant

```text
empty approved PostgreSQL 18.x
+
repository migrations
=
valid MMS database
```

must be continuously exercised.

---

# 10. R8.6.6 Deterministic Seed Mechanism

Implement:

```bash
npm run db:seed:test
```

Fixtures must be:

- synthetic;
- deterministic;
- version controlled;
- repeatable;
- easy to inspect;
- safe to destroy.

Use stable UUIDs where useful, for example:

```text
00000000-0000-4000-8000-000000000101
```

rather than randomly generated identifiers.

The seed command must refuse to run against an unmarked or production database.

---

# 11. R8.6.7 Organization Fixtures

Seed at minimum:

```text
Head Office
│
├── Asia Region
│   ├── Shanghai Station
│   ├── Singapore Station
│   └── Busan Station
│
├── Europe Region
│   └── Genoa Station
│
├── MTS Asia
│
├── Plan Approval Centre
│
└── HO Compliance
```

Include relationships exercising:

- station scope;
- regional scope;
- multiple-region coverage;
- centralized MTS scope;
- centralized Plan Approval Centre scope;
- worldwide HO Compliance oversight.

Global visibility must not automatically become unrestricted business approval authority.

---

# 12. R8.6.8 Test Personas

Seed at least:

```text
external.customer.a
external.customer.b
surveyor.shanghai
auditor.shanghai
manager.shanghai
surveyor.singapore
coordinator.asia
mts.asia
planapproval.central
compliance.ho
hr.test
finance.test
sysadmin.test
surveyor.expired
breakglass.test
```

Use unmistakably fictional names and email addresses.

### Mandatory semantic separation

Fixtures must preserve:

```text
identity
   ≠
job title
   ≠
organizational position
   ≠
application role
   ≠
organizational scope
   ≠
qualification
   ≠
regulated authority
```

No fixture shortcut may collapse these concepts.

---

# 13. R8.6.9 Qualification and Authority Fixtures

Create intentionally overlapping and non-overlapping test qualifications.

Example:

```text
surveyor.shanghai

role:
  int_surveyor

office:
  Shanghai

qualification:
  TEST_GENERAL_SURVEY

validity:
  active
```

```text
surveyor.singapore

role:
  int_surveyor

office:
  Singapore

qualification:
  TEST_SPECIAL_SURVEY

validity:
  active
```

```text
surveyor.expired

role:
  int_surveyor

qualification:
  TEST_GENERAL_SURVEY

validity:
  expired
```

### Mandatory invariant

Holding `int_surveyor` permits appropriate surveyor workflow participation but does not itself prove technical authorization for every survey, ship type, flag, class service, product, or certificate.

If the definitive R9 qualification model does not yet exist, implement only the minimum fixture representation compatible with the current schema. Do not prematurely implement R9.

---

# 14. R8.6.10 Synthetic Company and Vessel Fixtures

Until the approved R9 canonical company/vessel model exists, create only the minimum compatible fixtures.

### Customer A

```text
TEST ABC SHIPPING LTD

MV TEST ALPHA
MV TEST BRAVO
```

### Customer B

```text
TEST XYZ MARITIME LTD

MV TEST CHARLIE
```

Do not use IMO numbers belonging to real ships. Use clearly synthetic identifiers.

### Authorization expectation

`external.customer.a` may access:

```text
TEST ABC SHIPPING LTD
MV TEST ALPHA
MV TEST BRAVO
```

but must not discover or mutate:

```text
TEST XYZ MARITIME LTD
MV TEST CHARLIE
```

through:

- UI navigation;
- guessed/direct URLs;
- modified form submissions;
- direct PostgREST requests.

---

# 15. R8.6.11 Workflow Fixtures

Create independent deterministic records for currently implemented states, for example:

```text
request.draft
request.submitted
request.triage
request.accepted
request.rejected
```

As approved R9 functionality is implemented, extend fixtures with states such as:

```text
job.unassigned
job.assigned
job.in_progress
job.review
job.completed
```

Tests must not depend on unrelated tests leaving a shared fixture in a particular state.

Use independent fixture records or reset state between cases.

---

# 16. R8.6.12 Development-Only Persona Login

Implement a development-only identity selection mechanism, such as:

```text
/dev/login
```

Expose personas including:

```text
Customer A
Customer B
Shanghai Surveyor
Shanghai Auditor
Shanghai Station Manager
Singapore Surveyor
Asia Coordinator
Asia MTS
Plan Approval Centre
HO Compliance
HR
Finance
Sysadmin
Expired Surveyor
Break Glass
```

### Critical implementation rule

The mechanism establishes test identity only.

It must then use normal MMS:

```text
session handling
active-role handling
PostgREST
RLS
organizational scope
qualification
authority
segregation of duties
```

The dev-login subsystem must never implement authorization itself.

### Prohibited behaviors

It must not:

- disable RLS;
- connect as database superuser;
- use `BYPASSRLS`;
- inject arbitrary caller-chosen roles/scopes;
- bypass session validation;
- bypass authority/qualification checks;
- bypass active-role logic.

---

# 17. R8.6.13 Production Prohibition for Dev Login

Use multiple protections.

Dev login shall require:

```text
APP_ENV in {local,test}
AND
production == false
AND
ALLOW_DEV_LOGIN == true
```

Prefer not registering the route at all in production.

### Required tests

Production configuration:

```text
GET /dev/login
POST /dev/login
```

Expected:

```text
404
```

Then test:

```text
APP_ENV=production
ALLOW_DEV_LOGIN=true
```

Expected:

```text
application startup failure
```

There must be no header, cookie, query string, hostname, JWT claim, or form parameter capable of enabling dev login in production.

---

# 18. R8.6.14 Native PostgREST Management

PostgREST is part of the canonical acceptance environment and shall run natively.

Add helper scripts where useful, following existing repository conventions, for example:

```bash
npm run postgrest:test
npm run postgrest:check
```

Use the actual approved PostgREST executable and normal MMS configuration model.

Do not implement a fake PostgREST layer for testing.

### Acceptance tests

Verify:

```text
unauthenticated caller
authenticated gateway caller
valid persona
wrong role
wrong organization
wrong station
expired authority
inactive role
```

against the actual database authorization layer.

---

# 19. R8.6.15 Native Worker Execution

Add or retain:

```bash
npm run worker:test
```

Use the restricted worker database identity.

### Manual/automated scenario

```text
stop worker
     ↓
generate outbox job
     ↓
verify pending
     ↓
start worker
     ↓
verify leased
     ↓
verify processing
     ↓
verify done
```

Then test transport failure:

```text
processing
   ↓
failure
   ↓
retry
   ↓
retry exhaustion
   ↓
dead letter
```

Confirm duplicate workers do not execute the same leased job incorrectly.

---

# 20. R8.6.16 Native Audit-Sealer Execution

Add or retain:

```bash
npm run sealer:test
```

The sealer must use its own restricted credentials.

Test:

```text
business mutation
      ↓
audit event/change
      ↓
sealer
      ↓
hash/chain
      ↓
test immutable-storage adapter
      ↓
verification
```

A local filesystem or test adapter may simulate storage mechanics, but it must never be described as proving real production WORM immutability.

---

# 21. R8.6.17 Local Test Document Storage

Use local test directories outside tracked source, for example:

```text
.testdata/
├── quarantine/
├── clean/
└── infected/
```

Add `.testdata/` to `.gitignore`.

Preserve the existing security invariant:

```text
storage location != malware scan verdict
```

A document becomes clean only when an authorized scanner records a clean verdict.

---

# 22. R8.6.18 Deterministic Test Scanner

Provide a test-only scanner adapter supporting controlled outcomes:

```text
clean
infected
error
timeout
```

Do not infer outcome from arbitrary user-controlled filenames.

Production startup must fail if the test scanner is enabled.

### Required tests

```text
pending -> clean
pending -> infected
pending -> error
```

and:

```text
pending  -> normal download denied
infected -> normal download denied
error    -> normal download denied
clean    -> download subject to normal authorization
```

Also test scanner timeout/retry behavior.

---

# 23. R8.6.19 Notification Testing

Use a lightweight local test-mail/notification sink compatible with the existing notification adapter.

Mailpit is an acceptable option if compatible with the repository's existing interfaces.

The notification sink itself may optionally be containerized because it is disposable support infrastructure. Docker must still not be required merely to run PostgreSQL/PostgREST or the core MMS acceptance environment.

Test at least:

- invitations;
- reset/security notifications where implemented;
- break-glass alerts;
- future survey/workflow notifications.

---

# 24. R8.6.20 Environment Lifecycle Commands

Canonical commands shall be equivalent to:

```bash
npm run testenv:check
npm run testenv:reset
npm run testenv:status
```

Where appropriate, also provide:

```bash
npm run testenv:start
npm run testenv:stop
```

### Semantics

`testenv:check`

> Verify native prerequisites, versions, database safety, and connectivity.

`testenv:reset`

> Destructively reconstruct only the disposable acceptance database and deterministic fixtures.

`testenv:status`

> Report PostgreSQL, PostgREST, MMS web, worker, sealer, scanner, and notification readiness where applicable.

`testenv:start`

> Start MMS acceptance processes.

`testenv:stop`

> Stop MMS acceptance processes without uninstalling or unnecessarily stopping the host PostgreSQL service.

Do not make `testenv:stop` delete the acceptance database.

If a full destructive purge is needed, create a separately named and explicitly destructive command.

---

# 25. R8.6.21 Product-Owner Startup Workflow

The intended workflow should become approximately:

```bash
git pull
npm ci
npm run testenv:check
npm run testenv:reset
npm run dev
```

Then open:

```text
http://localhost:3000/dev/login
```

No Docker command shall be required for the normal workflow.

Create:

```text
docs/testing/product-owner-guide.md
```

The guide must explain how to:

1. reset the acceptance database;
2. start MMS;
3. select a test persona;
4. execute a feature acceptance card;
5. verify expected positive and negative behavior;
6. inspect notifications/audit evidence where appropriate;
7. reset the environment after testing.

---

# 26. R8.6.22 Add Playwright

Add Playwright as the browser-level acceptance framework.

Do not replace existing unit, integration, pgTAP, or database security tests.

Suggested layout:

```text
tests/e2e/
├── fixtures/
├── helpers/
├── authentication/
├── authorization/
├── administration/
├── documents/
├── survey/
└── smoke/
```

Use the repository's existing package/workspace conventions.

---

# 27. R8.6.23 Initial E2E Suite

## E2E-001 Station isolation

```text
surveyor.shanghai
→ Shanghai resource
→ allowed

surveyor.shanghai
→ Singapore resource
→ denied
```

Exercise:

- normal navigation;
- direct URL;
- modified HTTP request.

## E2E-002 Customer isolation

`external.customer.a` may see:

```text
MV TEST ALPHA
MV TEST BRAVO
```

and must not see:

```text
MV TEST CHARLIE
```

Attempt direct access with Charlie's deterministic fixture ID.

Expected response must follow the system's non-disclosure policy.

## E2E-003 Sysadmin segregation of duties

`sysadmin.test` may exercise legitimate platform-administration functions.

Attempt a regulated/business approval.

Expected:

```text
denied
```

## E2E-004 Expired qualification

`surveyor.expired` attempts a qualification-controlled operation.

Expected:

```text
UI action unavailable
AND
forced request denied
```

---

# 28. R8.6.24 Direct PostgREST Acceptance Tests

Browser testing is insufficient for security verification.

Add direct PostgREST tests using valid test identities/tokens.

For significant authorization boundaries, test:

```text
allowed persona
wrong office
wrong organization
wrong role
expired authority
inactive role
tampered resource UUID
```

These tests must prove PostgreSQL authorization independently of Remix UI behavior.

---

# 29. R8.6.25 Authorization Acceptance Matrix

Create:

```text
docs/testing/authorization-acceptance-matrix.md
```

At minimum cover:

| Caller | Own station | Other station | Global oversight | HR | Platform admin | Business approval |
|---|---|---|---|---|---|---|
| Surveyor | scoped | deny | deny | deny | deny | qualification dependent |
| Station Manager | scoped | deny | deny | deny | deny | workflow/authority dependent |
| MTS Asia | configured coverage | configured coverage only | deny | deny | deny | authority dependent |
| Plan Approval | assigned scope | assigned scope | deny | deny | deny | plan authority only |
| HO Compliance | oversight | oversight | defined global oversight | no implicit HR | deny | no implicit approval |
| HR | HR scope | HR scope | deny | yes | deny | deny |
| Sysadmin | platform need only | platform need only | no automatic business grant | no implicit HR | yes | deny |
| External A | own company | deny | deny | deny | deny | deny |

This is an acceptance specification, not the authorization implementation.

---

# 30. R8.6.26 Feature Acceptance Card

Create:

```text
docs/testing/feature-test-template.md
```

Template:

```markdown
# Feature Acceptance Test

## Feature ID

## Commit

## Preconditions

## Persona

## Fixture IDs

## Positive path

### Steps

### Expected result

## Organization-scope negative path

## Role negative path

## Qualification negative path

## Direct API bypass attempt

## Concurrency scenario

## Audit evidence

## Notification/outbox evidence

## Database invariant

## Reset procedure

## Result

PASS / FAIL

## Defects
```

Every consequential R9 feature shall include an acceptance card or update an existing one.

---

# 31. R8.6.27 Preserve Real Authentication Test Paths

Dev persona login is for efficient business-feature and authorization testing only.

It does not replace tests of:

- Entra authentication;
- OAuth issuer/audience/tenant checks;
- OAuth state/nonce;
- identity linking;
- external password authentication;
- TOTP/MFA;
- session rotation/expiry;
- password reset;
- step-up authentication;
- break-glass authentication.

Document two testing modes:

```text
Business Acceptance Testing
→ deterministic test personas

Authentication/Security Testing
→ real authentication path
```

---

# 32. R8.6.28 Optional Disposable CI PostgreSQL

This is the only R8.6 PostgreSQL use case for which containers are positively recommended.

CI should be able to create:

```text
fresh approved PostgreSQL 18.x
       ↓
empty PGDATA
       ↓
MMS bootstrap
       ↓
all migrations
       ↓
schema validation
       ↓
pgTAP
       ↓
integration tests
       ↓
destroy environment
```

A PostgreSQL container may implement this disposable test boundary.

### Critical rule

Containerized CI must not make MMS application code dependent on Docker.

These must remain interchangeable through configuration:

```text
DATABASE_URL -> native PostgreSQL
```

and:

```text
DATABASE_URL -> ephemeral CI PostgreSQL
```

with no application behavior change.

Pin the CI PostgreSQL image/version explicitly rather than using `latest`.

---

# 33. R8.6.29 CI Architecture

## Fast CI

Run the repository-equivalent commands for:

```bash
npm ci
npm run typecheck
npm test
npm run check:boundary
npm run doctor
```

## Database CI

Use disposable PostgreSQL:

```text
blank PostgreSQL
→ bootstrap
→ migrations
→ schema/database checks
→ pgTAP
→ integration tests
```

## Browser acceptance CI

For relevant changes:

```text
acceptance database
→ deterministic seed
→ PostgREST
→ Remix
→ Playwright
```

## Release CI

Retain the repository's release gate, including:

```bash
npm run release:check
```

Do not weaken locked-migration or human security-review requirements.

---

# 34. R8.6.30 Native Environment Drift Controls

Because native installations are not recreated from a container image, `testenv:check` must detect material drift in:

```text
PostgreSQL version
PostgREST version
server encoding
timezone
required extensions
required roles
MMS migration state
critical database configuration assumptions
```

Where an exact setting is important to MMS security or correctness, assert it.

Where it is not material, do not require unnecessary machine-level equality.

The objective is behavioral parity, not identical developer operating systems.

---

# 35. R8.6.31 Operating-System Documentation

Document supported native development/test environments separately from production operations.

For every supported development OS, document installation/configuration of:

```text
Node.js
PostgreSQL 18.x
PostgREST 16.5
repository dependencies
```

The guide needs only enough native PostgreSQL administration to:

```text
create required roles
create mms_dev
create mms_test
create mms_acceptance
start/check PostgREST
reset mms_acceptance
inspect relevant logs
```

Do not turn R8.6 into the production server operations manual.

---

# 36. R8.6.32 Final Adversarial Acceptance Suite

Before completion, automate the following representative cases.

## Organizational isolation

```text
Shanghai -> Singapore
Singapore -> Shanghai
Customer A -> Customer B
MTS covered region -> uncovered region
```

## Role isolation

```text
finance -> survey operation
HR -> platform administration
sysadmin -> regulated approval
surveyor -> HR-only data/action
```

## Temporal authorization

```text
expired position
expired assignment
expired membership
expired coverage
expired qualification
```

## Session/role isolation

```text
disabled user
revoked session
expired session
inactive role
role changed after login
```

## Request manipulation

```text
ship UUID
company UUID
unit UUID
document UUID
survey/request UUID
forged form POST
direct PostgREST/RPC
```

## Runtime failures

```text
worker unavailable
worker retry exhaustion
PostgREST unavailable
scanner timeout
scanner error
notification transport failure
sealer failure
```

## Document attacks

```text
oversized upload
wrong MIME
wrong extension
upload-token replay
cross-company document access
pending-file download
infected-file download
```

---

# 37. Required Final Validation

At completion, execute commands equivalent to:

```bash
npm ci

npm run testenv:check
npm run testenv:reset
npm run testenv:status

npm run typecheck
npm test
npm run check:boundary
npm run doctor

npm run db:check
npm run db:spike
npm run db:test
npm run db:verify

npm run test:e2e

npm run release:check
```

Use existing repository command names when equivalent scripts already exist. Do not add redundant aliases solely to match these names literally.

The implementation report must record command exit status and any intentionally skipped environment-dependent test.

---

# 38. R8.6 Release Gate

R8.6 is complete only when all of the following are true:

- [ ] Normal MMS development requires no Docker installation.
- [ ] PostgreSQL 18.x works natively.
- [ ] PostgREST works natively.
- [ ] `testenv:check` detects incompatible native dependencies.
- [ ] `mms_dev`, `mms_test`, and `mms_acceptance` are safely separated.
- [ ] `testenv:reset` can destroy only positively marked disposable databases.
- [ ] A blank acceptance database can be reconstructed using normal repository migrations.
- [ ] Test fixtures load deterministically.
- [ ] Test personas cover the principal MMS authorization archetypes.
- [ ] Job title, role, position, scope, qualification, and authority remain separate concepts.
- [ ] Dev login establishes identity only.
- [ ] PostgreSQL remains the final authorization authority.
- [ ] Dev login does not exist in production.
- [ ] Production refuses unsafe test feature switches.
- [ ] PostgREST does not require `BYPASSRLS` for normal testing.
- [ ] Worker uses its own database identity.
- [ ] Audit sealer uses its own database identity.
- [ ] Scanner clean/infected/error/timeout paths are testable.
- [ ] Normal document access before a clean scan is denied.
- [ ] Cross-station authorization is tested.
- [ ] Cross-customer authorization is tested.
- [ ] Sysadmin segregation of duties is tested.
- [ ] Expired qualification is tested.
- [ ] Direct PostgREST bypass attempts are tested.
- [ ] Request UUID/resource tampering is tested.
- [ ] Worker retry/dead-letter behavior is tested.
- [ ] Notification delivery can be inspected locally.
- [ ] Playwright acceptance tests pass.
- [ ] Existing database security/pgTAP tests remain green.
- [ ] `release:check` passes.
- [ ] Product owner can test features from documented native-environment instructions.
- [ ] Optional disposable containerized CI PostgreSQL can bootstrap from empty state without application-code changes.

---

# 39. Stop Conditions

The implementing agent must stop and request an architectural decision if:

1. dev login requires weakening production authentication;
2. a test persona requires bypassing RLS;
3. PostgREST requires `BYPASSRLS` for normal testing;
4. the reset script cannot positively identify a disposable database;
5. MMS application code starts depending on Docker-specific hostnames, volumes, or network semantics;
6. native PostgreSQL and disposable CI PostgreSQL produce materially different behavior;
7. an accepted R0-R8.5 security invariant must be weakened;
8. real employee, customer, vessel, or confidential production data appears necessary;
9. a R9 maritime entity must be prematurely implemented to complete R8.6;
10. production infrastructure architecture must be changed merely to satisfy R8.6;
11. a test-only scanner/login/storage mechanism cannot be made unreachable in production;
12. destructive reset safety cannot be proven fail-closed.

The agent must document the condition and stop at the smallest safe boundary rather than inventing a workaround.

---

# 40. Explicit Prohibition on Docker Coupling

The following is an architectural requirement:

> MMS application code must be infrastructure-location agnostic. PostgreSQL and PostgREST may run natively, remotely, as managed services, or within an ephemeral CI environment without application-code changes. Docker is not part of the MMS runtime contract.

The canonical R8.6 developer and acceptance environment uses native PostgreSQL and native PostgREST.

Containerized PostgreSQL is permitted as an optional disposable CI/integration-test implementation and does not define the production database architecture.

---

# 41. Fixture Governance

Add these rules to the relevant testing documentation and agent instructions where appropriate:

1. Fixtures must be synthetic.
2. Never copy real production customer data into fixtures.
3. Never use real employee personal information for personas.
4. Never use real vessel identifiers where unnecessary.
5. Never store production credentials in fixture/configuration files.
6. Stable fixture IDs must not change without updating dependent tests.
7. Every fixture must have a documented testing purpose.
8. Tests must not depend on execution order unless intentionally serialized.
9. Destructive tests must target positively identified disposable data only.
10. Test personas are identities, not authorization shortcuts.
11. Test fixtures must not be inserted by production migrations.
12. R9 fixtures must follow the accepted R9 domain model once implemented.

---

# 42. Standard Feature-Delivery Requirement After R8.6

After R8.6 is green, every consequential R9 feature must arrive with:

1. deterministic fixtures where required;
2. at least one positive authorization case;
3. at least one organizational-scope negative case where applicable;
4. at least one role/authority/qualification negative case where applicable;
5. database-level tests for security/integrity invariants;
6. direct API/PostgREST tests for meaningful authorization boundaries;
7. Playwright coverage when a user-facing workflow exists;
8. audit-event verification for consequential mutations;
9. notification/outbox verification when side effects are generated;
10. an updated feature acceptance card usable by the product owner.

An agent's statement that a feature is complete is not sufficient evidence of acceptance.

---

# 43. R8.6 Implementation Report

The implementing agent must finish with:

```text
R8.6 IMPLEMENTATION REPORT

Commit:

Native environment
------------------
OS tested:
Node version:
PostgreSQL version:
PostgREST version:

Database isolation
------------------
mms_dev:
mms_test:
mms_acceptance:
Disposable marker:
Reset safety tests:

Runtime identities
------------------
Migration/bootstrap:
PostgREST:
Worker:
Audit sealer:

Fixtures
--------
Organizations:
Personas:
Companies:
Vessels:
Qualifications:
Workflow fixtures:

Acceptance environment
----------------------
testenv:check:
testenv:reset:
testenv:status:
Dev login:
Production dev-login guard:

Security verification
---------------------
Cross-station:
Cross-customer:
Expired qualification:
Sysadmin SoD:
Direct PostgREST:
Tampered UUID/resource ID:
Upload state:

Operational tests
-----------------
Worker:
Outbox retry/dead-letter:
Scanner:
Sealer:
Notifications:

Automated tests
---------------
Unit/integration:
pgTAP:
Playwright:
DB verification:
release:check:

Optional CI containers
----------------------
PostgreSQL image/version:
Fresh bootstrap:
Migration result:
pgTAP result:
Application dependency on Docker: NONE

Known limitations:
Production differences:
Residual risks:
Documentation:
```

---

# 44. Final Instruction to Implementing Agents

R8.6 is a proving environment, not a new application architecture.

Do not optimize for test-environment convenience at the cost of production security or architectural parity.

Specifically:

- Do not replace database authorization with mock authorization.
- Do not make Docker part of application behavior.
- Do not use administrator database access for ordinary persona testing.
- Do not weaken RLS, SoD, temporal authorization, audit, upload quarantine, or migration controls.
- Do not implement R9 business models simply to make R8.6 appear complete.
- When a requirement conflicts with an accepted ADR or R0-R8.5 invariant, stop and request a decision.

The successful end state is a native, deterministic, resettable acceptance environment in which a product owner can independently verify each implemented MMS feature while the same code continues to work unchanged against ephemeral CI PostgreSQL and the future production database infrastructure.
