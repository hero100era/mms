# MMS Unified Implementation Plan — Part 5: Review Baseline & Evidence (R0)

> **Master Plan:** [MMS Unified Implementation Plan (docs/plans/README.md)](README.md)  
> **Phase:** R0 (Tasks R0.1 and R0.2)  
> **Prerequisites for:** [Part 2: Rectification Plan (Phases R1–R10)](rectification-implementation-plan.md)  
> **Scope:** Byte-for-byte snapshot comparison evidence and exact toolchain version verification.

## Purpose

This record supports `docs/plans/rectification-implementation-plan.md`, Phase R0. It is evidence only: it
contains no secret values.

## R0.1 — reviewed baseline

### Source identity

| Item | Value |
| --- | --- |
| Git commit being rectified | `f74c90199d3b904f9a8d220d7fbcd1e96781334f` (`main`, single commit, subject `implement auth as per docs/implementation_plan.md`) |
| Reviewed snapshot | `mms-source-review.txt` (484 `BEGIN FILE`/`END FILE` blocks) |
| Snapshot match check | All 484 snapshot files were extracted and compared byte-for-byte (trailing whitespace normalised) against the working tree: **484 identical, 0 different, 0 missing**. |
| Untracked additions at review time | `.tool-versions`, `CODEOWNERS`, `docs/plans/rectification-implementation-plan.md`, `mms-source-review.txt` (the plan and its evidence, not application source) |

**R0.1 stop condition:** satisfied. The checked-out source does not differ materially
from the reviewed snapshot, and Remix is still 3.2.0 (see below). Work may proceed.

### Exact toolchain versions

| Component | Version | Source of truth |
| --- | --- | --- |
| Node.js | `v26.12.0` (runtime observed) | `node --version` |
| Node.js declared | `>=24.7.0` / `24.7.0` | `package.json` `engines`, `apps/web/package.json` `engines`, `.tool-versions`, `.github/workflows/ci.yml` |
| npm | `12.2.1` | `npm --version` |
| Remix | `3.2.0` (exact pin in `apps/web/package.json`; lockfile `node_modules/remix` = `3.2.0`) | `apps/web/package.json`, `package-lock.json` |
| TypeScript | `7.0.2` (installed), declared as `latest` in `apps/web/package.json` and `packages/*/package.json` | `node_modules/typescript/package.json` |
| PostgreSQL | `PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2 ...), 64-bit` | `select version()` on the dev instance; `infra/compose.yaml` pins `postgres:18.6` |
| PostgREST | `16.4` installed locally; `16.5` pinned in `infra/compose.yaml` and `.tool-versions` | `postgrest --version` |
| pgschema | `1.14.1` | `pgschema --version`, `.tool-versions`, `.github/workflows/ci.yml` (checksum-verified download) |
| `@remix-run/test` | `1.1.0` | `package-lock.json` |
| `pg` | `8.23.1` | `package-lock.json` |

Lockfile confirmation: `package-lock.json` resolves `node_modules/remix` to `3.2.0` with
an integrity hash. The plan's Remix-3.2.0 precondition holds.

**Version drift to track (not a regression of the reviewed snapshot):** local Node is
26.12.0 while `engines`/CI/`.tool-versions` declare 24.7.0; local PostgREST is 16.4 while
compose/`.tool-versions` pin 16.5; TypeScript is a floating `latest`. These are the subject
of R8.3 and are recorded here rather than changed under R0.

### Required external services

