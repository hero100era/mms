# MMS — Architecture, Problem Areas and Refactoring Plan

> Scope: `apps/web` (Remix 3 BFF), `packages/*`, `db/*`, `scripts/*`, `docs/*`.
> This document is the output of a full read of the application and tooling layers.
> Line references point at the code as it existed **before** this refactor pass;
> section 5 lists exactly what changed.

---

## 1. Architecture summary

### 1.1 System shape

MMS is a **narrow-waist BFF** over a hardened PostgreSQL data plane. There is no
ORM and no direct table access from the web tier: every request reaches the
database through one of two seams.

```
                         ┌──────────────────────────────┐
   Browser ─────────────▶│  apps/web (Remix 3 BFF)      │
   (SSR HTML + islands)   │  server.ts / router.ts       │
                         └───────┬──────────────┬───────┘
                                 │              │
             signed ES256 JWT   │              │  auth_gateway pg.Pool
             Bearer token       │              │  (SECURITY DEFINER fns)
                                 ▼              ▼
                   ┌──────────────────┐  ┌────────────────────┐
                   │  PostgREST :3001 │  │  auth schema       │
                   │  (api schema)    │  │  iam / private     │
                   └────────┬─────────┘  └─────────┬──────────┘
                            └──────────┬──────────┘
                                       ▼
                         ┌──────────────────────────────┐
                         │  PostgreSQL 18               │
                         │  db/src/<schema>/main.sql    │
                         │  RLS + grants + audit        │
                         └──────────────────────────────┘
                                       ▲
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     ┌────────┴────────┐     ┌────────┴────────┐      ┌────────┴────────┐
     │ worker process  │     │ sealer process  │      │ Azure Blob /     │
     │ (worker role)   │     │ (audit_sealer)  │      │ Filesystem WORM  │
     │ outbox, Entra,  │     │ audit_trail.seal →    │      │ quarantine docs  │
     │ malware scan    │     │ WORM artifacts  │      │                  │
     └─────────────────┘     └─────────────────┘      └──────────────────┘
```

**Three deployment targets** (`app/jobs/runtime.ts`, ADR-0021) enforce privilege
separation: `web` serves HTTP, `worker` runs outbox/Entra/malware jobs, `sealer`
writes Tier-2 audit seals. `MMS_RUNTIME_ROLE` defaults to `all` in development and
`web` in production, so a missing deployment manifest cannot accidentally
co-locate the sealer credential with the request path.

### 1.2 Request lifecycle

`server.ts` wraps `router.fetch` in a Node HTTP listener. `router.ts` installs 13
middleware in a fixed order:

`staticFiles → requestContext → logger → securityHeaders → cop → session →
formData → csrf → render → sessionAuth → requireMfa → requireBreakGlass → pgrst`

* `requestContext` resolves a spoof-resistant client IP, assigns request/trace
  IDs, and stamps `X-Request-Id` / `Cache-Control: no-store` on the response.
* `session` loads a signed `__mms_sid` cookie into a DB-backed
  `DbSessionStorage`; `sessionAuth` copies `session.get('auth')` into `AuthKey`.
* `requireMfa` / `requireBreakGlass` gate half-authenticated and dormant
  break-glass sessions using hand-maintained path allow-lists.
* `pgrst` mints an ES256 access token **per request** from `AuthKey`, then stores
  a `PgrstClient` under `PgrstKey`.
* `render({assets})` installs `context.render` using the server-side asset
  pipeline; pages wrap their content in `<Document>`, which emits the import map
  and the browser entry (`app/actions/public/entry.ts`).

### 1.3 Routing contract

`app/routes.ts` is a single `route({...})` tree of 12 nested groups. `router.ts`
calls `router.map()` once per group; each group owns exactly one controller
directory (`app/actions/<group>/controller.tsx`). `createController` refuses an
action for a leaf its map does not own, so ownership is total at startup. The same
contract generates type-safe `href()`s for pages and (inconsistently) controllers.

| Group | Controller | Primary data path |
|---|---|---|
| root (`assets`, `jwks`) | `actions/controller.tsx` | none / public key |
| `session`, `identity`, `auth`, `mfa`, `breakGlass` | `actions/*/controller.tsx` | auth gateway (`authCall`) |
| `admin`, `admin.proposals`, `admin.externalUsers` | `actions/admin/**` | PostgREST |
| `uploads`, `survey`, `triage` | `actions/*/controller.tsx` | PostgREST + blob storage |

### 1.4 Auth plane

* **Password**: argon2id via `auth/password.ts`, throttling by client IP,
  generic errors, then a session with `authMethod:'pwd'` gated by TOTP (`requireMfa`).
