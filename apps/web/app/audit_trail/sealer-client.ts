// Server-only. All audit sealing operations execute under the dedicated audit_sealer login role.
import { createRolePool, withRole } from '../db/role-pool.ts'

export function getSealerDatabaseUrl(): string {
  let url = process.env.AUDIT_SEALER_DATABASE_URL || process.env.MMS_SEALER_DATABASE_URL
  if (!url) {
    let base = process.env.DATABASE_URL ?? process.env.MMS_TEST_DATABASE_URL
    if (!base) {
      throw new Error('DATABASE_URL or AUDIT_SEALER_DATABASE_URL is required. See docs/testing/native-environment.md')
    }
    url = withRole(base, 'audit_sealer')
  }
  return url
}

const sealer = createRolePool(getSealerDatabaseUrl, 3)

export function getSealerPool() {
  return sealer.get()
}

export async function closeSealerPool(): Promise<void> {
  await sealer.close()
}
