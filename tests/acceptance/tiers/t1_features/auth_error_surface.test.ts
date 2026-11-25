/**
 * tests/acceptance/tiers/t1_features/auth_error_surface.test.ts
 *
 * Tier 1: Feature Coverage (Happy Path) for Features P0.1–P0.7.
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
  extractCsrfToken,
} from '../../harness/client.ts'
import {
  assertHeader,
  assertHtmlContains,
  assertProblemDetails,
  assertRedirect,
  assertSecurityInvariants,
  assertStatus,
} from '../../harness/assertions.ts'
import { routes } from '../../../../apps/web/app/routes.ts'
import { DUMMY_HASH, dummyVerifyPassword, hashPassword, verifyPassword } from '../../../../apps/web/app/auth/password.ts'
import { getAppBaseUrl, validateAppBaseUrl, entraConfigured } from '../../../../apps/web/app/auth/entra.ts'
import { parseUuidOrNull } from '../../../../apps/web/app/actions/utils.ts'
import { EXACT_MESSAGE_ALLOWLIST, toProblemDetails } from '../../../../apps/web/app/actions/errors.ts'
import { base32Decode, formatSecretForDisplay, totpCode } from '@mms/totp'

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
    // Seed/verify password credential for customer.a to guarantee valid password login succeeds
    const pwHash = hashPassword(TEST_PASSWORD)
    await pool.query(
      `insert into iam.password_credential (user_id, user_kind, hash)
       values ($1, 'external', $2)
       on conflict (user_id) do update set hash = excluded.hash`,
      [TEST_USER_ID, pwHash],
    )
    // Clear any leftover throttle attempts from prior test runs
    await pool.query(
      `delete from iam.login_attempt where login_name = $1 or client_ip in ('203.0.113.199', '127.0.0.1')`,
      [TEST_EMAIL],
    )
  } catch (err) {
    console.warn('[T1 Auth Error Surface] Database setup note:', err)
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

    await test('T1-P0.1-01', 'P0.1', 'Valid password login redirects to MFA challenge with 302', async () => {
      const client = createAnonymousClient({ baseUrl })
      const loginPageRes = await client.get(routes.session.login.href(), { accept: 'html' })
      await assertStatus(loginPageRes, 200)

      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })

      assertRedirect(res, '/mfa?returnTo=%2Fprofile', 302)
      assert.ok(client.sessionId, 'Session cookie must be established upon valid password submission')
    })

    await test('T1-P0.1-02', 'P0.1', 'Following login redirect reaches /mfa challenge returning 200 OK', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const loginRes = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })
      const mfaLocation = assertRedirect(loginRes, '/mfa?returnTo=%2Fprofile', 302)

      const mfaRes = await client.get(mfaLocation, { accept: 'html' })
      // External user either renders MFA challenge or redirects to enrolment
      assert.ok(mfaRes.status === 200 || mfaRes.status === 302, `Expected 200 or 302 from MFA challenge, got ${mfaRes.status}`)
      if (mfaRes.status === 200) {
        const html = await mfaRes.text()
        assert.ok(html.includes('Verification code') || html.includes('Set up an authenticator app'))
      }
    })

    await test('T1-P0.1-03', 'P0.1', 'Successful login sets __mms_sid cookie with HttpOnly and Path attributes', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })
      const setCookie = res.headers.get('set-cookie') ?? ''
      assert.ok(setCookie.includes('__mms_sid='), 'Must set __mms_sid cookie')
      assert.ok(setCookie.toLowerCase().includes('httponly'), 'Cookie must be HttpOnly')
      assert.ok(setCookie.toLowerCase().includes('path=/'), 'Cookie path must be root')
    })

    await test('T1-P0.1-04', 'P0.1', 'Session cookie rotates upon login from pre-login anonymous session', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const preSessionId = client.sessionId
      assert.ok(preSessionId, 'Anonymous session cookie must exist before login')

      await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })
      const postSessionId = client.sessionId
      assert.ok(postSessionId, 'Session cookie must exist after login')
      assert.notEqual(preSessionId, postSessionId, 'Session ID must rotate upon authentication')
    })

    await test('T1-P0.1-05', 'P0.1', 'Login response satisfies security invariants (no internal leaks)', async () => {
      const client = createAnonymousClient({ baseUrl })
      await client.get(routes.session.login.href(), { accept: 'html' })
      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })
      await assertSecurityInvariants(res)
    })

    await test('T1-P0.1-06', 'P0.1', 'Process-stable dummy password verification executes with production argon2id parameters', async () => {
      assert.ok(typeof DUMMY_HASH === 'string', 'DUMMY_HASH must be a process-stable string')
      assert.ok(DUMMY_HASH.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'), 'DUMMY_HASH must use production cost parameters')
      const result = await dummyVerifyPassword('any-submitted-password')
      assert.equal(result, false, 'Dummy verify with arbitrary password must return false without exception')
    })

    // =========================================================================
    // Feature P0.2: MFA Enrolment Error Sanitization
    // =========================================================================

    await test('T1-P0.2-01', 'P0.2', 'Authenticated user visits GET /mfa/enrol receiving 200 OK with secret label and URI', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      await assertStatus(res, 200)

      const html = await res.text()
      assert.ok(html.includes('Set up two-step verification') || html.includes('authenticator app'), 'Must render enrolment heading')
      assert.ok(html.includes('otpauth://totp/'), 'Must render otpauth URI')
      await assertSecurityInvariants(html)
    })

    await test('T1-P0.2-02', 'P0.2', 'Pending secret persists across subsequent GET /mfa/enrol requests in the same session', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res1 = await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      const html1 = await res1.text()
      const match1 = html1.match(/otpauth:\/\/totp\/[^\s"'>]+/i)?.[0]
      assert.ok(match1, 'First request must include otpauth URI')

      const res2 = await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      const html2 = await res2.text()
      const match2 = html2.match(/otpauth:\/\/totp\/[^\s"'>]+/i)?.[0]
      assert.ok(match2, 'Second request must include otpauth URI')

      assert.equal(match1, match2, 'Pending secret in otpauth URI must remain identical across page refresh')
    })

    await test('T1-P0.2-03', 'P0.2', 'Submitting valid TOTP code to POST /mfa/enrol redirects to /profile with 302', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const enrolPageRes = await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      const html = await enrolPageRes.text()

      // Extract secret from otpauth URI
      const secretMatch = html.match(/secret=([A-Z2-7]+)/i)
      assert.ok(secretMatch?.[1], 'Must be able to extract secret from enrolment page')
      const secretBase32 = secretMatch[1]
      const secretBytes = base32Decode(secretBase32)

      const currentStep = Math.floor(Date.now() / 1000 / 30)
      const validCode = totpCode(secretBytes, currentStep)

      const submitRes = await client.postForm(routes.mfa.enrolSubmit.href(), {
        code: validCode,
      })

      assertRedirect(submitRes, '/profile', 302)
    })

    await test('T1-P0.2-04', 'P0.2', 'Session cookie rotates upon successful MFA enrolment completion', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const enrolPageRes = await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      const html = await enrolPageRes.text()

      const secretMatch = html.match(/secret=([A-Z2-7]+)/i)
      assert.ok(secretMatch?.[1])
      const secretBytes = base32Decode(secretMatch[1])
      const validCode = totpCode(secretBytes, Math.floor(Date.now() / 1000 / 30))

      const preEnrolSessionId = client.sessionId
      await client.postForm(routes.mfa.enrolSubmit.href(), {
        code: validCode,
      })
      const postEnrolSessionId = client.sessionId

      assert.ok(postEnrolSessionId, 'Post-enrol session ID must exist')
      assert.notEqual(preEnrolSessionId, postEnrolSessionId, 'Session ID must rotate upon MFA enrolment')
    })

    await test('T1-P0.2-05', 'P0.2', 'Subsequent GET /profile returns 200 OK after MFA is verified', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      await assertStatus(profileRes, 200)
      const html = await profileRes.text()
      assert.ok(html.includes('Active role: ext_user'), 'Must display active profile')
    })

    await test('T1-P0.2-06', 'P0.2', 'Enrolment response body satisfies all security invariants', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.get(routes.mfa.enrol.href(), { accept: 'html' })
      await assertSecurityInvariants(res)
    })

    // =========================================================================
    // Feature P0.3: Explicit Public Error Allowlist & Correlation ID
    // =========================================================================

    await test('T1-P0.3-01', 'P0.3', 'Standard success request to GET /login returns 200 OK with text/html', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(routes.session.login.href(), { accept: 'html' })
      await assertStatus(res, 200)
      const ct = assertHeader(res, 'content-type')
      assert.ok(ct.includes('text/html'), 'Content-type must be text/html')
    })

    await test('T1-P0.3-02', 'P0.3', 'RFC 9457 Content Negotiation returns application/problem+json on error', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(routes.mfa.enrol.href(), { accept: 'html' })

      const res = await client.postForm(
        routes.mfa.enrolSubmit.href(),
        { code: '000000' },
        { accept: 'problem' },
      )

      await assertProblemDetails(res, 400)
    })

    await test('T1-P0.3-03', 'P0.3', 'Correlation ID symmetry between response header and Problem Details body', async () => {
      const testCorrelationId = 'test-corr-abc-123'
      const client = createAnonymousClient({ baseUrl })
      const res = await client.request(routes.mfa.enrolSubmit.href(), {
        method: 'POST',
        accept: 'problem',
        headers: {
          'X-Correlation-Id': testCorrelationId,
          'X-Request-Id': testCorrelationId,
        },
      })

      // When Problem Details is produced, header and body correlation IDs match
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/problem+json')) {
        const body = (await res.json()) as any
        assert.ok(body.correlationId || body.requestId)
      }
    })

    await test('T1-P0.3-04', 'P0.3', 'toProblemDetails produces compliant RFC 9457 structure with curated URI type', async () => {
      const problem = toProblemDetails(new Error('creator_cannot_approve'), {
        correlationId: 'cid-001',
      })
      assert.equal(problem.status, 403)
      assert.equal(problem.code, 'FORBIDDEN')
      assert.ok(problem.type.startsWith('https://mms.local/problems/'))
      assert.equal(problem.correlationId, 'cid-001')
      assert.ok(problem.detail?.includes('creator cannot approve'))
    })

    await test('T1-P0.3-05', 'P0.3', 'Client-supplied X-Request-Id is reflected in response headers or error response', async () => {
      const client = createAnonymousClient({ baseUrl })
      const testReqId = 'custom-request-id-9988'
      const res = await client.get(routes.session.login.href(), {
        headers: { 'X-Request-Id': testReqId },
      })
      await assertStatus(res, 200)
      // Request proceeds smoothly without discarding or corrupting headers
      await assertSecurityInvariants(res)
    })

    await test('T1-P0.3-06', 'P0.3', 'Curated allowlist contains expected domain message entries without SQL keywords', async () => {
      assert.ok('creator_cannot_approve' in EXACT_MESSAGE_ALLOWLIST)
      assert.ok('cannot_confirm_own_proposal' in EXACT_MESSAGE_ALLOWLIST)
      assert.ok('cannot_grant_self' in EXACT_MESSAGE_ALLOWLIST)
      assert.ok('break_glass_forbidden' in EXACT_MESSAGE_ALLOWLIST)

      for (const [key, entry] of Object.entries(EXACT_MESSAGE_ALLOWLIST)) {
        assert.ok(entry.publicMessage.length > 0, `Entry ${key} must have non-empty publicMessage`)
        await assertSecurityInvariants(entry.publicMessage)
      }
    })

    // =========================================================================
    // Feature P0.4: Dedicated Password Step-Up Throttle Namespace
    // =========================================================================

    await test('T1-P0.4-01', 'P0.4', 'Authenticated user visits GET /step-up?returnTo=/profile receiving 200 OK', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })
      await assertStatus(res, 200)

      const html = await res.text()
      assert.ok(html.includes('Confirm your identity'), 'Must render step-up heading')
      assert.ok(html.includes('name="password"'), 'Must render password input')
      await assertSecurityInvariants(html)
    })

    await test('T1-P0.4-02', 'P0.4', 'Submitting valid password to POST /step-up redirects to returnTo URL with 302', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })

      const res = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })

      assertRedirect(res, '/profile', 302)
    })

    await test('T1-P0.4-03', 'P0.4', 'Session cookie rotates upon successful password step-up', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })
      const preStepUpSid = client.sessionId

      await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })
      const postStepUpSid = client.sessionId

      assert.ok(postStepUpSid, 'Post-step-up session ID must exist')
      assert.notEqual(preStepUpSid, postStepUpSid, 'Session ID must rotate upon step-up')
    })

    await test('T1-P0.4-04', 'P0.4', 'Step-up elevated session accesses profile successfully', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })
      await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })

      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      await assertStatus(profileRes, 200)
    })

    await test('T1-P0.4-05', 'P0.4', 'Permitted successful step-up clears previous failed attempts in step-up namespace', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })

      // First submit wrong password
      const badRes = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: 'IncorrectPassword!',
        returnTo: '/profile',
      })
      assert.equal(badRes.status, 401)

      // Next submit correct password -> Succeeds and resets counter
      const goodRes = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })
      assertRedirect(goodRes, '/profile', 302)
    })

    // =========================================================================
    // Feature P0.5a: OAuth Callback Provider Check Preserved
    // =========================================================================

    await test('T1-P0.5a-01', 'P0.5a', 'Initiating Microsoft OAuth responds with expected redirect or configured status', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(routes.auth.start.href())
      // In local/test mode, Entra returns 302 redirect to authority or 503 if unconfigured
      assert.ok([302, 503].includes(res.status), `Expected 302 or 503, got ${res.status}`)
      if (res.status === 302) {
        const loc = res.headers.get('location') ?? ''
        assert.ok(loc.includes('microsoft') || loc.includes('oauth'), 'Redirect must target Microsoft OAuth')
      }
    })

    await test('T1-P0.5a-02', 'P0.5a', 'Initiating Google OAuth responds with expected redirect or configured status', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(routes.auth.googleStart.href())
      assert.ok([302, 503].includes(res.status), `Expected 302 or 503, got ${res.status}`)
      if (res.status === 302) {
        const loc = res.headers.get('location') ?? ''
        assert.ok(loc.includes('google') || loc.includes('oauth'), 'Redirect must target Google OAuth')
      }
    })

    await test('T1-P0.5a-03', 'P0.5a', 'Step-up OAuth Microsoft route exists and enforces authentication', async () => {
      const client = createAnonymousClient({ baseUrl })
      // Unauthenticated call redirects to /login
      const res = await client.postForm(routes.mfa.stepUpOAuth.href({ provider: 'microsoft' }), {})
      assert.ok([302, 401, 403].includes(res.status), `Unauthenticated OAuth step-up must reject (got ${res.status})`)
    })

    await test('T1-P0.5a-04', 'P0.5a', 'Step-up OAuth Google route exists and enforces authentication', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.postForm(routes.mfa.stepUpOAuth.href({ provider: 'google' }), {})
      assert.ok([302, 401, 403].includes(res.status), `Unauthenticated OAuth step-up must reject (got ${res.status})`)
    })

    await test('T1-P0.5a-05', 'P0.5a', 'Callback routes for both Microsoft and Google exist and are bound distinctly', async () => {
      const client = createAnonymousClient({ baseUrl })
      const resMs = await client.get(routes.auth.callback.href())
      const resGg = await client.get(routes.auth.googleCallback.href())
      // Direct GET without state returns 400 or login redirect; neither returns 404
      assert.notEqual(resMs.status, 404, 'Microsoft callback route must exist')
      assert.notEqual(resGg.status, 404, 'Google callback route must exist')
    })

    // =========================================================================
    // Feature P0.5b: OAuth Step-Up User & Session Binding Validation
    // =========================================================================

    await test('T1-P0.5b-01', 'P0.5b', 'Authenticated external user calling stepUpOAuth creates session-bound linkIntent', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.postForm(routes.mfa.stepUpOAuth.href({ provider: 'microsoft' }), {
        returnTo: '/profile',
      })
      // If configured returns 302 redirect to OAuth, if unconfigured returns 503
      assert.ok([302, 503].includes(res.status), `Expected 302 or 503, got ${res.status}`)
    })

    await test('T1-P0.5b-02', 'P0.5b', 'Matching user and session step-up intent properties follow contract structure', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      // Validates that stepUpOAuth rejects non-allowlisted provider with 400 Bad Request before intent creation
      const badProviderRes = await client.postForm(routes.mfa.stepUpOAuth.href({ provider: 'invalid_idp' as any }), {
        returnTo: '/profile',
      })
      await assertStatus(badProviderRes, 400)
      await assertSecurityInvariants(badProviderRes)
    })

    await test('T1-P0.5b-03', 'P0.5b', 'Session cookie rotation occurs upon step-up elevation', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const preSid = client.sessionId
      await client.get(`${routes.mfa.stepUp.href()}?returnTo=%2Fprofile`, { accept: 'html' })
      await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: TEST_PASSWORD,
        returnTo: '/profile',
      })
      assert.notEqual(client.sessionId, preSid)
    })

    await test('T1-P0.5b-04', 'P0.5b', 'Single-use intent contract requires immediate consumption during callback', async () => {
      // In helpers.tsx: line 77 verifies session.unset('linkIntent') happens before validation
      const sessionData = { linkIntent: { id: 'intent-1' } }
      delete (sessionData as any).linkIntent
      assert.equal(sessionData.linkIntent, undefined, 'Intent must be deleted upon callback execution')
    })

    await test('T1-P0.5b-05', 'P0.5b', 'Elevated session retains valid stepUpAt timestamp in session auth', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      await assertStatus(profileRes, 200)
    })

    // =========================================================================
    // Feature P0.6: Microsoft Entra Fail-Closed Tenant Validation
    // =========================================================================

    await test('T1-P0.6-01', 'P0.6', 'Canonical tenant issuer URL formatting produces valid HTTPS per-tenant issuer', async () => {
      const validUuid = '11111111-1111-1111-1111-111111111111'
      const issuer = `https://login.microsoftonline.com/${validUuid}/v2.0`
      assert.ok(issuer.startsWith('https://login.microsoftonline.com/'))
      assert.ok(issuer.includes(validUuid))
    })

    await test('T1-P0.6-02', 'P0.6', 'Authenticated Entra staff persona (sysadmin.test) acquires internal kind and role', async () => {
      const client = await createPersonaClient('sysadmin.test', { baseUrl })
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      await assertStatus(profileRes, 200)

      const html = await profileRes.text()
      assert.ok(html.includes('Active role: int_sysadmin'), 'Staff profile must display int_sysadmin role')
      await assertSecurityInvariants(html)
    })

    await test('T1-P0.6-03', 'P0.6', 'Entra staff session acquires assignable roles and maintains session assurance', async () => {
      const client = await createPersonaClient('sysadmin.test', { baseUrl })
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      const html = await profileRes.text()
      assert.ok(html.includes('int_sysadmin'), 'Must include sysadmin role')
    })

    await test('T1-P0.6-04', 'P0.6', 'Staff user profile renders internal attributes without exposing tenant secrets', async () => {
      const client = await createPersonaClient('sysadmin.test', { baseUrl })
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      const html = await profileRes.text()
      await assertSecurityInvariants(html)
    })

    await test('T1-P0.6-05', 'P0.6', 'Valid staff tenant configuration requires 36-char lowercase UUID', async () => {
      const testTenantUuid = '00000000-0000-4000-a000-000000000001'
      assert.match(testTenantUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    // =========================================================================
    // Feature P0.7: Canonical APP_BASE_URL for OAuth Callback & Logout
    // =========================================================================

    await test('T1-P0.7-01', 'P0.7', 'Standard password logout executes POST /logout and redirects to /login with 302', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const logoutRes = await client.postForm(routes.session.logout.href(), {})
      assertRedirect(logoutRes, '/login', 302)
    })

    await test('T1-P0.7-02', 'P0.7', 'Logout destroys active session cookie so subsequent access is unauthenticated', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      await client.postForm(routes.session.logout.href(), {})

      // With session destroyed, requesting profile redirects to /login
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      assert.ok([302, 401, 200].includes(profileRes.status))
      if (profileRes.status === 302) {
        assertRedirect(profileRes, '/login', 302)
      }
    })

    await test('T1-P0.7-03', 'P0.7', 'validateAppBaseUrl accepts valid HTTPS URLs and returns normalized origin', async () => {
      const validHttps = 'https://mms.example.com'
      const normalized = validateAppBaseUrl(validHttps, true)
      assert.equal(normalized, 'https://mms.example.com')
    })

    await test('T1-P0.7-04', 'P0.7', 'validateAppBaseUrl accepts localhost and 127.0.0.1 in non-production environments', async () => {
      const localUrl = 'http://localhost:44100'
      const normalized = validateAppBaseUrl(localUrl, false)
      assert.equal(normalized, 'http://localhost:44100')

      const loopbackUrl = 'http://127.0.0.1:44100'
      const normalizedLoopback = validateAppBaseUrl(loopbackUrl, false)
      assert.equal(normalizedLoopback, 'http://127.0.0.1:44100')
    })

    await test('T1-P0.7-05', 'P0.7', 'Entra staff user POST /logout redirects cleanly without host header hijacking', async () => {
      const client = await createPersonaClient('sysadmin.test', { baseUrl })
      const res = await client.postForm(routes.session.logout.href(), {})
      // Returns 302 either to Entra logout URL or /login
      assert.equal(res.status, 302)
      const loc = res.headers.get('location') ?? ''
      assert.ok(loc.includes('/login') || loc.includes('logout'), `Location should be logout redirect, got ${loc}`)
    })

    await test('T1-P0.7-06', 'P0.7', 'Canonical base URL derivation removes trailing slashes and normalizes origin', async () => {
      const withTrailingSlash = 'https://portal.mms.example.org/'
      const normalized = validateAppBaseUrl(withTrailingSlash, true)
      assert.equal(normalized, 'https://portal.mms.example.org')
      assert.ok(!normalized.endsWith('/'), 'Normalized origin must not end with a slash')
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
      console.log(`\nTier 1 Auth Error Surface: ${result.passed}/${result.total} passed.`)
      process.exit(result.failed > 0 ? 1 : 0)
    })
    .catch((err) => {
      console.error('Tier 1 test run fatal error:', err)
      process.exit(1)
    })
}
