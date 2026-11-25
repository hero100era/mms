import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'
import { generateKeyPairSync } from 'node:crypto'
import { Pool } from 'pg'

import { router as _router } from '../router.ts'
import { routes } from '../routes.ts'
import { sessionCookie } from '../auth/session-cookie.ts'
import { hashPassword } from '../auth/password.ts'
import { clearStepUpThrottle } from '../auth/service.ts'
import { createRolePool, withRole } from '../db/role-pool.ts'

const TEST_IP = '198.51.100.77'
const router = {
  fetch(input: URL, init?: RequestInit): Promise<Response> {
    return _router.fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': TEST_IP },
    })
  },
}

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

process.env.AUTH_GATEWAY_DATABASE_URL =
  process.env.AUTH_GATEWAY_DATABASE_URL ||
  process.env.MMS_GATEWAY_DATABASE_URL ||
  withRole(adminUrl, 'auth_gateway')

async function makeSignedSessionCookie(sid: string): Promise<string> {
  let cookieVal = JSON.stringify({
    value: sid,
    expires: Date.now() + 12 * 60 * 60 * 1000,
  })
  let raw = await sessionCookie.serialize(cookieVal)
  return raw.split(';')[0] ?? ''
}

async function getStepUpCsrf(cookie: string): Promise<string> {
  let res = await router.fetch(new URL(routes.mfa.stepUp.href(), 'http://localhost'), {
    headers: { cookie },
  })
  assert.equal(res.status, 200, `Expected 200 from step-up page, got ${res.status}`)
  let text = await res.text()
  let match = text.match(/name="_csrf"\s+value="([^"]+)"/)
  return match?.[1] ?? ''
}

