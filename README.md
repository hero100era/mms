# MMS

The MMS application: a Remix web app, a PostgreSQL/PostgREST data plane, and the architecture and delivery roadmap defined in the [MMS Unified Implementation Plan](docs/plans/README.md).

The implementation roadmap is structured into modular parts: target architecture & auth foundation ([docs/plans/auth-implementation-plan.md](docs/plans/auth-implementation-plan.md)), rectification phases R0–R10 ([docs/plans/rectification-implementation-plan.md](docs/plans/rectification-implementation-plan.md)), native acceptance environment ([docs/plans/r8-6-implementation-plan.md](docs/plans/r8-6-implementation-plan.md)), review baseline evidence ([docs/plans/review-baseline.md](docs/plans/review-baseline.md)), and execution status & decisions ([docs/plans/rectification-decisions.md](docs/plans/rectification-decisions.md)). Trusted-proxy rules are in [docs/runbooks/request-context.md](docs/runbooks/request-context.md). For a full index of system documentation, see [docs/README.md](docs/README.md).

## Toolchain

Versions are pinned, not ranged:

| Component | Pin | Declared in |
| --- | --- | --- |
| Node.js | `^24.7.0` | root and `apps/web` `engines`, `.tool-versions`, CI |
| Remix | `3.3.0` (exact) | `apps/web/package.json` (see ADR-0002) |
| TypeScript | `7.0.2` (exact) | `apps/web`, `packages/*` `devDependencies` |
| `@types/node` | `26.6.6` (exact) | `apps/web` `devDependencies` |
| PostgreSQL | `18.7` | `infra/compose.yaml`, `.tool-versions` |
| PostgREST | `16.5` | `infra/compose.yaml`, `.tool-versions` |
| pgschema | `1.14.1` (checksum-verified in CI) | `.tool-versions`, CI |

R8.3 of the rectification plan required removing the floating `latest` ranges; a
regression test (`apps/web/app/version-pins.test.ts`) fails if a toolchain
dependency is declared as `latest`, `*` or a range again. Local development on a
newer Node (for example 26.x) works, but CI and the pin describe the supported
line.

## Layout

- `apps/web/` — the Remix app and the only deployable workspace.
  - `app/routes.ts` groups the URL contract by owning controller; `app/actions/*/controller.tsx` serve their group.
  - Root controller at `app/actions/controller.tsx` serves only `/assets` and the JWKS document.
  - Groups: `session/`, `identity/`, `auth/`, `mfa/`, `break-glass/`, `admin/` (with `proposals/`, `external-users/`), `uploads/`, `survey/`, `triage/`.
  - Shared action helpers live in `app/actions/helpers.tsx`.
  - `app/actions/home-page.tsx` and `app/actions/document.tsx` render the starter UI.
  - `app/actions/public/` contains the browser runtime entry and interactive prompt button.
  - `app/routes.ts` defines the shared route contract used by server and browser modules for type-safe hrefs.
  - `app/router.ts` wires routes to handlers and installs the standard Remix component renderer used by actions.
  - `app/assets.ts` owns the server-side asset pipeline used by the asset route and render middleware.
  - `server.ts` and `hmr.ts` are the runtime entries; `public/` holds static files.
- `packages/` — framework-agnostic libraries (`domain`, `pgrst-client`, `test-utils` as they are added).
- `db/` — declarative schema, bootstrap, migrations, seeds and database scripts.
- `infra/` — local compose and deployment assets.
- `docs/` — ADRs, architecture, security notes, runbooks, and implementation plans (see [docs/README.md](docs/README.md) and [docs/plans/README.md](docs/plans/README.md)).

## Commands

```sh
npm i
npm run dev
npm run hmr
npm run start
npm test
npm run typecheck
npm run check
npm run doctor
```

`npm run hmr` is for live server and browser updates; `npm run dev` only watches and restarts the server. `npm run check` runs the workspace typecheck and tests.

### Database credentials (stop `psql` prompting)

Every `npm run db:*` script spawns **many** short-lived `psql` processes — `db:migrate` starts one per migration plus one per seed file, and `db:check` builds two scratch databases and starts roughly a hundred. Each is a fresh libpq connection, so if PostgreSQL asks for a password and none is available, you get one prompt per process.

Configuration can be supplied via environment variables or a local `.env` file (which is loaded automatically by repository scripts). Put credentials somewhere libpq can see them on every connection without hardcoding. Any one of these works:

```sh
# 1. In the URL. The scripts extract it, redact it in diagnostics, and set PGPASSWORD per call;
#    the BFF/worker/sealer pools derive their URLs from DATABASE_URL and keep it too.
export DATABASE_URL='postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/mms_dev'

# 2. As an env var, inherited by every psql/pg_dump/pg_restore subprocess.
export PGPASSWORD='YOUR_PASSWORD'
export DATABASE_URL='postgresql://postgres@127.0.0.1:5432/mms_dev'

# 3. In ~/.pgpass (mode 0600) — covers every libpq client, including direct psql.
#    hostname:port:database:username:password
echo '127.0.0.1:5432:*:postgres:YOUR_PASSWORD' >> ~/.pgpass && chmod 600 ~/.pgpass
```

For purely local development instances, native local acceptance tests run against PostgreSQL with role passwords configured via `.env` or standard libpq credentials. Never use unredacted credentials or hardcoded universal passwords.

