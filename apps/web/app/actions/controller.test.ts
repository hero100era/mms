import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { Pool } from 'pg'

import { router as _router } from '../router.ts'

// Unique peer per test file: the throttle bucket counts by client IP, and the shared
// 0.0.0.0 would mean every suite locks out together. Runs only because the suite declares
// MMS_TRUSTED_PROXY_HOPS=1 (see package.json test script).
const TEST_IP = '203.0.113.11'
const router = {
  fetch(input: URL, init?: RequestInit): Promise<Response> {
    return _router.fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': TEST_IP },
    })
  },
}
import { createRolePool } from '../db/role-pool.ts'
import { routes } from '../routes.ts'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

const adminPoolPool = createRolePool(() => adminUrl, 1)

async function getCsrfAndCookie(path: string): Promise<{ csrf: string; cookie: string }> {
  let res = await router.fetch(new URL(path, 'http://localhost'))
  let text = await res.text()
  let match = text.match(/name="_csrf"\s+value="([^"]+)"/)
  let cookieHeader = res.headers.get('set-cookie') ?? ''
  let sid = cookieHeader.split(';')[0] ?? ''
  return { csrf: match?.[1] ?? '', cookie: sid }
}

describe('root controller', () => {
  let adminPool: Pool

  before(async () => {
    adminPool = adminPoolPool.get()
    await adminPool.query(`delete from iam.login_attempt where login_name like '%@example.com' or client_ip in ('127.0.0.1', '203.0.113.11', '198.51.100.42')`)
  })

  after(async () => {
    await adminPool.query(`delete from iam.session where user_id in (select id from iam.app_user where email = 'flow_d_user@example.com')`)
    await adminPool.query(`delete from iam.password_credential where user_id in (select id from iam.app_user where email = 'flow_d_user@example.com')`)
    await adminPool.query(`delete from iam.one_time_token where user_id in (select id from iam.app_user where email = 'flow_d_user@example.com')`)
    await adminPool.query(`delete from iam.app_user where email = 'flow_d_user@example.com'`)
    await adminPool.query(`delete from iam.login_attempt where login_name like '%@example.com' or client_ip in ('127.0.0.1', '198.51.100.42')`)
  })

  it('GET / returns the home page', async () => {
    let response = await router.fetch(new URL(routes.session.home.href(), 'http://localhost'))

    assert.ok([200, 401, 422].includes(response.status))
    assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
    assert.match(await response.text(), /<html[\s>]/)
  })

  it('GET /login renders external password sign-in form', async () => {
    let response = await router.fetch(new URL(routes.session.login.href(), 'http://localhost'))

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /External account sign-in/)
    assert.match(text, /name="email"/)
    assert.match(text, /name="password"/)
  })

  it('POST /login/password with invalid credentials displays generic error', async () => {
    let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('email', 'nobody@example.com')
    form.set('password', 'ValidPassw0rd!')

    let response = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie, 'x-client-ip': '198.51.100.1' },
      body: form,
    })

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /Invalid email or password\./)
  })

  it('GET /invite/:token renders invite accept form', async () => {
    let response = await router.fetch(new URL(routes.identity.invite.href({ token: 'test-token-xyz' }), 'http://localhost'))

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /Accept invitation/)
    assert.match(text, /name="confirmPassword"/)
  })

  it('POST /invite/:token with mismatched passwords shows error', async () => {
    let token = 'test-token-123'
    let { csrf, cookie } = await getCsrfAndCookie(routes.identity.invite.href({ token }))
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', 'SuperSecretPass123')
    form.set('confirmPassword', 'DifferentPass123')

    let response = await router.fetch(new URL(routes.identity.accept.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /Passwords do not match\./)
  })

  it('POST /invite/:token with too short password shows policy error', async () => {
    let token = 'test-token-123'
    let { csrf, cookie } = await getCsrfAndCookie(routes.identity.invite.href({ token }))
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', 'short')
    form.set('confirmPassword', 'short')

    let response = await router.fetch(new URL(routes.identity.accept.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /at least 12 characters/i)
  })

  it('POST /invite/:token with blocklisted password shows policy error', async () => {
    let token = 'test-token-123'
    let { csrf, cookie } = await getCsrfAndCookie(routes.identity.invite.href({ token }))
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', 'password12345')
    form.set('confirmPassword', 'password12345')

    let response = await router.fetch(new URL(routes.identity.accept.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /too common or easily guessed/i)
  })

  it('POST /invite/:token with invalid token shows error', async () => {
    let token = 'non-existent-token-xyz'
    let { csrf, cookie } = await getCsrfAndCookie(routes.identity.invite.href({ token }))
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', 'ValidNewPassword123!')
    form.set('confirmPassword', 'ValidNewPassword123!')

    let response = await router.fetch(new URL(routes.identity.accept.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.ok([200, 401, 422].includes(response.status))
    let text = await response.text()
    assert.match(text, /Invalid or expired invitation token\./)
  })

  it('POST /invite/:token with valid token sets password, activates user, and creates session', async () => {
    let token = 'flow-d-invite-token-1234567890'
    let tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))

    let userRes = await adminPool.query<{ id: string }>(`
      insert into iam.app_user (kind, email, display_name, status)
      values ('external', 'flow_d_user@example.com', 'Flow D User', 'invited')
      returning id
    `)
    let userId = userRes.rows[0]!.id

    await adminPool.query(`
      insert into iam.one_time_token (user_id, purpose, token_hash, expires_at)
      values ($1, 'invite', $2, now() + interval '72 hours')
    `, [userId, tokenHash])

    let { csrf, cookie } = await getCsrfAndCookie(routes.identity.invite.href({ token }))
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('password', 'ValidPassw0rd123!')
    form.set('confirmPassword', 'ValidPassw0rd123!')

    let response = await router.fetch(new URL(routes.identity.accept.href({ token }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('Location'), routes.mfa.enrol.href())
    assert.ok(response.headers.get('set-cookie'))

    let dbUser = await adminPool.query<{ status: string; email_verified_at: string }>(
      'select status, email_verified_at from iam.app_user where id = $1',
      [userId],
    )
    assert.equal(dbUser.rows[0]?.status, 'active')
    assert.ok(dbUser.rows[0]?.email_verified_at)

    let dbCred = await adminPool.query('select hash from iam.password_credential where user_id = $1', [userId])
    assert.equal(dbCred.rows.length, 1)
  })

  it('POST /login/password with valid credentials authenticates external user and sends them to the second factor (H-09)', async () => {
    let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('email', 'flow_d_user@example.com')
    form.set('password', 'ValidPassw0rd123!')

    let response = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.equal(response.status, 302)
    // Card H-09: the password step now hands off to the second factor.
    assert.equal(response.headers.get('Location'), '/mfa?returnTo=%2Fprofile')
    assert.ok(response.headers.get('set-cookie'))
  })

  it('P0.1: after POST /login/password succeeds, GET /profile redirects to /mfa (MFA gate enforced)', async () => {
    let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('email', 'flow_d_user@example.com')
    form.set('password', 'ValidPassw0rd123!')

    let response = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    assert.equal(response.status, 302)
    let authedCookie = response.headers.get('set-cookie')!.split(';')[0]!

    let profileRes = await router.fetch(new URL(routes.session.profile.href(), 'http://localhost'), {
      headers: { cookie: authedCookie },
    })

    assert.equal(profileRes.status, 302)
    assert.equal(profileRes.headers.get('Location'), '/mfa?returnTo=%2Fprofile')
  })

  it('POST /login/password triggers throttling and lockout message after 5 failed attempts', async () => {
    let testIp = '198.51.100.42'
    for (let i = 0; i < 5; i++) {
      let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
      let form = new FormData()
      form.set('_csrf', csrf)
      form.set('email', 'throttle_test@example.com')
      form.set('password', 'WrongPassword123!')

      let res = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie, 'x-client-ip': testIp },
        body: form,
      })
      assert.ok([200, 401, 429].includes(res.status))
    }

    let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
    let form = new FormData()
    form.set('_csrf', csrf)
    form.set('email', 'throttle_test@example.com')
    form.set('password', 'WrongPassword123!')

    let lockedRes = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie, 'x-client-ip': testIp },
      body: form,
    })
    assert.ok([200, 401, 429].includes(lockedRes.status))
    let text = await lockedRes.text()
    assert.match(text, /Too many failed attempts\. Account is temporarily locked\./)
  })

  it('GET /admin/external-users requires authentication', async () => {
    let response = await router.fetch(new URL(routes.admin.externalUsers.index.href(), 'http://localhost'))
    assert.ok([302, 401, 403].includes(response.status))
  })

  it('GET /dev/mailbox is hidden unless the dev auth stub is enabled', async () => {
    let previous = process.env.MMS_AUTH_STUB
    let prevDevLogin = process.env.ALLOW_DEV_LOGIN
    delete process.env.MMS_AUTH_STUB
    delete process.env.ALLOW_DEV_LOGIN

    try {
      let hidden = await router.fetch(new URL(routes.session.devMailbox.href(), 'http://localhost'))
      assert.equal(hidden.status, 404)

      // With the dev stub on, the local mailbox is readable for development.
      process.env.MMS_AUTH_STUB = '1'
      let response = await router.fetch(new URL(routes.session.devMailbox.href(), 'http://localhost'))
      assert.ok([200, 401, 422].includes(response.status))
      assert.equal(response.headers.get('Content-Type'), 'application/json')
      let data = await response.json()
      assert.ok(Array.isArray(data))
    } finally {
      if (previous === undefined) delete process.env.MMS_AUTH_STUB
      else process.env.MMS_AUTH_STUB = previous
      if (prevDevLogin === undefined) delete process.env.ALLOW_DEV_LOGIN
      else process.env.ALLOW_DEV_LOGIN = prevDevLogin
    }
  })

  describe('P0.1 Login Enumeration', () => {
    it('returns identical response for unknown user and wrong password', async () => {
      let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
      let form = new FormData()
      form.set('_csrf', csrf)
      form.set('email', 'unknown@example.com')
      form.set('password', 'ValidPassw0rd123!')

      let res1 = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie },
        body: form,
      })
      let text1 = await res1.text()

      let { csrf: csrf2, cookie: cookie2 } = await getCsrfAndCookie(routes.session.login.href())
      let form2 = new FormData()
      form2.set('_csrf', csrf2)
      form2.set('email', 'flow_d_user@example.com')
      form2.set('password', 'WrongPassw0rd123!')

      let res2 = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie: cookie2 },
        body: form2,
      })
      let text2 = await res2.text()

      assert.equal(res1.status, 401)
      assert.equal(res2.status, 401)
      let clean1 = text1.replace(/nonce="[^"]*"/g, '').replace(/name="_csrf"\s+value="[^"]*"/g, '')
      let clean2 = text2.replace(/nonce="[^"]*"/g, '').replace(/name="_csrf"\s+value="[^"]*"/g, '')
      assert.equal(clean1, clean2)
    })

    it('returns identical response for inactive/disabled accounts', async () => {
      // Set up inactive user
      await adminPool.query(`delete from iam.session where user_id in (select id from iam.app_user where email = 'inactive_test@example.com')`)
      await adminPool.query(`delete from iam.password_credential where user_id in (select id from iam.app_user where email = 'inactive_test@example.com')`)
      await adminPool.query(`delete from iam.app_user where email = 'inactive_test@example.com'`)

      let userRes = await adminPool.query<{ id: string }>(`
        insert into iam.app_user (kind, email, display_name, status)
        values ('external', 'inactive_test@example.com', 'Inactive User', 'suspended')
        returning id
      `)
      let userId = userRes.rows[0]!.id
      await adminPool.query(`insert into iam.password_credential (user_id, hash) values ($1, 'dummy_hash')`, [userId])

      let { csrf, cookie } = await getCsrfAndCookie(routes.session.login.href())
      let form = new FormData()
      form.set('_csrf', csrf)
      form.set('email', 'inactive_test@example.com')
      form.set('password', 'ValidPassw0rd123!')

      let res = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
        method: 'POST',
        headers: { cookie },
        body: form,
      })
      assert.equal(res.status, 401)
      assert.match(await res.text(), /Invalid email or password\./)
    })
  })
})