| Service | Local development | Production |
| --- | --- | --- |
| PostgreSQL 18 | `infra/compose.yaml` service `postgres` (port 5432 inside compose; dev instance on 55432), database `mms_dev` | Managed PostgreSQL 18 with the bootstrap roles |
| PostgREST | `infra/compose.yaml` service `postgrest` (compose port 3000; dev instance on 3001) | PostgREST 16.x, `PGRST_DB_SCHEMAS=api`, JWKS from the app |
| Mock OIDC | `infra/compose.yaml` `mock-oidc` (8090 -> 8080) | Entra ID / Google OIDC |
| Blob / WORM storage | Azurite (`infra/compose.yaml`, port 10000) or local `.worm/` directory | Azure Blob Storage with immutability/retention |
| Malware scanner | ClamAV (`CLAMAV_HOST`/`CLAMAV_PORT`) or the injected test scanner | Managed scanner per R7.3 (not yet decided) |
| Outbox mail | `apps/web/app/jobs/dev-mailbox.ts` | Managed mail transport |
| Signing key | Local PEM file (`MMS_JWT_PRIVATE_KEY_FILE`) | Approved key/secret service (rotation runbook) |

Environment variables consumed by the code (names only, **no values**):

- Database: `DATABASE_URL`, `MMS_GATEWAY_DATABASE_URL`, `MMS_WORKER_DATABASE_URL`,
  `MMS_SEALER_DATABASE_URL`, `MMS_TEST_DATABASE_URL`, `BASELINE_DB`, `CHECK_DB`,
  `PLAN_DB`, `ALLOW_DB_RESET`, `SKIP_SEEDS`.
- HTTP / TLS boundary: `HOST`, `PORT`, `APP_PORT`, `HMR_PORT`, `HMR_PROXY_PORT`,
  `MMS_PGRST_URL`, `MMS_TRUSTED_PROXY_HOPS`, `NODE_ENV`, `REMIX_NODE_HMR`.
- Auth / OIDC: `MMS_SESSION_SECRET`, `MMS_JWT_PRIVATE_KEY`, `MMS_JWT_PRIVATE_KEY_FILE`,
  `MMS_JWT_KID`, `MMS_JWT_NEXT_PRIVATE_KEY`, `MMS_JWT_NEXT_KID`,
  `MMS_JWT_ADDITIONAL_JWKS`, `MMS_ENTRA_*`, `MMS_GOOGLE_*`, `MMS_GRAPH_BASE_URL`,
  `MMS_AUTH_STUB`, `MMS_UPLOAD_SECRET`.
- Storage / scanning: `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`,
  `AZURE_STORAGE_ENDPOINT`, `AZURE_STORAGE_CONTAINER`, `AZURE_WORM_CONTAINER`,
  `AZURITE_ENABLED`, `MMS_FORCE_PROD_STORAGE`, `MMS_WORM_DIR`, `MALWARE_SCANNER_TYPE`,
  `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS`.
- Audit / crypto: `MMS_CRYPTO_SHRED_MASTER_KEY`, `CRYPTO_SHRED_MASTER_KEY`,
  `MMS_SEAL_INTERVAL_SECONDS`, `MMS_RUNTIME_ROLE`.
- Tooling: `PG_DUMP`, `PGSCHEMA_VERSION`, `MMS_ENTRA_APP_ROLE`,
  `MMS_ENTRA_APP_ROLE_ID`.

Secrets are supplied out of band (environment / secret store / `~/.pgpass`); the README
documents the mechanism. No `.env` loader exists.

### Topologies

**Local development** — one process (`npm run dev` / `npm run hmr`, port 44100) runs the
web app *and* every scheduler because `runtimePlan()` defaults to `all` outside production
(README "Running the web app locally"). One PostgreSQL instance, one PostgREST, optional
mock OIDC / Azurite / ClamAV. All three runtime roles share one `DATABASE_URL`.

**Production** — three separate workloads, each with its own database login
(`docs/runbooks/deployment-topology.md`, ADR-0021):

| Workload | Command | `MMS_RUNTIME_ROLE` | Database role |
| --- | --- | --- | --- |
| web/BFF | `npm start` | `web` | `auth_gateway` + PostgREST (never `worker`/`audit_sealer`) |
| background worker | `npm run start:worker` | `worker` | `worker` only |
| audit sealer | `npm run start:sealer` | `sealer` | `audit_sealer` only |

