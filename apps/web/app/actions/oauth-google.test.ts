import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { routes } from '../routes.ts'
import {
  createOauthTestEnvironment,
  type OauthTestEnvironment,
} from './oauth-test-helper.ts'

describe('Card I-08: External OAuth - Google Provider flows', () => {
  let env: OauthTestEnvironment

  before(async () => {
    env = await createOauthTestEnvironment('203.0.113.22')
  })

  after(async () => {
    await env.teardown()
  })

  it('GET /auth/google/start initiates OAuth and returns redirect with state, nonce, and session cookie', async () => {
    let response = await env.router.fetch(new URL(routes.auth.googleStart.href(), 'http://localhost'))
    assert.equal(response.status, 302)
    let location = response.headers.get('Location') ?? ''
    assert.match(location, /\/o\/oauth2\/v2\/auth/)
    assert.match(location, /client_id=google-client-id-xyz/)
    assert.match(location, /response_type=code/)
    assert.match(location, /state=/)
    assert.match(location, /nonce=/)
    assert.match(location, /code_challenge=/)
    assert.ok(response.headers.get('set-cookie'))
  })

  it('AC 1: Refuses external OAuth login when identity is not linked (401)', async () => {
    let startRes = await env.router.fetch(new URL(routes.auth.googleStart.href(), 'http://localhost'))
    let location = new URL(startRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let cookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0]!

    let code = 'code-unlinked-1'
    let token = env.makeGoogleToken({
      nonce,
      sub: 'google-sub-unlinked-1',
      email: 'unlinked@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie } },
    )

    assert.equal(callbackRes.status, 401)
    let text = await callbackRes.text()
    assert.match(text, /This account is not linked to any MMS user\./)
  })

  it('AC 2: Matching email in iam.app_user without active identity link is refused (no auto-linking)', async () => {
    let userRes = await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status)
      values ('external', 'oauth_test_matching_email@example.com', 'Matching User', 'active')
      returning id
    `)
    let userId = userRes.rows[0]!.id

    let startRes = await env.router.fetch(new URL(routes.auth.googleStart.href(), 'http://localhost'))
    let location = new URL(startRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let cookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0]!

    let code = 'code-matching-email'
    let token = env.makeGoogleToken({
      nonce,
      sub: 'google-sub-not-linked-yet',
      email: 'oauth_test_matching_email@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie } },
    )

    assert.equal(callbackRes.status, 401)
    let text = await callbackRes.text()
    assert.match(text, /This account is not linked to any MMS user\./)

    // Verify DB still has 0 linked identities for this user
    let idCheck = await env.adminPool.query('select * from iam.user_identity where user_id = $1', [userId])
    assert.equal(idCheck.rows.length, 0)
  })

  it('AC 8: Flow D - Linking during invite activates user, sets email_verified_at, and links identity', async () => {
    let tokenVal = 'invite-token-flow-d-oauth'
    let tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenVal)))

    let userRes = await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status)
      values ('external', 'oauth_test_flow_d@example.com', 'Flow D Invited User', 'invited')
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
    let sessionCookie = (linkStartRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    let code = 'code-flow-d-accept'
    let googleSub = 'google-sub-flow-d-12345'
    let token = env.makeGoogleToken({
      nonce,
      sub: googleSub,
      email: 'oauth_test_flow_d@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie: sessionCookie } },
    )

    assert.equal(callbackRes.status, 302)
    assert.equal(callbackRes.headers.get('Location'), '/profile')

    // Verify DB state
    let userRow = await env.adminPool.query<{ status: string; email_verified_at: string }>(
      'select status, email_verified_at from iam.app_user where id = $1',
      [userId],
    )
    assert.equal(userRow.rows[0]?.status, 'active')
    assert.ok(userRow.rows[0]?.email_verified_at)

    let tokenRow = await env.adminPool.query<{ used_at: string }>(
      'select used_at from iam.one_time_token where user_id = $1 and purpose = $2',
      [userId, 'invite'],
    )
    assert.ok(tokenRow.rows[0]?.used_at)

    let identityRow = await env.adminPool.query<{ provider: string; subject: string; unlinked_at: string | null }>(
      'select provider, subject, unlinked_at from iam.user_identity where user_id = $1',
      [userId],
    )
    assert.equal(identityRow.rows.length, 1)
    assert.equal(identityRow.rows[0]?.provider, 'google')
    assert.equal(identityRow.rows[0]?.subject, googleSub)
    assert.equal(identityRow.rows[0]?.unlinked_at, null)
  })

  it('AC 6: Denies duplicate link across active users (409)', async () => {
    let tokenVal = 'invite-token-dup-test'
    let tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenVal)))

    let userRes = await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status)
      values ('external', 'oauth_test_dup@example.com', 'Duplicate Test User', 'invited')
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
    let sessionCookie = (linkStartRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    let code = 'code-dup-test'
    let token = env.makeGoogleToken({
      nonce,
      sub: 'google-sub-flow-d-12345', // Already linked to user A!
      email: 'oauth_test_dup@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.googleCallback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie: sessionCookie } },
    )

    assert.equal(callbackRes.status, 409)
    let text = await callbackRes.text()
    assert.match(text, /already linked to another MMS user/i)

    // User B should still be in invited status
    let userRow = await env.adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [userId])
    assert.equal(userRow.rows[0]?.status, 'invited')
  })

  it('AC 7: Last remaining sign-in method cannot be removed', async () => {
    // Create an external user who has ONLY 1 linked identity and NO password
    let userId = (await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status, email_verified_at)
      values ('external', 'oauth_test_only_id@example.com', 'Only Id User', 'active', now())
      returning id
    `)).rows[0]!.id

    let idRow = (await env.adminPool.query<{ id: string }>(`
      insert into iam.user_identity (user_id, provider, issuer, subject, email_at_link)
      values ($1, 'google', $2, 'google-sub-only-method', 'oauth_test_only_id@example.com')
      returning id
    `, [userId, env.authority])).rows[0]!

    // Start OAuth login with this identity to authenticate
    let startRes = await env.router.fetch(new URL(routes.auth.googleStart.href(), 'http://localhost'))
    let location = new URL(startRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let cookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0]!

    let code = 'code-only-id-login'
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
    assert.equal(callbackRes.headers.get('Location'), '/profile')
    let authedCookie = (callbackRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    // User is logged in with fresh step-up. Now try to unlink their ONLY sign-in method!
    let csrf = await env.sessionCsrf(authedCookie)
    let unlinkForm = new FormData()
    unlinkForm.set('_csrf', csrf)
    unlinkForm.set('identityId', idRow.id)

    let unlinkRes = await env.router.fetch(
      new URL(routes.identity.unlink.href(), 'http://localhost'),
      { method: 'POST', headers: { cookie: authedCookie }, body: unlinkForm },
    )

    assert.ok(unlinkRes.status === 200 || unlinkRes.status === 422)
    let text = await unlinkRes.text()
    assert.match(text, /Cannot remove your last remaining sign-in method\./)

    // DB check: unlinked_at must still be null!
    let dbCheck = await env.adminPool.query<{ unlinked_at: string | null }>(
      'select unlinked_at from iam.user_identity where id = $1',
      [idRow.id],
    )
    assert.equal(dbCheck.rows[0]?.unlinked_at, null)
  })

  it('Successfully unlinks an identity when password credential exists', async () => {
    // Ensure user has both password credential and linked google identity
    let userRow = await env.adminPool.query<{ id: string }>('select id from iam.app_user where email = $1', ['oauth_test_stepup@example.com'])
    let userId = userRow.rows[0]?.id
    let { hashPassword } = await import('../auth/password.ts')
    let passHash = await hashPassword('ValidPass1234!')
    if (!userId) {
      let created = await env.adminPool.query<{ id: string }>(`
        insert into iam.app_user (kind, email, display_name, status, email_verified_at)
        values ('external', 'oauth_test_stepup@example.com', 'StepUp User', 'active', now())
        returning id
      `)
      userId = created.rows[0]!.id
      await env.adminPool.query('insert into iam.password_credential (user_id, hash) values ($1, $2)', [userId, passHash])
    } else {
      await env.adminPool.query(`
        insert into iam.password_credential (user_id, hash)
        values ($1, $2)
        on conflict (user_id) do update set hash = excluded.hash
      `, [userId, passHash])
    }

    let idRows = await env.adminPool.query<{ id: string }>(
      'select id from iam.user_identity where user_id = $1 and unlinked_at is null',
      [userId],
    )
    let idRow = idRows.rows[0]
    if (!idRow) {
      let ins = await env.adminPool.query<{ id: string }>(`
        insert into iam.user_identity (user_id, provider, issuer, subject, email_at_link)
        values ($1, 'google', $2, 'google-sub-stepup-unlink', 'oauth_test_stepup@example.com')
        returning id
      `, [userId, env.authority])
      idRow = ins.rows[0]!
    }

    // Log in with password to get fresh step-up
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

    await env.satisfyMfa(userId)
    await env.grantStepUp(authedCookie)

    // Unlink the identity
    let profileCsrf = await env.sessionCsrf(authedCookie)
    let unlinkForm = new FormData()
    unlinkForm.set('_csrf', profileCsrf)
    unlinkForm.set('identityId', idRow.id)

    let unlinkRes = await env.router.fetch(
      new URL(routes.identity.unlink.href(), 'http://localhost'),
      { method: 'POST', headers: { cookie: authedCookie }, body: unlinkForm },
    )

    assert.equal(unlinkRes.status, 302)
    assert.equal(unlinkRes.headers.get('Location'), '/profile?success=unlinked')

    // DB check: unlinked_at is now set!
    let dbCheck = await env.adminPool.query<{ unlinked_at: string | null }>(
      'select unlinked_at from iam.user_identity where id = $1',
      [idRow.id],
    )
    assert.ok(dbCheck.rows[0]?.unlinked_at)

    // Verify audit event auth.identity.unlinked was emitted
    let auditRow = await env.adminPool.query(
      "select * from audit_trail.event where event_type = 'auth.identity.unlinked' and subject_id = $1",
      [userId],
    )
    assert.ok(auditRow.rows.length >= 1)
  })

  it('loginPassword preserves googleEnabled on failed password attempt', async () => {
    let { csrf, cookie } = await env.getCsrfAndCookie(routes.session.login.href())
    let loginForm = new FormData()
    loginForm.set('_csrf', csrf)
    loginForm.set('email', 'nonexistent@example.com')
    loginForm.set('password', 'WrongPassword123!')

    let loginRes = await env.router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: loginForm,
    })
    assert.equal(loginRes.status, 401)
    let html = await loginRes.text()
    assert.match(html, /Sign in with Google/)
  })
})
