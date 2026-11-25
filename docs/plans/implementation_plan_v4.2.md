# MMS Independent Code Review Rectification Plan (Version 4.2)

## 1. Purpose

This is the authoritative follow-up plan for the current MMS code-review cycle. It incorporates the independently verified findings and the subsequent review refinements. It is written for weaker coding agents and therefore resolves implementation-policy ambiguities wherever practical.

Do not redesign accepted R0-R8.6 architecture. Fix confirmed defects first, then consistency, maintainability, portability, and documentation issues.

---

## 2. Review Classification

### Confirmed high-priority findings

1. Login account-state enumeration: inactive accounts disclose a different public message from unknown-user/bad-password cases.
2. MFA enrolment can expose raw exception messages to HTML clients.
3. Error response generation still contains a fragile safe-message mechanism that may expose unexpected exception text.
4. Password step-up lacks the canonical login-equivalent throttle/attempt controls.
5. OAuth step-up intent must require initiating-user and stable-session binding. The existing callback-provider comparison is already implemented and must be preserved, not rewritten.
6. Microsoft Entra tenant issuer handling must fail closed for invalid/missing tenant identity when tenant-bound authentication is configured.
7. IdP callback/logout URLs must derive from a validated application base URL, not request Host/Forwarded input.
8. Browser test helpers contain developer-specific absolute filesystem paths.
10. CI Gitleaks is non-blocking because the current snapshot uses `continue-on-error: true`; secret scanning must become release-blocking.

### Confirmed consistency and maintainability findings

9. HTML authentication/validation failures use inconsistent status codes.
11. Authorization guards inconsistently negotiate RFC 9457 Problem Details versus plain text/HTML.
12. Controllers still contain hard-coded internal route strings instead of the shared route contract.
13. Session assurance timestamps are duplicated at top level and inside `auth`.
14. Identity-unlink error rendering can omit active-session data.
15. Admin form/page data loaders are duplicated.
16. Raw `FormData.get()` values are repeatedly stringified, allowing `File` values to become `[object File]`.
17. Test setup/key/session helper code is duplicated.
18. Test harness conventions are inconsistent.
19. UI component/style conventions have residual inconsistencies, including mapped-element keys and static style placement.
20. Documentation/status drift remains, including obsolete 100-day break-glass wording versus the tested 92-day policy.

### Findings that must be verified before changing code

20. Break-glass controller session-elevation ordering. Verify the existing database activation transaction and durable outbox semantics before changing it. Do not make activation depend on external notification delivery.
22. Invitation/reset token format. Validate against the actual opaque-token codec. Do not invent a restrictive regex.
23. Step-up natural-expiry coverage. Improve tests with controlled time/injectable clock rather than wall-clock sleeps.

---

## 3. Verified-Finding Ledger

Every review item must have exactly one status. Coding agents must use this ledger to decide whether to implement, narrow, verify, or leave a protection unchanged.

Allowed statuses:

```text
CONFIRMED_DEFECT
PARTIALLY_IMPLEMENTED
ALREADY_IMPLEMENTED
NEEDS_RUNTIME_VERIFICATION
DESIGN_IMPROVEMENT
PRODUCTION_ASSURANCE_GAP
```

| ID | Finding | Status | Required action |
|---|---|---|---|
| P0.1 | Login account/status enumeration and timing-path inconsistency | CONFIRMED_DEFECT | Correct public response and verification-path behavior; add regression tests. |
| P0.2 | MFA enrolment renders raw exception message | CONFIRMED_DEFECT | Replace raw message with curated public error and protected server diagnostics. |
| P0.3 | Unknown exception message can become public through safe-string classification | CONFIRMED_DEFECT | Move to explicit trusted validation/domain/code mappings. |
| P0.4 | Password step-up lacks a dedicated throttle | CONFIRMED_DEFECT | Extend the existing throttle mechanism with a separate step-up namespace. Do not build a second throttle subsystem. |
| P0.5a | OAuth callback provider comparison | ALREADY_IMPLEMENTED | Preserve `intent.provider === providerName`; add/retain regression coverage. Do not rewrite it. |
| P0.5b | OAuth step-up missing/optional user binding | PARTIALLY_IMPLEMENTED | Require initiating user ID to exist and exactly match current authenticated user; verify session binding, replay and ownership. |
| P0.6 | Entra invalid/missing tenant can fall back to broader issuer | NEEDS_RUNTIME_VERIFICATION | First establish the accepted single-/multi-tenant Entra policy. Once confirmed, record any policy-incompatible fallback as a confirmed defect and correct it fail-closed. |
| P0.7 | OAuth/logout origin derived from request URL | CONFIRMED_DEFECT | Use one validated canonical `APP_BASE_URL` source. |
| P1 | Guard/status/Problem Details/route consistency | DESIGN_IMPROVEMENT | Consolidate existing mechanisms; no new authorization framework. |
| P2.1 | Duplicate assurance timestamps | CONFIRMED_DEFECT | Clean cutover to `session.auth` only. |
| P2.2 | Assurance-expiry tests | DESIGN_IMPROVEMENT | Use controlled time; no wall-clock sleeps. |
| P3.1 | Identity-unlink failure loses profile/session context | CONFIRMED_DEFECT | Reuse one complete profile loader. |
| P3.2 | Opaque token shape checks | DESIGN_IMPROVEMENT | Validate only against the actual token codec/length contract. |
| P3.3 | Break-glass session-elevation ordering | NEEDS_RUNTIME_VERIFICATION | Inspect DB transaction/outbox/session refresh before changing code. |
| P4 | Typed form access/loaders/small UI cleanup | DESIGN_IMPROVEMENT | Keep helpers small; extend existing validation module. |
| P5.1 | Playwright developer-specific absolute paths | CONFIRMED_DEFECT | Remove absolute developer-home dependencies; preserve environment-specific sandbox exceptions only when proven necessary. |
| P5.2/P5.3 | Shared test helpers/harness conventions | DESIGN_IMPROVEMENT | Extract only genuine duplication; respect boundary graph. |
| P5.4 | Gitleaks is non-blocking in CI | CONFIRMED_DEFECT | Remove `continue-on-error: true`; make secret scan release-blocking. |
| P6 | Active documentation/status contradictions | CONFIRMED_DEFECT | Reconcile active policy with tested behavior; move history out of active instructions. |
| P7 | E2E/readiness/negative assertion/error-classification hardening | DESIGN_IMPROVEMENT | Implement after security gates. |
| P8 | Audit retention/crypto-shred/log-forwarder operational wiring and real WORM/recovery evidence | PRODUCTION_ASSURANCE_GAP | Add a separate production-assurance phase; do not mix into P0 authentication fixes. |
| P9 | Current technical `audit` schema conflicts with the future maritime Company Audit bounded context | RESOLVED (Pre-Production Normalization) | P9 was resolved through pre-production baseline normalization. Every prototype migration creates/references `audit_trail`. No forward `audit` → `audit_trail` migration is required because no deployed database depends on `audit`. `audit` remains reserved for the maritime Company Audit domain. Baseline preview is maintained at `docs/review/production-baseline-preview.lock.json` (`FIRST_PRODUCTION_BASELINE = NOT_ESTABLISHED` pending formal release). |

