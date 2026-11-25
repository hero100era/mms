// Card H-11: which processes run which jobs.
//
// The application used to start every scheduler from the HTTP server. That works in
// development and is wrong in production for two reasons that are about privilege, not
// about load:
//
//   * the job poller and the malware scanner connect as the `worker` login role, and the
//     sealer connects as `audit_sealer`. If the web process starts them, the web tier
//     carries three standing database credentials, and a compromise of the request path
//     reaches the audit sealer's role, which exists to be independent of it;
//   * independent administration is the point of Tier-2 sealing (G2). The same operator
//     who can deploy the web tier should not thereby be able to stop sealing or start it
//     under a role the web tier holds.
//
// So the process states what it is, and each role starts only its own work. The default
// is deliberately permissive in development (`all`) and deliberately narrow in
// production (`web`), because a silent default of "start everything" is how the
// separation gets lost again.

export type RuntimeRole = 'web' | 'worker' | 'sealer' | 'all'

export type RuntimePlan = {
  role: RuntimeRole
  http: boolean
  jobs: boolean
  sealer: boolean
}

const VALID: ReadonlySet<string> = new Set(['web', 'worker', 'sealer', 'all'])

/**
 * Reads `MMS_RUNTIME_ROLE`. Unset means `all` outside production (one process is
 * convenient for `npm run dev` and for the test suite) and `web` in production, where
 * an unset variable is far more likely to be a missing deployment manifest entry than a
 * deliberate decision to co-locate everything.
 */
export function runtimeRole(env: NodeJS.ProcessEnv = process.env): RuntimeRole {
  let raw = (env.MMS_RUNTIME_ROLE ?? '').trim().toLowerCase()
  if (raw && VALID.has(raw)) return raw as RuntimeRole
  if (raw) {
    throw new Error(
      `MMS_RUNTIME_ROLE must be one of web, worker, sealer or all (received ${JSON.stringify(raw)})`,
    )
  }
  return env.NODE_ENV === 'production' ? 'web' : 'all'
}

export function runtimePlan(env: NodeJS.ProcessEnv = process.env): RuntimePlan {
  let role = runtimeRole(env)
  return {
    role,
    http: role === 'web' || role === 'all',
    jobs: role === 'worker' || role === 'all',
    sealer: role === 'sealer' || role === 'all',
  }
}

/**
 * A process that may not do a thing fails loudly rather than quietly doing nothing: a
 * worker deployment that silently served no HTTP would look healthy in a load balancer
 * check while every job stalled.
 */
export function assertPlan(plan: RuntimePlan): void {
  if (plan.role === 'worker' && plan.http) {
    throw new Error('a worker process must not serve HTTP')
  }
  if (plan.role === 'sealer' && (plan.http || plan.jobs)) {
    throw new Error('the sealer process must not serve HTTP or run application jobs')
  }
}
