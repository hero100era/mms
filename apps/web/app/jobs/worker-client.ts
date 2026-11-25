// The `worker` login role for outbox jobs, Entra deprovisioning and malware
// scanning. URL policy lives here; pool mechanics live in ../db/role-pool.ts.
import { createRolePool, withRole } from '../db/role-pool.ts'

const worker = createRolePool(() => {
  let url = process.env.WORKER_DATABASE_URL || process.env.MMS_WORKER_DATABASE_URL
  if (!url && process.env.MMS_GATEWAY_DATABASE_URL) {
    url = withRole(process.env.MMS_GATEWAY_DATABASE_URL, 'worker')
  }
  if (!url) {
    let base = process.env.DATABASE_URL
    if (!base) {
      throw new Error('DATABASE_URL or WORKER_DATABASE_URL is required. See docs/testing/native-environment.md')
    }
    url = withRole(base, 'worker')
  }
  return url
}, 3)

export function getWorkerPool() {
  return worker.get()
}

export async function closeWorkerPool(): Promise<void> {
  await worker.close()
}