### Ledger update rule

If an agent discovers that the current branch has already corrected a `CONFIRMED_DEFECT`, it must not reimplement it. The agent must:

1. cite the current code path and regression test;
2. change the ledger status to `ALREADY_IMPLEMENTED` in its completion report;
3. run the required targeted validation;
4. make no unrelated refactor.

---

## 4. Mandatory Agent Rules

1. Read `AGENTS.md`, relevant ADRs, and existing tests before editing.
2. Read installed Remix 3.2.0 documentation before using an unfamiliar Remix API.
3. Do not edit locked historical migrations. Add forward migrations only when a DB change is genuinely required.
4. Preserve PostgreSQL/RLS as the final authorization and integrity authority.
5. Never weaken CSP, CSRF, RLS, segregation of duties, break-glass, upload quarantine, audit, production dev-login guards, or migration controls to make tests pass.
6. Use the shared route contract rather than adding new internal route literals.
7. User-visible errors must come from an explicit allowlist/stable domain-code model. Unknown exceptions receive generic public text.
8. Never expose secrets, SQL internals, filesystem paths, provider tokens, connection strings, or raw DB exceptions.
9. Add negative/adversarial regression tests for every security correction.
10. Keep commits/task changes narrow and reviewable.
11. If the current code already resolves a finding, confirm regression coverage, document it as already resolved, and do not rewrite working code.
12. Do not mark human security-review, penetration-test, real infrastructure, or production-assurance gates complete unless actually performed by the authorized party.
13. Stop when a Stop Condition in this plan is met.

---

# Phase P0: Authentication and Error-Surface Security

## P0.1 Eliminate login account-status enumeration

**Priority:** P0  
**Gate:** A  
**Primary area:** `apps/web/app/actions/session/controller.tsx`, password verification/authentication helpers and tests.

### Required public behavior

The following cases must expose the same user-visible response:

```text
unknown user
missing password hash
incorrect password
inactive account
disabled account
```

Public message:

```text
Invalid email or password.
```

For the HTML password-login POST, return **401 Unauthorized** for unknown user, missing password hash, incorrect password, inactive account, and disabled account. Use the same rendered generic failure body for all five cases. API authentication failures also use 401 per P1.2. Do not use 400 or 422 for a syntactically valid login request whose credentials/account state fail authentication.

### Timing-cost requirements

Implement a process-stable precomputed dummy verification hash using the **same production password algorithm and cost parameters** as ordinary password hashes.

Do not generate the dummy hash on each request.

Required flow:

```text
lookup account
      |
      +-- account missing / hash missing
      |       -> verify submitted password against DUMMY_HASH
      |       -> generic public failure
      |
      +-- account + hash present
              -> verify submitted password against REAL HASH
              -> evaluate active/disabled state
              -> generic public failure if password/state invalid
```

An inactive/disabled account with a real password hash must use the real hash verification path before returning the generic failure.

### Internal observability

Security/audit telemetry may retain distinct internal outcome codes such as:

```text
user_not_found
missing_password_hash
bad_password
account_inactive
account_disabled
```

These internal reasons must not appear in the client response.

### Required tests

- Unknown email and wrong password return identical public text/status.
- Missing password hash and wrong password return identical public text/status.
- Inactive/disabled accounts return identical public text/status.
- Correct password for inactive/disabled account still cannot authenticate.
- Internal attempt telemetry retains reason differentiation.
- Dummy verification uses the same password algorithm/cost family/configuration as production hashes.
- Do not assert identical wall-clock response durations; verify algorithm/cost configuration and code-path structure instead. Timing/network measurements may be supplementary only.

### Acceptance criteria

No user-visible path reveals whether an account exists, has a password, is inactive, or is disabled.

---

## P0.2 Stop raw MFA enrolment error leakage

**Priority:** P0  
**Gate:** A

### Primary area

- MFA enrolment controller
- central action-error utilities
- MFA tests

### Implementation

1. Remove direct rendering of `err.message` / optional equivalent.
2. Send diagnostic detail only to structured server-side logs, explicitly excluding TOTP secret, submitted verification code, recovery codes, session/token material, and passwords.
3. Include/use the existing request or correlation ID.
4. HTML clients receive a stable generic enrolment message.
5. API clients requesting Problem Details receive sanitized RFC 9457 output.
6. Never return SQL, schema, function, filesystem, provider, secret, or connection detail.

### Required tests

Inject exceptions containing:

```text
SQL text
schema/function names
filesystem paths
connection strings
secret-looking text
stack fragments
```

None may appear in HTML or Problem Details.

---

## P0.3 Replace denylist-style public error filtering with explicit allowlisting

**Priority:** P0  
**Gate:** A

### Primary area

`apps/web/app/actions/errors.ts` and all dependent action/controller tests.

### Policy

Unknown `Error.message` text must never become public detail automatically.

Use explicit mappings:

```text
stable domain code / known SQLSTATE / trusted ValidationError
                      |
                      v
approved public title/detail
```

Unknown error:

```text
500
+ generic public message
+ correlation ID
+ structured server-side diagnostic
```

### Rules

1. Trusted field errors from project validators may be returned.
2. Known domain codes map to curated public messages.
3. Stable database/PostgREST codes are preferred over text inspection.
4. Do not classify confidentiality using SQL keyword/path denylisting.
5. A compatibility fallback may use only an **exact, explicitly enumerated mapping** of known messages where no stable code is yet available. General substring matching, regular expressions, denylist-based public-safety classification, or returning the matched raw exception text are prohibited. Every compatibility mapping must name an owner/removal target and map to a separately curated public message.

