import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { generateKeyPairSync } from 'node:crypto'
import { Pool } from 'pg'

import { sessionCookie } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { devMailbox } from '../jobs/dev-mailbox.ts'
import { pollOnce } from '../jobs/poller.ts'
import { router } from '../router.ts'
import { routes } from '../routes.ts'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

async function getCsrfAndCookie(path: string): Promise<{ csrf: string; cookie: string }> {
  let res = await router.fetch(new URL(path, 'http://localhost'))
  let text = await res.text()
  let match = text.match(/name="_csrf"\s+value="([^"]+)"/)
  let cookieHeader = res.headers.get('set-cookie') ?? ''
  let sid = cookieHeader.split(';')[0] ?? ''
  return { csrf: match?.[1] ?? '', cookie: sid }
}

async function makeSignedSessionCookie(sid: string): Promise<string> {
  let cookieVal = JSON.stringify({
    value: sid,
    expires: Date.now() + 12 * 60 * 60 * 1000,
  })
  let raw = await sessionCookie.serialize(cookieVal)
  return raw.split(';')[0] ?? ''
}

async function getAuthenticatedCsrf(cookie: string): Promise<string> {
  let res = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
    headers: { cookie },
  })
  assert.equal(res.status, 200, `Expected 200 from profile, got ${res.status}`)
  let text = await res.text()
  let match = text.match(/name="_csrf"\s+value="([^"]+)"/)
  return match?.[1] ?? ''
}

