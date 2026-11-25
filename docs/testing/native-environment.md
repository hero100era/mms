# MMS Native Local Environment Setup Guide

## 1. Supported Operating Systems

MMS development and acceptance testing run natively without requiring Docker:
- **Debian / Ubuntu Linux** (x86_64, aarch64)
- **macOS** (Apple Silicon, Intel)

---

## 2. Required Prerequisites

| Dependency | Required Version | Verification Command |
|---|---|---|
| **Node.js** | `^24.7.0` or `^26.0.0` (Node 26 recommended) | `node --version` |
| **npm** | `^10.0.0` or `^12.0.0` | `npm --version` |
| **PostgreSQL** | Approved PostgreSQL 18.x (baseline: 18.7) | `psql --version` |
| **PostgREST** | 16.5 baseline | `postgrest --version` |

---

## 3. Native Installation Instructions

### Debian / Ubuntu Linux

```bash
# 1. Install PostgreSQL 18 from PGDG repository
sudo apt-get install -y curl ca-certificates gnupg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update
sudo apt-get install -y postgresql-18 postgresql-contrib-18 libpq-dev

# 2. Download and install PostgREST 16.5
curl -fsSL https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-linux-static-x64.tar.xz | tar -xJ
sudo mv postgrest /usr/local/bin/
postgrest --version
```

### macOS (Homebrew)

```bash
# 1. Install Node, PostgreSQL, and PostgREST
brew install node@26 postgresql@18 postgrest
brew services start postgresql@18
```

---

## 4. PostgreSQL Cluster & Database Setup

The MMS repository provides an authoritative, idempotent initialization command that creates required runtime roles, memberships, databases, disposable markers, and acceptance signing keys without manual SQL:

```bash
# Authoritative environment initialization (fails closed; requires --allow-initial-create on first run)
npm run testenv:init -- --allow-initial-create
```

This single command:
1. Reuses authoritative bootstrap definitions (`db/bootstrap/01_roles.sql`) to configure runtime roles (`mms_owner`, `migrator`, `authenticator`, `auth_gateway`, `worker`, `audit_sealer`, and `NOLOGIN` capability roles).
2. Verifies and configures `mms_dev` (protected), `mms_test` (marked disposable), and `mms_acceptance` (marked disposable) with UTC timezone.
3. Initializes protected acceptance test signing keys in `.testdata/keys/` (mode 0700/0600).

To customize local role passwords via environment variables during initialization:
```bash
LOCAL_AUTHENTICATOR_PASSWORD=<LOCAL_AUTHENTICATOR_PASSWORD> \
LOCAL_MIGRATOR_PASSWORD=<LOCAL_MIGRATOR_PASSWORD> \
npm run testenv:init
```

---

## 5. Starting & Managing PostgREST

Native PostgREST runs as a standalone daemon communicating with PostgreSQL over localhost:

```bash
# Automatically configure keys and start native PostgREST in background
npm run testenv:start

# Check PostgREST status and reachability
npm run postgrest:check

# Stop PostgREST daemon
npm run testenv:stop
```

To run PostgREST manually with explicit environment variables:
```bash
PGRST_DB_URI="postgres://authenticator:<LOCAL_AUTHENTICATOR_PASSWORD>@127.0.0.1:5432/mms_acceptance" \
PGRST_DB_SCHEMAS='api' \
PGRST_DB_ANON_ROLE='web_anon' \
PGRST_JWT_SECRET='@.testdata/keys/mms-jwks.json' \
PGRST_JWT_AUD='mms-api' \
PGRST_JWT_ROLE_CLAIM_KEY='$.role' \
PGRST_SERVER_PORT=3001 \
PGRST_DB_PRE_REQUEST='private.pre_request' \
postgrest
```

To reload PostgREST's schema cache after migrations or schema changes:
```bash
psql "${DATABASE_URL:-postgresql://postgres@127.0.0.1:5432/mms_acceptance}" -c "NOTIFY pgrst, 'reload schema';"
```

---

## 6. Verifying & Resetting Acceptance Environment

```bash
# 1. Verify prerequisites and detect any native drift
npm run testenv:check

# 2. Reset and re-seed the disposable acceptance database
npm run testenv:reset

# 3. View comprehensive environment status
npm run testenv:status

# 4. Run end-to-end acceptance tests
npm run test:e2e
```
