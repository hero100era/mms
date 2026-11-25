// Server-only. Persists both authenticated sessions (iam.session) and
// pre-authentication sessions (iam.pre_auth_session) in PostgreSQL through
// auth_gateway functions so multi-replica deployments share CSRF/OAuth state
// and enforce immediate session revocation with zero cross-replica lag (R2-H01).
import { Session } from 'remix/session'
import type { SessionStorage } from 'remix/session'

import { authCall } from './gateway-client.ts'
import type { SessionAuth } from './context.ts'

type SessionData = Session['data']

type SessionRow = {
  session_id: string
  user_id: string
  user_kind: 'internal' | 'external'
  active_role: string
  auth_method: 'entra' | 'microsoft' | 'google' | 'pwd'
  data: SessionData
  idle_expires_at: string
  expires_at: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Kept as no-op compatibility exports now that session reads and pre-auth state
// are authoritative in PostgreSQL with no process-local read cache.
export function invalidateCachedSession(_id: string): void {}
export function invalidateAllCachedSessions(_keepId?: string): void {}
export function clearSessionCaches(): void {}

export class DbSessionStorage implements SessionStorage {
  async read(cookie: string | null): Promise<Session> {
    if (!cookie) return new Session()

    if (UUID_RE.test(cookie)) {
      let row = await authCall<SessionRow | null>('auth.session_touch', [cookie])
      if (row) {
        return new Session(cookie, row.data)
      }
    }

    let preData = await authCall<SessionData | null>('auth.pre_auth_read', [cookie])
    return preData ? new Session(cookie, preData) : new Session()
  }

  async save(session: Session): Promise<string | null> {
    if (session.destroyed) {
      if (UUID_RE.test(session.id)) {
        await authCall('auth.session_revoke_reason', [session.id, 'logout'])
      }
      await authCall('auth.pre_auth_delete', [session.id])
      return ''
    }
    if (session.deleteId) {
      if (UUID_RE.test(session.deleteId)) {
        await authCall('auth.session_revoke_reason', [session.deleteId, 'rotated'])
      }
      await authCall('auth.pre_auth_delete', [session.deleteId])
    }

    let auth = session.get('auth') as SessionAuth | undefined

    if (!auth) {
      if (UUID_RE.test(session.id)) {
        let existing = await authCall<SessionRow | null>('auth.session_read', [session.id])
        if (existing) {
          if (session.dirty) {
            await authCall('auth.session_write', [session.id, JSON.stringify(session.data)])
          }
          return null
        }
      }
      await authCall('auth.pre_auth_write', [session.id, JSON.stringify(session.data)])
      return session.id
    }

    let existing = UUID_RE.test(session.id)
      ? await authCall<SessionRow | null>('auth.session_read', [session.id])
      : null

    if (existing) {
      if (session.dirty) {
        await authCall('auth.session_write', [session.id, JSON.stringify(session.data)])
      }
      return session.id
    }

    await authCall('auth.session_create', [
      auth.userId,
      auth.authMethod,
      auth.activeRole,
      auth.clientIp ?? null,
      auth.userAgent ?? null,
      session.id,
    ])
    await authCall('auth.session_write', [session.id, JSON.stringify(session.data)])
    await authCall('auth.pre_auth_delete', [session.id])
    return session.id
  }
}
