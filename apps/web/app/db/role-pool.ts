// One place to own a login-role database pool.
//
// Every background/auth tier connects as its own PostgreSQL login role
// (`auth_gateway`, `worker`, `audit_sealer`). Each used to carry its own
// module-level `let pool`, lazy `new Pool`, URL-username rewrite and
// `close*Pool()`, and the three copies had already drifted: different guards
// for production, different fallback env vars, different failure messages.
// The policy (which env var wins) stays with each client; the mechanics live
// here.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Pool, type PoolClient } from 'pg'

// Load database URLs and passwords from .env in non-production environments only
if (process.env.NODE_ENV !== 'production' && process.env.APP_ENV !== 'production') try {
  let curr = import.meta.dirname
  let envFile: string | undefined
  for (let i = 0; i < 6; i++) {
    let candidate = path.join(curr, '.env')
    if (fs.existsSync(candidate)) {
      envFile = candidate
      break
    }
    let parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  if (envFile) {
    let content = fs.readFileSync(envFile, 'utf8')
    for (let line of content.split('\n')) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      let eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        let key = line.slice(0, eqIdx).trim()
        let val = line.slice(eqIdx + 1).trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (key.endsWith('DATABASE_URL') || key === 'PGRST_DB_URI') {
          if (!process.env[key]) {
            process.env[key] = val
          }
        }
      }
    }
  }
} catch {}

function getPasswordForRole(host: string, port: string, role: string, db: string): string | undefined {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD
  // Role-specific database URLs loaded from environment / .env
  let roleEnvMap: Record<string, string | undefined> = {
    auth_gateway: process.env.AUTH_GATEWAY_DATABASE_URL || process.env.MMS_GATEWAY_DATABASE_URL,
    worker: process.env.WORKER_DATABASE_URL || process.env.MMS_WORKER_DATABASE_URL,
    audit_sealer: process.env.AUDIT_SEALER_DATABASE_URL || process.env.MMS_SEALER_DATABASE_URL,
    migrator: process.env.MIGRATOR_DATABASE_URL,
    authenticator: process.env.PGRST_DB_URI,
  }
  let roleUrl = roleEnvMap[role]
  if (roleUrl) {
    try {
      let parsed = new URL(roleUrl)
      if (parsed.password) return parsed.password
    } catch {}
  }
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    return undefined
  }
  try {
    let pgpass = path.join(os.homedir(), '.pgpass')
    if (fs.existsSync(pgpass)) {
      let content = fs.readFileSync(pgpass, 'utf8')
      let lines = content.split('\n')
      let fallbackPass: string | undefined
      for (let line of lines) {
        line = line.trim()
        if (!line || line.startsWith('#')) continue
        let parts = line.split(':')
        if (parts.length >= 5) {
          let [h, p, d, u] = parts
          let pass = parts.slice(4).join(':')
          if (
            (h === '*' || h === host || (h === 'localhost' && host === '127.0.0.1') || (h === '127.0.0.1' && host === 'localhost')) &&
            (p === '*' || p === port || (port === '' && p === '5432')) &&
            (d === '*' || d === db)
          ) {
            if (u === role) return pass
            if (u === '*' || (u === 'postgres' && role === 'postgres')) fallbackPass = pass
          }
        }
      }
      if (fallbackPass) return fallbackPass
    }
  } catch {}
  return undefined
}

/**
 * Rewrites only the username of a connection URL, preserving host, port,
 * password and database. If password is empty, resolves via libpq methods (PGPASSWORD or ~/.pgpass).
 * Malformed URLs are returned unchanged: callers treat
 * them as opaque configuration and let `pg` report the real error.
 */
export function withRole(url: string, role: string): string {
  try {
    let parsed = new URL(url)
    parsed.username = role
    if (!parsed.password) {
      let pass = getPasswordForRole(parsed.hostname, parsed.port, role, parsed.pathname.replace(/^\//, ''))
      if (pass) {
        parsed.password = pass
      }
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export type RolePool = {
  get(): Pool
  close(): Promise<void>
}

/**
 * A lazily created pool. `resolve()` is called exactly once, on first use,
 * so importing a module never opens a connection or reads production secrets.
 */
export function createRolePool(resolve: () => string, max: number): RolePool {
  let pool: Pool | undefined
  return {
    get() {
      if (!pool) {
        let connStr = resolve()
        try {
          let parsed = new URL(connStr)
          if (!parsed.password) {
            let pass = getPasswordForRole(parsed.hostname, parsed.port, parsed.username, parsed.pathname.replace(/^\//, ''))
            if (pass) {
              parsed.password = pass
              connStr = parsed.toString()
            }
          }
        } catch {}
        pool = new Pool({
          connectionString: connStr,
          max,
          connectionTimeoutMillis: 10_000,
          idleTimeoutMillis: 30_000,
        })
        pool.on('error', (err) => {
          console.error('Unexpected idle PostgreSQL client error:', err)
        })
      }
      return pool
    },
    async close() {
      await pool?.end()
      pool = undefined
    },
  }
}

/** Runs work with one checked-out client, always releasing it. */
export async function withClient<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client = await pool.connect()
  try {
    return await work(client)
  } finally {
    client.release()
  }
}