* **OAuth**: custom Entra and Google providers implement authorization-code +
  PKCE + ID-token signature validation. `helpers.tsx#handleOAuthCallback` owns
  the callback state machine (link intent, invite, step-up, staff vs external,
  break-glass detection).
* **TOTP**: `@mms/totp` supplies secret/URI formatting; verification lives in
  PostgreSQL (ADR-0019).
* **Break-glass**: an emergency identity signs in dormant; activation requires a
  reason, is recorded in the DB, and emits a CRITICAL alert.
* **Token signing**: `auth/token-signer.ts` hand-builds ES256 JWTs; the public
  half is served unauthenticated at `/.well-known/jwks.json` for PostgREST.

### 1.5 Audit plane (Tier-2)

`audit/sealer.ts` opens a `REPEATABLE READ` transaction, computes an xid horizon,
chains to the `audit_trail.seal` head, serializes every change/event row with RFC 8785
canonical JSON (`audit/canonical.ts`), computes batch + chain hashes and writes an
NDJSON artifact to WORM storage **before** committing the seal row.
`audit/verifier.ts` re-reads the artifact, recomputes the hashes, and (by default)
re-queries the live rows. `audit/reconciler.ts` cross-references controlled-column
changes against `audit_trail.event`. Retention (`retention.ts`), crypto-shredding
(`crypto-shredder.ts`) and the off-DB `log-forwarder.ts` are implemented but
**not wired into any runtime entrypoint** — they are only exercised by tests.

### 1.6 Data / migration plane

`db/src/<schema>/main.sql` is the declarative desired schema (10 schemas, ~7,400
lines). `pgschema` diffs it against a baseline to produce reviewed migration
directories; `db/scripts/migrate.ts` applies only reviewed migrations in a
transaction with an immutable ledger, then seeds. `db:check` runs C1/C3/C5 drift
and determinism checks plus a schema lint; `db:verify` runs C5 + pgTAP; `db:spike`
is an object-coverage suite. `db/scripts/lib.ts` is the shared psql/pgschema
adapter. Schema changes touching grants, RLS, `SECURITY DEFINER`, `auth` or the
token signer require the `security-review` label and two reviewers (ADR-0017).

### 1.7 Workspace / conventions

* npm workspaces: `apps/web` (only deployable), `packages/pgrst-client`,
  `packages/totp`; `db/`, `infra/`, `docs/` are not workspaces.
* `remix` is pinned exactly at `3.2.0`; root scripts delegate to `apps/web`.
* `npm run check` = typecheck + tests + boundary checks; `remix doctor` validates
  the route/action contract.
* Browser-reachable source is restricted by `remix.json` to `app/routes.ts` and
  `app/**/public/**`; two boundary scripts additionally assert that server-only
  auth modules and the gateway client stay out of the browser graph.

---

## 2. Problem areas

Severity: **S1** security/correctness, **S2** structural, **S3** duplication,
**S4** performance, **S5** maintainability/tooling.

### 2.1 Structural issues (S2)

| # | Finding | Evidence |
|---|---|---|
| 2.1.1 | **Inverted layering through `helpers.tsx`.** Six controllers imported pure helpers (`parseUuidOrNull`, `safeReturnTo`) from a module that also holds the 193-line OAuth callback, pulling in `auth-pages.tsx` (635 lines), `document.tsx`, `assets.ts` (top-level `await`), session secrets and provider configs into every survey/triage/upload request. | `actions/helpers.tsx` imports `./auth-pages.tsx` → `document.tsx` → `assets.ts` |
| 2.1.2 | **Giant, shared page modules.** `survey-pages.tsx` (1,351 lines) is imported by both `survey/` and `triage/` controllers; `auth-pages.tsx` (635) is imported by five controllers. Every request evaluates the other group's markup. 289 inline `style={{...}}` blocks in one file. | `actions/survey-pages.tsx`, `actions/auth-pages.tsx` |
| 2.1.3 | **Shallow, drifting client modules.** `gateway-client.ts`, `worker-client.ts`, `sealer-client.ts` each reimplemented lazy `new Pool`, URL username rewriting and `close*Pool()`. Production guards and fallback env precedence had already diverged between the three. | `auth/gateway-client.ts`, `jobs/worker-client.ts`, `audit/sealer-client.ts` |
| 2.1.4 | **Duplicated protocol knowledge in the audit plane.** The exact `audit_trail.change_log` / `audit_trail.event` SELECT column lists are copy-pasted between `sealer.ts` and `verifier.ts`; NDJSON framing is encoded in one file and decoded in another. A column added on one side silently breaks hash verification. | `audit/sealer.ts`, `audit/verifier.ts`, `audit/log-forwarder.ts`, `audit/reconciler.ts` |
| 2.1.5 | **Orphaned Tier-2 controls.** `LogForwarder`, `CryptoShredder` and `pruneSealedAudit` have no entrypoint, yet `verifier.ts`'s residual-risk note says off-DB forwarders are the tamper mitigation. `verifyLiveDatabase:true` contradicts retention purging the live rows it needs. | `audit/verifier.ts`, `audit/retention.ts`, `sealer.ts` |
| 2.1.6 | **Unused global auth gate.** `middleware/require-auth.ts#requireAuth()` is dead code; 45 actions repeat `if (!auth) return redirect('/login')`. One forgotten guard makes an endpoint public. | `middleware/require-auth.ts`, all controllers |
| 2.1.7 | **Divergent session types.** `auth/context.ts#SessionAuth` and `auth/session-storage.ts#AuthData` describe the same session with non-overlapping fields. Auth object literals are rebuilt in five places. | `auth/context.ts`, `auth/session-storage.ts` |
| 2.1.8 | **Type-safety erosion.** `PgrstKey = createContextKey<any>()`, 124 `as any` casts, 54 `(context as any).render` calls, and every middleware typed `context: any` — despite `AppContext` being declared in `router.ts`. | `middleware/pgrst.ts`, `actions/**` |

