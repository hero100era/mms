# Threat model

- Status: refreshed 2026-11-03 (Card H-12) for the M3/M4/M5 slice and hardening cards
  H-01 to H-11. Supersedes the F-01 draft.
- Scope: browser, BFF (`apps/web`), PostgREST, PostgreSQL, identity providers, file
  storage, the worker and sealer deployments, and CI.
- Review triggers: a new identity provider, a new schema with regulated data, a new
  file-storage path, a new privileged role or login role, a new background process, or any
  change to the token signer, session storage, grants or policies. The runbook is
  [security-review-and-drills.md](runbooks/security-review-and-drills.md).

## Assets

- User identities, credentials (password hashes, TOTP secrets, linked identities) and
  sessions.
- The ES256 signing key for BFF-issued PostgREST tokens, and its rotation window.
- The database login roles: `mms_owner`, `auth_gateway`, `worker`, `audit_sealer`,
  `mms_emergency`, `authenticator`, `migrator`, and the capability roles.
- Regulated records (survey, fleet, party) and their Tier-1 audit trail.
- The Tier-2 seal chain and the WORM objects it commits to.
- Uploaded evidence and its metadata.
- The deploy pipeline, its secrets and the migration history.

## Actors and trust boundaries

| Actor | Trust | Holds |
| --- | --- | --- |
| Browser | Untrusted | An opaque session cookie; public data only |
| BFF web tier | Trusted server | Session storage, signing key, `auth_gateway` and PostgREST credentials |
| Worker process | Trusted, separate deployment | Only the `worker` login role (H-11) |
| Sealer process | Trusted, separate deployment | Only the `audit_sealer` login role (H-11) |
| PostgREST | Trusted data API, private network | Public keys, not signing keys |
| PostgreSQL | System of record | Enforces grants, RLS, transition functions and the audit trail |
| Entra / external IdP | Trusted for authentication after ID-token validation | Signing keys for its own tokens |
| Compliance verifier | Trusted, human-run | Reads `audit_trail.seal` and the WORM store, writes nothing |
| Operator / CI | Privileged | Must not be able to read application secrets from code |

The browser never reaches PostgREST or PostgreSQL. The BFF-to-PostgREST hop is a
short-lived ES256 JWT (300 s) carrying `sub`, `role`, `sid`, `amr`; PostgREST-to-PostgreSQL
uses `authenticator` then `SET LOCAL ROLE` to the capability role, and
`private.pre_request()` re-validates the session and the role before the request runs.

## Threats and controls

