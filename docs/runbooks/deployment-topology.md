# Runbook: deployment topology (web, worker, sealer)

Three workloads share one codebase and one database, and differ only by
`MMS_RUNTIME_ROLE`. Card H-11; the reasoning is in
[ADR-0021](../adr/0021-separate-worker-and-sealer-deployments.md).

## What runs where

| Workload | Command | Role | Database credentials it may hold |
| --- | --- | --- | --- |
| web | `npm start` | `web` | `auth_gateway`, PostgREST (no `worker`, no `audit_sealer`) |
| worker | `npm run start:worker` | `worker` | `worker` only |
| sealer | `npm run start:sealer` | `sealer` | `audit_sealer` only |

`MMS_RUNTIME_ROLE` is required in production. If it is unset the web tier starts and the
job and sealing work does **not** — deliberate, so a forgotten manifest line fails visible
(jobs stall, `audit_trail.seal` stops advancing) rather than folding the sealer's role back into
the application.

## Environment

| Variable | Workload | Meaning |
| --- | --- | --- |
| `MMS_RUNTIME_ROLE` | all | `web`, `worker`, `sealer`, or `all` (development only) |
| `MMS_WORKER_DATABASE_URL` | worker | connection string for the `worker` role |
| `MMS_SEALER_DATABASE_URL` | sealer | connection string for `audit_sealer` |
| `MMS_SEAL_INTERVAL_SECONDS` | sealer | sealing cadence, default `900` |
| `MMS_WORM_*` | sealer | WORM storage target (see the sealing runbook) |

Development uses `all` in one process; do not deploy that.

## Starting and checking

1. Deploy the three workloads with their own credentials; do not share a service account
   between the worker and the sealer.
2. Web: `GET /.well-known/jwks.json` returns 200 and a login works.
3. Worker: the log line `Worker started (runtime role worker)`; outbox depth stops growing
   (`select count(*) from core.outbox where processed_at is null`).
4. Sealer: the log line at startup is either
   `Sealer startup: sealed <from>..<to> …` or `Sealer startup: nothing to seal`.
   Then confirm `select max(id), max(to_xid) from audit_trail.seal` advances over an hour of
   real traffic, and that the verifier passes (`npm run db:verify`).

## Failure modes

| Symptom | Cause | Action |
| --- | --- | --- |
| Web exits with `does not serve HTTP; start worker.ts or sealer.ts instead` | `MMS_RUNTIME_ROLE` set to `worker`/`sealer` on the web workload | fix the manifest |
| Worker exits with `does not run application jobs` | role left as `web` (the production default) | set `MMS_RUNTIME_ROLE=worker` |
| Sealer logs `MMS_SEALER_DATABASE_URL is required` and keeps retrying | credential not mounted | mount it; the process stays up on purpose |
| Sealer logs `Sealer run failed` repeatedly | WORM endpoint unreachable or credentials expired | restore storage; unsealed horizon grows, which is the alarm |
| `audit_trail.seal` static for hours with no sealer log | the sealer workload is not deployed at all | deploy it; the web tier will not seal for you |
| Jobs stall, web healthy | worker workload not deployed | deploy it; `MMS_RUNTIME_ROLE=web` does not start jobs |

## Shutdown

All three handle `SIGTERM`: the web tier stops accepting connections and closes the
session pool, the worker stops its schedulers and closes the worker pool, the sealer waits
for the in-flight run and closes the sealer pool. Give each a grace period longer than one
seal run (the sealer's default interval is 15 minutes; a run is normally seconds).