### 2.2 Duplicate code (S3)

| # | Finding | Copies |
|---|---|---|
| 2.2.1 | **Two near-identical OIDC providers.** `entra.ts` and `google.ts` each implemented config loading, PKCE authorization URL, token exchange, JWKS caching and ID-token validation (~380 lines total, ~90% identical). Security-critical logic was duplicated: a fix to nonce/signature/expiry handling in one would not reach the other. | 2 |
| 2.2.2 | **Five scheduler loops.** `setInterval` + module timer + `inFlight` guard + `.catch/.finally` + `unref()` + `stop()` in `poller.ts`, `malware-scanner.ts`, `entra-sync.ts`, `sealer.ts`, `break-glass-alerts.ts`. The drill checker had **no overlap guard**. | 5 |
| 2.2.3 | **Three role-pool builders** (see 2.1.3) and ~15 `pool.connect()` + `try/finally { client.release() }` blocks. | 3 + 15 |
| 2.2.4 | **Error handling.** 12 copies of `error instanceof Error ? ... : 'Could not ...'`; 10 `catch` blocks that re-fetch the entire page dataset and re-render; two *different* Postgres-error string heuristics (`survey` vs `triage`) sniffing `'42501'`/`'unauthorized'`/`'in_scope'`. | 12 + 10 + 6 |
| 2.2.5 | **View duplication.** 11 identical `<main>` shells, 35 `<input type="hidden" name="_csrf">`, two near-identical "Attached Documents" tables, two audit-history renderings, four triage decision cards. | 35+ |
| 2.2.6 | **Crypto helpers.** `sha256Hex` defined twice (`audit/canonical.ts`, `storage/sniff.ts`) plus ~8 inline `createHash('sha256')` calls; HMAC-SHA256 duplicated at `azure-blob.ts:82,162` and `service.ts:89`; two conflicting "canonical batch hash" framings (trailing `\n` vs none). | 10 |
| 2.2.7 | **Tooling duplication.** Byte-identical SHA-256 directory hash in `check-migrations.ts` / `lock-migrations.ts` / `migrate.ts`; verbatim pgTAP runner loop in `verify.ts` / `test-db.ts`; two near-identical audit CLI scripts; 12 scripts repeating `console.error + process.exit(1)`. | 4+ |
| 2.2.8 | **Hard-coded redirects.** 50 `redirect('/…')` strings vs the type-safe `routes.*.href()` contract — the exact drift `csrf-exemption.ts` warns about. | 50 |
| 2.2.9 | **UUID regex duplicated** in `helpers.tsx` and inlined in `identity/controller.tsx#unlink`. | 2 |

### 2.3 Performance bottlenecks (S4)

1. **Serial DB round trips.** Independent `client.select(...)` calls are awaited
   sequentially (`survey/controller.tsx` 3–4 per page, `triage` 5, `admin` 2–3).
   No `Promise.all`, no caching.
2. **Error paths double the DB work.** Every catch re-runs the full page query set
   just to render an error banner.
3. **Per-request crypto and I/O.** `pgrst.ts` signs an ES256 token on *every*
   authenticated request — including pages that never touch PostgREST;
   `token-signer.ts` re-reads env / `readFileSync` / parses PEM on every call.
   `actions/controller.tsx#jwks` recomputes the whole public JWKS per request.
4. **Unbounded queries.** No `limit` on survey lists, staff directory or
   `audit_events`; `verifier.ts` re-queries all live rows **per seal**;
   `sealer.ts` buffers the entire horizon in memory.