describe('Card I-09: Reset, logout, sessions', () => {
  let adminPool: Pool
  let testUserId: string
  const testEmail = 'reset_test_user@example.com'
  const newPassword = 'NewSecurePassword456!'

  before(async () => {
    if (!process.env.MMS_JWT_PRIVATE_KEY) {
      let ecPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      process.env.MMS_JWT_PRIVATE_KEY = ecPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    }

    adminPool = new Pool({ connectionString: adminUrl })
    devMailbox.clear()
    clearSessionCaches()

    // Clean any prior state
    await adminPool.query(
      `delete from iam.session where user_id in (select id from iam.app_user where email = $1)`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.password_credential where user_id in (select id from iam.app_user where email = $1)`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.one_time_token where user_id in (select id from iam.app_user where email = $1)`,
      [testEmail],
    )
    await adminPool.query(
      `delete from core.outbox where payload->>'email' = $1`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.app_user where email = $1`,
      [testEmail],
    )

    // Provision test user
    let userRes = await adminPool.query<{ id: string }>(
      `insert into iam.app_user (kind, email, display_name, status)
       values ('external', $1, 'Reset Test User', 'active')
       returning id`,
      [testEmail],
    )
    testUserId = userRes.rows[0].id

    await adminPool.query(
      `insert into iam.password_credential (user_id, hash)
       values ($1, '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhash$dummy')
       on conflict (user_id) do update set hash = excluded.hash`,
      [testUserId],
    )
  })

  after(async () => {
    clearSessionCaches()
    await adminPool.query(
      `delete from iam.session where user_id = $1`,
      [testUserId],
    )
    await adminPool.query(
      `delete from iam.password_credential where user_id = $1`,
      [testUserId],
    )
    await adminPool.query(
      `delete from iam.one_time_token where user_id = $1`,
      [testUserId],
    )
    await adminPool.query(
      `delete from core.outbox where payload->>'email' = $1`,
      [testEmail],
    )
    await adminPool.query(
      `delete from iam.app_user where id = $1`,
      [testUserId],
    )
    await adminPool.end()
  })

  it('GET /forgot-password renders request form', async () => {
    let response = await router.fetch(new URL(routes.session.forgotPassword.href(), 'http://localhost'))
    assert.equal(response.status, 200)
    let text = await response.text()
    assert.match(text, /Reset password/)
    assert.match(text, /name="email"/)
  })

  it('AC 2: No enumeration — response content is identical for existing and non-existing email', async () => {
    // 1. Request for non-existent email
    let { csrf: csrf1, cookie: cookie1 } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let form1 = new FormData()
    form1.set('_csrf', csrf1)
    form1.set('email', 'nonexistent_account_12345@example.com')

    let resUnknown = await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: cookie1 },
      body: form1,
    })

    assert.equal(resUnknown.status, 200)
    let bodyUnknown = await resUnknown.text()

    // 2. Request for existing email
    let { csrf: csrf2, cookie: cookie2 } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let form2 = new FormData()
    form2.set('_csrf', csrf2)
    form2.set('email', testEmail)

    let resExisting = await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: cookie2 },
      body: form2,
    })

    assert.equal(resExisting.status, 200)
    let bodyExisting = await resExisting.text()

    // Response message is displayed
    assert.match(bodyExisting, /If an account with that email exists, we have sent instructions/)
    assert.match(bodyUnknown, /If an account with that email exists, we have sent instructions/)

    // Content comparison (stripping per-request CSRF tokens and CSP nonces).
    // R1.3 mints a fresh CSP nonce per response; it is a request-scoped random
    // value, not user data, so it must not make the two responses differ.
    let stripRequestTokens = (html: string) =>
      html.replace(/value="[^"]*"/g, 'value=""').replace(/nonce="[^"]*"/g, 'nonce=""')
    let normalizedExisting = stripRequestTokens(bodyExisting)
    let normalizedUnknown = stripRequestTokens(bodyUnknown)
    assert.equal(normalizedExisting, normalizedUnknown)
  })

  it('AC 2: Timing is a regression check — existing vs non-existing timing difference is low', async () => {
    let { csrf: csrf1, cookie: cookie1 } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let form1 = new FormData()
    form1.set('_csrf', csrf1)
    form1.set('email', 'nonexistent_timed@example.com')

    let t0 = Date.now()
    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: cookie1 },
      body: form1,
    })
    let durationUnknown = Date.now() - t0

    let { csrf: csrf2, cookie: cookie2 } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let form2 = new FormData()
    form2.set('_csrf', csrf2)
    form2.set('email', testEmail)

    let t1 = Date.now()
    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: cookie2 },
      body: form2,
    })
    let durationExisting = Date.now() - t1

    let delta = Math.abs(durationExisting - durationUnknown)
    assert.ok(delta < 150, `Timing delta between existing and unknown should be low: ${delta}ms`)
  })

  it('AC 1: Single-use 30-min token is issued via outbox and worker delivers it', async () => {
    devMailbox.clear()
    let { csrf, cookie } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('email', testEmail)

    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    let processed = await pollOnce()
    assert.ok(processed >= 1)

    let mail = devMailbox.findPasswordReset(testEmail)
    assert.ok(mail, 'Expected password reset email in dev mailbox')
    assert.match(String(mail.payload.resetUrl), /\/reset-password\/[0-9a-f]{64}/)

    // Verify token expiry in DB is ~30 minutes
    let tokenRes = await adminPool.query<{ expires_at: Date }>(
      `select expires_at from iam.one_time_token
       where user_id = $1 and purpose = 'password_reset' and used_at is null
       order by expires_at desc limit 1`,
      [testUserId],
    )
    assert.equal(tokenRes.rows.length, 1)
    let diffMs = tokenRes.rows[0].expires_at.getTime() - Date.now()
    let diffMinutes = Math.round(diffMs / (60 * 1000))
    assert.equal(diffMinutes, 30, 'Token expiry must be 30 minutes')
  })

  it('GET /reset-password/:token renders password form with minLength 12', async () => {
    let mail = devMailbox.findPasswordReset(testEmail)!
    let token = String(mail.payload.token)

    let response = await router.fetch(new URL(routes.session.resetPassword.href({ token }), 'http://localhost'))
    assert.equal(response.status, 200)
    let text = await response.text()
    assert.match(text, /Set new password/)
    assert.match(text, /name="password"/)
    assert.match(text, /minLength="12"|minlength="12"/)
  })

  it('POST /reset-password/:token validates password policy (mismatch, short, blocklisted)', async () => {
    let mail = devMailbox.findPasswordReset(testEmail)!
    let token = String(mail.payload.token)

    // 1. Mismatch
    let { csrf: c1, cookie: ck1 } = await getCsrfAndCookie(routes.session.resetPassword.href({ token }))
    let f1 = new FormData()
    f1.set('_csrf', c1)
    f1.set('password', 'SuperSecretPassword123!')
    f1.set('confirmPassword', 'DifferentPassword456!')

    let resMismatch = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ck1 },
      body: f1,
    })
    assert.ok([200, 422].includes(resMismatch.status))
    assert.match(await resMismatch.text(), /Passwords do not match\./)

    // 2. Too short
    let { csrf: c2, cookie: ck2 } = await getCsrfAndCookie(routes.session.resetPassword.href({ token }))
    let f2 = new FormData()
    f2.set('_csrf', c2)
    f2.set('password', 'Short123')
    f2.set('confirmPassword', 'Short123')

    let resShort = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ck2 },
      body: f2,
    })
    assert.ok([200, 422].includes(resShort.status))
    assert.match(await resShort.text(), /at least 12 characters/)

    // 3. Blocklisted
    let { csrf: c3, cookie: ck3 } = await getCsrfAndCookie(routes.session.resetPassword.href({ token }))
    let f3 = new FormData()
    f3.set('_csrf', c3)
    f3.set('password', 'letmein12345')
    f3.set('confirmPassword', 'letmein12345')

    let resBlock = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ck3 },
      body: f3,
    })
    assert.ok([200, 422].includes(resBlock.status))
    assert.match(await resBlock.text(), /too common or easily guessed/)
  })

  it('AC 3: Sessions revoked after reset & replaying token fails (single-use)', async () => {
    // 1. Create an active session for the user prior to reset
    let sessionRes = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let preResetSessionId = sessionRes.rows[0].id

    let mail = devMailbox.findPasswordReset(testEmail)!
    let token = String(mail.payload.token)

    // 2. Reset password
    let { csrf, cookie } = await getCsrfAndCookie(routes.session.resetPassword.href({ token }))
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', newPassword)
    form.set('confirmPassword', newPassword)

    let resetRes = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.equal(resetRes.status, 302)
    assert.equal(resetRes.headers.get('location'), '/login?reset=success')

    // 3. Verify prior session was revoked in PostgreSQL
    let checkSession = await adminPool.query<{ revoked_at: Date; revoke_reason: string }>(
      `select revoked_at, revoke_reason from iam.session where id = $1`,
      [preResetSessionId],
    )
    assert.ok(checkSession.rows[0].revoked_at !== null, 'Session must be revoked after password reset')
    assert.equal(checkSession.rows[0].revoke_reason, 'password_reset')

    // 4. Verify single-use: Replaying the token fails
    let { csrf: cReplay, cookie: ckReplay } = await getCsrfAndCookie(routes.session.resetPassword.href({ token }))
    let fReplay = new FormData()
    fReplay.set('_csrf', cReplay)
    fReplay.set('password', newPassword)
    fReplay.set('confirmPassword', newPassword)

    let replayRes = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ckReplay },
      body: fReplay,
    })

    assert.ok([200, 422].includes(replayRes.status))
    let replayText = await replayRes.text()
    assert.match(replayText, /Invalid or expired reset token\./)
  })

  it('AC 4: Flow G — My sessions list and revoke one / revoke all other sessions', async () => {
    clearSessionCaches()

    // 1. Create session A and session B
    let sA = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, client_ip, user_agent, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', '127.0.0.1', 'Browser A', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let sidA = sA.rows[0].id

    let sB = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, client_ip, user_agent, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', '127.0.0.1', 'Browser B', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let sidB = sB.rows[0].id

    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd',
           -- The test signs in at the password step; H-09 was satisfied here.
           'mfaVerifiedAt', now()::text,
           'authTime', now()::text,
           'assignableRoles', jsonb_build_array('ext_user')
         ),
         '_csrf', 'test-csrf-token-a'
       ), jsonb_build_object())
       where id = $2`,
      [testUserId, sidA],
    )

    let signedCookieA = await makeSignedSessionCookie(sidA)

    let profileRes = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie: signedCookieA },
    })
    assert.equal(profileRes.status, 200)
    let profileText = await profileRes.text()
    assert.match(profileText, /Active sessions/)
    assert.match(profileText, /Current/)
    assert.match(profileText, /Browser B/)

    // 2. Revoke one session (Session B) from Session A
    let csrfA = await getAuthenticatedCsrf(signedCookieA)
    let formRevokeOne = new FormData()
    formRevokeOne.set('_csrf', csrfA)
    formRevokeOne.set('sessionId', sidB)

    let revokeOneRes = await router.fetch(new URL(routes.session.profileSessionRevoke.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookieA },
      body: formRevokeOne,
    })

    assert.equal(revokeOneRes.status, 302)
    assert.equal(revokeOneRes.headers.get('location'), '/profile?success=session_revoked')

    // Session B is revoked
    let checkB = await adminPool.query<{ revoked_at: Date }>(
      `select revoked_at from iam.session where id = $1`,
      [sidB],
    )
    assert.ok(checkB.rows[0].revoked_at !== null, 'Session B must be revoked')

    // Session A is still active
    let checkA = await adminPool.query<{ revoked_at: Date }>(
      `select revoked_at from iam.session where id = $1`,
      [sidA],
    )
    assert.equal(checkA.rows[0].revoked_at, null, 'Session A must remain active')

    // 3. Create session C and test Revoke All Other Sessions
    let sC = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, client_ip, user_agent, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', '127.0.0.1', 'Browser C', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let sidC = sC.rows[0].id

    let formRevokeAll = new FormData()
    formRevokeAll.set('_csrf', csrfA)

    let revokeAllRes = await router.fetch(new URL(routes.session.profileSessionRevokeAll.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookieA },
      body: formRevokeAll,
    })

    assert.equal(revokeAllRes.status, 302)
    assert.equal(revokeAllRes.headers.get('location'), '/profile?success=all_sessions_revoked')

    // Session C is revoked
    let checkC = await adminPool.query<{ revoked_at: Date }>(
      `select revoked_at from iam.session where id = $1`,
      [sidC],
    )
    assert.ok(checkC.rows[0].revoked_at !== null, 'Session C must be revoked')

    // Session A remains active
    let checkAAfter = await adminPool.query<{ revoked_at: Date }>(
      `select revoked_at from iam.session where id = $1`,
      [sidA],
    )
    assert.equal(checkAAfter.rows[0].revoked_at, null, 'Current session A must remain active')
  })

  it('Flow G: POST /logout revokes current session and redirects to /login', async () => {
    clearSessionCaches()
    let sLogout = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let sid = sLogout.rows[0].id

    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd',
           -- The test signs in at the password step; H-09 was satisfied here.
           'mfaVerifiedAt', now()::text,
           'authTime', now()::text,
           'assignableRoles', jsonb_build_array('ext_user')
         ),
         '_csrf', 'test-csrf-token-logout'
       ), jsonb_build_object())
       where id = $2`,
      [testUserId, sid],
    )

    let signedCookie = await makeSignedSessionCookie(sid)
    let csrf = await getAuthenticatedCsrf(signedCookie)
    let form = new FormData()
    form.set('_csrf', csrf)

    let logoutRes = await router.fetch(new URL(routes.session.logout.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: form,
    })

    assert.equal(logoutRes.status, 302)
    assert.equal(logoutRes.headers.get('location'), '/login')

    // Session is revoked in DB
    let check = await adminPool.query<{ revoked_at: Date; revoke_reason: string }>(
      `select revoked_at, revoke_reason from iam.session where id = $1`,
      [sid],
    )
    assert.ok(check.rows[0].revoked_at !== null, 'Logged out session must be marked revoked')
    assert.equal(check.rows[0].revoke_reason, 'logout')
  })

  it('Flow G: Entra logout redirects to Entra end-session endpoint', async () => {
    clearSessionCaches()
    process.env.MMS_ENTRA_TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    process.env.MMS_ENTRA_CLIENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    process.env.MMS_ENTRA_CLIENT_SECRET = 'entra-secret'
    process.env.MMS_ENTRA_REDIRECT_URI = 'http://localhost/auth/microsoft/callback'

    let staffUserRes = await adminPool.query<{ id: string }>(
      `insert into iam.app_user (kind, display_name, email, entra_tenant_id, entra_object_id, status)
       values ('internal', 'Staff Logout User', 'staff_logout@example.com',
               'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '99999999-9999-9999-9999-999999999999', 'active')
       on conflict (entra_tenant_id, entra_object_id) do update set status = 'active'
       returning id`,
    )
    let staffId = staffUserRes.rows[0].id

    let sEntra = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'internal', 'int_viewer', 'entra', now() + interval '60 minutes', now() + interval '12 hours')
       returning id`,
      [staffId],
    )
    let sidEntra = sEntra.rows[0].id

    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'kind', 'internal',
           'activeRole', 'int_viewer',
           'authMethod', 'entra',
           'authTime', now()::text,
           'assignableRoles', jsonb_build_array('int_viewer')
         ),
         '_csrf', 'test-csrf-token-entra'
       ), jsonb_build_object())
       where id = $2`,
      [staffId, sidEntra],
    )

    let signedCookie = await makeSignedSessionCookie(sidEntra)
    let csrf = await getAuthenticatedCsrf(signedCookie)
    let form = new FormData()
    form.set('_csrf', csrf)

    let logoutRes = await router.fetch(new URL(routes.session.logout.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: form,
    })

    assert.equal(logoutRes.status, 302)
    let location = logoutRes.headers.get('location') ?? ''
    assert.match(location, /oauth2\/v2\.0\/logout/, 'Must redirect to Microsoft end-session endpoint')
    assert.match(location, /post_logout_redirect_uri=/, 'Must specify post_logout_redirect_uri')
  })

  it('Token invalidation on re-request: requesting reset twice invalidates the first token', async () => {
    devMailbox.clear()

    // First request
    let { csrf: c1, cookie: ck1 } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let f1 = new FormData()
    f1.set('_csrf', c1)
    f1.set('email', testEmail)
    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ck1 },
      body: f1,
    })
    await pollOnce()
    let mail1 = devMailbox.findPasswordReset(testEmail)!
    let token1 = String(mail1.payload.token)

    // Second request
    let { csrf: c2, cookie: ck2 } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let f2 = new FormData()
    f2.set('_csrf', c2)
    f2.set('email', testEmail)
    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ck2 },
      body: f2,
    })
    await pollOnce()
    let mail2 = devMailbox.findPasswordReset(testEmail)!
    let token2 = String(mail2.payload.token)
    assert.notEqual(token1, token2, 'Consecutive reset requests must produce different tokens')

    // Attempting to consume the first token fails
    let { csrf: cSub1, cookie: ckSub1 } = await getCsrfAndCookie(routes.session.resetPassword.href({ token: token1 }))
    let fSub1 = new FormData()
    fSub1.set('_csrf', cSub1)
    fSub1.set('password', 'AnotherPassword123!')
    fSub1.set('confirmPassword', 'AnotherPassword123!')
    let res1 = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token: token1 }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ckSub1 },
      body: fSub1,
    })
    assert.ok([200, 422].includes(res1.status))
    assert.match(await res1.text(), /Invalid or expired reset token\./)

    // Second token succeeds
    let { csrf: cSub2, cookie: ckSub2 } = await getCsrfAndCookie(routes.session.resetPassword.href({ token: token2 }))
    let fSub2 = new FormData()
    fSub2.set('_csrf', cSub2)
    fSub2.set('password', 'AnotherPassword123!')
    fSub2.set('confirmPassword', 'AnotherPassword123!')
    let res2 = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token: token2 }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ckSub2 },
      body: fSub2,
    })
    assert.equal(res2.status, 302)
    assert.equal(res2.headers.get('location'), '/login?reset=success')
  })

  it('Expired reset token (> 30 minutes) is rejected', async () => {
    devMailbox.clear()
    let { csrf, cookie } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('email', testEmail)
    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })
    await pollOnce()
    let mail = devMailbox.findPasswordReset(testEmail)!
    let token = String(mail.payload.token)

    // Manually expire the token in database
    await adminPool.query(
      `update iam.one_time_token set expires_at = now() - interval '1 minute'
       where user_id = $1 and purpose = 'password_reset' and used_at is null`,
      [testUserId],
    )

    let { csrf: cExp, cookie: ckExp } = await getCsrfAndCookie(routes.session.resetPassword.href({ token }))
    let fExp = new FormData()
    fExp.set('_csrf', cExp)
    fExp.set('password', 'ValidPassword123!')
    fExp.set('confirmPassword', 'ValidPassword123!')

    let res = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ckExp },
      body: fExp,
    })
    assert.ok([200, 422].includes(res.status))
    assert.match(await res.text(), /Invalid or expired reset token\./)
  })

  it('POST /reset-password/:token invalidates current browser session and terminates access immediately', async () => {
    devMailbox.clear()
    clearSessionCaches()

    // 1. Create an active session
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
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd',
           -- The test signs in at the password step; H-09 was satisfied here.
           'mfaVerifiedAt', now()::text,
           'authTime', now()::text,
           'assignableRoles', jsonb_build_array('ext_user')
         ),
         '_csrf', 'test-csrf-token-active'
       ), jsonb_build_object())
       where id = $2`,
      [testUserId, sid],
    )

    let signedCookie = await makeSignedSessionCookie(sid)

    // Verify session is active before reset
    let profResBefore = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie: signedCookie },
    })
    assert.equal(profResBefore.status, 200)

    // Request reset
    let { csrf: cForgot, cookie: ckForgot } = await getCsrfAndCookie(routes.session.forgotPassword.href())
    let fForgot = new FormData()
    fForgot.set('_csrf', cForgot)
    fForgot.set('email', testEmail)
    await router.fetch(new URL(routes.session.forgotPasswordSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: ckForgot },
      body: fForgot,
    })
    await pollOnce()
    let mail = devMailbox.findPasswordReset(testEmail)!
    let token = String(mail.payload.token)

    // Submit reset using the active session's cookie
    let csrfReset = await getAuthenticatedCsrf(signedCookie)
    let fReset = new FormData()
    fReset.set('_csrf', csrfReset)
    fReset.set('password', 'AnotherStrongPassword999!')
    fReset.set('confirmPassword', 'AnotherStrongPassword999!')

    let resetRes = await router.fetch(new URL(routes.session.resetPasswordSubmit.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: signedCookie },
      body: fReset,
    })
    assert.equal(resetRes.status, 302)

    // Trying to access /profile with the old session now fails immediately (redirects to /login)
    let profResAfter = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie: signedCookie },
    })
    assert.equal(profResAfter.status, 302)
    assert.ok(profResAfter.headers.get('location')?.startsWith('/login'))
  })

  it('POST /profile/sessions/revoke cannot revoke another user session', async () => {
    clearSessionCaches()

    // User A session
    let sA = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let sidA = sA.rows[0].id

    await adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd',
           -- The test signs in at the password step; H-09 was satisfied here.
           'mfaVerifiedAt', now()::text,
           'authTime', now()::text,
           'assignableRoles', jsonb_build_array('ext_user')
         ),
         '_csrf', 'test-csrf-token-a'
       ), jsonb_build_object())
       where id = $2`,
      [testUserId, sidA],
    )
    let cookieA = await makeSignedSessionCookie(sidA)

    // Another user (victim) session
    let victimRes = await adminPool.query<{ id: string }>(
      `insert into iam.app_user (kind, display_name, email, status)
       values ('external', 'Victim User', 'victim_user@example.com', 'active')
       returning id`,
    )
    let victimId = victimRes.rows[0].id

    let sVictim = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [victimId],
    )
    let sidVictim = sVictim.rows[0].id

    try {
      let csrfA = await getAuthenticatedCsrf(cookieA)
      let form = new FormData()
      form.set('_csrf', csrfA)
      form.set('sessionId', sidVictim)

      let res = await router.fetch(new URL(routes.session.profileSessionRevoke.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie: cookieA },
        body: form,
      })

      assert.equal(res.status, 302)
      // Redirects back to /profile without success query
      assert.equal(res.headers.get('location'), '/profile')

      // Victim session remains ACTIVE in database
      let checkVictim = await adminPool.query<{ revoked_at: Date }>(
        `select revoked_at from iam.session where id = $1`,
        [sidVictim],
      )
      assert.equal(checkVictim.rows[0].revoked_at, null, 'Another user session must not be revoked')
    } finally {
      await adminPool.query(`delete from iam.session where user_id = $1`, [victimId])
      await adminPool.query(`delete from iam.app_user where id = $1`, [victimId])
    }
  })

  it('Session rotation does NOT emit auth.logout, but explicit logout does', async () => {
    clearSessionCaches()

    let countBefore = await adminPool.query<{ count: string }>(
      `select count(*) from audit_trail.event where event_type = 'auth.logout'`,
    )
    let initialCount = Number(countBefore.rows[0].count)

    // Create a session and rotate it
    let sRes = await adminPool.query<{ id: string }>(
      `insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
       values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
       returning id`,
      [testUserId],
    )
    let oldSid = sRes.rows[0].id

    // Revoke old session with 'rotated' via sessionStorage
    let signedCookie = await makeSignedSessionCookie(oldSid)
    let session = await (await import('../auth/session-cookie.ts')).sessionStorage.read(oldSid)
    session.regenerateId(true)
    session.set('auth', {
      userId: testUserId,
      kind: 'external',
      activeRole: 'ext_user',
      authMethod: 'pwd',
      // Second factor already satisfied (H-09); this test is about rotation.
      mfaVerifiedAt: new Date().toISOString(),
      authTime: new Date().toISOString(),
      assignableRoles: ['ext_user'],
    })
    await (await import('../auth/session-cookie.ts')).sessionStorage.save(session)

    // Verify old session has revoke_reason = 'rotated'
    let checkOld = await adminPool.query<{ revoke_reason: string }>(
      `select revoke_reason from iam.session where id = $1`,
      [oldSid],
    )
    assert.equal(checkOld.rows[0].revoke_reason, 'rotated')

    // Verify auth.logout was NOT emitted on rotation
    let countAfterRotation = await adminPool.query<{ count: string }>(
      `select count(*) from audit_trail.event where event_type = 'auth.logout'`,
    )
    assert.equal(Number(countAfterRotation.rows[0].count), initialCount, 'Rotation must not emit auth.logout')

    // Now perform explicit logout
    let newSid = session.id
    let newCookie = await makeSignedSessionCookie(newSid)
    let csrf = await getAuthenticatedCsrf(newCookie)
    let form = new FormData()
    form.set('_csrf', csrf)

    let logoutRes = await router.fetch(new URL(routes.session.logout.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: newCookie },
      body: form,
    })
    assert.equal(logoutRes.status, 302)

    // Verify auth.logout WAS emitted on explicit logout
    let countAfterLogout = await adminPool.query<{ count: string }>(
      `select count(*) from audit_trail.event where event_type = 'auth.logout'`,
    )
    assert.equal(Number(countAfterLogout.rows[0].count), initialCount + 1, 'Explicit logout must emit auth.logout')
  })
})

