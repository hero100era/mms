import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { clearSessionCaches } from '../auth/session-storage.ts'
import { sessionCookie, sessionStorage } from '../auth/session-cookie.ts'
import { routes } from '../routes.ts'
import {
  createOauthTestEnvironment,
  type OauthTestEnvironment,
} from './oauth-test-helper.ts'

describe('Card I-08: External OAuth - Callback, Step-Up, and Link Intent flows', () => {
  let env: OauthTestEnvironment

  before(async () => {
    env = await createOauthTestEnvironment('203.0.113.24')
  })

  after(async () => {
    await env.teardown()
  })

  it('AC 4: Enforces step-up authentication when linking or unlinking identities', async () => {
    // 1. Create active external user with password
    let userId = (await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status, email_verified_at)
      values ('external', 'oauth_test_stepup@example.com', 'StepUp User', 'active', now())
      returning id
    `)).rows[0]!.id

    let { hashPassword } = await import('../auth/password.ts')
    let passHash = await hashPassword('ValidPass1234!')
    await env.adminPool.query('insert into iam.password_credential (user_id, hash) values ($1, $2)', [userId, passHash])

    await env.clearThrottleFor('oauth_test_stepup@example.com')
    // Log in via password to get an authenticated session
    let { csrf, cookie } = await env.getCsrfAndCookie(routes.session.login.href())
    let loginForm = new FormData()
    loginForm.set('_csrf', csrf)
    loginForm.set('email', 'oauth_test_stepup@example.com')
    loginForm.set('password', 'ValidPass1234!')

    let loginRes = await env.router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: loginForm,
    })
    assert.equal(loginRes.status, 302)
    let authedCookie = (loginRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    // In the session DB row, set stepUpAt and authTime to 15 minutes ago
    await env.adminPool.query(`
      update iam.session
         set data = jsonb_set(
           jsonb_set(
             jsonb_set(
               case when jsonb_typeof(data) = 'array' then data else jsonb_build_array(data) end,
               '{0,auth,stepUpAt}',
               to_jsonb((now() - interval '15 minutes')::text)
             ),
             '{0,auth,authTime}',
             to_jsonb((now() - interval '15 minutes')::text)
           ),
           -- Card H-09: password sign-in parks the session on the second-factor gate;
           -- mark it satisfied so these tests exercise step-up, not MFA.
           '{0,auth,mfaVerifiedAt}',
           to_jsonb(now()::text)
         )
       where user_id = $1
    `, [userId])
    clearSessionCaches()

    // Try initiating link without fresh step-up
    let profileCsrf = await env.sessionCsrf(authedCookie)
    let linkForm = new FormData()
    linkForm.set('_csrf', profileCsrf)

    let linkRes = await env.router.fetch(
      new URL(routes.identity.link.href({ provider: 'google' }), 'http://localhost'),
      { method: 'POST', headers: { cookie: authedCookie }, body: linkForm },
    )

    // Should redirect to /step-up: the session is past its freshness window, so the
    // handler demands the factor again rather than acting on an old authorisation.
    assert.equal(linkRes.status, 302)
    let redirLoc = linkRes.headers.get('Location') ?? ''
    assert.match(redirLoc, /\/step-up/)

    // Try unlinking without fresh step-up
    let unlinkForm = new FormData()
    unlinkForm.set('_csrf', profileCsrf)
    unlinkForm.set('identityId', '55555555-5555-5555-5555-555555555555')

    let unlinkRes = await env.router.fetch(
      new URL(routes.identity.unlink.href(), 'http://localhost'),
      { method: 'POST', headers: { cookie: authedCookie }, body: unlinkForm },
    )
    assert.equal(unlinkRes.status, 302)
    assert.match(unlinkRes.headers.get('Location') ?? '', /\/step-up/)
  })

  it('AC 9: Flow E - Links external identity for logged-in user with valid step-up', async () => {
    // Drop existing session so this test observes what the database says.
    await env.adminPool.query(
      'delete from iam.session where user_id in (select id from iam.app_user where email = $1)',
      ['oauth_test_stepup@example.com'],
    )
    clearSessionCaches()

    // External user with password logs in (fresh step-up)
    await env.clearThrottleFor('oauth_test_stepup@example.com')
    let { csrf, cookie } = await env.getCsrfAndCookie(routes.session.login.href())
    let loginForm = new FormData()
    loginForm.set('_csrf', csrf)
    loginForm.set('email', 'oauth_test_stepup@example.com')
    loginForm.set('password', 'ValidPass1234!')

    let loginRes = await env.router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: loginForm,
    })
    assert.equal(loginRes.status, 302)
    let authedCookie = (loginRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    await env.satisfyMfa(
      (await env.adminPool.query<{ id: string }>('select id from iam.app_user where email = $1', [
        'oauth_test_stepup@example.com',
      ])).rows[0]!.id,
    )
    await env.grantStepUp(authedCookie)
    let profileCsrf = await env.sessionCsrf(authedCookie)
    let linkForm = new FormData()
    linkForm.set('_csrf', profileCsrf)
    let linkRes = await env.router.fetch(
      new URL(routes.identity.link.href({ provider: 'google' }), 'http://localhost'),
      { method: 'POST', headers: { cookie: authedCookie }, body: linkForm },
    )
    let location = new URL(linkRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let postLinkCookie = (linkRes.headers.get('set-cookie') ?? authedCookie).split(';')[0]!

    let code = 'code-flow-e-link'
    let token = env.makeGoogleToken({
      nonce,
      sub: 'google-sub-flow-e-active',
      email: 'oauth_test_stepup@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie: postLinkCookie } },
    )

    assert.equal(callbackRes.status, 302)
    assert.equal(callbackRes.headers.get('Location'), '/profile?success=linked')

    // Verify identity was added in DB
    let userRow = await env.adminPool.query<{ id: string }>('select id from iam.app_user where email = $1', ['oauth_test_stepup@example.com'])
    let userId = userRow.rows[0]!.id

    let idRow = await env.adminPool.query<{ id: string; provider: string }>(
      'select id, provider from iam.user_identity where user_id = $1 and unlinked_at is null',
      [userId],
    )
    assert.equal(idRow.rows.length, 1)
    assert.equal(idRow.rows[0]?.provider, 'google')
  })

  it('AC 5: Stale and replayed linkIntent is rejected', async () => {
    let tokenVal = 'invite-token-stale-intent'
    let tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenVal)))

    let userRes = await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status)
      values ('external', 'oauth_test_stale_intent@example.com', 'Stale Intent User', 'invited')
      returning id
    `)
    let userId = userRes.rows[0]!.id

    await env.adminPool.query(`
      insert into iam.one_time_token (user_id, purpose, token_hash, expires_at)
      values ($1, 'invite', $2, now() + interval '72 hours')
    `, [userId, tokenHash])

    let { csrf, cookie } = await env.getCsrfAndCookie(routes.identity.invite.href({ token: tokenVal }))
    let form = new FormData()
    form.set('_csrf', csrf)

    let linkStartRes = await env.router.fetch(
      new URL(routes.identity.linkInvite.href({ token: tokenVal, provider: 'google' }), 'http://localhost'),
      { method: 'POST', headers: { cookie }, body: form },
    )
    assert.equal(linkStartRes.status, 302)
    let location = new URL(linkStartRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let cookieStr = (linkStartRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    // 1. Manually expire linkIntent in session data
    let parsed: any = await sessionCookie.parse(cookieStr)
    if (parsed && typeof parsed === 'string' && parsed.startsWith('{')) {
      try { parsed = JSON.parse(parsed) } catch {}
    }
    let sid = typeof parsed === 'object' && parsed && 'value' in parsed ? parsed.value : parsed
    let sess = await sessionStorage.read(sid)
    let intent = sess.get('linkIntent') as any
    sess.set('linkIntent', { ...intent, expiresAt: Date.now() - 1000 })
    await sessionStorage.save(sess)

    let code = 'code-stale-intent'
    let token = env.makeGoogleToken({
      nonce,
      sub: 'google-sub-stale-intent',
      email: 'oauth_test_stale_intent@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie: cookieStr } },
    )

    assert.equal(callbackRes.status, 400)
    let text = await callbackRes.text()
    assert.match(text, /Linking intent has expired or is invalid/i)

    // 2. Replay test: linkIntent was unset during the attempt, so second attempt fails
    let replayRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie: cookieStr } },
    )
    assert.equal(replayRes.status, 401)
  })

  it('Step-up verification via password rotates session ID and prevents open redirects', async () => {
    // 1. Log in user with password
    await env.clearThrottleFor('oauth_test_stepup@example.com')
    let { csrf: loginCsrf, cookie: loginCookie } = await env.getCsrfAndCookie(routes.session.login.href())
    let loginForm = new FormData()
    loginForm.set('_csrf', loginCsrf)
    loginForm.set('email', 'oauth_test_stepup@example.com')
    loginForm.set('password', 'ValidPass1234!')

    let loginRes = await env.router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: loginCookie },
      body: loginForm,
    })
    assert.equal(loginRes.status, 302)
    let authedCookie = (loginRes.headers.get('set-cookie') ?? loginCookie).split(';')[0]!

    // Age the session past 10 minutes
    let userRow = await env.adminPool.query<{ id: string }>('select id from iam.app_user where email = $1', ['oauth_test_stepup@example.com'])
    let userId = userRow.rows[0]!.id

    await env.adminPool.query(`
      update iam.session
         set data = jsonb_set(
           jsonb_set(
             jsonb_set(
               case when jsonb_typeof(data) = 'array' then data else jsonb_build_array(data) end,
               '{0,auth,stepUpAt}',
               to_jsonb((now() - interval '15 minutes')::text)
             ),
             '{0,auth,authTime}',
             to_jsonb((now() - interval '15 minutes')::text)
           ),
           -- Card H-09: password sign-in parks the session on the second-factor gate;
           -- mark it satisfied so these tests exercise step-up, not MFA.
           '{0,auth,mfaVerifiedAt}',
           to_jsonb(now()::text)
         )
       where user_id = $1
    `, [userId])
    clearSessionCaches()

    // 2. Visit /step-up with an external open-redirect URL
    let { csrf: stepUpCsrf, cookie: stepUpCookie } = await env.getCsrfAndCookie(
      routes.mfa.stepUp.href() + '?returnTo=https://evil.com',
      authedCookie,
    )

    // 3. Submit step-up password confirmation
    let stepUpForm = new FormData()
    stepUpForm.set('_csrf', stepUpCsrf)
    stepUpForm.set('password', 'ValidPass1234!')
    stepUpForm.set('returnTo', 'https://evil.com')

    let stepUpRes = await env.router.fetch(new URL(routes.mfa.stepUpSubmit.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: stepUpCookie },
      body: stepUpForm,
    })

    assert.equal(stepUpRes.status, 302)
    // Open redirect must be rejected and safely redirected to fallback /profile
    assert.equal(stepUpRes.headers.get('Location'), '/profile')

    // Session ID must be rotated upon step-up
    let rotatedCookie = stepUpRes.headers.get('set-cookie')
    assert.ok(rotatedCookie, 'Session cookie must rotate on step-up')
    let newSid = rotatedCookie.split(';')[0]!
    assert.notEqual(newSid, stepUpCookie, 'New session cookie must differ from old session cookie')
  })

  it('Step-up verification via OAuth re-authentication (Flow E stepUpOAuth)', async () => {
    // Ensure oauth_test_only_id@example.com exists
    let userRow = await env.adminPool.query<{ id: string }>('select id from iam.app_user where email = $1', ['oauth_test_only_id@example.com'])
    let userId = userRow.rows[0]?.id
    if (!userId) {
      let created = await env.adminPool.query<{ id: string }>(`
        insert into iam.app_user (kind, email, display_name, status, email_verified_at)
        values ('external', 'oauth_test_only_id@example.com', 'Only Id User', 'active', now())
        returning id
      `)
      userId = created.rows[0]!.id
      await env.adminPool.query(`
        insert into iam.user_identity (user_id, provider, issuer, subject, email_at_link)
        values ($1, 'google', $2, 'google-sub-only-method', 'oauth_test_only_id@example.com')
      `, [userId, env.authority])
    }

    let startRes = await env.router.fetch(new URL(routes.auth.googleStart.href(), 'http://localhost'))
    let location = new URL(startRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let cookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0]!

    let code = 'code-stepup-oauth-login'
    let token = env.makeGoogleToken({
      nonce,
      sub: 'google-sub-only-method',
      email: 'oauth_test_only_id@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie } },
    )
    assert.equal(callbackRes.status, 302)
    let authedCookie = (callbackRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    // Age the session past 10 minutes
    await env.adminPool.query(`
      update iam.session
         set data = jsonb_set(
           jsonb_set(
             jsonb_set(
               case when jsonb_typeof(data) = 'array' then data else jsonb_build_array(data) end,
               '{0,auth,stepUpAt}',
               to_jsonb((now() - interval '15 minutes')::text)
             ),
             '{0,auth,authTime}',
             to_jsonb((now() - interval '15 minutes')::text)
           ),
           '{0,auth,mfaVerifiedAt}',
           to_jsonb(now()::text)
         )
       where user_id = $1
    `, [userId])
    clearSessionCaches()

    // Initiate OAuth step-up via POST /step-up/oauth/google
    let { csrf, cookie: freshCookie } = await env.getCsrfAndCookie(routes.mfa.stepUp.href(), authedCookie)
    let stepUpForm = new FormData()
    stepUpForm.set('_csrf', csrf)
    stepUpForm.set('returnTo', '/profile')

    let stepUpOAuthRes = await env.router.fetch(
      new URL(routes.mfa.stepUpOAuth.href({ provider: 'google' }), 'http://localhost'),
      { method: 'POST', headers: { cookie: freshCookie }, body: stepUpForm },
    )
    assert.equal(stepUpOAuthRes.status, 302)
    let oauthLoc = new URL(stepUpOAuthRes.headers.get('Location')!)
    let oauthState = oauthLoc.searchParams.get('state')!
    let oauthNonce = oauthLoc.searchParams.get('nonce')!
    let postStartCookie = (stepUpOAuthRes.headers.get('set-cookie') ?? freshCookie).split(';')[0]!

    // Complete OAuth callback with the user's linked account
    let cbCode = 'code-stepup-oauth-confirm'
    let cbToken = env.makeGoogleToken({
      nonce: oauthNonce,
      sub: 'google-sub-only-method',
      email: 'oauth_test_only_id@example.com',
    })
    env.activeTokens.set(cbCode, cbToken)

    let finalCbRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${cbCode}&state=${oauthState}`, 'http://localhost'),
      { headers: { cookie: postStartCookie } },
    )
    assert.equal(finalCbRes.status, 302)
    assert.equal(finalCbRes.headers.get('Location'), '/profile')

    let rotatedCookie = finalCbRes.headers.get('set-cookie')
    assert.ok(rotatedCookie, 'Session cookie must rotate on OAuth step-up')
  })

  it('identityUnlink rejects non-UUID identityId with 400', async () => {
    await env.clearThrottleFor('oauth_test_stepup@example.com')
    let { csrf, cookie } = await env.getCsrfAndCookie(routes.session.login.href())
    let loginForm = new FormData()
    loginForm.set('_csrf', csrf)
    loginForm.set('email', 'oauth_test_stepup@example.com')
    loginForm.set('password', 'ValidPass1234!')

    let loginRes = await env.router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: loginForm,
    })
    assert.equal(loginRes.status, 302)
    let authedCookie = (loginRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    await env.satisfyMfa(
      (await env.adminPool.query<{ id: string }>('select id from iam.app_user where email = $1', [
        'oauth_test_stepup@example.com',
      ])).rows[0]!.id,
    )

    let profileCsrf = await env.sessionCsrf(authedCookie)
    let unlinkForm = new FormData()
    unlinkForm.set('_csrf', profileCsrf)
    unlinkForm.set('identityId', 'not-a-valid-uuid')

    let unlinkRes = await env.router.fetch(
      new URL(routes.identity.unlink.href(), 'http://localhost'),
      { method: 'POST', headers: { cookie: authedCookie }, body: unlinkForm },
    )
    assert.equal(unlinkRes.status, 400)
    let text = await unlinkRes.text()
    assert.match(text, /Invalid identity id/)
  })

  it('P0.5: OAuth step-up rejects missing or mismatched user ID with 403', async () => {
    // 1. Create external user and session
    await env.adminPool.query(`delete from iam.session where user_id in (select id from iam.app_user where email in ('oauth_stepup_p05@example.com', 'oauth_stepup_p05b@example.com'))`)
    await env.adminPool.query(`delete from iam.app_user where email in ('oauth_stepup_p05@example.com', 'oauth_stepup_p05b@example.com')`)

    let userId = (await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status, email_verified_at)
      values ('external', 'oauth_stepup_p05@example.com', 'Step Up User', 'active', now())
      returning id
    `)).rows[0]!.id

    let sid = (await env.adminPool.query<{ id: string }>(`
      insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
      values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
      returning id
    `, [userId])).rows[0]!.id

    // Test missing intent.userId -> 403
    await env.adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd',
           'mfaVerifiedAt', now()::text
         ),
         '__auth', jsonb_build_object(
           'provider', 'google',
           'state', 'state',
           'providerState', 'nonce-p05-1',
           'nonce', 'nonce-p05-1', 'codeVerifier', 'verifier-p05-1'
         ),
         'linkIntent', jsonb_build_object(
           'id', 'intent-p05-1',
           'sessionId', $2::text,
           'provider', 'google',
           'purpose', 'step_up',
           'createdAt', 1000,
           'expiresAt', extract(epoch from now() + interval '10 minutes') * 1000
         ),
         '_csrf', 'test-csrf-p05'
       ), jsonb_build_object())
       where id = $2`,
      [userId, sid],
    )

    let cookieVal = JSON.stringify({ value: sid, expires: Date.now() + 12 * 60 * 60 * 1000 })
    let rawCookie = (await sessionCookie.serialize(cookieVal)).split(';')[0]!

    // Start OAuth mock callback
    let code1 = 'code-p05-missing-user'
    let token1 = env.makeGoogleToken({ nonce: 'nonce-p05-1', sub: 'google-p05-sub' })
    env.activeTokens.set(code1, token1)

    // Complete callback with missing intent.userId -> 403
    let resMissing = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code1}&state=state`, 'http://localhost'),
      { headers: { cookie: rawCookie } },
    )
    assert.equal(resMissing.status, 403)
    let textMissing = await resMissing.text()
    assert.match(textMissing, /Unauthorized step-up attempt\./)

    // Test mismatched intent.userId -> 403
    let otherUserId = '00000000-0000-0000-0000-000000000001'
    await env.adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object(
           'userId', $1::text,
           'kind', 'external',
           'activeRole', 'ext_user',
           'authMethod', 'pwd',
           'mfaVerifiedAt', now()::text
         ),
         '__auth', jsonb_build_object(
           'provider', 'google',
           'state', 'state',
           'providerState', 'nonce-p05-2',
           'nonce', 'nonce-p05-2', 'codeVerifier', 'verifier-p05-2'
         ),
         'linkIntent', jsonb_build_object(
           'id', 'intent-p05-2',
           'sessionId', $2::text,
           'provider', 'google',
           'purpose', 'step_up',
           'userId', $3::text,
           'createdAt', 1000,
           'expiresAt', extract(epoch from now() + interval '10 minutes') * 1000
         ),
         '_csrf', 'test-csrf-p05-2'
       ), jsonb_build_object())
       where id = $2`,
      [userId, sid, otherUserId],
    )
    clearSessionCaches()

    let code2 = 'code-p05-mismatch-user'
    let token2 = env.makeGoogleToken({ nonce: 'nonce-p05-2', sub: 'google-p05-sub-2' })
    env.activeTokens.set(code2, token2)

    let resMismatch = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code2}&state=state`, 'http://localhost'),
      { headers: { cookie: rawCookie } },
    )
    assert.equal(resMismatch.status, 403)
    let textMismatch = await resMismatch.text()
    assert.match(textMismatch, /Unauthorized step-up attempt\./)

    // Cleanup
    await env.adminPool.query('delete from iam.session where id = $1', [sid])
    await env.adminPool.query('delete from iam.app_user where id = $1', [userId])
  })

  it('P0.5: OAuth step-up rejects session mismatch, provider mismatch, and replayed intent with 400', async () => {
    await env.adminPool.query(`delete from iam.session where user_id in (select id from iam.app_user where email = 'oauth_stepup_p05b@example.com')`)
    await env.adminPool.query(`delete from iam.app_user where email = 'oauth_stepup_p05b@example.com'`)

    let userId = (await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status, email_verified_at)
      values ('external', 'oauth_stepup_p05b@example.com', 'Step Up User B', 'active', now())
      returning id
    `)).rows[0]!.id

    let sid = (await env.adminPool.query<{ id: string }>(`
      insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
      values ($1, 'external', 'ext_user', 'pwd', now() + interval '30 minutes', now() + interval '8 hours')
      returning id
    `, [userId])).rows[0]!.id

    let cookieVal = JSON.stringify({ value: sid, expires: Date.now() + 12 * 60 * 60 * 1000 })
    let rawCookie = (await sessionCookie.serialize(cookieVal)).split(';')[0]!

    // 1. Session mismatch: intent.sessionId != session.id
    await env.adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object('userId', $1::text, 'kind', 'external', 'activeRole', 'ext_user', 'authMethod', 'pwd', 'mfaVerifiedAt', now()::text),
         '__auth', jsonb_build_object('provider', 'google', 'state', 'state', 'providerState', 'nonce-p05-s', 'nonce', 'nonce-p05-s', 'codeVerifier', 'verifier-p05-sess'),
         'linkIntent', jsonb_build_object(
           'id', 'intent-p05-sess',
           'sessionId', 'other-session-id',
           'provider', 'google',
           'purpose', 'step_up',
           'userId', $1::text,
           'createdAt', 1000,
           'expiresAt', extract(epoch from now() + interval '10 minutes') * 1000
         )
       ), jsonb_build_object())
       where id = $2`,
      [userId, sid],
    )

    let codeSess = 'code-p05-sess'
    env.activeTokens.set(codeSess, env.makeGoogleToken({ nonce: 'nonce-p05-s', sub: 'google-sub-s' }))
    let resSess = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${codeSess}&state=state`, 'http://localhost'),
      { headers: { cookie: rawCookie } },
    )
    assert.equal(resSess.status, 400)
    assert.match(await resSess.text(), /Linking intent is invalid/)

    // 2. Provider mismatch: intent.provider = 'microsoft', callback to Google
    await env.adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object('userId', $1::text, 'kind', 'external', 'activeRole', 'ext_user', 'authMethod', 'pwd', 'mfaVerifiedAt', now()::text),
         '__auth', jsonb_build_object('provider', 'google', 'state', 'state', 'providerState', 'nonce-p05-p', 'nonce', 'nonce-p05-p', 'codeVerifier', 'verifier-p05-prov'),
         'linkIntent', jsonb_build_object(
           'id', 'intent-p05-prov',
           'sessionId', $2::text,
           'provider', 'microsoft',
           'purpose', 'step_up',
           'userId', $1::text,
           'createdAt', 1000,
           'expiresAt', extract(epoch from now() + interval '10 minutes') * 1000
         )
       ), jsonb_build_object())
       where id = $2`,
      [userId, sid],
    )
    clearSessionCaches()

    let codeProv = 'code-p05-prov'
    env.activeTokens.set(codeProv, env.makeGoogleToken({ nonce: 'nonce-p05-p', sub: 'google-sub-p' }))
    let resProv = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${codeProv}&state=state`, 'http://localhost'),
      { headers: { cookie: rawCookie } },
    )
    assert.equal(resProv.status, 400)
    assert.match(await resProv.text(), /Linking intent has expired or is invalid/)

    // 3. Stale / expired intent: intent.expiresAt has passed
    await env.adminPool.query(
      `update iam.session set data = jsonb_build_array(jsonb_build_object(
         'auth', jsonb_build_object('userId', $1::text, 'kind', 'external', 'activeRole', 'ext_user', 'authMethod', 'pwd', 'mfaVerifiedAt', now()::text),
         '__auth', jsonb_build_object('provider', 'google', 'state', 'state', 'providerState', 'nonce-p05-e', 'nonce', 'nonce-p05-e', 'codeVerifier', 'verifier-p05-exp'),
         'linkIntent', jsonb_build_object(
           'id', 'intent-p05-exp',
           'sessionId', $2::text,
           'provider', 'google',
           'purpose', 'step_up',
           'userId', $1::text,
           'createdAt', 1000,
           'expiresAt', 500
         )
       ), jsonb_build_object())
       where id = $2`,
      [userId, sid],
    )
    clearSessionCaches()

    let codeExp = 'code-p05-exp'
    env.activeTokens.set(codeExp, env.makeGoogleToken({ nonce: 'nonce-p05-e', sub: 'google-sub-e' }))
    let resExp = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${codeExp}&state=state`, 'http://localhost'),
      { headers: { cookie: rawCookie } },
    )
    assert.equal(resExp.status, 400)
    assert.match(await resExp.text(), /Linking intent has expired or is invalid/)

    // Cleanup
    await env.adminPool.query('delete from iam.session where id = $1', [sid])
    await env.adminPool.query('delete from iam.app_user where id = $1', [userId])
  })
})
