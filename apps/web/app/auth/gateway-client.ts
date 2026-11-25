// Server-only. All BFF database access goes through the auth_gateway login role
// and the SECURITY DEFINER functions in the auth schema.
import type { QueryResultRow } from 'pg'

import { createRolePool, withRole } from '../db/role-pool.ts'

const gateway = createRolePool(() => {
  let url = process.env.AUTH_GATEWAY_DATABASE_URL || process.env.MMS_GATEWAY_DATABASE_URL
  if (process.env.NODE_ENV === 'production') {
    if (!url) throw new Error('MMS_GATEWAY_DATABASE_URL is required')
    return url
  }
  if (!url) {
    let base = process.env.DATABASE_URL
    if (!base) {
      throw new Error('DATABASE_URL or AUTH_GATEWAY_DATABASE_URL is required. See docs/testing/native-environment.md')
    }
    url = withRole(base, 'auth_gateway')
  }
  return url
}, 5)

export async function authCall<T>(fn: string, args: unknown[]): Promise<T> {
  let placeholders = args.map((_, index) => `$${index + 1}`).join(', ')
  let result = await gateway.get().query<{ result: T }>(
    `select ${fn}(${placeholders}) as result`,
    args,
  )
  return result.rows[0]!.result
}

export async function authQuery<T extends QueryResultRow>(sql: string, args: unknown[] = []): Promise<T[]> {
  let result = await gateway.get().query<T>(sql, args)
  return result.rows
}

export async function closeGatewayPool(): Promise<void> {
  await gateway.close()
}