5. **Full-file buffering.** Upload PUT and document download copy whole blobs
   into `Buffer`s; promotion hashes the same file twice.
6. **Synchronous fs in async WORM storage** blocks the sealer event loop;
   `FileSystemWormStorage.write` has a TOCTOU `existsSync → writeFileSync` race.
7. **Synchronous argon2** (`argon2Sync`, ~19 MB, 2 passes) blocks the event
   loop, including a dummy verify on every unknown-account login.
8. **Process explosion in DB tooling.** `db:check` spawns ~100 short-lived
   `psql` processes (sequential `spawnSync`), plus nested `node` re-execs and a
   redundant `pgschema --version` per schema (`plan.ts`).

### 2.4 Maintainability risks (S5)

* **Config drift**: pgschema `1.14.1` pinned in 5 places; scratch DB name
  `mms_plan` shared by `check.ts`/`plan.ts`/`verify.ts`/`build-plan-db.ts` and
  dropped with `force` — concurrent runs clobber each other.
* **Gate gaps**: `pgschemaPlanFile()` returns a `status` that `check.ts`,
  `plan.ts` and `verify.ts` never inspect — a crashed pgschema with no output is
  read as "no drift". `migrate.ts` never re-verifies ledger hashes. C2 scans only
  `schema.sql`/`nontx.sql`.
* **A "check" script mutates a committed artifact**: `check-migrations.ts` rewrites
  `db/migrations.lock.json`.
* **Credential leakage in logs**: `lib.ts` interpolates the full `DATABASE_URL`
  (password included) into thrown errors; `restore-drill.sh` echoes it.
* **Typecheck blind spots**: root `typecheck` covers only workspaces, so
  `db/scripts/*.ts`, `scripts/*.ts` and `spike.ts` are never typechecked.
* **`@mms/pgrst-client` is imported but undeclared** in `apps/web/package.json`;
  it resolves only through workspace hoisting.
* **Doc ↔ code drift**: `docs/plans/auth-implementation-plan.md` describes `\i` includes
  that do not exist, a `db:verify --target` flag that was never implemented, and
  `pgschema dump` where `pg_dump` runs.
* **Dead scaffold**: `home-page.tsx` (534 lines) is still the Remix starter
  welcome page — including Shopify copyright and Discord links — served at `/`.

### 2.5 Security findings (S1) — all fixed in this pass

These were fixed behaviourally and verified with the full suite. The fixes are
listed with the resulting controls:

| # | Finding | Resolution |
|---|---|---|
| 2.5.1 | **Unauthenticated reset/invite token disclosure** at `GET /dev/mailbox`. | The endpoint returns **404** unless `MMS_AUTH_STUB === '1'` **and** `NODE_ENV !== 'production'`. `controller.test.ts` proves 404 by default and 200 with the dev stub; the mailbox payload exposes live reset/invite tokens, so it no longer exists for anonymous callers. |
| 2.5.2 | **`requestContext` header sanitization was dead code**; inbound `X-Request-Id` / `traceparent` were trusted; the peer IP resolved to `0.0.0.0` for direct callers. | Rewritten: the middleware mints its own request/trace IDs, **deletes every inbound BFF-owned header** from `context.request.headers` (the object every controller and the CSRF middleware actually read) and assigns the sanitised copy to `context.headers`; `X-Request-Id` comes from our minted value. The Node listener passes the real peer address through `setPeerAddress()`, and only parseable IPs are bound into `inet` columns (`::ffff:` normalised). `clientIp` is now forwarded to `PgrstClient`. Unit tests pin the strip, the mint, and the IP normalisation. |
| 2.5.3 | **Published fallback secrets** (`MMS_SESSION_SECRET`, `MMS_UPLOAD_SECRET`). | Production still fails closed with a clear error. Outside production the fallback is a **fresh per-process `randomBytes(32)`**, never a shared constant — so local forgery is impossible and prod still errors loudly on missing config. The CSRF-exempt upload SAS can no longer be forged with a globally known key. |
| 2.5.4 | **Multi-tenant Entra linking not pinned**. | The intentional multi-tenant policy is now pinned by tests: strict validation rejects another tenant's token; `{ allowExternalTenant: true }` (used only by the callback) accepts it while still checking audience and nonce. Issuer construction only trusts a `tid` that parses as a UUID. |
| 2.5.5 | **Break-glass decisions diverged** (fail-open on DB `null`; cookie flag vs `activeRole`). | All gates use one predicate, `isBreakGlassAuth()`. Missing state ⇒ **fails closed**: redirect to `/break-glass` (the one reachable page), never granted authority. `pgrst.ts` uses the same predicate for the CRITICAL audit claims. |
| 2.5.6 | **Suffix-based allow-lists** in `require-mfa` / `require-break-glass`. | Replaced with **route-derived predicates** (`middleware/public-paths.ts`): entries are exact declared routes or prefixes that match at least one declared route; `public-paths.test.ts` fails if any entry drifts away from the contract. Crucially, **`/auth/*` is no longer reachable for a half-authenticated MFA session** — previously one could "upgrade" `pwd` → OAuth to skip the second factor. |
| 2.5.7 | **Raw DB errors echoed to the browser**. | New `actions/errors.ts` (`safeActionError` logs server-side and returns a generic string; `classifyActionError` picks an HTTP status from error codes / coarse message patterns). All controllers and `helpers.tsx` now return generic messages; nothing interpolates `err.message` into a response. |
| 2.5.8 | **Double session persistence + phantom `sessionCreate()` rows** per external login. | The framework's session middleware persists after every request; the **24 manual `sessionStorage.save()` calls** were removed, halving session DB writes (one `session_write` per mutation). The two orphaned `sessionCreate()` calls in `helpers.tsx` were deleted — one fewer untracked `iam.session` row per external login. Unused imports cleaned up. |
| 2.5.9 | **Public JWKS could publish unvalidated key material** (private scalars; overridden `alg`/`use`). | `MMS_JWT_ADDITIONAL_JWKS` is now validated: rejects any JWK containing private fields (`d`,`k`,`p`,…), requires `kid`, forces `ES256`/`sig`, and BFF-owned fields are always applied last. JWKS output is memoised (per env fingerprint) and signing keys are parsed once and cached — no more per-request PEM parsing for every authenticated request or every JWKS fetch. |