### Required adversarial tests

Ensure these are not leaked:

- `/var/lib/postgresql/...`;
- `postgresql://user:secret@...`;
- arbitrary secrets without SQL keywords;
- multiline stack fragments;
- database diagnostics that avoid obvious `SELECT`/`FROM` words.

---

## P0.4 Add a separate password step-up throttle

**Priority:** P0  
**Gate:** A

### Decision

Step-up authentication uses a **separate throttle namespace**. Step-up password failures must **not increment the primary-login credential-lockout counter**.

Rationale: a compromised low-assurance session or repeated legitimate step-up mistakes must not provide a simple mechanism to lock the user out of primary authentication.

### Canonical throttle dimensions

Use the existing throttle service; do not invent a parallel throttle subsystem. Inspect its data model before implementation. The protection must not be a single counter whose entire key includes `session_id`, because creating a new session must not reset effective protection. Implement the closest supported combination of:

```text
per-user step-up protection across sessions
per-user + trusted-client-IP protection
per-current-session attempt protection
purpose = step_up
```

The user-level protection is authoritative across session rotation. The per-session dimension is supplemental, not the sole throttle boundary.

### Behavior

- Check step-up throttle before password verification.
- Record failed attempts.
- Record/clear successful state according to canonical throttle semantics.
- Successful step-up clears/resets the applicable step-up throttle.
- Session revocation naturally invalidates the session dimension.
- Repeated failures produce security telemetry.
- Trusted client IP must use the existing trusted-proxy implementation.
- An active step-up rate limit returns **429 Too Many Requests**. Emit an appropriate `Retry-After` header when the existing throttle policy exposes a reliable retry time. Do not reveal whether the supplied account identifier exists.

### Required tests

- Repeated wrong step-up password reaches configured threshold.
- Primary-login counter is unchanged by step-up failures.
- Correct password while the step-up throttle is active remains denied until policy permits retry.
- Successful permitted step-up resets/clears applicable throttle state.
- Session change/revocation prevents reuse of old throttle/session state.
- Forged forwarding headers cannot create an attacker-selected client-IP key.

---

## P0.5 Complete OAuth step-up binding without rewriting existing provider protection

**Priority:** P0  
**Gate:** A

### Existing protection to preserve

The current callback already compares the stored provider with the callback provider. Treat that comparison as `ALREADY_IMPLEMENTED`; do not rewrite the OAuth state machine simply to re-add it.

### Missing/required binding

For `intent.purpose === 'step_up'`, require every condition:

```text
intent ID valid and single-use
stable server-side session identifier used by the normal MMS session implementation is stored in the intent and exactly matches the callback session
initiating user ID is present (not optional)
user ID binding exactly matches the current authenticated user
intent not expired
intent.provider == callback provider
resolved external identity belongs to same current user
```

Reject provider mismatch before granting fresh step-up state.

### Required tests

- Start Microsoft step-up -> complete Google callback -> rejected.
- Start Google step-up -> complete Microsoft callback -> rejected.
- Same-provider linked identity -> succeeds.
- Replayed intent -> rejected.
- Different-user identity -> rejected.
- Expired intent -> rejected.

---

## P0.6 Fail closed for invalid Microsoft Entra tenant identity

**Priority:** P0  
**Gate:** A

### Verification gate before implementation

First determine the accepted Microsoft Entra tenant policy from ADR/configuration: single-tenant, explicitly allowed tenants, or deliberately multi-tenant. If this cannot be established, stop. Do not silently convert the application to single-tenant or broaden it to multi-tenant.

The implementation must use the established authentication library/JWKS validation path. Do not create custom JWT cryptography. Never treat a merely decoded `tid` claim as authenticated identity data. Cryptographic signature and applicable audience/issuer validation must succeed in accordance with the approved Entra validation model before claims are trusted.

When MMS is configured for a specific Entra tenant:

1. Require the token tenant identifier required by the configured validation mode.
2. Parse it according to documented Microsoft Entra semantics.
3. Require it to match the configured tenant.
4. Do not fall back to a broad/generic Microsoft issuer when `tid` is malformed or missing.
5. Validate cryptographic signature, audience, issuer/tenant relationship, nonce/state and other provider requirements using the approved library flow before identity resolution. Claim decoding alone is not validation.
6. Keep Google issuer logic independent.

### Tests

```text
configured tenant        -> accepted
wrong valid tenant       -> rejected
malformed tenant         -> rejected
missing tenant           -> rejected in tenant-bound flow
Google issuer flow       -> unaffected
```

---

## P0.7 Use configured application origin for IdP logout and OAuth callback URLs

**Priority:** P0  
**Gate:** A

### Required configuration behavior

Use validated `APP_BASE_URL` or the repository's canonical equivalent to construct:

- Microsoft Entra OAuth callback URL;
- Google OAuth callback URL;
- Microsoft Entra post-logout redirect URI;
- any other security-sensitive externally registered application callback origin.

Do not derive these origins from:

```text
context.url.origin
Host
X-Forwarded-Host
Forwarded host
```

unless a dedicated trusted-proxy normalization layer has already converted them into a separately validated canonical application origin. Preferred design remains explicit `APP_BASE_URL`.

### Startup validation

Production:

```text
absolute HTTPS URL required
```

Local/test may explicitly permit:

```text
http://localhost:<port>
http://127.0.0.1:<port>
```

Do not allow arbitrary production HTTP origins. Reject credentials/userinfo, query strings, and fragments in the configured application base URL. Explicitly document whether a deployment path prefix is supported; if not, reject non-root path prefixes at startup.

### Required tests

- Forged Host cannot change callback URL.
- Forged X-Forwarded-Host cannot change callback/logout URL.
- Production rejects invalid/non-HTTPS base URL.
- Local `localhost` and `127.0.0.1` configured origins work.
- Entra and Google callbacks use exactly the configured base origin.

---

# Phase P1: Authorization and HTTP Response Consistency

## P1.1 Introduce canonical authentication/role guard helpers

**Priority:** P1  
**Gate:** B

Create small helpers consistent with the existing Remix/context architecture, for example:

```text
requireAuth(context)
requireRole(context, allowedRoles)
forbiddenResponse(context, detail?)
```

Do not create a large authorization framework.

### Required behavior

- unauthenticated browser: canonical login flow/redirect;
- unauthenticated API: 401;
- authenticated but unauthorized: 403;
- Problem Details negotiation is consistent;
- correlation/request IDs are preserved;
- DB authorization remains final authority.

### Controller inventory and migration scope

Before changing controllers, create a finite inventory (for example `docs/review/controller-http-contract-inventory.md`) with columns:

```text
Controller/route
Authentication guard
Authorization guard
Structural 400
Semantic 422
Problem Details
HTML behavior
Documented exemption/reason
Migration status
```

Migrate in small reviewable batches, but **Gate B cannot close until every applicable controller under `apps/web/app/actions/` is accounted for and uses the canonical conventions or has a documented approved exemption**.

Partial migration is not an acceptable final state.

---

## P1.2 Fix the HTTP status-code convention

**Priority:** P1  
**Gate:** B

Use this project-wide convention for applicable controllers:

```text
400  malformed request / wrong primitive type / unparsable UUID/date/enum /
     structurally invalid payload

401  authentication required or invalid authentication for API response

403  authenticated caller lacks authorization

404  genuinely missing resource, or non-disclosure response where the
     accepted resource policy deliberately hides existence

409  workflow/state/concurrency conflict

422  structurally valid input that fails semantic/business/form validation

429  rate/throttle limit reached; include Retry-After when policy provides it

500  unexpected server failure
```

### Explicit exception

Anti-enumerating operations such as password-reset request may deliberately return a generic success response if that is the accepted security design.

### Requirements

- Failed HTML POST re-render must not default to HTTP 200.
- Validation tests must distinguish 400 from 422.
- Authorization tests must not accept 400 as proof of a 403 authorization rule.
- Document resource classes that intentionally use 404 rather than 403 for non-disclosure.

### Completion requirement

All applicable actions under `apps/web/app/actions/` must comply before Gate B closes.

---

## P1.3 Standardize RFC 9457 content negotiation

- API/problem clients receive `application/problem+json`.
- HTML clients receive the canonical rendered page/redirect behavior.
- Remove ad hoc plain-text `Forbidden`/`Unauthorized` responses in migrated controller paths unless deliberately emitted by the central helper.
- Use the same stable error codes/message mapping defined in P0.3.

---

## P1.4 Replace hard-coded internal routes with the shared route contract

Replace internal literals such as:

```text
/login
/profile
/admin/positions
/admin/assignments
/mfa...
```

with the existing `routes.*.href()` or equivalent route contract and safe query composition.

Do not replace external IdP URLs or intentionally non-route asset URLs.

Add a focused lint/static regression check if feasible without creating a brittle grep rule.

---

# Phase P2: Session Assurance Model Cleanup

## P2.1 Make `auth` the single assurance-state source of truth

**Priority:** P1  
**Gate:** B

MMS is not in production. Perform a clean cutover.

Canonical session state:

```text
session.get('auth')
```

Remove duplicate top-level reads/writes for:

```text
stepUpAt
mfaVerifiedAt
```

Do **not** add a backwards-compatibility shim solely for development/test sessions. Existing development/test sessions may be invalidated.

Keep these concepts distinct:

```text
authTime
mfaVerifiedAt
stepUpAt
```

### Tests

- login -> MFA -> step-up lifecycle;
- session rotation preserves canonical `auth` state;
- no top-level duplicate is written;
- stale top-level values, if manually inserted in a test, do not override canonical state;
- freshness middleware reads canonical values only.

---

## P2.2 Improve step-up expiry testing using controlled time

Introduce an injectable clock/time provider or focused test seam around assurance freshness.

Do not use real 10/15-minute sleeps.

Test:

```text
just before expiry
exactly at expiry
just after expiry
```

Also test normal middleware request handling rather than proving expiry solely by mutating JSON and calling an isolated helper.

---

# Phase P3: Identity and Break-Glass Correctness

## P3.1 Preserve complete profile data on identity-unlink failure

On unlink error, reload everything required by the profile page, including:

- linked identities;
- active sessions;
- other existing profile context.

Prefer one `loadProfileData()` helper shared by GET and error re-render.

### Test

Force unlink failure and assert existing active sessions are still rendered.

---

## P3.2 Validate opaque invitation/reset tokens structurally

Before DB calls or hidden-form rendering:

- require token presence;
- require non-empty value;
- enforce a safe maximum length;
- if the actual token codec defines an alphabet/encoding, validate using that codec or its parser.

Do not invent a regex without verifying the real token format.

Invalid token shape must receive the same safe invalid/expired response class and disclose no DB internals.

---

## P3.3 Verify break-glass session elevation ordering before changing it

**Verification-first task.**

Inspect current `breakGlassActivate` RPC and controller behavior first.

If the database RPC already atomically creates:

```text
break-glass role assignment
activation state
audit event
durable security-alert outbox rows
```

then treat the committed DB transaction as the authoritative activation transaction.

### Required controller behavior

1. Call activation RPC.
2. Only after successful RPC completion, refresh authoritative effective role/claims from DB.
3. Update/rotate session from that authoritative result.
4. Do not wait for external notification delivery. Durable transactional outbox is the accepted design.
5. On RPC failure, leave the caller's session unprivileged.

Remove any hard-coded session-role assignment only if authoritative refresh is available without weakening constraints.

### Tests

- failed activation RPC -> session remains unprivileged;
- successful activation -> refreshed session contains only the intended break-glass role/scope;
- external alert transport outage after outbox commit does not undo valid activation;
- expiry/deactivation immediately removes effective access.

### Required end-to-end stale-session test

1. Authenticate normally.
2. Activate break glass.
3. Verify a specifically allowed break-glass operation succeeds.
4. Keep the same authenticated session/cookie alive.
5. Expire or deactivate break glass through the supported mechanism.
6. Retry the previously allowed operation using the unchanged session.
7. Verify denial at the authoritative request/database boundary.

A test that only confirms removal of the database assignment is insufficient.

---

# Phase P4: Input and Controller Maintainability

## P4.1 Add typed FormData getters without breaking multipart upload boundaries

Create or extend canonical validators such as:

