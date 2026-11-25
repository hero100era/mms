import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { Session } from 'remix/session'

import { clearSessionCaches, DbSessionStorage } from './session-storage.ts'
import { createRolePool, withRole } from '../db/role-pool.ts'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'
const gatewayUrl =
  process.env.AUTH_GATEWAY_DATABASE_URL ||
  process.env.MMS_GATEWAY_DATABASE_URL ||
  (adminUrl ? withRole(adminUrl, 'auth_gateway') : undefined)
process.env.AUTH_GATEWAY_DATABASE_URL = gatewayUrl
const enabled = Boolean(gatewayUrl && adminUrl)
const adminPoolPool = createRolePool(() => adminUrl!, 1)
const user1 = '11111111-1111-1111-1111-111111111111'
const user2 = '22222222-2222-2222-2222-222222222222'

describe('DbSessionStorage', { skip: !enabled }, () => {
  let pool: Pool
  let storage: DbSessionStorage

  before(async () => {
    pool = adminPoolPool.get()
    await pool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values
        ($1, 'internal', 'Session One', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'active'),
        ($2, 'internal', 'Session Two', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'active')
      on conflict (id) do nothing
    `, [user1, user2])
    await pool.query(`
      insert into iam.role_assignment (user_id, db_role, scope_type, source, granted_by, grant_reason)
      select $1, 'int_viewer', 'global', 'manual', $2, 'session storage test'
      where not exists (select 1 from iam.role_assignment where user_id = $1 and db_role = 'int_viewer' and revoked_at is null)
    `, [user1, user2])
    storage = new DbSessionStorage()
  })

  after(async () => {
    await pool.query(`delete from iam.session where user_id in ($1, $2)`, [user1, user2])
    await pool.query(`delete from iam.role_assignment where user_id in ($1, $2)`, [user1, user2])
    await pool.query(`delete from iam.app_user where id in ($1, $2)`, [user1, user2])
    await pool.end()
  })

  function session(): Session {
    let s = new Session()
    s.set('auth', {
      userId: user1,
      kind: 'internal',
      activeRole: 'int_viewer',
      authMethod: 'entra',
      authTime: new Date().toISOString(),
    })
    s.set('__auth', { state: 'oauth-state' })
    s.set('_csrf', 'csrf-token')
    return s
  }

  it('persists the full Session.data and reloads it', async () => {
    let cookie = await storage.save(session())
    assert.ok(cookie)
    let loaded = await storage.read(cookie)
    assert.equal((loaded.get('auth') as { userId: string }).userId, user1)
    assert.deepEqual(loaded.get('__auth'), { state: 'oauth-state' })
    assert.equal(loaded.get('_csrf'), 'csrf-token')
  })

  it('rotates the id and deletes the old row', async () => {
    let cookie = await storage.save(session())
    let loaded = await storage.read(cookie)
    loaded.regenerateId(true)
    let rotated = await storage.save(loaded)
    assert.notEqual(rotated, cookie)
    assert.equal((await storage.read(cookie)).get('auth'), undefined)
  })

  it('rejects idle-expired and revoked sessions', async () => {
    let cookie = await storage.save(session())
    await pool.query(`update iam.session set idle_expires_at = now() - interval '1 second' where id = $1`, [cookie])
    clearSessionCaches()
    assert.equal((await storage.read(cookie)).get('auth'), undefined)

    let cookie2 = await storage.save(session())
    await pool.query(`update iam.session set expires_at = now() - interval '1 second' where id = $1`, [cookie2])
    clearSessionCaches()
    assert.equal((await storage.read(cookie2)).get('auth'), undefined)

    let cookie3 = await storage.save(session())
    await pool.query(`update iam.session set revoked_at = now() where id = $1`, [cookie3])
    clearSessionCaches()
    assert.equal((await storage.read(cookie3)).get('auth'), undefined)
  })
})