describe('P0.4: Dedicated Password Step-Up Throttle', () => {
  let adminPool: Pool
  let testUserId: string
  const testEmail = 'stepup_throttle_test@example.com'
  const validPassword = 'StepUpValidPass123!'

  before(async () => {
    if (!process.env.MMS_JWT_PRIVATE_KEY) {
      let ecPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      process.env.MMS_JWT_PRIVATE_KEY = ecPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    }

    adminPool = createRolePool(() => adminUrl, 1).get()

    // Clean prior state
    await adminPool.query(
      `delete from iam.session where user_id in (select id from iam.app_user where email = $1)`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.password_credential where user_id in (select id from iam.app_user where email = $1)`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.app_user where email = $1`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.login_attempt where login_name = $1 or client_ip = $2`,
      [testEmail, TEST_IP],
    )

    let userRes = await adminPool.query<{ id: string }>(
      `insert into iam.app_user (kind, email, display_name, status)
       values ('external', $1, 'StepUp Throttle User', 'active')
       returning id`,
      [testEmail],
    )
    testUserId = userRes.rows[0].id

    let hash = await hashPassword(validPassword)
    await adminPool.query(
      `insert into iam.password_credential (user_id, hash)
       values ($1, $2)
       on conflict (user_id) do update set hash = excluded.hash`,
      [testUserId, hash],
    )
  })

  beforeEach(() => {
    clearStepUpThrottle()
  })

  after(async () => {
    clearStepUpThrottle()
    await adminPool.query(`delete from iam.session where user_id = $1`, [testUserId])
    await adminPool.query(`delete from iam.password_credential where user_id = $1`, [testUserId])
    await adminPool.query(`delete from iam.app_user where id = $1`, [testUserId])
    await adminPool.query(`delete from iam.login_attempt where login_name = $1 or client_ip = $2`, [testEmail, TEST_IP])
    await adminPool.end()
  })

  it('P0.4: 5 failed step-up attempts trigger 429 with Retry-After without touching iam.login_attempt', async () => {
    // 1. Create a session for this user
    let sRes = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let sid = sRes.rows[0].id
    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'email', $2::text,
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd'
         ),
         '_csrf', 'test-stepup-csrf'
       ), jsonb_build_object())
       where id = $3`,
      [testUserId, testEmail, sid],
    )

    let signedCookie = await makeSignedSessionCookie(sid)
    let csrf = await getStepUpCsrf(signedCookie)

    // Clear login attempts before starting
    await adminPool.query(
      `delete from iam.login_attempt where login_name = $1 or client_ip = $2`,
      [testEmail, TEST_IP],
    )

    // 2. Perform 5 failed step-up attempts
    for (let i = 0; i < 5; i++) {
      let form = new FormData()
      form.set('_csrf', csrf)
      form.set('password', 'WrongPassword123!')
      form.set('returnTo', '/profile')

      let res = await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie: signedCookie },
        body: form,
      })
      assert.equal(res.status, 401, `Attempt ${i + 1} should return 401`)
      let text = await res.text()
      assert.match(text, /Incorrect password\./)
    }

    // 3. The 6th attempt must return HTTP 429 with Retry-After header
    let form6 = new FormData()
    form6.set('_csrf', csrf)
    form6.set('password', 'WrongPassword123!')
    form6.set('returnTo', '/profile')

    let res6 = await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: form6,
    })
    assert.equal(res6.status, 429, '6th attempt must return 429 Too Many Requests')
    let retryAfter = res6.headers.get('Retry-After')
    assert.ok(retryAfter, 'Must contain Retry-After header')
    assert.ok(Number(retryAfter) > 0, 'Retry-After must be positive seconds')
    let text6 = await res6.text()
    assert.match(text6, /Too many failed step-up attempts\./)

    // 4. CRITICAL: iam.login_attempt must NOT have recorded step-up failures!
    let attemptCount = await adminPool.query<{ count: string }>(
      `select count(*) from iam.login_attempt where login_name = $1 or client_ip = $2`,
      [testEmail, TEST_IP],
    )
    assert.equal(Number(attemptCount.rows[0].count), 0, 'Step-up failures must NOT touch iam.login_attempt')

    // 5. Correct password while throttled must still return 429
    let formCorrect = new FormData()
    formCorrect.set('_csrf', csrf)
    formCorrect.set('password', validPassword)
    formCorrect.set('returnTo', '/profile')

    let resThrottledCorrect = await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: formCorrect,
    })
    assert.equal(resThrottledCorrect.status, 429, 'Throttled step-up must reject even with correct password')

    // 6. Clearing throttle enables successful step-up (HTTP 302 to returnTo)
    clearStepUpThrottle(testUserId)
    let resSuccess = await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: formCorrect,
    })
    assert.equal(resSuccess.status, 302, 'Correct password after unthrottle must elevate and redirect')
    assert.equal(resSuccess.headers.get('Location'), '/profile')

    // Cleanup session
    await adminPool.query(`delete from iam.session where id = $1`, [sid])
  })

  it('P0.4: User-level step-up throttle persists across session rotation', async () => {
    // Session 1
    let s1 = (await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )).rows[0].id
    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object('userId', $1::text, 'email', $2::text, 'kind', 'external', 'activeRole', 'ext_user', 'authMethod', 'pwd'),
         '_csrf', 'test-csrf-1'
       ), jsonb_build_object()) where id = $3`,
      [testUserId, testEmail, s1],
    )

    let c1 = await makeSignedSessionCookie(s1)
    let csrf1 = await getStepUpCsrf(c1)

    // Fail 5 times in Session 1
    for (let i = 0; i < 5; i++) {
      let f = new FormData()
      f.set('_csrf', csrf1)
      f.set('password', 'WrongPassword123!')
      await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie: c1 },
        body: f,
      })
    }

    // Session 2 for the same user (e.g. cookie rotation or another browser)
    let s2 = (await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )).rows[0].id
    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object('userId', $1::text, 'email', $2::text, 'kind', 'external', 'activeRole', 'ext_user', 'authMethod', 'pwd'),
         '_csrf', 'test-csrf-2'
       ), jsonb_build_object()) where id = $3`,
      [testUserId, testEmail, s2],
    )

    let c2 = await makeSignedSessionCookie(s2)
    let csrf2 = await getStepUpCsrf(c2)

    // Attempt in Session 2 must be throttled immediately because throttle tracks userId!
    let f2 = new FormData()
    f2.set('_csrf', csrf2)
    f2.set('password', validPassword)

    let resSession2 = await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: c2 },
      body: f2,
    })
    assert.equal(resSession2.status, 429, 'Step-up throttle must track user across sessions')

    await adminPool.query(`delete from iam.session where id in ($1, $2)`, [s1, s2])
  })

  it('P0.1: submitting POST /step-up with half-authenticated password session does NOT set mfaVerifiedAt or unlock /profile', async () => {
    let sid = (await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )).rows[0].id
    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object('userId', $1::text, 'email', $2::text, 'kind', 'external', 'activeRole', 'ext_user', 'authMethod', 'pwd'),
         '_csrf', 'test-csrf-half'
       ), jsonb_build_object()) where id = $3`,
      [testUserId, testEmail, sid],
    )

    let signedCookie = await makeSignedSessionCookie(sid)
    let csrf = await getStepUpCsrf(signedCookie)

    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', validPassword)
    form.set('returnTo', '/profile')

    let res = await router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: form,
    })
    assert.equal(res.status, 302)
    let authedCookie = (res.headers.get('set-cookie') ?? signedCookie).split(';')[0]!

    // Verify in database that mfaVerifiedAt was NOT set
    let sessionRow = await adminPool.query<{ data: any }>(
      `select data from iam.session where user_id = $1 order by created_at desc limit 1`,
      [testUserId],
    )
    let authObj = Array.isArray(sessionRow.rows[0]?.data)
      ? sessionRow.rows[0].data[0]?.auth
      : sessionRow.rows[0]?.data?.auth
    assert.equal(authObj?.mfaVerifiedAt, undefined, 'mfaVerifiedAt must not be set by step-up')

    // GET /profile with the session must still be redirected to /mfa because mfaVerifiedAt is missing
    let profileRes = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie: authedCookie },
    })
    assert.equal(profileRes.status, 302)
    assert.equal(profileRes.headers.get('Location'), '/mfa?returnTo=%2Fprofile')

    await adminPool.query(`delete from iam.session where user_id = $1`, [testUserId])
  })
})