| Threat | Control | Where |
| --- | --- | --- |
| Credential stuffing or password spraying | Per-name and per-IP attempt counting with lockout; breached-password check at set time; TOTP second factor for external password users | `auth.login_attempt`, `auth.password_*`, `middleware/require-mfa.ts` |
| Second factor bypassed or replayed | TOTP verified inside PostgreSQL, single-use `last_step` watermark, ±1 step drift, 5 failures locks 15 minutes; the secret never reaches the BFF | `auth.totp_verify`, `iam.totp_credential`, ADR-0019 |
| TOTP secret disclosure | `secret` column excluded from audit payloads; no grant or policy on the table; only `auth_gateway` may execute the verifier | `db/seed/030_audit_exclusions.sql`, `iam` RLS |
| Session theft or fixation | HttpOnly/Secure/SameSite cookie; id rotation on login, link, role switch and step-up; server-side sessions with idle and absolute timeouts; caches cleared on rotation | `auth/session-storage.ts`, `auth.session_*` |
| CSRF | Origin/Referer check plus `_csrf` token for unsafe methods, evaluated before the session layer | `middleware/csrf.ts` |
| OAuth code interception or mix-up | State, nonce and PKCE S256; `iss`/`aud`/signature/nonce validation; tenant allowlist | `actions/auth/controller.tsx`, `auth/helpers.tsx`, `auth/google.ts`, `auth/entra.ts` |
| Forged or replayed BFF token | ES256, 300 s TTL, `aud`/`iss` checks, published JWKS with `kid`, rotation via publish-then-sign-then-retire, never in browser storage | `auth/token-signer.ts`, ADR-0004, runbook `signing-key-rotation.md` |
| Privilege escalation by role switching | The active role is a claim minted after a database check that the user holds a live assignment for it; the database re-checks scope, position and grade on every call | `auth.session_set_role`, `private.assert_authority` |
| Authority beyond one's position | `private.assert_authority` matches a seeded `iam.authority_rule` on role, family, unit type, grade and amount; denial emits `authz.denied.insufficient_authority` | `db/src/private/main.sql`, `db/seed/020_iam_reference.sql` |
| Cross-unit access (IDOR) | RLS on every table plus `private.assert_in_scope` on writes; `private.my_units()`/`my_offices()` derive scope from the position, never from the request | `db/src/*/main.sql`, `db/tests/` |
| Standing global administrator | Break-glass accounts are dormant: a registry row, no assignment, no session until a reason is recorded; window ≤ 4 h carried in the token and re-checked per request | ADR-0020, `auth.break_glass_*`, `private.pre_request()` |
| Break-glass used for business acts | A break-glass account holds no staff position, so `assert_authority` refuses every regulated action; it can only administer | `api.emergency_*` grants, runbook `break-glass.md` |
| Sealing stopped or forged by the app | Sealer runs as its own deployment with only `audit_sealer`; the web tier holds no sealer credential; chain hashes and WORM objects are verified independently | ADR-0021, `audit/sealer.ts`, `audit/verifier.ts` |
| Lost or altered audit trail | Tier-1 writes are transactional with the business change; append-only tables without UPDATE/DELETE grants; Tier-2 seal chain; `audit_trail:reconcile` for pgaudit forwarding gaps | ADR-0007, ADR-0013, `scripts/reconcile-audit_trail.ts` |
| Deleted history through retention | Retention prunes only after sealing (`tx_id < max_sealed_xid`) and records the purge; crypto-shredding removes key material, not rows | ADR-0014, `audit/retention.ts` |
| Malicious uploads | Size/type limits, sniffer, malware scan before promotion, quarantine bucket, no execution path | ADR-0016, `jobs/malware-scanner.ts` |
| Secret leakage into browser assets | Server-only modules; a boundary check asserts the signer, gateway client and DB clients are absent from browser output | `scripts/check-browser-boundary.mjs` |
| SQL injection | Parameterised queries, no dynamic SQL from input, views with `security_invoker`, reviewed `SECURITY DEFINER` functions with `set search_path = ''` | `db/src/**`, schema lint |
| Definer function impersonation | `private.caller_role()` instead of `session_user`/`current_user`; the lint rejects those tokens inside function bodies | ADR-0017, `db/scripts/lint-schema.ts` |
| Emergency role abuse | `mms_emergency` is `nologin` until an incident, holds only `usage` on `iam`, and every runbook function refuses callers that are not that role | `db/bootstrap/01_roles.sql`, `db/src/api/main.sql` |
| SSRF through URL fields | Outbound destinations are configured, not user-supplied | `auth/*.ts` |
| Supply chain | Lockfile, exact Remix pin, `npm ci` from the lockfile, review of dependency updates | `package-lock.json` |
| Development shortcuts reaching production | `assertDevAuthAllowed()` refuses the dev auth stub unless explicitly enabled outside production | `auth/dev-stub.ts` |

## Residual risks

1. **The BFF remains the highest-value target.** It holds sessions and the signing key. A
   compromise is bounded by the 300 s token TTL and by the database re-checking authority,
   but not prevented. Keep the key in a managed store (H-06).
2. **The pen test is outstanding.** Everything here is a design review plus tests; an
   external adversarial review is a G3 release input (H-12).
3. **Break-glass recovery when both holders are unavailable** is unresolved. The runbook
   names it; the design does not solve it.
4. **The sealer and worker are separate deployments by configuration, not by
   infrastructure.** If the manifest co-locates them, the separation is nominal. The pen
   test should verify the deployed manifest (H-12).
5. **TOTP has no recovery codes.** A lost authenticator plus a lost password leaves an
   external user dependent on support. Documented in ADR-0019.
6. **Internal users authenticate through Entra**, so MFA strength for staff is Entra's
   Conditional Access, not ours (H-09 covers external password users only).
7. **pgaudit forwarding is reconciled, not real-time.** A gap between the database and the
   off-DB log store is detected after the fact (ADR-0013).
8. **Crypto-shredding is irreversible by design**; a key destroyed in error cannot be
   reconstructed, and only the audit trail shows it happened.
9. **No penetration of the WORM storage account itself.** Immutability is a policy on the
   container; its administration is out of scope for this application's tests.
10. **Local development runs without Docker**, so the compose topology is not exercised by
    the test suite.

## Review record

| Date | Change | By |
| --- | --- | --- |
| 2026-11-03 | Refreshed for H-01..H-11: sealing, TOTP, break-glass, deployment split; residual risks renumbered | H-12 |
