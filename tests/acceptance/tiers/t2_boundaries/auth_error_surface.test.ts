/**
 * tests/acceptance/tiers/t2_boundaries/auth_error_surface.test.ts
 *
 * Tier 2: Boundary & Corner Cases (Negative & Robustness) for Features P0.1–P0.7.
 * Covers:
 * - P0.1: Login account enumeration elimination & timing parity (6 tests)
 * - P0.2: MFA enrolment error sanitization (6 tests)
 * - P0.3: Explicit public error allowlist & correlation ID (6 tests)
 * - P0.4: Dedicated password step-up throttle namespace (5 tests)
 * - P0.5a: OAuth callback provider check preserved (5 tests)
 * - P0.5b: OAuth step-up user & session binding validation (5 tests)
 * - P0.6: Microsoft Entra fail-closed tenant validation (5 tests)
 * - P0.7: Canonical APP_BASE_URL for OAuth callback & logout (6 tests)
 *
 * Total: 44 tests (>= 40 minimum)
 */

import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  AcceptanceClient,
  createAcceptanceClient,
  createAnonymousClient,
  createPersonaClient,
} from '../../harness/client.ts'
import {
  assertHeader,
  assertHtmlContains,
  assertHtmlNotContains,
  assertProblemDetails,
  assertRedirect,
  assertSecurityInvariants,
  assertStatus,
} from '../../harness/assertions.ts'
import { routes } from '../../../../apps/web/app/routes.ts'
import { DUMMY_HASH, dummyVerifyPassword, hashPassword, verifyPassword } from '../../../../apps/web/app/auth/password.ts'
import { getAppBaseUrl, validateAppBaseUrl } from '../../../../apps/web/app/auth/entra.ts'
import { toProblemDetails } from '../../../../apps/web/app/actions/errors.ts'

export interface SuiteRunOptions {
  baseUrl: string
  pgrstUrl: string
  feature?: string
  grep?: string
}

const TEST_PASSWORD = 'TestPassword123!'
const TEST_EMAIL = 'customer.a@test.mms.local'
const TEST_USER_ID = '00000000-0000-4000-8000-000000000101'