`MMS_RUNTIME_ROLE` is required in production; if unset, job and sealing work does not run.
All three handle `SIGTERM`. CI (`.github/workflows/ci.yml`) runs `check`/`doctor` and a
separate `db` job with PostgreSQL 18.6 and a checksum-verified pgschema 1.14.1.

## R0.2 — baseline evidence

Environment for DB commands: a fresh/local PostgreSQL 18.6 instance with database
`mms_dev`; `DATABASE_URL` supplied at run time (no value recorded here). Log excerpts live
outside the repository (`/tmp/mms-baseline/`).

| # | Command | Exit | Classification |
| --- | --- | --- | --- |
| 1 | `node --version` | 0 | `v26.12.0` |
| 2 | `npm --version` | 0 | `12.2.1` |
| 3 | `npm ci` | see note | **environment issue**, then resolved |
| 4 | `npm run typecheck` | 0 | clean |
| 5 | `npm test` | 0 | 30 server test files, 0 failures |
| 6 | `npm run check:boundary` | 0 | browser boundary (235 assets) + gateway boundary pass |
| 7 | `npm run doctor` | 0 | `remix doctor`: 0 warnings, 0 advice |
| 8 | `npm run db:bootstrap` | 0 | roles/schemas/extensions idempotent |
| 9 | `npm run db:check` | 0 | lint + C1/C3/C5 on fresh databases |
| 10 | `npm run db:spike` | 0 | pgschema object-coverage spike |
| 11 | `npm run db:test` | 0 | pgTAP suite passes (18 test files) |
| 12 | `npm run db:verify` | 0 | C5 + pgTAP against running database |

`npm ci` note (environment, not a source defect): the first attempt with the default
global registry mirror and offline cache failed (`ENOTCACHED`, then `EACCES` on
root-owned files in `/home/joshua/.npm/_cacache`, then `404` from the mirror for
`@remix-run/test@1.1.0`). It was completed successfully with

```sh
npm ci --registry=https://registry.npmjs.org --cache /tmp/npm-cache-mms2
```

which restored `node_modules` from the lockfile (113 packages, one low-severity audit
advisory). `npm run typecheck` and `npm test` were re-run afterwards and both passed.
This is classified as **environment**; owner: local developer setup / CI image. No source
change is warranted under R0.2.

### Failure classification summary

- Genuine regression: none.
- Pre-existing defect: none observed in the baseline commands.
- Flaky test: none observed (suite run once; `audit_trail.seal` / `iam.login_attempt` suites
  already serialise with `--concurrency 1`).
- Environment: the `npm ci` registry/cache problem above.
- Advisory (not a failure): `npm audit` reports one low-severity advisory; TypeScript is
  floating at `latest`; local Node/PostgREST versions differ from declared pins (R8.3).

### esbuild pin (`overrides`)

`@remix-run/test` depends on `esbuild: ^0.27.1`, and 0.27.7 resolves inside that range.
GHSA-g7r4-m6w7-qqqr affects esbuild 0.27.3–0.28.0 (Windows dev-server path traversal, low /
CVSS 2.5), and a transitive `^` range would silently reintroduce it on any `npm install`.
The root `package.json` therefore pins `"overrides": { "esbuild": "0.27.2" }`, the last
release before the advisory, and the committed lockfile resolves all 27 `@esbuild/*`
platform packages to 0.27.2. Revisit the pin when `@remix-run/test` widens its range:
`npm audit --audit-level=low` should stay clean, and `npm ci` must keep reproducing the
same tree. `npm audit` in CI runs at `--audit-level=moderate` so this low advisory would
not have failed the pipeline on its own; the pin is defence in depth, not a gate.

**R0 acceptance:** the baseline report lists every command and exit status; all
pre-existing conditions have an owner (`R8.3` for the version drift, local environment
for `npm ci`) and a task reference. No unrelated failures were fixed in this task.
