import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { entraTenantId } from '../auth/entra.ts'
import { routes } from '../routes.ts'
import {
  createOauthTestEnvironment,
  staffTenantId,
  type OauthTestEnvironment,
} from './oauth-test-helper.ts'

describe('Card I-08: External OAuth - Microsoft Entra flows', () => {
  let env: OauthTestEnvironment

  before(async () => {
    env = await createOauthTestEnvironment('203.0.113.23')
  })

  after(async () => {
    await env.teardown()
  })

  it('AC 3: Microsoft ID token with our staff tenant routes to staff login', async () => {
    let startRes = await env.router.fetch(new URL(routes.auth.start.href(), 'http://localhost'))
    let location = new URL(startRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let cookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0]!

    let code = 'code-staff-1'
    let staffOid = '33333333-3333-3333-3333-333333333333'
    let token = env.makeEntraToken({
      nonce,
      tid: entraTenantId(), // Matches MMS_ENTRA_TENANT_ID!
      oid: staffOid,
      preferred_username: 'oauth_test_staff@example.com',
      roles: ['MMS.User'],
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.callback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie } },
    )

    // With no assignable roles, resolve_entra returns assignable_roles: []
    // and controller renders NoAccessPage with status 200
    assert.equal(callbackRes.status, 200)
    let text = await callbackRes.text()
    assert.match(text, /No access assigned/)

    // Now give this user an assignable role and test staff login with redirection
    let userRow = await env.adminPool.query<{ id: string }>(
      'select id from iam.app_user where entra_tenant_id = $1 and entra_object_id = $2',
      [staffTenantId, staffOid],
    )
    let userId = userRow.rows[0]!.id

    let granterId = (await env.adminPool.query<{ id: string }>(
      'select id from iam.app_user where id <> $1 and kind = \'internal\' and (email like \'%oauth_test_%\' or entra_object_id = \'99999999-9999-9999-9999-999999999999\') limit 1',
      [userId],
    )).rows[0]?.id

    if (!granterId) {
      let insGranter = await env.adminPool.query<{ id: string }>(`
        insert into iam.app_user (kind, display_name, entra_tenant_id, entra_object_id, status)
        values ('internal', 'Staff Granter', $1, '99999999-9999-9999-9999-999999999999', 'active')
        returning id
      `, [staffTenantId])
      granterId = insGranter.rows[0]!.id
    }

    await env.adminPool.query(`
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
      values ($1, 'internal', 'int_viewer', 'global', 'manual', $2, 'oauth test')
    `, [userId, granterId])

    let startRes2 = await env.router.fetch(new URL(routes.auth.start.href(), 'http://localhost'))
    let location2 = new URL(startRes2.headers.get('Location')!)
    let state2 = location2.searchParams.get('state')!
    let nonce2 = location2.searchParams.get('nonce')!
    let cookie2 = (startRes2.headers.get('set-cookie') ?? '').split(';')[0]!

    let code2 = 'code-staff-2'
    let token2 = env.makeEntraToken({
      nonce: nonce2,
      tid: entraTenantId(),
      oid: staffOid,
      preferred_username: 'oauth_test_staff@example.com',
      roles: ['MMS.User'],
    })
    env.activeTokens.set(code2, token2)

    let callbackRes2 = await env.router.fetch(
      new URL(routes.auth.callback.href() + `?code=${code2}&state=${state2}`, 'http://localhost'),
      { headers: { cookie: cookie2 } },
    )
    assert.equal(callbackRes2.status, 302)
    assert.equal(callbackRes2.headers.get('Location'), '/profile')
    assert.ok(callbackRes2.headers.get('set-cookie'))
  })

  it('Refuses to link internal staff Microsoft account to external user', async () => {
    let tokenVal = 'invite-token-staff-reject'
    let tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenVal)))

    let userRes = await env.adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status)
      values ('external', 'oauth_test_staff_reject@example.com', 'Staff Reject User', 'invited')
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
      new URL(routes.identity.linkInvite.href({ token: tokenVal, provider: 'microsoft' }), 'http://localhost'),
      { method: 'POST', headers: { cookie }, body: form },
    )
    assert.equal(linkStartRes.status, 302)
    let location = new URL(linkStartRes.headers.get('Location')!)
    let state = location.searchParams.get('state')!
    let nonce = location.searchParams.get('nonce')!
    let sessionCookie = (linkStartRes.headers.get('set-cookie') ?? cookie).split(';')[0]!

    let code = 'code-staff-as-external'
    let token = env.makeEntraToken({
      nonce,
      tid: entraTenantId(), // Internal staff tenant!
      oid: '44444444-4444-4444-4444-444444444444',
      preferred_username: 'oauth_test_staff_reject@example.com',
    })
    env.activeTokens.set(code, token)

    let callbackRes = await env.router.fetch(
      new URL(routes.auth.callback.href() + `?code=${code}&state=${state}`, 'http://localhost'),
      { headers: { cookie: sessionCookie } },
    )

    assert.equal(callbackRes.status, 400)
    let text = await callbackRes.text()
    assert.match(text, /Internal staff accounts cannot be linked to external users\./)
  })
})