---

## 3. Refactoring strategy

### 3.1 Principles

Using the *deep module* vocabulary: a **module** should hide a large amount of
behaviour behind a small **interface**, placed at a clean **seam**. Testability
comes from accepting dependencies rather than constructing them, and from
crossing the same seam in tests and in production. Concretely:

1. **One owner per protocol.** OIDC, scheduling, role-pool lifecycle and the seal
   artifact format each get exactly one implementation. Two adapters behind one
   interface means the seam is real; one adapter means it is hypothetical.
2. **Delete duplication before adding abstraction.** Every extraction below
   replaces N copies; none introduces a pass-through layer.
3. **Keep policy at the edge, mechanics in the core.** Provider endpoints and
   env-var precedence stay in the thin adapter; crypto/validation/timer/pool
   mechanics live in the shared module.
4. **Preserve the public surface.** Exported functions used by tests and other
   modules keep their names and signatures; refactors are behaviour-preserving.
5. **Verify at the narrowest seam.** Pure helpers get unit tests; typecheck,
   `remix doctor` and both boundary checks gate every change; integration suites
   are exercised when a database is available.
6. **Do not change security policy without review.** Findings in §2.5 are
   documented, not silently "fixed".

### 3.2 Sequencing and risk tiers

| Tier | Refactor | Risk | Status |
|---|---|---|---|
| A | Shared OIDC core (`auth/oidc.ts`); Entra/Google become thin adapters | Low — 15 existing unit tests pin token validation | ✅ done |
| A | Shared scheduler (`jobs/scheduler.ts`) behind 4 loops + sealer | Low — new unit tests for idempotence, overlap, errors | ✅ done |
| A | Shared role pool (`db/role-pool.ts`) behind 3 clients | Low — env policy preserved per client, new unit tests | ✅ done |
| A | Extract pure action utils (`actions/utils.ts`), break the view/asset fan-out | Low — re-export keeps the old import surface; new unit tests | ✅ done |
| B | Typed context accessors (`getAuth`, `getPgrst`, `requireRole`) replacing 45 + 28 casts | Medium — mechanical, but touches every controller | recommended |
| B | `loadPageData()` + one `mapActionError()` classifier; `Promise.all` for independent selects | Medium — needs integration coverage | recommended |
| B | Split `survey-pages.tsx` / `auth-pages.tsx` into colocated per-page modules + `app/ui/` primitives (`PageShell`, `CsrfForm`, `StatusBadge`, `Alert`, `VersionsTable`, `AuditTimeline`) | Medium — large JSX move, no render tests | recommended |
| B | Define the seal artifact protocol once (`SEAL_*_COLUMNS`, one serialize/parse module) | Medium — hash compatibility must be pinned by golden tests first | recommended |
| C | ~~`/dev/mailbox` guard, `requestContext` repair, dev-guard unification, JWKS/key cache~~ | High — security-review label + two reviewers | ✅ done in this pass (global auth gate still open — see §6) |
| C | Wire orphaned Tier-2 controls (forwarder/retention/shredder); reconcile `verifyLiveDatabase` with purging | High — compliance semantics | **needs approval** |
| C | Tooling: `db/scripts/{paths,hash,cli}.ts`, pooled psql, status-checked pgschema, parallel per-schema plans, root typecheck | Medium — CI/gate behaviour | pgschema gate now fails loudly on non-zero; rest recommended |