### Canonical Native Acceptance Environment (R8.6)

Native PostgreSQL 18.7 and native PostgREST 16.5 form the canonical R8.6 acceptance test environment. Docker Compose (`infra/compose.yaml`) is non-canonical and retained only for legacy or isolated disposable CI purposes. See [docs/testing/native-environment.md](docs/testing/native-environment.md).

```sh
npm run testenv:init -- --allow-initial-create  # idempotent cluster, roles, & signing key setup
npm run testenv:check                          # verify native prerequisites and drift
npm run testenv:reset                          # reset and re-seed disposable acceptance database
npm run testenv:start                          # start native PostgREST daemon
npm run test:e2e                               # run integration and real Playwright browser tests
```

### Running the web app locally

`npm run dev` starts the HTTP server on `:44100` **and**, in development, every background scheduler: `runtimePlan()` defaults to `all` outside production, so `server.ts` starts the outbox poller, the Entra sync, the malware scanner and the break-glass drill checker. Those connect to PostgreSQL immediately. With no database listening on the default `127.0.0.1:55432` you get `ECONNREFUSED` from the poller every 5 seconds — the server itself is fine, it is only the schedulers complaining.

Full local setup, in order:

```sh
# 1. Point every client at your real PostgreSQL. The gateway/worker/sealer pools
#    derive their URLs from DATABASE_URL by swapping only the username, so the host,
#    port and password carry through. 55432 is only the repo's dev default.
export DATABASE_URL='postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/mms_dev'
npm run db:bootstrap     # creates roles, schemas, extensions (idempotent)
npm run db:migrate       # applies migrations + seeds
npm run db:fixtures      # organisation tree (idempotent, no users)

# 2. Bootstrap creates login roles without passwords. On a password-auth server,
#    set them and export the matching URLs, or use local trust in pg_hba.conf:
#    MMS_GATEWAY_DATABASE_URL, MMS_WORKER_DATABASE_URL, MMS_SEALER_DATABASE_URL

# 3. Signing key: every authenticated request mints an ES256 token, so the signer
#    needs a key and PostgREST needs the matching public JWKS (see the rotation runbook).
export MMS_JWT_PRIVATE_KEY_FILE=/path/to/private.pem
export MMS_JWT_KID=dev

# 4. Start PostgREST on :3001, then the app (MMS_PGRST_URL defaults to that port).
npm run dev
```

To look at the HTML shell without a database at all, run `MMS_RUNTIME_ROLE=web npm run dev`: that skips the schedulers and their connections, but any action that reaches the database will still fail.

#### Generate a development signing key

The BFF signs ES256 (EC P-256) tokens. The native test environment manages signing keys centrally in `.testdata/keys/` (mode 0700/0600, excluded from git). PostgREST verifies with the **public half only**, as a JWKS.

```sh
# Generate or verify acceptance signing keys in .testdata/keys/
npm run testenv:keys

# Or rotate keys on demand:
npm run testenv:keys -- --rotate
```

Or manually using openssl and node:

```sh
# 1. Private key (PKCS#8). Keep it out of the repo; it is a signing credential.
mkdir -p .testdata/keys && chmod 700 .testdata/keys
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out .testdata/keys/mms-jwt-private.pem
chmod 600 .testdata/keys/mms-jwt-private.pem

# 2. Matching public JWKS for PostgREST's PGRST_JWT_SECRET.
node -e '
  const { createPrivateKey, createPublicKey } = require("node:crypto");
  const { readFileSync, writeFileSync } = require("node:fs");
  const jwk = createPublicKey(createPrivateKey(readFileSync(".testdata/keys/mms-jwt-private.pem", "utf8")))
    .export({ format: "jwk" });
  delete jwk.d; delete jwk.k;
  writeFileSync(".testdata/keys/mms-jwks.json", JSON.stringify({
    keys: [{ ...jwk, kid: "dev", alg: "ES256", use: "sig" }]
  }, null, 2));
'

# 3. Feed both sides the SAME kid, and keep aud/role claim in sync.
export MMS_JWT_PRIVATE_KEY_FILE=.testdata/keys/mms-jwt-private.pem
export MMS_JWT_KID=dev
# PostgREST:
#   PGRST_JWT_SECRET=@.testdata/keys/mms-jwks.json
#   PGRST_JWT_AUD=mms-api              # matches the signer's AUDIENCE
#   PGRST_JWT_ROLE_CLAIM_KEY='$.role'  # matches the "role" claim
```

`kid` must match on both sides or PostgREST rejects every token. The JWKS endpoint at
`/.well-known/jwks.json` serves the same public set (see
`docs/runbooks/signing-key-rotation.md` for rotation and the Key Vault variant). Never
commit either the private key or a real `kid`; `/tmp` paths above are for local dev only.

## Growing The App

- Put an action in the controller that owns its route group: `apps/web/app/routes.ts` and `apps/web/app/actions/*/controller.tsx` are two views of one contract, and `createController` rejects an action for a leaf its map does not own.
- Add a new group by adding a nested map in `apps/web/app/routes.ts` plus a matching kebab-case directory with a `controller.tsx`, then `router.map(...)` it in `apps/web/app/router.ts`.
- Add directories like `apps/web/app/data/` or `apps/web/test/` when the app actually needs them.
- Move shared UI into `apps/web/app/ui/` once more than one route needs it.
