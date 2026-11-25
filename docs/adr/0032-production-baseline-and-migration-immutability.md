# ADR-0032: First Production Baseline Freeze and Forward-Only Migration Immutability

- Status: Accepted (Baseline Pending Release)
- Date: 2026-11-20
- Authors: MMS Architecture & Security Team
- State: `FIRST_PRODUCTION_BASELINE = NOT_ESTABLISHED`
- Baseline Scope: 84 normalized migrations (`20261030T111331Z_f04-poc` through `20261108T085334Z_r8-5-closure`)
- Preview Manifest: `docs/review/production-baseline-preview.lock.json`
- Policy: `PRE_PRODUCTION_NORMALIZATION`

## Context

During prototype development prior to production deployment, MMS maintained a declarative desired schema in `db/src/` alongside migration files in `db/migrations/`. In pre-production, migrations were consolidated and normalized to represent the approved target architecture:
1. Technical audit infrastructure (change logs, events, sealing, reconciliation, WORM storage) was normalized directly under the `audit_trail` schema namespace across all 84 prototype migrations.
2. The `audit` namespace was permanently reserved for the maritime Company Audit domain (`audit.programme`, `audit.job`, `audit.report`, `audit.finding`, etc.).
3. Redundant, non-authoritative AST dumps (`plan/` subdirectories) were removed to maintain single-source-of-truth consistency across executable SQL, review checklists (`REVIEW.md`), and lock manifests (`migrations.lock.json`).

Before MMS holds live, non-disposable maritime operational records (vessels, surveys, certificates, qualifications, deficiencies, audits, billing), the database schema history must transition from flexible prototype consolidation to permanent immutability.

## Decision

1. **Explicit State: `FIRST_PRODUCTION_BASELINE = NOT_ESTABLISHED`**:
   MMS remains in pre-production prototype development. The normalized 84-migration baseline is verified and maintained as an authoritative preview in `docs/review/production-baseline-preview.lock.json`. The production baseline lock file (`db/production-baseline.lock.json`) is not established until a formal production release occurs.

2. **Strictly One-Way Freeze Procedure & Release Governance**:
   The transition to permanent immutability is executed via `npm run db:baseline:freeze`. This operation is strictly one-way and irreversible:
   - **Non-Self-Asserted Approval Governance:**
     * Self-asserted CLI execution is strictly prohibited. The irreversible freeze command rejects local CLI executions to prevent unproven baseline declarations.
     * Must execute exclusively within an approved release workflow (GitHub Actions `.github/workflows/baseline-freeze.yml`) targeting the protected environment `production-release` with required environment reviewers and automated CI provenance (`GITHUB_RUN_ID`, `GITHUB_SHA`, `MMS_RELEASE_APPROVERS`, `MMS_RELEASE_ID`).
   - **Release Tag Authenticity:**
     * The workflow verifies that the designated release tag exists, points directly to current `HEAD` (`git rev-list -n 1 <tag> === HEAD`), and is an authenticated annotated tag object (`git cat-file -t <tag> === 'tag'`), not a lightweight pointer.
   - **Unified Database Execution Model:**
     * The approved model is strictly codified: **Approved CI runner -> ephemeral local PostgreSQL 18.x service -> full database and acceptance gates -> baseline freeze**.
     * Refuses remote or shared database hosts; enforces execution against an ephemeral local PostgreSQL instance with safe unique scratch database isolation (`mms_freeze_scratch_*_scratch`), durable disposable marker comments, and guaranteed cleanup in `finally`.
   - **Complete Lock Coverage Verification:**
     * Asserts that migration directories match lock entries (84/84), all disk digests match recorded hashes, no extra or missing directories exist, no duplicate migration IDs exist, no untracked migration artifacts exist, and required review records (`REVIEW.md`) are present with completed checklists.
   - **Full Gate Enforcement:**
     * Full empty-database replay of all 84 migrations into the scratch database.
     * Zero-drift verification against `db/src/` (`npm run db:check`).
     * Pgschema coverage verification (`npm run db:spike`).
     * Database invariant and pgTAP test verification (`npm run db:test`, `npm run db:verify`).
     * Release gate verification (`npm run release:check`).
   - **Manifest Transition:**
     * Copies verified manifest to authoritative path `db/production-baseline.lock.json`.
     * Updates `db/FIRST_PRODUCTION_BASELINE.json` with status `ESTABLISHED`, recording release ID, commit SHA, approvers, approval date, workflow run ID, and release tag SHA.
     * Refuses to overwrite any already existing baseline lock (one-way).

3. **Baseline Verification Tooling**:
   - `npm run db:baseline:verify` (`db/scripts/verify-baseline.ts`) provides a strictly read-only verification command:
     * When `NOT_ESTABLISHED`: verifies disk digests and review records against `docs/review/production-baseline-preview.lock.json`.
     * When `ESTABLISHED`: verifies disk digests, metadata, and immutability against `db/production-baseline.lock.json`.
   - Integrated into `npm run release:check`.

4. **Mechanical CI Enforcement (Post-Establishment)**:
   - Once `db/production-baseline.lock.json` is generated upon formal release, `db/scripts/check-migrations.ts` and `scripts/check-release-gate.ts` enforce byte-for-byte SHA-256 matching for baseline migrations.
   - `db/scripts/lock-migrations.ts` refuses to update or overwrite any baseline migration entry.
   - All subsequent database changes must be forward-only migrations created via `npm run db:plan -- --name <name>` starting from migration 85.

## Consequences

- Resolves ambiguity between pre-production normalization and production baseline freeze.
- Baseline preview in `docs/review/production-baseline-preview.lock.json` guarantees verified prototype consistency without prematurely locking pre-production development.
- Baseline freeze cannot be triggered accidentally or overwrite an existing frozen baseline.
- Production upgrades proceed forward-only with tested, immutable scripts once formal release occurs.