```text
requireText(form, name)
optionalText(form, name)
requireUuid(...)
requireEnum(...)
requireBoundedReason(...)
requireFile(form, name)
optionalFile(form, name)
```

### Rules

- Text/UUID/enum getters explicitly reject unexpected `File` values and other structural/type mismatches with the canonical **400 structural request error** defined in P1.2.
- File getters explicitly validate that a `File` is present where required.
- Inputs that are structurally well-formed but violate business/field rules use the canonical **422 semantic validation error** defined in P1.2.
- Never rely on `String(form.get(...))` for sensitive text input.
- Do not migrate legitimate multipart upload fields through text getters.
- Preserve upload size, MIME, quarantine, and scanner boundaries.

### Migration scope

Migrate admin, identity, session, MFA, break-glass, survey, and other action controllers that currently stringify raw form entries.

---

## P4.2 Extract duplicated admin page/form loaders

Create focused reusable loaders such as:

```text
loadPositionsFormData(client)
loadAssignmentsFormData(client)
```

Reuse the existing proposal-page data-loading pattern where appropriate.

GET and failed-action re-render paths must use the same loader so forms do not lose option/context data after validation or server errors.

---

## P4.3 Normalize JSX keys and static style placement

- Add stable `key` props to every mapped element.
- Avoid array-index keys where a stable domain ID exists.
- Hoist static `css(...)` declarations when values do not depend on render state and doing so matches existing style conventions.
- Do not turn this into a design-system rewrite.

---

# Phase P5: Test Infrastructure, CI, and Portability

## P5.1 Remove developer-specific Playwright dependency paths

Remove references similar to:

```text
/home/<developer>/...
```

### Required approach

- Prefer ordinary Playwright browser installation and discovery.
- Document required OS dependencies.
- If a custom library path is unavoidable in a specific environment, configure it through an explicit environment variable.
- Do not commit a developer-specific absolute path.
- Remove `--no-sandbox` from the default path unless the execution environment genuinely requires it; isolate/document the exception.

### Tests

- browser suite runs under a different Unix username/home directory;
- browser suite runs in CI;
- repository search finds no developer-specific home path.

---

## P5.2 Consolidate test helpers without violating package boundaries

Before adding `packages/test-utils`, inspect existing workspace and `check:boundary` rules.

If `packages/test-utils` is used, it must be:

- test-only/dev-only;
- referenced only through appropriate `devDependencies`;
- absent from production/browser runtime dependency graphs;
- accepted by `npm run check:boundary`.

Suggested separated modules may cover:

- acceptance JWT/test-key setup;
- signed test-session cookies;
- CSRF/session helpers;
- deterministic persona helpers;
- shared DB cleanup utilities where semantics truly match.

Do not create one large helper module coupling browser, DB, auth, and runtime concerns.

If the existing workspace architecture cannot accommodate a test-utils package cleanly, colocate focused helpers in the existing test structure instead.

---

## P5.3 Standardize test harness conventions

Document the supported split rather than forcing one harness everywhere:

- use Remix test facilities where Remix router/request behavior is required;
- use `node:test` for pure Node/unit utilities when no Remix harness is required;
- use pgTAP for database security/invariant tests;
- use direct PostgREST integration tests for the API/DB boundary;
- use Playwright for real browser acceptance behavior.

Remove accidental inconsistency, not purposeful layering.

---

## P5.4 Fix confirmed non-blocking CI secret scanning

Current snapshot evidence shows the Gitleaks job uses `continue-on-error: true`. Treat this as `CONFIRMED_DEFECT`, not a verification-only item.

Inspect `.github/workflows/ci.yml` to confirm the exact current syntax, then remove the non-blocking behavior. The current defect is equivalent to:

```text
continue-on-error: true
```

remove it.

Also:

- pin the action according to repository supply-chain policy;
- ensure release/provenance success depends on a completed successful secret scan; a failed, cancelled, or skipped required secret-scan job must prevent a successful release/provenance result;
- add a lightweight CI/static assertion where practical to prevent accidental reintroduction of non-blocking scanning.

If a newer branch has already made the scan blocking, do not rewrite it merely to satisfy this task. Record it as `ALREADY_IMPLEMENTED` and retain regression evidence.

---

# Phase P6: Documentation and Status Integrity

## P6.1 Reconcile break-glass drill wording

The tested/authoritative automated policy is 92 days.

- Remove obsolete active 100-day wording or mark it clearly as superseded historical material.
- Do not change runtime policy back to 100 days to match stale documentation.

---

## P6.2 Reconcile R8.6 status

Update status documentation to reflect the actual R8.6 closure state.

Keep these explicitly open until actually performed:

- required two-human security review;
- external penetration testing;
- real Entra deployment validation;
- real Key Vault/key-management validation;
- real immutable/WORM storage validation;
- production backup/restore verification;
- physical/runtime workload separation evidence;
- other documented production assurance gates.

Coding agents cannot self-approve these.

---

## P6.3 Separate current requirements from historical progress narratives

Keep the authoritative implementation plan focused on current target requirements.

Move obsolete progress commentary to a reviewed history location such as:

```text
docs/review-history/
```

or mark it explicitly superseded.

Do not leave contradictory historical instructions next to active agent instructions.

---

# Phase P7: Additional Independent Hardening

## P7.1 Harden E2E server reuse detection

Current acceptance runners must not reuse an existing server merely because `/login` returns HTTP 200.

Implement a stronger acceptance-instance identity, for example:

- dedicated test-only readiness endpoint; or
- application build/environment fingerprint returned only in local/test; or
- equivalent explicit handshake.

Required proof:

```text
correct MMS acceptance server -> reusable
unrelated HTTP server returning /login 200 -> rejected
stale MMS non-test server -> rejected
```

Do not expose sensitive environment information.

---

## P7.2 Tighten negative-test status assertions

Replace overly broad checks such as:

```text
status >= 400
```

when the security contract is known.

Examples:

```text
role/SoD denial -> 403
malformed request -> 400
semantic validation -> 422
conflict -> 409
non-disclosure resource policy -> documented 404 or 403
```

A malformed request must not count as proof of an authorization rule.

Document the expected non-disclosure policy per relevant resource class.

---

## P7.3 Derive runtime version/status output from the canonical version policy

`testenv:status`, `testenv:check`, and test-environment startup must use the same version-policy implementation.