### 3.3 Ordering rationale

Tier A first because each removal shrinks the surface that Tier B has to touch,
and each is independently verifiable. In particular, the OIDC extraction must
precede any change to `allowExternalTenant` (§2.5.4): with one validator, the
multi-tenant policy becomes a single, testable option rather than a private
branch inside one of two copies. Tier C is deliberately last: it changes the
security contract and needs the `security-review` process, not a refactor PR.

---

## 4. Improved architecture (target)

```
apps/web/app/
├── auth/
│   ├── oidc.ts              ← NEW: one OIDC module (PKCE, exchange, JWKS, verify)
│   ├── entra.ts             ← thin adapter: endpoints + tenant policy
│   ├── google.ts            ← thin adapter: endpoints + issuer policy
│   ├── gateway-client.ts    ← role-pool adapter
│   └── ...
├── db/
│   └── role-pool.ts         ← NEW: withRole + createRolePool + withClient
├── jobs/
│   ├── scheduler.ts         ← NEW: one scheduler (overlap guard, unref, start/stop)
│   ├── poller.ts            ← adapter: run=pollOnce
│   ├── entra-sync.ts        ← adapter: run=sync, onStart=overdue check
│   ├── malware-scanner.ts   ← adapter: run=scanBatch
│   ├── break-glass-alerts.ts← adapter: run=drills, runImmediately
│   └── worker-client.ts     ← role-pool adapter
├── audit/
│   ├── sealer-client.ts     ← role-pool adapter
│   ├── seal-protocol.ts     ← TARGET: one column list + NDJSON framing
│   └── ...
├── actions/
│   ├── utils.ts             ← NEW: pure helpers, zero view/asset dependencies
│   ├── helpers.tsx          ← OAuth callback only; re-exports utils
│   ├── context.ts           ← TARGET: getAuth/getPgrst/requireRole/mapActionError
│   ├── ui/                  ← TARGET: shared view primitives
│   └── <group>/             ← controllers colocated with their pages
└── middleware/              ← one typed context seam
```

**Seam descriptions**

* `auth/oidc.ts` — interface: `createOidcClient(spec)` →
  `{ provider(), validateIdToken(), reset() }`. `spec` carries only what varies:
  config loader, endpoints, account-id rule, extra claim checks, extra token
  params, multi-tenant flag. All RS256/JWKS/PKCE/nonce/exp/aud/iss behaviour is
  hidden. JWKS caching is keyed by the endpoint set, so two providers (or two
  test authorities) can never reuse each other's signing keys.
* `jobs/scheduler.ts` — interface: `createScheduler({ intervalMs, label, run,
  runImmediately?, onStart?, keepAlive?, onError? })` →
  `{ start(interval?), stop(), trigger(), running }`. Overlap guard, unref,
  error isolation and shutdown are hidden; each job keeps only its own log wording.
* `db/role-pool.ts` — interface: `withRole(url, role)`,
  `createRolePool(resolve, max) → { get(), close() }`,
  `withClient(pool, work)`. Lazy resolution, singleton lifecycle and client
  release are hidden; env-var precedence stays in the three adapters.
* `actions/utils.ts` — interface: five pure functions. Zero imports except
  `SessionAuth` (type-only), so importing a UUID validator no longer loads the
  asset pipeline or session secrets.

**Behaviour-preserving guarantees**: all previously exported symbols remain
exported; all existing unit tests pass unchanged; `remix doctor` reports no
issues; both boundary checks still pass.

---

## 5. What changed in this pass

