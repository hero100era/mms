# Runbook: Backup and Restore Operations (Phase R7.5)

This runbook defines the operational procedures, Recovery Point Objective (RPO), Recovery Time Objective (RTO), and restore verification drills for the MMS PostgreSQL 18 database and WORM evidence.

## 1. Objectives (RPO and RTO)

Baseline agreed objectives from project governance (see `docs/plans/auth-implementation-plan.md` Decision Q18, Gate G3):
- **Baseline Target:** **RPO = 15 minutes**, **RTO = 4 hours** (subject to formal product owner sign-off at release gate).
- **Aspirational / Operational Target (Proposed):**

| Service Area | RPO (Target) | RTO (Target) | Mechanism |
|---|---|---|---|
| **Primary Relational Store** (`core`, `survey`, `iam`, `auth`, `party`) | **<= 15 minutes** (Baseline Q18) / *<= 5m (Proposed)* | **<= 4 hours** (Baseline Q18) / *<= 60m (Proposed)* | Continuous PostgreSQL WAL archiving to cloud blob storage with 15-minute incremental storage snapshots. |
| **Tier-2 Audit Evidence** (`audit_trail.seal`, WORM batch archives) | **RPO = 0** | **<= 15 minutes** | Immutable WORM storage replication (Azure Blob Storage Immutability Policy / S3 Object Lock). Once sealed, audit horizons cannot be rolled back. |
| **Quarantine Storage** (`quarantine/*`) | Transient | N/A | Non-promoted quarantine blobs are ephemerally retained for 24 hours and automatically swept by `runQuarantineSweep()`. |

## 2. Backup Topology

1. **Continuous WAL Archiving:**
   PostgreSQL `archive_mode = on` with `archive_command` streaming WAL segments to encrypted, append-only cold storage every 60 seconds.
2. **Automated Base Backups:**
   Daily full physical backup (`pg_basebackup` or managed cloud snapshot) retained for 30 days.
3. **WORM Evidence Replication:**
   Cryptographic audit batches written by the sealer are multi-region geo-replicated with retention locks matching the statutory 5–10 year requirement.

## 3. Restore Drill Procedure (`scripts/restore-drill.sh`)

Restore drills prove that backups can be restored into a fresh environment without data corruption, loss of grants, or broken cryptographic chains.

### Safety Invariants

Before any destructive command executes, `scripts/restore-drill.sh` validates:
1. `SCRATCH_DB` is **not** identical to `DATABASE_URL`'s database name.
2. `SCRATCH_DB` matches approved scratch patterns (`mms_restore_drill`, `*_drill`, `*_scratch`, `*_restore`).
3. Destructive `DROP DATABASE` operates only against the validated scratch database.

### Drill Execution

Run the restore drill locally or in staging:

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mms_dev ./scripts/restore-drill.sh
```

### Verification Pipeline (Steps 1 to 5)

1. **Dump Source Database:** Creates a custom-format pg_dump archive including table data, schemas, grants, and row-level security policies.
2. **Create Scratch Database:** Creates `mms_restore_drill` on the target database server.
3. **Restore Archive:** Restores schemas and data via `pg_restore --exit-on-error`.
4. **Database Invariants Check:** Runs `npm run db:verify` against `$SCRATCH_URL`:
   - Enforces 23 pgTAP test suites.
   - Validates RLS policies, caller-role functions, authority rules, and break-glass locks.
5. **WORM & Seal Correspondence:**
   - Queries `audit_trail.seal` row count in the restored database.
   - Executes `npm run audit_trail:verify` to confirm that the restored seal hash chain matches the immutable WORM records byte-for-byte.

## 4. Cadence and Audit Evidence

- **Automated Drill Frequency:** Bi-weekly automated execution in CI/staging environment.
- **Disaster Recovery Exercise:** Semi-annual live exercise witnessed by Head Office Compliance.
- **Record Keeping:**
  - Date and time of drill.
  - Source database and scratch database identifier.
  - Dump byte size and elapsed duration in seconds.
  - Number of verified audit seals.
  - Exit code and hash verification output.
  - Sign-off from Lead Infrastructure Engineer and HO Compliance Officer.

## 5. Drill Execution Log

| Date (UTC) | Operator | Source DB | Scratch DB | Dump Size | Duration | pgTAP Invariants | Seal Count Verified | Exit Code | Result |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-10 | Antigravity / Engineering | `mms_dev` | `mms_restore_drill` | 556 KB | 7s | 23/23 Suites Passed | 0 / 0 | 0 | PASS |