Do not hard-code display strings such as `PostgreSQL 18.6` in status output if the actual server version can be queried.

Report:

```text
detected version
approved policy/range
pass/warn/fail decision
```

from one canonical module.

---

## P7.4 Validate PostgREST readiness semantically

A generic HTTP 404 is not sufficient proof that the expected PostgREST API is ready.

Require evidence equivalent to:

```text
daemon reachable
expected PostgREST response/OpenAPI endpoint
expected API schema/cache available
```

Use official PostgREST behavior already supported by the current version rather than creating an unrelated health protocol.

---

## P7.5 Consolidate error classification around stable codes

Audit remaining error classifiers.

Preferred precedence:

```text
trusted local ValidationError
stable domain code
stable SQLSTATE/PostgREST code
explicit compatibility mapping
unknown -> generic internal error
```

Message substring matching must not remain the ordinary authorization/control-flow mechanism.

---

# P9: Technical Audit Schema Rename and Maritime Audit Namespace Reservation

**Classification:** DESIGN_IMPROVEMENT with domain-model namespace impact  
**Priority:** Complete after P0-P7 rectification but before P8 production audit-service wiring and before implementation of the maritime Company Audit domain.  
**Gate:** Domain Namespace Gate F

## P9.1 Mandatory architecture rule

After this phase:

```text
audit_trail = technical/system audit evidence
audit       = reserved maritime Company Audit namespace
```

Do not create maritime Company Audit tables merely to occupy `audit`. The schema may remain absent/reserved until its domain ADR is approved.

## P9.2 Create a dependency inventory before editing

Before changing SQL, create a reviewed inventory of every current reference to `audit` across:

```text
db/src/**
db/migrations/**
db/tests/**
apps/**
packages/**
scripts/**
.github/**
docs/**
PostgREST configuration
search_path configuration
GRANT / REVOKE
RLS policies
SECURITY DEFINER bodies
views/materialized views
triggers
pgTAP
worker/sealer/reconciliation tooling
WORM tooling
backup/restore verification
monitoring/operations SQL
```

Classify each match as exactly one of:

```text
CURRENT_EXECUTABLE_REFERENCE
HISTORICAL_LOCKED_MIGRATION
TEST_REFERENCE
CONFIGURATION_REFERENCE
DOCUMENTATION_REFERENCE
FUTURE_MARITIME_AUDIT_REFERENCE
```

Do not perform blind repository-wide replacement.

## P9.3 Resolution via Pre-Production Baseline Normalization

P9 was resolved through pre-production baseline normalization.

Every prototype migration creates/references `audit_trail`.

No forward `audit` → `audit_trail` migration is required because no deployed database depends on `audit`.

`audit` remains reserved for the maritime Company Audit domain.

`FIRST_PRODUCTION_BASELINE` is currently `NOT_ESTABLISHED` pending formal production release. An authoritative preview of the normalized 84-migration baseline is verified at `docs/review/production-baseline-preview.lock.json`. Permanent immutability will be established upon formal release via `npm run db:baseline:freeze`.

### Architectural Context & Decision
Because MMS has not yet entered production and has no non-disposable production database containing live records, maintaining an artificial forward migration (`ALTER SCHEMA audit RENAME TO audit_trail`) and synthetic reverse-rename upgrade tests introduced unnecessary architectural debt. All 84 prototype migrations were normalized to establish `audit_trail` directly from their initial definitions. All executable SQL, tests, and configuration reference `audit_trail`.

The schema `audit` remains completely reserved for the future maritime Company Audit domain.

## P9.4 Security invariants

Capture and compare before/after evidence for:

```text
schema owner
object owners
GRANT/REVOKE state
PUBLIC privileges
RLS enabled/forced state
function EXECUTE privileges
capability roles
worker privileges
audit-sealer privileges
PostgREST exposure
SECURITY DEFINER settings
```

The rename must not provide additional read, write, execute, ownership, or bypass authority.

Any `SECURITY DEFINER` code must continue to use the accepted secure search-path convention and fully qualified object names.

## P9.5 Application and source terminology

Update code/configuration where the identifier refers specifically to the technical audit subsystem.

Prefer:

```text
auditTrail...
audit_trail.event
audit_trail.change_log
```

Do not create unnecessary churn by renaming generic local symbols where there is no ambiguity.

Once the maritime Company Audit domain is formally implemented, `audit` may naturally contain business concepts such as:

```text
audit.programme
audit.job
audit.assignment
audit.report
audit.finding
audit.corrective_action
```

The exact maritime schema must still be defined by its own ADR/domain-design phase.

## P9.6 ADR requirement

Create or amend an ADR recording:

```text
Decision:
  audit_trail = technical/system audit evidence
  audit       = reserved maritime Company Audit domain

Rationale:
  avoid semantic collision between a system audit trail and classification-society
  Company Audit programmes/jobs/reports/findings/corrective-action workflows.

Rejected alternatives:
  logging      - ordinary log semantics, too weak for authoritative evidence
  history      - too generic
  compliance   - conflicts with broader HO Compliance semantics
  system_audit - acceptable but more ambiguous than audit_trail
```

Update current architecture/database documentation and agent instructions. Historical documents/migrations may retain the old name when clearly historical.

## P9.7 Required tests

Verify at minimum:

1. Fresh bootstrap plus all forward migrations results in technical objects under `audit_trail`.
2. The old technical `audit` schema is absent after migration unless a separately approved maritime-domain migration has intentionally created it.
3. Event/change transaction correlation still works.
4. Audit reconciliation still works.
5. Signing/sealing still works.
6. WORM evidence generation and verification still work.
7. Scope-filtered technical audit visibility is unchanged.
8. Unauthorized direct update/delete remains denied.
9. Worker and sealer privileges are unchanged.
10. Backup/restore verification uses `audit_trail` successfully.
11. PostgreSQL ACL/owner comparison shows no privilege broadening.
12. `db:check`, `db:spike`, `db:test`, and `db:verify` pass.
13. `release:check` passes and historical migration hashes remain intact.

## P9.8 Repository consistency gate

After the change, every remaining current `audit_trail.` reference must be classified as:

```text
historical locked migration
historical/superseded documentation
approved maritime Company Audit implementation
```

Any unexplained executable reference to the former technical schema is a release blocker.

## P9.9 Ordering

Use this order:

```text
P0-P7 security/code-quality rectification
        ↓
P9 rename technical audit schema to audit_trail
        ↓
P8 operational audit-trail/compliance readiness
        ↓
future maritime-domain programme
        ↓
Company Audit domain implemented under audit
```

This ordering prevents P8 operational integrations from being newly wired to a schema name that is already planned for replacement.

## P9 Stop Conditions

Stop and request review if:

1. a production/external dependency relies on literal schema name `audit` and lacks an atomic migration path;
2. a locked historical migration would need editing;
3. owner/ACL/RLS/function privilege behavior changes unexpectedly;
4. PostgREST exposure changes unexpectedly;
5. sealer/WORM/reconciliation continuity cannot be preserved;
6. an approved ADR already assigns `audit` to an incompatible purpose;
7. implementation would require premature Company Audit business tables.

## Gate F: Domain Namespace Readiness

Gate F closes only when:

- [ ] the technical schema is `audit_trail`;
- [ ] current executable/configuration references use `audit_trail`;
- [ ] locked historical migrations are unchanged;
- [ ] owner/ACL/RLS behavior is unchanged;
- [ ] reconciliation/sealing/WORM verification passes;
- [ ] operational tooling uses `audit_trail`;
- [ ] `audit` is documented as reserved for maritime Company Audit;
- [ ] no maritime Company Audit model was introduced prematurely;
- [ ] full DB/release gates pass.

---

# Phase P8: Audit and Compliance Operational Readiness

**Classification:** PRODUCTION_ASSURANCE_GAP  
**Priority:** Separate from P0-P7 code correction  
**Gate:** Production Assurance Gate E

After P9, the technical evidence subsystem is named `audit_trail`. Its architecture is strong, but test-covered modules are not sufficient evidence that production compliance services are operational. This phase must not be mixed into the authentication/security correction commits.

## P8.1 Inventory audit/compliance runtime services

Inspect and classify at least:

```text
retention.ts
crypto-shredder.ts
log-forwarder.ts
audit sealer
reconciliation/verification jobs
WORM writer/verification
```

For each component first classify **APPLICABLE** or **NOT_APPLICABLE** to the intended production architecture. `NOT_APPLICABLE` requires a documented architectural reason and approval; do not leave status ambiguous and do not wire every module merely because it exists.

For each applicable component record:

```text
continuous service / scheduled job / on-demand operation
runtime identity
trigger/cadence
input/output
retry/dead-letter behavior
monitoring/alert ownership
recovery behavior
production dependency
```

Do not wire a module merely because it exists. Confirm the intended operational semantics from ADRs/architecture documentation first.

## P8.2 Connect retention and crypto-shredding to authorized workflows

- Before enabling destructive retention/crypto-shredding, require approved retention schedule, legal-hold policy, authorization/approval rules, and applicable compliance owner.
- Define which records/keys are eligible for retention expiry or cryptographic destruction.
- Ensure authorization, approval, legal hold, audit evidence, and segregation of duties are explicit.
- Make operations idempotent/restart-safe.
- Never allow a normal application role or generic sysadmin role to bypass retention/legal-hold controls merely by invoking the module.
- Add dry-run/reporting mode where appropriate before destructive execution.

## P8.3 Connect log forwarding to the intended external sink

- Use a separate restricted runtime identity.
- Redact secrets, credentials, session tokens, TOTP material, recovery codes, document content, and unnecessary personal data.
- Define buffering/retry behavior during sink outage.
- Monitor queue age/failure/dead-letter state.
- Verify forwarding failure cannot silently delete the authoritative local audit evidence.

## P8.4 Operational monitoring and overdue-job controls

For every scheduled/continuous `audit_trail`/compliance service define measurable health signals:

```text
last successful run
duration
processed count
failure count
retry/dead-letter count
oldest pending age
last verified audit sequence/hash
WORM write/verification status
```

Create alerts for failure and overdue execution according to approved operational policy. Do not invent production paging thresholds if none are approved; record the decision required.

## P8.5 Crash/outage recovery verification

Test at least:

- worker/process crash after job claim;
- database reconnect/restart;
- external log sink outage;
- WORM storage outage;
- retry after partial external side effect;
- duplicate runtime instances;
- restart after lease expiry;
- reconstruction/verification after backup restore.

Prove at-least-once/idempotent behavior where applicable and prove duplicate execution does not corrupt audit evidence.

## P8.6 Real WORM and audit restoration evidence

Before production approval:

1. Write sealed evidence to the actual production-equivalent immutable/WORM storage service.
2. Verify configured retention/immutability policy with the actual provider controls.
3. Restore a database backup to an isolated environment.
4. Reconcile restored `audit_trail` records to WORM evidence.
5. Verify signature/hash-chain checks.
6. Record discrepancies and remediation.
7. Store drill evidence under the approved operations/compliance process.

A filesystem/mock/test adapter is not evidence of production WORM compliance.

## P8 acceptance criteria

P8 is complete only when:

- [ ] Every audit/compliance module is explicitly classified APPLICABLE or approved NOT_APPLICABLE.
- [ ] Every applicable module has an explicit runtime owner and execution model.
- [ ] Retention/crypto-shredding is connected only through approved authorized workflows.
- [ ] Log forwarding is connected to the intended production-equivalent sink and tested under outage.
- [ ] Monitoring detects failed and overdue audit jobs.
- [ ] Crash/restart/duplicate-worker behavior is tested.
- [ ] Real immutable/WORM controls are verified outside the source repository.
- [ ] Database restore + `audit_trail`/WORM reconciliation drill succeeds.
- [ ] Evidence and residual risks are recorded.

---

# 5. Validation Cadence

## 5.1 After each atomic task

Run targeted validation only:

- relevant workspace/package typecheck;
- directly relevant unit/integration tests;
- relevant lint/boundary test;
- focused pgTAP/database tests if DB code changed;
- focused Playwright test if browser behavior changed.

Do **not** rebuild/reset the entire acceptance environment after unrelated JSX, documentation, or small utility changes.

Agents must record the exact commands and exit status in their completion report.

## 5.2 At each phase boundary

Run broader affected suites.

### P0/P1/P2 boundary

Run all authentication, authorization, session, error-response, direct PostgREST, and relevant browser tests.

### Database/security-affecting phases

Also run:

```bash
npm run db:check
npm run db:spike
npm run db:test
npm run db:verify
```

### P5/P7 boundary

Run:

```bash
npm run check:boundary
npm run test:acceptance:integration
npm run test:e2e:browser
```

using the actual repository-equivalent script names.

---

# 6. Required Final/Release Validation Gate

After all phases are complete, run repository-equivalent commands. Before `testenv:reset`, positively verify that `APP_ENV`/equivalent is local/test, the target is the marked disposable test/acceptance database, host/name/marker safety checks pass, and no production/shared operational database can be targeted. Never bypass reset safety to complete this gate:

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

npm run test:acceptance:integration
npm run test:e2e:browser
npm run test:e2e

npm run release:check
```

If a script name differs, use the repository's existing equivalent rather than adding a redundant alias merely to match this document.

Separately report:

```text
unit/package tests
pgTAP/database tests
HTTP/router acceptance integration
direct PostgREST tests
Playwright browser tests
boundary checks
release gate
```

Do not describe an HTTP/router runner as Playwright.

---

# 7. Release Gates

## Gate A: Authentication and error-surface security

Must complete P0 entirely.

Gate A cannot close with:

- account-state enumeration;
- raw exception rendering;
- denylist-based unknown error exposure;
- unthrottled password step-up;
- cross-provider step-up ambiguity;
- fail-open/ambiguous Microsoft tenant validation;
- request-derived OAuth/logout origins.

## Gate B: HTTP and session consistency

Must complete P1 and P2.

Gate B requires **all applicable** `apps/web/app/actions/` controllers to comply with the chosen guard/response/status conventions. No partial final migration.

No duplicate assurance-state source of truth may remain.

## Gate C: Maintainability and test portability

Must complete P3-P5.

Browser tests must run without developer-specific filesystem assumptions.

## Gate D: Documentation and independent hardening

Must complete P6/P7 and ensure active instructions reflect actual runtime behavior.

## Gate E: Audit and compliance operational readiness

P8 is a production-assurance gate, not a prerequisite for merging P0-P7 code corrections. P9 must be complete before P8 tooling is newly wired to the renamed technical evidence schema. It must be complete before production use of controlled maritime records depends on the audit/compliance services described in P8.

## Production Gate

Remains separate from these code gates.

Do not declare production readiness until existing external/human requirements are actually completed, including applicable:

- two-human security review;
- external penetration test;
- production Entra validation;
- production key/vault validation;
- real WORM/immutable audit-storage validation;
- backup/restore drill;
- physical/runtime workload separation verification.

---

# 8. Stop Conditions

Stop and request an architectural/security decision if:

1. a correction requires weakening database/RLS authority;
2. provider/tenant authentication policy conflicts with an accepted ADR;
3. the existing throttle service cannot express the required separate step-up throttle without materially redesigning account lockout policy;
4. the actual opaque invitation/reset token format cannot be determined from code/ADR/tests;
5. a locked historical migration would need editing;
6. Playwright would require disabling production CSP/authentication protections;
7. a human security-review or production-assurance checkbox would need agent approval;
8. R9 domain functionality would have to be implemented to close these findings;
9. removing a request-derived callback origin conflicts with a documented trusted-proxy/deployment contract;
10. a test helper/package would have to violate `check:boundary` or enter production runtime dependencies.

---

# 9. Recommended Execution Order

```text
P0.1 account-enumeration + timing parity
        ↓
P0.2/P0.3 error leakage/public-message model
        ↓
P0.4 separate step-up throttle
        ↓
P0.5/P0.6 provider + Entra tenant binding
        ↓
P0.7 configured callback/logout origin
        ↓
Gate A validation
        ↓
P1 canonical guards/status/problem details/routes
        ↓
P2 assurance-state cleanup + controlled expiry testing
        ↓
Gate B validation
        ↓
P3 identity + verified break-glass ordering
        ↓
P4 typed forms/loaders/small UI cleanup
        ↓
P5 Playwright portability/test-utils/CI scan
        ↓
Gate C validation
        ↓
P6 documentation status cleanup
        ↓
P7 independent hardening
        ↓
Gate D validation
        ↓
P9 pre-production baseline normalization (audit_trail)
        ↓
Gate F domain-namespace validation (resolved via normalization)
        ↓
P8 audit_trail/compliance operational readiness (separate production-assurance workstream)
        ↓
Gate E production-assurance validation
        ↓
full final/release validation gate
```

P0.2 and P0.3 should normally be implemented together.

P0.5 and P0.6 may be implemented together when they touch the same OAuth verification boundary.

P5 work may run in parallel with P3/P4 if file ownership does not conflict, but it must not delay Gate A/B security fixes.

P9 must precede new P8 production integration work so retention, forwarding, reconciliation, sealing, WORM, backup/restore, and monitoring are not newly wired to a schema name scheduled for replacement. The future maritime Company Audit bounded context remains outside this rectification cycle except for reserving the `audit` namespace.

---

# 10. Standard Agent Completion Report

Every agent must finish an assigned task with:

```text
TASK COMPLETION REPORT

Task IDs:
Commit/branch:

Files changed:
Migrations added:

Behavior before:
Behavior after:

Security impact:
Authorization impact:
Session/authentication impact:

Tests added/updated:
Targeted commands run + exit status:
Phase-gate commands run + exit status:

Compatibility decisions:
Documentation updated:

Human/production gates intentionally left open:
Known limitations:
Residual risks:
Existing security invariants weakened: NONE (or explicitly STOP and explain)
Unverified assumptions:
Follow-up task IDs:
```

An agent must not claim a task is complete when required tests were skipped without stating exactly which test could not run and why.

---

# 11. Final Instruction to Implementing Agents

This is a focused security/correctness and consistency rectification cycle, not another MMS architecture rewrite.

The only domain-namespace change in this rectification cycle is P9: reserve `audit` for maritime Company Audit and normalize the technical evidence schema to `audit_trail` throughout all prototype migrations. Do not implement Company Audit business entities here.

Optimize for:

```text
fail-closed behavior
stable domain/error codes
uniform security responses
explicit trust boundaries
database-enforced authority
reproducible adversarial tests
portable acceptance infrastructure
clean current documentation
```

Do not optimize for the number of files changed.

Where existing code already implements the required behavior correctly, prove it with tests, record it as verified, and move to the next finding.
