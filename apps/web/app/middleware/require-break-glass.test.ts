import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { generateKeyPairSync } from 'node:crypto'
import { Pool } from 'pg'

import { sessionCookie } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { withRole } from '../db/role-pool.ts'
import { router } from '../router.ts'
import { routes } from '../routes.ts'

// Card H-10: a break-glass account signs in like anyone else and is then parked on the
// one page that asks why. These tests drive the real router, so they cover the gate as
// the browser meets it rather than the middleware in isolation: the gate reads dormancy
// from the database, and a stubbed answer would not prove that.
const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = adminUrl
}
if (!process.env.AUTH_GATEWAY_DATABASE_URL) {
  process.env.AUTH_GATEWAY_DATABASE_URL =
    process.env.MMS_GATEWAY_DATABASE_URL || withRole(adminUrl, 'auth_gateway')
}

const userId = 'f1000000-0000-0000-0000-000000000001'
const sessionId = 'f1000000-0000-0000-0000-000000000201'

async function signedCookie(sid: string): Promise<string> {
  let cookieVal = JSON.stringify({ value: sid, expires: Date.now() + 12 * 60 * 60 * 1000 })
  let raw = await sessionCookie.serialize(cookieVal)
  return raw.split(';')[0] ?? ''
}

describe('Card H-10: break-glass gate', () => {
  let adminPool: Pool
  let cookie: string

  before(async () => {
    if (!process.env.MMS_JWT_PRIVATE_KEY) {
      let pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      process.env.MMS_JWT_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    }
    adminPool = new Pool({ connectionString: adminUrl })
    clearSessionCaches()

    await adminPool.query('delete from iam.role_assignment where user_id = $1', [userId])
    await adminPool.query('delete from iam.break_glass_account where user_id = $1', [userId])
    await adminPool.query('delete from iam.session where user_id = $1', [userId])
    await adminPool.query('delete from iam.app_user where id = $1', [userId])

    await adminPool.query(
      // An internal identity must carry a tenant and object id (app_user_kind_shape_ck);
      // the values only have to be present and unique, the gate never reads them.
      `insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
       values ($1, 'internal', 'Break Glass Test',
               '11111111-1111-1111-1111-111111111111', $1, 'active')`,
      [userId],
    )
    await adminPool.query(
      `insert into iam.break_glass_account (user_id, label) values ($1, 'Test emergency key')`,
      [userId],
    )
    await adminPool.query(
      `insert into iam.session (id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at, data)
       values ($1::uuid, $2::uuid, 'internal', 'int_sysadmin', 'entra',
               now() + interval '30 minutes', now() + interval '4 hours',
               jsonb_build_array(jsonb_build_object(
                 'auth', jsonb_build_object(
                   'userId', $2::text,
                   'kind', 'internal',
                   'activeRole', 'int_sysadmin',
                   'authMethod', 'entra',
                   'authTime', now()::text,
                   'breakGlass', true
                 )), '{}'::jsonb))`,
      [sessionId, userId],
    )
    cookie = await signedCookie(sessionId)
  })

  after(async () => {
    clearSessionCaches()
    await adminPool.query('delete from iam.role_assignment where user_id = $1', [userId])
    await adminPool.query('delete from iam.break_glass_account where user_id = $1', [userId])
    await adminPool.query('delete from iam.session where user_id = $1', [userId])
    await adminPool.query('delete from iam.app_user where id = $1', [userId])
    await adminPool.end()
  })

  it('parks a dormant break-glass session on the reason page', async () => {
    let res = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie },
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('Location'), '/break-glass')
  })

  it('renders the reason form while the account has no authority', async () => {
    let res = await router.fetch(new URL(routes.breakGlass.index.href(), 'http://localhost'), {
      headers: { cookie },
    })
    assert.equal(res.status, 200)
    let text = await res.text()
    assert.ok(text.includes('name="reason"'), 'the activate form must ask for a reason')
    assert.ok(text.includes('Test emergency key'), 'the page must show which key is in use')
  })

  it('lets the same session through once the window is open', async () => {
    await adminPool.query(
      `select auth.break_glass_activate($1, 'window opened by the test suite')`,
      [userId],
    )
    clearSessionCaches()
    let res = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie },
    })
    assert.notEqual(res.headers.get('Location'), '/break-glass')
  })

  it('parks the session again after deactivation revokes it', async () => {
    await adminPool.query(
      `select auth.break_glass_deactivate($1, 'window closed by the test suite')`,
      [userId],
    )
    clearSessionCaches()
    let res = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie },
    })
    // Deactivation revokes the session itself, so the account is signed out rather than
    // returned to the reason form: there is nothing left to authorise.
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('Location'), '/login?returnTo=%2Fprofile')
  })
})
