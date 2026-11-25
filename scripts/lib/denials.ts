// Pure helpers for asserting that a database call was denied by authorization.
//
// This module intentionally has no import-time side effects (no database URL or
// key reads), so callers can import it without provisioning an environment. The
// acceptance suites import it from here; `scripts/postgrest-test.ts` keeps the
// database/signing bootstrap.

import { PgrstError } from '@mms/pgrst-client'

/**
 * A check that expects an authorization denial must only pass on a genuine
 * 401/403 from PostgREST. A 404/PGRST202 (function-not-found because of wrong
 * argument names or a stale schema cache), a 404/PGRST205 (missing relation), a
 * connection/setup failure, or a plain Error is NOT a denial: counting any of
 * those as "rejected" lets a broken or misconfigured test pass.
 */
export function isAuthorizationDenial(err: unknown): boolean {
  return err instanceof PgrstError && (err.status === 401 || err.status === 403)
}

export function describeError(err: unknown): string {
  if (err instanceof PgrstError) {
    return `HTTP ${err.status}${err.code ? ` (code ${err.code})` : ''}: ${err.message}`
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`
  }
  return String(err)
}

export interface DenialCheck {
  passed: boolean
  detail: string
}

/**
 * Calls an RPC that the caller's database role must NOT be allowed to perform
 * and reports a pass only on a genuine 401/403 authorization denial.
 *
 * The denial may come from either layer, which is why the detail records the
 * PostgREST status and message:
 *   - a missing EXECUTE grant (SQLSTATE 42501 from the grant check), or
 *   - an authorization refusal raised inside the function body (also 42501).
 * Both are legitimate denials for segregation-of-duties checks; a 404 (wrong
 * arguments or a stale schema cache) and a successful call are failures.
 */
export async function expectDenied(
  client: { rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown> },
  fn: string,
  args: Record<string, unknown>,
): Promise<DenialCheck> {
  let threw = false
  let denialError: unknown
  try {
    await client.rpc(fn, args)
  } catch (err) {
    threw = true
    denialError = err
  }

  if (!threw) {
    return { passed: false, detail: `UNEXPECTED: ${fn} was permitted (no denial returned)` }
  }
  if (!isAuthorizationDenial(denialError)) {
    return {
      passed: false,
      detail: `Expected a 401/403 authorization denial from ${fn}, but got ${describeError(denialError)}`,
    }
  }
  return { passed: true, detail: `Denied by database authorization: ${describeError(denialError)}` }
}