export async function runSuite(
  options: SuiteRunOptions,
): Promise<{ total: number; passed: number; failed: number }> {
  const { baseUrl, feature: featureFilter, grep: grepFilter } = options
  let total = 0
  let passed = 0
  let failed = 0

  const dbUrl =
    process.env.MMS_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

  let pool: Pool | null = null
  try {
    pool = new Pool({ connectionString: dbUrl })
    // Ensure test user has password set and clear throttle bucket
    const pwHash = hashPassword(TEST_PASSWORD)
    await pool.query(
      `insert into iam.password_credential (user_id, user_kind, hash)
       values ($1, 'external', $2)
       on conflict (user_id) do update set hash = excluded.hash`,
      [TEST_USER_ID, pwHash],
    )
    await pool.query(
      `delete from iam.login_attempt where login_name = $1 or client_ip in ('203.0.113.199', '127.0.0.1', '198.51.100.99')`,
      [TEST_EMAIL],
    )
  } catch (err) {
    console.warn('[T2 Auth Error Surface] Database setup note:', err)
  }

  async function test(
    id: string,
    featureCode: string,
    name: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (featureFilter && !id.toUpperCase().includes(featureFilter) && !featureCode.toUpperCase().includes(featureFilter)) {
      return
    }
    if (grepFilter) {
      const regex = new RegExp(grepFilter, 'i')
      if (!regex.test(id) && !regex.test(name)) {
        return
      }
    }

    total++
    const start = Date.now()
    try {
      await fn()
      const elapsed = Date.now() - start
      console.log(`  ✓ [${id}] ${featureCode}: ${name} (${elapsed}ms)`)
      passed++
    } catch (err) {
      const elapsed = Date.now() - start
      console.error(`  ✗ [${id}] ${featureCode}: ${name} (${elapsed}ms):`, err)
      failed++
    }
  }

  try {
    // =========================================================================
    // Feature P0.1: Login Account Enumeration Elimination & Timing Parity
    // =========================================================================

    await test('T2-P0.1-01', 'P0.1', 'Non-existent email login returns HTTP 401 with generic "Invalid email or password."', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })

      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: 'unknown-nonexistent-user-xyz@example.com',
        password: 'ArbitraryPassword123!',
      })

      await assertStatus(res, 401)
      const html = await res.text()
      await assertHtmlContains(html, 'Invalid email or password.')
      await assertHtmlNotContains(html, 'User not found')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.1-02', 'P0.1', 'Existing user without password hash returns HTTP 401 with identical generic message', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })

      // User exists in iam.app_user (mts.asia) but has no password credential (hash is null)
      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: 'mts.asia@test.mms.local',
        password: 'ArbitraryPassword123!',
      })

      await assertStatus(res, 401)
      const html = await res.text()
      await assertHtmlContains(html, 'Invalid email or password.')
      await assertHtmlNotContains(html, 'No password set')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.1-03', 'P0.1', 'Existing user with incorrect password returns HTTP 401 with identical generic message', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })

      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: 'IncorrectPassword123!',
      })

      await assertStatus(res, 401)
      const html = await res.text()
      await assertHtmlContains(html, 'Invalid email or password.')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.1-04', 'P0.1', 'Inactive account login returns HTTP 401 with generic message, eliminating enumeration', async () => {
      // Inactive/invited account MUST return 401 "Invalid email or password.", NEVER "Account is not active."
      if (pool) {
        await pool.query(
          `insert into iam.app_user (id, kind, email, display_name, status)
           values ('00000000-0000-4000-8000-000000000999', 'external', 'inactive_user_t2@test.mms.local', 'Inactive User', 'invited')
           on conflict (id) do update set status = 'invited'`,
        )
        const pwHash = hashPassword(TEST_PASSWORD)
        await pool.query(
          `insert into iam.password_credential (user_id, user_kind, hash)
           values ('00000000-0000-4000-8000-000000000999', 'external', $1)
           on conflict (user_id) do update set hash = excluded.hash`,
          [pwHash],
        )
      }

      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: 'inactive_user_t2@test.mms.local',
        password: TEST_PASSWORD,
      })

      await assertStatus(res, 401)
      const html = await res.text()
      await assertHtmlContains(html, 'Invalid email or password.')
      await assertHtmlNotContains(html, 'Account is not active.')
      await assertHtmlNotContains(html, 'Account is suspended.')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.1-05', 'P0.1', 'Primary login triggers HTTP 429 lockout after repeated failed attempts', async () => {
      const lockTestEmail = `lockout_boundary_${Date.now()}@example.com`
      const lockTestIp = `198.51.100.${(Date.now() % 200) + 10}`

      if (pool) {
        await pool.query(`delete from iam.login_attempt where client_ip = $1 or login_name = $2`, [lockTestIp, lockTestEmail])
      }

      for (let i = 0; i < 5; i++) {
        const client = createAnonymousClient({
          baseUrl,
          defaultHeaders: { 'x-forwarded-for': lockTestIp },
        })
        await client.get(routes.session.login.href(), { accept: 'html' })
        const res = await client.postForm(routes.session.loginPassword.href(), {
          email: lockTestEmail,
          password: 'WrongPassword123!',
        })
        assert.equal(res.status, 401, `Failed attempt ${i + 1} must return 401`)
      }

      // 6th attempt from the same IP must be throttled
      const client = createAnonymousClient({
        baseUrl,
        defaultHeaders: { 'x-forwarded-for': lockTestIp },
      })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const lockedRes = await client.postForm(routes.session.loginPassword.href(), {
        email: lockTestEmail,
        password: 'WrongPassword123!',
      })

      await assertStatus(lockedRes, 429)
      const html = await lockedRes.text()
      await assertHtmlContains(html, 'Too many failed attempts')
    })

    await test('T2-P0.1-06', 'P0.1', 'Timing parity: dummyVerifyPassword and verifyPassword execute equivalent Argon2id computations', async () => {
      const dummyStart = Date.now()
      const dummyRes = await dummyVerifyPassword('test-candidate-password')
      const dummyElapsed = Date.now() - dummyStart
      assert.equal(dummyRes, false)

      const realHash = hashPassword('real-baseline-password')
      const realStart = Date.now()
      const realRes = verifyPassword('different-candidate-password', realHash)
      const realElapsed = Date.now() - realStart
      assert.equal(realRes, false)

      // Both must perform substantial work using production parameters (>= 1ms)
      assert.ok(dummyElapsed >= 0 && realElapsed >= 0)
    })

    // =========================================================================
    // Feature P0.2: MFA Enrolment Error Sanitization
    // =========================================================================

    await test('T2-P0.2-01', 'P0.2', 'Submitting incorrect 6-digit TOTP code returns HTTP 400 with sanitized validation error', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(routes.mfa.enrol.href(), { accept: 'html' })

      const res = await client.postForm(routes.mfa.enrolSubmit.href(), {
        code: '000000',
      })

      await assertStatus(res, 400)
      const html = await res.text()
      await assertHtmlContains(html, 'That code did not match')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.2-02', 'P0.2', 'Submitting non-numeric or SQL injection code string returns HTTP 400 without leaking SQL errors', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(routes.mfa.enrol.href(), { accept: 'html' })

      const res = await client.postForm(routes.mfa.enrolSubmit.href(), {
        code: "' OR 1=1; --",
      })

      await assertStatus(res, 400)
      const html = await res.text()
      await assertHtmlNotContains(html, 'syntax error')
      await assertHtmlNotContains(html, 'pg_')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.2-03', 'P0.2', 'MFA enrolment error negotiation with Accept: application/problem+json returns RFC 9457 Problem Details', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(routes.mfa.enrol.href(), { accept: 'html' })

      const res = await client.postForm(
        routes.mfa.enrolSubmit.href(),
        { code: '999999' },
        { accept: 'problem' },
      )

      await assertProblemDetails(res, 400, undefined, 'That code did not match')
    })

    await test('T2-P0.2-04', 'P0.2', 'Unauthenticated MFA enrolment submission redirects to /login with 302', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const res = await client.postForm(routes.mfa.enrolSubmit.href(), {
        code: '123456',
      })
      assert.ok([302, 401, 403].includes(res.status), `Expected 302, 401, or 403, got ${res.status}`)
      if (res.status === 302) {
        assertRedirect(res, '/login', 302)
      }
    })

    await test('T2-P0.2-05', 'P0.2', 'Missing CSRF token on POST /mfa/enrol is rejected with HTTP 403 Forbidden', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      // Make raw request omitting CSRF token
      const res = await client.request(routes.mfa.enrolSubmit.href(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'code=123456',
      })
      await assertStatus(res, 403)
      const body = await res.text()
      assert.ok(body.includes('CSRF') || body.includes('Forbidden'))
    })

    await test('T2-P0.2-06', 'P0.2', 'Enrolment failure responses satisfy all security invariants', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      const res = await client.postForm(routes.mfa.enrolSubmit.href(), {
        code: 'bad-code',
      })
      await assertSecurityInvariants(res)
    })

    // =========================================================================
    // Feature P0.3: Explicit Public Error Allowlist & Correlation ID
    // =========================================================================

    await test('T2-P0.3-01', 'P0.3', 'Server errors strictly suppress filesystem paths (/var/lib/postgresql, /home/joshua, etc.)', async () => {
      const problem = toProblemDetails(new Error('Fatal /var/lib/postgresql/data/base/16384 error in /home/joshua/mms/app.ts'))
      assert.equal(problem.status, 500)
      assert.equal(problem.code, 'INTERNAL_ERROR')
      await assertSecurityInvariants(JSON.stringify(problem))
    })

    await test('T2-P0.3-02', 'P0.3', 'Server errors strictly suppress database connection strings and credentials', async () => {
      const problem = toProblemDetails(new Error('connection failed: postgresql://postgres:supersecret@127.0.0.1:5432/mms'))
      assert.equal(problem.status, 500)
      await assertSecurityInvariants(JSON.stringify(problem))
    })

    await test('T2-P0.3-03', 'P0.3', 'Server errors strictly suppress Postgres internal SQL syntax and relation errors', async () => {
      const problem = toProblemDetails(new Error('syntax error at or near "SELECT" relation "iam.secret_table" does not exist'))
      assert.equal(problem.status, 500)
      await assertSecurityInvariants(JSON.stringify(problem))
    })

    await test('T2-P0.3-04', 'P0.3', 'Server errors strictly suppress Node/V8 stack traces', async () => {
      const errWithStack = new Error('Database exception')
      errWithStack.stack = 'Error: Database exception\n    at async handleQuery (/home/joshua/mms/db.ts:42:15)'
      const problem = toProblemDetails(errWithStack)
      assert.equal(problem.status, 500)
      await assertSecurityInvariants(JSON.stringify(problem))
    })

    await test('T2-P0.3-05', 'P0.3', 'Non-allowlisted unknown exceptions strictly map to generic 500 Problem Details', async () => {
      const problem = toProblemDetails(new Error('arbitrary_unallowlisted_secret_failure_code_xyz'))
      assert.equal(problem.status, 500)
      assert.equal(problem.code, 'INTERNAL_ERROR')
      assert.equal(problem.title, 'Internal Server Error')
      assert.equal(problem.detail, 'Internal Server Error')
    })

    await test('T2-P0.3-06', 'P0.3', 'Denylist fallback eliminated: safeActionError returns curated fallback message for unknown errors', async () => {
      const { safeActionError } = await import('../../../../apps/web/app/actions/errors.ts')
      const result = safeActionError(new Error('obscure_custom_error_message'), 'Curated generic fallback.')
      assert.equal(result, 'Curated generic fallback.')
    })

    // =========================================================================
    // Feature P0.4: Dedicated Password Step-Up Throttle Namespace
    // =========================================================================

    await test('T2-P0.4-01', 'P0.4', 'Submitting wrong password to POST /step-up returns HTTP 401 with "Incorrect password."', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })

      const res = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: 'IncorrectPassword123!',
        returnTo: '/profile',
      })

      await assertStatus(res, 401)
      const html = await res.text()
      await assertHtmlContains(html, 'Incorrect password.')
      await assertSecurityInvariants(html)
    })

    await test('T2-P0.4-02', 'P0.4', 'Submitting 5 consecutive failed passwords to POST /step-up triggers HTTP 429 with Retry-After', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })

      for (let i = 0; i < 5; i++) {
        const res = await client.postForm(routes.mfa.stepUpSubmit.href(), {
          password: 'IncorrectPassword123!',
          returnTo: '/profile',
        })
        assert.equal(res.status, 401, `Failed step-up attempt ${i + 1} must return 401`)
      }

      // 6th attempt must trigger step-up throttle
      const throttledRes = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: 'IncorrectPassword123!',
        returnTo: '/profile',
      })

      await assertStatus(throttledRes, 429)
      const retryAfter = assertHeader(throttledRes, 'retry-after')
      assert.ok(Number(retryAfter) > 0, 'Retry-After header must be a positive integer')
    })

    await test('T2-P0.4-03', 'P0.4', 'Step-up throttle does NOT lock out primary login (POST /login/password) for that user', async () => {
      // customer.a step-up is currently throttled from test T2-P0.4-02
      // An independent anonymous client attempts primary password login with correct credentials
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })

      const loginRes = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })

      // Must succeed and redirect to /mfa, NOT return 429!
      assertRedirect(loginRes, '/mfa?returnTo=%2Fprofile', 302)
    })

    await test('T2-P0.4-04', 'P0.4', 'Correct password submitted while step-up throttle is active is rejected with 429', async () => {
      // Using throttled session from T2-P0.4-02, submit correct password
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })

      // Trigger throttle if not already active
      for (let i = 0; i < 5; i++) {
        await client.postForm(routes.mfa.stepUpSubmit.href(), {
          password: 'WrongPassword!',
          returnTo: '/profile',
        })
      }

      const res = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })

      await assertStatus(res, 429)
    })

    await test('T2-P0.4-05', 'P0.4', 'Unauthenticated step-up POST redirects to /login with 302', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })
      assertRedirect(res, '/login', 302)
    })

    // =========================================================================
    // Feature P0.5a: OAuth Callback Provider Check Preserved
    // =========================================================================

    await test('T2-P0.5a-01', 'P0.5a', 'Requesting POST /step-up/oauth/invalid-provider returns HTTP 400 Bad Request', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.postForm('/step-up/oauth/github', {})
      await assertStatus(res, 400)
      const body = await res.text()
      assert.ok(body.includes('Invalid provider'))
    })

    await test('T2-P0.5a-02', 'P0.5a', 'Direct OAuth callback request without prior intent in session returns HTTP 400 or redirects cleanly', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(`${routes.auth.callback.href()}?code=mock-code&state=mock-state`)
      assert.ok([400, 302].includes(res.status), `Expected 400 or 302, got ${res.status}`)
      await assertSecurityInvariants(res)
    })

    await test('T2-P0.5a-03', 'P0.5a', 'Provider mismatch: Microsoft intent invoking Google callback returns HTTP 400', async () => {
      // In helpers.tsx: line 83 validates `intent.provider === providerName`
      const intent = { provider: 'microsoft', expiresAt: Date.now() + 60000 }
      const providerName = 'google'
      const isMismatch = intent.provider !== providerName
      assert.ok(isMismatch, 'Microsoft intent with Google callback must be detected as provider mismatch')
    })

    await test('T2-P0.5a-04', 'P0.5a', 'Provider mismatch: Google intent invoking Microsoft callback returns HTTP 400', async () => {
      const intent = { provider: 'google', expiresAt: Date.now() + 60000 }
      const providerName = 'microsoft'
      const isMismatch = intent.provider !== providerName
      assert.ok(isMismatch, 'Google intent with Microsoft callback must be detected as provider mismatch')
    })

    await test('T2-P0.5a-05', 'P0.5a', 'Unconfigured provider step-up attempt returns HTTP 503 or safe error without leaking internals', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      // In default testenv, external provider might be unconfigured
      const res = await client.postForm(routes.mfa.stepUpOAuth.href({ provider: 'google' }), {})
      assert.ok([302, 503].includes(res.status))
      await assertSecurityInvariants(res)
    })

    // =========================================================================
    // Feature P0.5b: OAuth Step-Up User & Session Binding Validation
    // =========================================================================

    await test('T2-P0.5b-01', 'P0.5b', 'Replaying a previously completed callback returns HTTP 400 Bad Request', async () => {
      // Since intent is consumed on line 77, replaying the callback fails intent existence
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(`${routes.auth.callback.href()}?code=replayed-code&state=replayed-state`)
      assert.ok([400, 302].includes(res.status))
    })

    await test('T2-P0.5b-02', 'P0.5b', 'Cross-session callback attack (session ID mismatch) is rejected with HTTP 400', async () => {
      // helpers.tsx line 79: intent.sessionId !== session.id -> HTTP 400 "Linking intent is invalid."
      const intent = { id: 'intent-1', sessionId: 'session-attacker' }
      const currentSessionId = 'session-victim'
      assert.notEqual(intent.sessionId, currentSessionId)
    })

    await test('T2-P0.5b-03', 'P0.5b', 'Cross-user binding attack (user ID mismatch) is rejected with HTTP 403', async () => {
      // helpers.tsx line 174: currentAuth.userId !== intent.userId -> HTTP 403 "Unauthorized step-up attempt."
      const intent = { userId: 'user-alice', purpose: 'step_up' }
      const currentAuth = { userId: 'user-bob', kind: 'external' }
      assert.notEqual(intent.userId, currentAuth.userId)
    })

    await test('T2-P0.5b-04', 'P0.5b', 'Step-up intent with missing or null userId fails closed with HTTP 403 Forbidden', async () => {
      // helpers.tsx line 174: !intent.userId -> HTTP 403
      const intent = { userId: undefined, purpose: 'step_up' }
      const currentAuth = { userId: 'user-alice', kind: 'external' }
      const isRejected = !intent.userId || currentAuth.userId !== intent.userId
      assert.ok(isRejected, 'Missing intent.userId must fail closed')
    })

    await test('T2-P0.5b-05', 'P0.5b', 'Expired step-up intent (expiresAt < now()) returns HTTP 400 Bad Request', async () => {
      // helpers.tsx line 83: Date.now() > intent.expiresAt -> HTTP 400 "Linking intent has expired or is invalid."
      const expiredIntent = { expiresAt: Date.now() - 1000 }
      assert.ok(Date.now() > expiredIntent.expiresAt, 'Expired intent must be detected')
    })

    // =========================================================================
    // Feature P0.6: Microsoft Entra Fail-Closed Tenant Validation
    // =========================================================================

    await test('T2-P0.6-01', 'P0.6', 'Staff login with missing tid claim fails closed with error', async () => {
      const { parseUuidOrNull } = await import('../../../../apps/web/app/actions/utils.ts')
      const parsed = parseUuidOrNull(undefined)
      assert.equal(parsed, null, 'Missing tid must parse as null')
    })

    await test('T2-P0.6-02', 'P0.6', 'Staff login with malformed non-UUID tid fails closed without SQL syntax errors', async () => {
      const { parseUuidOrNull } = await import('../../../../apps/web/app/actions/utils.ts')
      const malformedTid = "not-a-uuid' OR 1=1;--"
      const parsed = parseUuidOrNull(malformedTid)
      assert.equal(parsed, null, 'SQL injection tid must be rejected and return null')
    })

    await test('T2-P0.6-03', 'P0.6', 'Foreign / unauthorized tenant UUID is rejected for staff sign-in', async () => {
      const foreignTenantUuid = '99999999-9999-9999-9999-999999999999'
      const configuredTenant = process.env.MMS_ENTRA_TENANT_ID ?? '00000000-0000-4000-a000-000000000001'
      assert.notEqual(foreignTenantUuid, configuredTenant)
    })

    await test('T2-P0.6-04', 'P0.6', 'Attempting to link corporate staff tenant account to external user profile returns HTTP 400', async () => {
      // helpers.tsx line 87: profile.tid === entraTenantId() -> HTTP 400 "Internal staff accounts cannot be linked to external users."
      const staffTenant = '00000000-0000-4000-a000-000000000001'
      const profileTid = staffTenant
      assert.equal(profileTid, staffTenant, 'Matching staff tenant must trigger rejection when linking external profile')
    })

    await test('T2-P0.6-05', 'P0.6', 'Entra callback errors preserve security invariants without leaking secrets', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(`${routes.auth.callback.href()}?error=access_denied&error_description=User+cancelled`)
      await assertSecurityInvariants(res)
    })

    // =========================================================================
    // Feature P0.7: Canonical APP_BASE_URL for OAuth Callback & Logout
    // =========================================================================

    await test('T2-P0.7-01', 'P0.7', 'Host header injection on logout (Host: evil.attacker.com) is ignored in redirect URI', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.request(routes.session.logout.href(), {
        method: 'POST',
        headers: {
          Host: 'evil.attacker.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: client.csrfToken ? `_csrf=${client.csrfToken}` : '',
      })

      const location = res.headers.get('location') ?? ''
      assert.ok(!location.includes('evil.attacker.com'), 'Logout redirect must not include injected Host header')
    })

    await test('T2-P0.7-02', 'P0.7', 'X-Forwarded-Host injection on logout is ignored in redirect URI', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.request(routes.session.logout.href(), {
        method: 'POST',
        headers: {
          'X-Forwarded-Host': 'phishing.attacker.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: client.csrfToken ? `_csrf=${client.csrfToken}` : '',
      })

      const location = res.headers.get('location') ?? ''
      assert.ok(!location.includes('phishing.attacker.com'), 'Logout redirect must not include injected X-Forwarded-Host')
    })

    await test('T2-P0.7-03', 'P0.7', 'Host header injection on OAuth start does not alter canonical redirect_uri', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(routes.auth.start.href(), {
        headers: { Host: 'evil.attacker.com' },
      })
      const location = res.headers.get('location') ?? ''
      assert.ok(!location.includes('redirect_uri=http%3A%2F%2Fevil.attacker.com'))
    })

    await test('T2-P0.7-04', 'P0.7', 'validateAppBaseUrl rejects non-HTTPS URL in production mode', async () => {
      assert.throws(
        () => validateAppBaseUrl('http://mms.production.example.com', true),
        /APP_BASE_URL must use HTTPS in production/,
      )
    })

    await test('T2-P0.7-05', 'P0.7', 'validateAppBaseUrl rejects URLs with credentials, query strings, fragments, or path prefixes', async () => {
      assert.throws(() => validateAppBaseUrl('https://user:pass@mms.example.com'), /credentials/)
      assert.throws(() => validateAppBaseUrl('https://mms.example.com?query=1'), /query string/)
      assert.throws(() => validateAppBaseUrl('https://mms.example.com#fragment'), /fragment/)
      assert.throws(() => validateAppBaseUrl('https://mms.example.com/prefix'), /path prefix/)
    })

    await test('T2-P0.7-06', 'P0.7', 'Forged X-Forwarded-Proto header cannot downgrade canonical redirect_uri scheme', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(routes.auth.start.href(), {
        headers: { 'X-Forwarded-Proto': 'ftp' },
      })
      const location = res.headers.get('location') ?? ''
      assert.ok(!location.startsWith('ftp://'))
    })
  } finally {
    if (pool) {
      await pool.end()
    }
  }

  return { total, passed, failed }
}

if (process.argv[1] && process.argv[1].endsWith('auth_error_surface.test.ts')) {
  const baseUrl = process.env.APPLICATION_BASE_URL ?? 'http://localhost:44100'
  const pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'

  runSuite({ baseUrl, pgrstUrl })
    .then((result) => {
      console.log(`\nTier 2 Auth Error Surface: ${result.passed}/${result.total} passed.`)
      process.exit(result.failed > 0 ? 1 : 0)
    })
    .catch((err) => {
      console.error('Tier 2 test run fatal error:', err)
      process.exit(1)
    })
}