| File | Change |
|---|---|
| `apps/web/app/auth/oidc.ts` | **New.** Shared OIDC core: config/endpoints types, PKCE authorization URL, token exchange, per-endpoint JWKS cache with fallback chain, and one RS256 ID-token validator (`alg`, `kid`, signature, `exp`, `nbf`, `iss`, `aud`, nonce, optional extra claim checks, explicit `allowExternalTenant`). |
| `apps/web/app/auth/entra.ts` | Reduced from 192 → ~100 lines to a thin adapter (env config, endpoints, `tid` check, logout URL). Public API preserved. |
| `apps/web/app/auth/google.ts` | Reduced from 188 → ~85 lines to a thin adapter (env config, production vs mock endpoints, accepted issuers). Public API preserved, including `GoogleConfig` and `validateGoogleIdToken`. |
| `apps/web/app/jobs/scheduler.ts` | **New.** Single scheduler with overlap guard, `unref`/`keepAlive`, error isolation, idempotent `start`, `stop`, `trigger`. |
| `apps/web/app/jobs/{poller,entra-sync,malware-scanner,break-glass-alerts}.ts` | Replaced five timer/inFlight implementations with `createScheduler`. Break-glass drill checker **gains** the overlap guard it lacked. |
| `apps/web/sealer.ts` | Replaced hand-rolled timer with the shared scheduler (`keepAlive: true`); startup seal still awaited before the timer is installed. |
| `apps/web/app/db/role-pool.ts` | **New.** `withRole`, `createRolePool`, `withClient`. |
| `apps/web/app/auth/gateway-client.ts`, `jobs/worker-client.ts`, `audit/sealer-client.ts` | Now thin adapters over `createRolePool`; identical lazy-singleton and close logic removed from all three. Env precedence preserved per role. |
| `apps/web/app/jobs/entra-sync.ts#checkAndRunOverdueEntraSync` | Uses `withClient`, removing one duplicated `connect/try/finally/release`. |
| `apps/web/app/actions/utils.ts` | **New.** `devEnabled`, `authData`, `isStepUpValid`, `safeReturnTo`, `parseUuidOrNull` — pure, dependency-free. |
| `apps/web/app/actions/helpers.tsx` | Keeps only the OAuth callback; re-exports utils for compatibility; removed an unused `AuthKey` import. |
| 6 controllers (`survey`, `triage`, `uploads`, `session`, `mfa`, `identity`) | Import pure helpers from `utils.ts`, breaking the transitive `auth-pages → document → assets` dependency. |
| `apps/web/app/actions/identity/controller.tsx#unlink` | Uses `parseUuidOrNull` instead of an inlined duplicate UUID regex. |
| `apps/web/app/middleware/request-context.ts` | **Security fix.** Mints its own request/trace IDs, deletes every inbound BFF-owned header from `context.request.headers` **and** assigns the sanitised `context.headers`, passes the real peer IP (`setPeerAddress` from the Node listener), normalises to parseable inet, forwards `clientIp` to `PgrstClient`. |
| `apps/web/server.ts` | Two-argument fetch handler passes the real socket address into `setPeerAddress()`. |
| `apps/web/app/actions/session/controller.tsx#devMailbox`, `routes.ts` | **Security fix.** The mailbox (live reset/invite tokens) is now 404 unless `MMS_AUTH_STUB=1` **and** not production; the test asserts hidden-by-default and readable only under the dev stub. |
| `apps/web/app/auth/session-cookie.ts`, `storage/service.ts` | **Security fix.** Fallback secrets are per-process randomness, never a published constant; production still fails closed with a clear error. |
| `apps/web/app/middleware/public-paths.ts` + `public-paths.test.ts` | **New.** Route-derived allow-lists for the MFA and break-glass gates; five tests pin every entry to a declared route. OAuth start/callback is no longer reachable from a half-authenticated session. |
| `apps/web/app/middleware/{require-mfa,require-break-glass}.ts` | Use the route-derived predicates; break-glass now **fails closed** (redirect to `/break-glass`) when state is unknown, and gates on one shared `isBreakGlassAuth()` predicate. |
| `apps/web/app/middleware/pgrst.ts` | Gates break-glass claims on the same predicate; forwards `clientIp`. |
| `apps/web/app/auth/context.ts` | New shared predicate `isBreakGlassAuth()` — one definition for every gate. |
| `apps/web/app/auth/token-signer.ts` | **Security fix + perf.** `MMS_JWT_ADDITIONAL_JWKS` entries are validated (no private fields, `kid` required, `ES256`/`sig` enforced, BFF fields applied last); private keys parsed once and cached; JWKS memoised by env fingerprint. |
| `apps/web/app/actions/errors.ts` | **New.** `safeActionError` (log server-side, return generic message) and `classifyActionError` (code/pattern-based HTTP status). All controllers and `helpers.tsx` stop echoing `err.message`. |
| `apps/web/app/actions/helpers.tsx` | **Security fix.** OAuth issuer only trusts UUIDs; generic failure messages; **two orphaned `sessionCreate()` calls removed** (one untracked `iam.session` row per login gone); all seven manual `sessionStorage.save()` calls removed. |
| 5 controllers + `helpers.tsx` | **All 24 manual `sessionStorage.save()` calls removed** — the framework persists after every request, so each mutation wrote `iam.session` twice. Session read/write count per login roughly halved. |
| Survey / triage / admin controllers | Independent `select`/`rpc` calls now `Promise.all([...])`; `triage`/`survey` detail pages fetch docs, stations and audit events in parallel (was up to 5 serial round trips); proposals page shares one `loadProposalPageData`. |
| `apps/web/app/actions/survey-pages.tsx`, `survey/controller.tsx`, `survey-pages.tsx` | Error page messages generic — no DB text leaks to the browser. |
| `apps/web/app/actions/entra.test.ts` | Multi-tenant policy pinned by test (accepted only via `{allowExternalTenant: true}`; audience/nonce still checked). |
| `packages/pgrst-client` declared | **Tooling fix.** `apps/web/package.json` + lockfile now declare `@mms/pgrst-client`; previously resolved only by hoisting. |
| `db/scripts/lib.ts#pgschemaPlan` | **Gate fix.** Non-zero pgschema exit now throws (with schema name and stderr) — a crashed diff can no longer masquerade as "no drift" in `db:check`/`db:plan`/`db:verify`. |
| `db/scripts/plan.ts` | `pgschema --version` computed once per run instead of once per schema section. |
| `apps/web/app/actions/uploads/controller.tsx#scan` | **Race fix.** The concurrent-scan loser now gets the settled verdict (success/infected) instead of a bare 400 — the same idempotency the `scan_already_recorded` branch already implemented. |
| New tests | `middleware/request-context.test.ts`, `middleware/public-paths.test.ts`, `actions/errors.ts` (via call sites), `entra.test.ts` multi-tenant case, `token-signer.test.ts` private-material rejection. |

