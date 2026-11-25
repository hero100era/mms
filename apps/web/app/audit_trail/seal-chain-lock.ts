import { Pool, type PoolClient } from 'pg'

/**
 * Serialises the `audit_trail.seal` blocks in `sealer-verifier.test.ts`.
 *
 * Those three `describe` blocks mutate one shared object, the seal chain in `audit_trail.seal`,
 * and the remix test runner forks a worker per *file*: a file with several top-level
 * describes runs them concurrently in separate forks, sharing only the database. Their
 * cleanup used to overlap ("delete every seal" in one block while another block was
 * mid-flow), which produced two different faults and hid a third:
 *
 *   - a real CHAIN_BROKEN, when the chain a seal expected to extend had been deleted
 *     underneath it, so the seal was written as a genesis seal;
 *   - then a silent no-op, when the surviving chain head already sat at the database
 *     horizon (`pg_snapshot_xmax`) and there was nothing left in [head, xmax) to seal.
 *
 * A module-level flag cannot fix that: each fork imports the module separately and gets
 * its own copy. The exclusion has to live in the database, so each block holds a session
 * advisory lock for its whole lifetime.
 */
const SEAL_CHAIN_LOCK = 782041650

export interface SealChainLock {
  release: () => Promise<void>
}

/**
 * Blocks until the `audit_trail.seal` chain is exclusively ours. The caller must release the
 * result, normally from an `after` hook, or the next block waits forever.
 */
export async function lockSealChain(url: string, block: string): Promise<SealChainLock> {
  let pool = new Pool({ connectionString: url, max: 1 })
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (error) {
    await pool.end().catch(() => {})
    throw error
  }
  
  // A held lock is a statement about a session, so it has to be verified on the session
  // that took it; Postgres has no "did I get this" return value here.
  try {
    await client.query('SET lock_timeout = 0')
    await client.query('SELECT pg_advisory_lock($1)', [SEAL_CHAIN_LOCK])
    let held = await client.query<{ held: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND objid = $1 AND pid = pg_backend_pid()
       ) AS held`,
      [SEAL_CHAIN_LOCK],
    )
    if (!held.rows[0]?.held) {
      throw new Error(`block "${block}": advisory lock not held after acquiring it`)
    }
  } catch (error) {
    client.release(true)
    await pool.end().catch(() => {})
    throw error
  }

  return {
    release: async () => {
      await client.query('SELECT pg_advisory_unlock($1)', [SEAL_CHAIN_LOCK]).catch(() => {})
      client.release()
      await pool.end().catch(() => {})
    },
  }
}
