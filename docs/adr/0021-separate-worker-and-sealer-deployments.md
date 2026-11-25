# ADR-0021: Separate deployments for the web tier, the worker and the audit sealer

- Status: proposed
- Date: 2026-11-03
- Card: H-11 (separate worker/sealer deployments)
- Related: ADR-0014 (Tier-2 retention and crypto-shredding), ADR-0017 (caller identity in definer functions)

## Context

Until H-11 the web process started every background job: the outbox poller, the Entra
deprovisioning sync, the malware scan scheduler, and (from H-11 onward) the audit sealer.
That is convenient in development and wrong in production for reasons of privilege, not
of load:

- The poller and scanner connect as the `worker` login role; the sealer connects as
  `audit_sealer`. Co-locating them gives the web tier three standing database
  credentials, and a compromise of the request path then reaches the sealer's role.
- Tier-2 sealing exists so the audit trail is exported to WORM storage by something that
  does not share administration with the application. If the application process seals,
  whoever deploys the application can also stop sealing, which is exactly the
  independence the control was meant to buy.

The roles already existed (`db/bootstrap/01_roles.sql`); what was missing was a
deployment boundary that keeps them apart, and an entrypoint that can run the sealer at
all — before H-11 nothing outside the test suite ever called `sealHorizon()`.

## Decision

The process states what it is via `MMS_RUNTIME_ROLE`, and each role starts only its own
work. `apps/web/app/jobs/runtime.ts` is the single place that maps a role to a plan:

| Role | Serves HTTP | Runs application jobs | Seals |
| --- | --- | --- | --- |
| `web` | yes | no | no |
| `worker` | no | yes | no |
| `sealer` | no | no | yes |
| `all` | yes | yes | yes |

- **Unset is `all` outside production and `web` in production.** One process is what
  `npm run dev` and the test suite need; in production an unset variable is far more
  likely a missing manifest entry than a deliberate decision to co-locate everything, so
  the default narrows rather than widens.
- **An unknown value throws** instead of falling back. `MMS_RUNTIME_ROLE=worker,sealer`
  is a configuration mistake, and accepting it silently would produce a process that does
  one job and looks healthy.
- **A process that is asked to do the wrong thing exits loudly.** `server.ts` refuses to
  run when the plan has no HTTP; `worker.ts` refuses when it may not run jobs;
  `sealer.ts` refuses when it may not seal. A worker that quietly served nothing would
  look healthy behind a load balancer while every job stalled.
- **Entrypoints:** `apps/web/server.ts` (web), `apps/web/worker.ts`, `apps/web/sealer.ts`,
  wired as `npm start`, `npm run start:worker`, `npm run start:sealer`.

The sealer runs `sealHorizon()` once at startup and then on a cadence
(`MMS_SEAL_INTERVAL_SECONDS`, default 900). Sealing is idempotent per horizon, so a missed
tick is recovered by the next one; the `audit_trail.seal` chain makes a real gap visible rather
than silent. Overlapping runs are refused in-process because two runs would compute the
same horizon and race on the chain head. A failed run is logged and retried — the timer is
deliberately not unref'd, because a transient WORM outage must not end the deployment.

## Consequences

- The deployment manifest needs three workloads (or two plus the web tier) and an explicit
  `MMS_RUNTIME_ROLE`; the web tier no longer needs `MMS_WORKER_DATABASE_URL` or
  `MMS_SEALER_DATABASE_URL` at all, and the sealer needs nothing but its own.
- `npm run start` alone now serves HTTP only in production. Development and `npm run check`
  are unaffected because they run with `NODE_ENV` unset or `development`.
- Sealing still shares a host with the application until it is deployed separately. This
  ADR makes that separation possible and default-safe; it does not enforce it, and the
  pen test (H-12) should verify the production manifest actually separates them.
- The worker and sealer have no HTTP health endpoint. Liveness is the process staying up
  and (for the sealer) `audit_trail.seal` advancing; a metrics endpoint is out of scope here.