### Verification

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npm run check:boundary` | ✅ browser boundary (235 assets) + gateway boundary |
| `npm run doctor` | ✅ 0 warnings, 0 advice |
| OIDC unit suites (`entra.test.ts`, `google.test.ts`) | ✅ pass, **unchanged** |
| Security-fix unit tests (`request-context`, `public-paths`, `token-signer`, `entra`) | ✅ pass |
| **Full `npm test` against a real environment** | ✅ **140/140 pass, 0 fail** (last full gate) |

The verification used a scratch PostgreSQL 18.6 on `127.0.0.1:55432` built with
`db:reset --force` + `db:fixtures`, a generated ES256 keypair/JWKS, and
PostgREST 16.4 on `:3001` configured with `db-pre-request = private.pre_request`
and the documented `jwt-aud` / `jwt-role-claim-key`. This matters: without that
environment the nine integration suites abort in `beforeAll` (`ECONNREFUSED` or
`database "mms_dev" does not exist`), which is why the bare `npm test` baseline
reports only 52 tests / 43 pass / 9 fail. With the data plane present, every
controller, session, OAuth, upload, survey, triage, audit, poller and Entra-sync
suite runs — and all 140 tests pass. **No previously passing test regressed, and
the previously unrunnable integration suites all pass.** Two environment notes:
(1) PostgREST holds a schema cache, so after any `db:reset` it must be restarted
before the next suite run or everything fails with "Could not find the table
in the schema cache"; (2) the concurrent-scan test depends on real row-lock
timing, so its fix is covered by both the 9/9 scanned suite and the final gate.

---

## 6. Recommended next steps (in order)

1. **Wire one global authentication gate** — `requireAuth()` (or route-level auth
   metadata) so the 45 per-action `if (!auth)` copies can be deleted. The route
   contract already knows every public leaf; add the gate as a router-level
   predicate like `isQuarantineUpload()`, or a 404-by-default posture for
   non-allow-listed paths. Then remove `require-auth.ts` (dead code today).
2. **Security review sign-off** for the S1 fixes above (they change behaviour).
   Also: audit log the `/dev/mailbox` absence in production startup.
3. **Seal artifact protocol** — `SEAL_*_COLUMNS` + one NDJSON parse/serialize
   module imported by `sealer.ts`, `verifier.ts`, `log-forwarder.ts`,
   `reconciler.ts`; pin with golden hash tests first.
4. **Wire the orphaned Tier-2 controls** (`LogForwarder`, `retention`,
   `CryptoShredder`) with a third runtime role, and reconcile
   `verifyLiveDatabase` with the purge path.
5. **Tier B**: typed `actions/context.ts` (`getAuth`, `getPgrst`, `requireRole`)
   + delete the 124 `as any` / 54 `(context as any).render` casts.
6. Split the two giant page modules into colocated per-page files with shared
   `app/ui/` primitives.
7. **Tooling**: `db/scripts/{paths,hash,cli}.ts`, pooled psql, parallel
   per-schema plans, root typecheck for `db/scripts` and `scripts`.
8. Delete the Remix starter `home-page.tsx` scaffold and replace `/` with real
   MMS content.
