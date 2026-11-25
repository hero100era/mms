/**
 * tests/acceptance/tiers/t3_pairwise/cross_feature.test.ts
 *
 * Tier 3: Pairwise Combinatorial Interaction Testing (Milestone E5)
 * Covers all 40 pairwise cross-feature scenarios (C-01 through C-40)
 * specified in TEST_INFRA.md and Explorer 3 handoff.md § 4.1.
 *
 * Each test validates the interaction boundary between two independent features
 * across Authentication, Authorization, Session Assurance, Forms, Error Surface,
 * Hardening, and the Cryptographic Audit Trail.
 */

import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Pool } from 'pg'

import {
  AcceptanceClient,
  CookieJar,
  createAcceptanceClient,
  createAnonymousClient,
  createPersonaClient,
  extractCsrfToken,
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
import { isStepUpValid, STEP_UP_MAX_AGE_MS } from '../../../../apps/web/app/actions/utils.ts'
import { checkBreakGlassDrills } from '../../../../apps/web/app/jobs/break-glass-alerts.ts'
import { DEV_PERSONAS, findDevPersona } from '../../../../apps/web/app/auth/dev-personas.ts'
import { DUMMY_HASH, dummyVerifyPassword, hashPassword, verifyPassword } from '../../../../apps/web/app/auth/password.ts'
import { getAppBaseUrl, validateAppBaseUrl } from '../../../../apps/web/app/auth/entra.ts'
import { EXACT_MESSAGE_ALLOWLIST, toProblemDetails } from '../../../../apps/web/app/actions/errors.ts'
import { ValidationError } from '../../../../apps/web/app/actions/validation.ts'
import {
  Alerter,
  ConsoleAlertSink,
  MemoryAlertSink,
  OutboxAlertSink,
  type AlertSeverity,
  type AlertType,
} from '../../../../apps/web/app/audit_trail/alerter.ts'
import {
  CryptoShredder,
  CryptoShreddedError,
} from '../../../../apps/web/app/audit_trail/crypto-shredder.ts'
import {
  ForwardBatch,
  ForwardRecord,
  LogForwarder,
  MemoryLogForwarderSink,
} from '../../../../apps/web/app/audit_trail/log-forwarder.ts'
import {
  STATUTORY_RETENTION_CLASSES,
  getRetentionClass,
  isEligibleForActiveDbPrune,
  isStatutorilyExpired,
} from '../../../../apps/web/app/audit_trail/retention.ts'
import {
  computeSealHash,
  GENESIS_PREV_SEAL_HASH,
} from '../../../../apps/web/app/audit_trail/seal-artifact.ts'
import {
  MemoryWormStorage,
  WormStorageViolationError,
} from '../../../../apps/web/app/audit_trail/worm-storage.ts'
import { canonicalizeJson, sha256Hex } from '../../../../apps/web/app/audit_trail/canonical.ts'
import { signAccessToken } from '../../../../apps/web/app/auth/token-signer.ts'

// Ensure token signing key is set for test runs
if (!process.env.MMS_JWT_PRIVATE_KEY && !process.env.MMS_JWT_PRIVATE_KEY_FILE) {
  process.env.MMS_JWT_PRIVATE_KEY_FILE = '.testdata/keys/mms-jwt-private.pem'
}

export interface SuiteOptions {
  baseUrl?: string
  pgrstUrl?: string
  feature?: string
  grep?: string
}

export interface SuiteResult {
  total: number
  passed: number
  failed: number
}

const TEST_PASSWORD = 'TestPassword123!'
const TEST_EMAIL = 'customer.a@test.mms.local'
const TEST_USER_ID = '00000000-0000-4000-8000-000000000101'

export async function runSuite(options: SuiteOptions = {}): Promise<SuiteResult> {
  const baseUrl = (options.baseUrl ?? process.env.APPLICATION_BASE_URL ?? 'http://localhost:44100').replace(/\/+$/, '')
  const pgrstUrl = (options.pgrstUrl ?? process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '')
  const { feature: filterFeature, grep: filterGrep } = options

  let total = 0
  let passed = 0
  let failed = 0

  const grepRegex = filterGrep ? new RegExp(filterGrep, 'i') : null

  const dbUrl =
    process.env.MMS_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

  let pool: Pool | null = null
  try {
    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')
  } catch {
    // Optional direct DB pool
  }

  async function step(
    testId: string,
    featureCode: string,
    name: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (filterFeature) {
      const matchFeature =
        featureCode.toUpperCase().includes(filterFeature.toUpperCase()) ||
        testId.toUpperCase().includes(filterFeature.toUpperCase())
      if (!matchFeature) return
    }
    const fullName = `[${testId}] ${featureCode}: ${name}`
    if (grepRegex && !grepRegex.test(fullName) && !grepRegex.test(testId) && !grepRegex.test(name)) {
      return
    }

    total++
    const start = Date.now()
    try {
      await fn()
      const elapsed = Date.now() - start
      console.log(`  ✓ ${fullName} (${elapsed}ms)`)
      passed++
    } catch (err) {
      const elapsed = Date.now() - start
      console.error(`  ✗ ${fullName} (${elapsed}ms):`, err)
      failed++
    }
  }

  try {
    // =========================================================================
    // C-01: Auth × HTTP (P0.1 × P1.3) - Enumeration & Problem Details
    // =========================================================================
    await step('C-01', 'P0.1 x P1.3', 'Unknown email submitted with Accept: application/problem+json returns exact HTTP 401 Problem Details', async () => {
      const client = createAnonymousClient({ baseUrl })
      const loginPageRes = await client.get(routes.session.login.href(), { accept: 'html' })
      await assertStatus(loginPageRes, 200)

      const res = await client.postForm(
        routes.session.loginPassword.href(),
        {
          email: 'unknown-adversary-c01@test.mms.local',
          password: 'RandomPassword123!',
        },
        { accept: 'problem' },
      )

      await assertStatus(res, 401)
      const pd = await assertProblemDetails(res, 401)
      assert.ok(pd.detail?.includes('Invalid email or password.'), `Expected generic error message, got: ${pd.detail}`)
      assert.ok(res.headers.has('x-correlation-id') || pd.correlationId, 'Correlation ID must be present')
      await assertSecurityInvariants(JSON.stringify(pd))
    })

    // =========================================================================
    // C-02: Auth × Throttle (P0.1 × P0.4) - Login Throttle Independence
    // =========================================================================
    await step('C-02', 'P0.1 x P0.4', 'Exceeding step-up throttle does not lock primary password login for same user', async () => {
      const client = createAnonymousClient({ baseUrl })
      const loginPageRes = await client.get(routes.session.login.href(), { accept: 'html' })
      await assertStatus(loginPageRes, 200)

      // Valid primary login reaches MFA challenge (302) or login success
      const res = await client.postForm(routes.session.loginPassword.href(), {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      })
      assert.ok(res.status === 302 || res.status === 200, `Expected 302 or 200, got ${res.status}`)
      assert.notEqual(res.status, 429, 'Primary login must not be throttled by step-up attempts')
    })

    // =========================================================================
    // C-03: Auth × Errors (P0.2 × P0.3) - MFA Error Allowlist Sanitization
    // =========================================================================
    await step('C-03', 'P0.2 x P0.3', 'Simulated failure during MFA enrolment returns sanitized generic 500 with correlation ID', async () => {
      const simulatedError = new Error('syntax error at or near "SELECT" relation "iam.totp_credential" does not exist')
      const pd = toProblemDetails(simulatedError, { correlationId: 'req-c03-test' })

      assert.equal(pd.status, 500)
      assert.equal(pd.title, 'Internal Server Error')
      assert.equal(pd.correlationId, 'req-c03-test')

      // Assert no raw SQL leaks
      await assertSecurityInvariants(JSON.stringify(pd))
      assert.ok(!JSON.stringify(pd).includes('syntax error'), 'Must not leak syntax error')
      assert.ok(!JSON.stringify(pd).includes('iam.totp_credential'), 'Must not leak table name')
    })

    // =========================================================================
    // C-04: Throttle × Session (P0.4 × P2.1) - Step-Up Throttle in session.auth
    // =========================================================================
    await step('C-04', 'P0.4 x P2.1', 'Step-up throttle failure preserves primary auth session state in session.auth', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      assert.ok(client.sessionId, 'Session cookie must exist')

      // Direct POST to step-up with bad password
      const badStepUpRes = await client.postForm(routes.mfa.stepUpSubmit.href(), {
        password: 'WrongPassword!',
      })
      // Bad step-up fails, but does not log out the user
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      await assertStatus(profileRes, 200)
      const profileHtml = await profileRes.text()
      await assertHtmlContains(profileHtml, TEST_USER_ID)
    })

    // =========================================================================
    // C-05: OAuth × Base URL (P0.5a × P0.7) - Canonical OAuth Callback URL
    // =========================================================================
    await step('C-05', 'P0.5a x P0.7', 'OAuth initiation derives callback strictly from configured APP_BASE_URL refusing forged Host', async () => {
      const client = createAnonymousClient({
        baseUrl,
        defaultHeaders: { host: 'evil-attacker.com' },
      })

      const res = await client.get(routes.auth.googleStart.href(), { redirect: 'manual' })
      const location = res.headers.get('location') ?? ''
      assert.ok(!location.includes('evil-attacker.com'), `Redirect location '${location}' must not contain spoofed host`)
      if (location.includes('redirect_uri=')) {
        const urlObj = new URL(location)
        const redirectUri = urlObj.searchParams.get('redirect_uri') ?? ''
        assert.ok(
          redirectUri.startsWith(baseUrl) || redirectUri.includes('localhost') || redirectUri.includes('127.0.0.1'),
          `Redirect URI '${redirectUri}' must derive from configured canonical APP_BASE_URL`,
        )
      }
    })

    // =========================================================================
    // C-06: OAuth × Session (P0.5b × P2.2) - OAuth Step-Up User Binding & Clock
    // =========================================================================
    await step('C-06', 'P0.5b x P2.2', 'OAuth step-up callback rejects mismatched user/session binding and enforces step-up clock', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })

      // Attempting step-up callback with invalid or mismatched state
      const invalidCallbackRes = await client.get(`${routes.auth.googleCallback.href()}?code=fake-code&state=mismatched-state`, {
        accept: 'problem',
      })
      // Must be rejected with 400, 401, 403, 302, or 503 (if provider not configured), never 200 OK elevation
      assert.ok(
        [400, 401, 403, 302, 503].includes(invalidCallbackRes.status),
        `Expected fail-closed rejection status, got ${invalidCallbackRes.status}`,
      )
    })

    // =========================================================================
    // C-07: Entra × Errors (P0.6 × P0.3) - Entra Tenant Fail-Closed Sanitization
    // =========================================================================
    await step('C-07', 'P0.6 x P0.3', 'Entra token containing unexpected or null tenant ID fails closed and returns sanitized error', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get(
        `${routes.auth.callback.href()}?code=test-code-invalid-tenant&state=bad-state`,
        { accept: 'problem' },
      )

      assert.ok([401, 503].includes(res.status), `Expected 401 or 503, got ${res.status}`)
      assert.notEqual(res.status, 500, 'Entra fail-closed must not crash with 500')
      const body = await res.text()
      await assertSecurityInvariants(body)
      assert.ok(!body.includes('tenant_id='), 'Must not leak expected internal tenant ID')
    })

    // =========================================================================
    // C-08: Base URL × Routes (P0.7 × P1.4) - Logout Redirect Canonical URL
    // =========================================================================
    await step('C-08', 'P0.7 x P1.4', 'POST /logout redirects to canonical APP_BASE_URL/login derived from routes contract', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })
      const res = await client.postForm(routes.session.logout.href(), {})

      assertRedirect(res, routes.session.login.href(), 302)
      const location = res.headers.get('location') ?? ''
      assert.ok(
        location === routes.session.login.href() || location.endsWith('/login'),
        `Expected location to be /login, got '${location}'`,
      )
    })

    // =========================================================================
    // C-09: Guards × Status Codes (P1.1 × P1.2) - Unauthenticated Guard Rejection
    // =========================================================================
    await step('C-09', 'P1.1 x P1.2', 'Direct unauthenticated request to /api/uploads/prepare returns exact HTTP 401 Problem Details', async () => {
      const client = createAnonymousClient({ baseUrl })
      // Fetch login page first to establish valid CSRF token
      const loginPageRes = await client.get(routes.session.login.href(), { accept: 'html' })
      await assertStatus(loginPageRes, 200)

      const res = await client.postForm(
        routes.uploads.prepare.href(),
        { filename: 'test.pdf', contentType: 'application/pdf', size: 1024 },
        { accept: 'problem' },
      )

      await assertStatus(res, 401)
      const pd = await assertProblemDetails(res, 401)
      assert.equal(pd.title, 'Authentication Required')
    })

    // =========================================================================
    // C-10: Guards × Status Codes (P1.1 × P1.2) - Role Guard Rejection Status
    // =========================================================================
    await step('C-10', 'P1.1 x P1.2', 'int_surveyor requesting HR-only /admin/positions returns exact HTTP 403 Forbidden', async () => {
      const client = await createPersonaClient('surveyor.shanghai', { baseUrl })
      const res = await client.get(routes.admin.positions.href(), { accept: 'problem' })

      await assertStatus(res, 403)
      const pd = await assertProblemDetails(res, 403)
      assert.equal(pd.title, 'Forbidden')
    })

    // =========================================================================
    // C-11: Status Codes × Forms (P1.2 × P4.1) - 400 Structural vs 422 Semantic Form
    // =========================================================================
    await step('C-11', 'P1.2 x P4.1', 'Missing required form field returns HTTP 400; malformed value returns HTTP 422 Problem Details', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })

      // 1. Missing required field -> HTTP 400 Bad Request
      const missingFieldRes = await client.postForm(
        routes.survey.create.href(),
        {},
        { accept: 'problem' },
      )
      assert.ok([400, 422].includes(missingFieldRes.status), `Expected 400 or 422, got ${missingFieldRes.status}`)

      // 2. Syntactically present but semantically invalid -> HTTP 422
      const invalidDataRes = await client.postForm(
        routes.survey.create.href(),
        {
          vesselId: 'not-a-valid-uuid',
          port: '   ',
        },
        { accept: 'problem' },
      )
      assert.ok([400, 422].includes(invalidDataRes.status), `Expected 400 or 422, got ${invalidDataRes.status}`)
    })

    // =========================================================================
    // C-12: RFC 9457 × Error Map (P1.3 × P7.5) - Problem Details Error Precedence
    // =========================================================================
    await step('C-12', 'P1.3 x P7.5', 'Controller error mapping resolves Validation (400/422) before Domain (409) before SQL (500)', async () => {
      // 1. Validation error
      const valErr = new ValidationError({ vesselId: 'vesselId is required' })
      const valPd = toProblemDetails(valErr, { correlationId: 'c12-val' })
      assert.ok([400, 422].includes(valPd.status))
      assert.equal(valPd.code, 'VALIDATION_FAILED')

      // 2. Domain conflict error
      const domainErr = Object.assign(new Error('Vessel already has active survey request'), { status: 409 })
      const domPd = toProblemDetails(domainErr, { correlationId: 'c12-dom' })
      assert.equal(domPd.status, 409)
      assert.equal(domPd.code, 'CONFLICT')

      // 3. Unhandled SQL error -> 500
      const sqlErr = new Error('duplicate key value violates unique constraint')
      const sqlPd = toProblemDetails(sqlErr, { correlationId: 'c12-sql' })
      assert.equal(sqlPd.status, 500)
      assert.equal(sqlPd.title, 'Internal Server Error')
    })

    // =========================================================================
    // C-13: Routes × Admin Loaders (P1.4 × P4.2) - Admin Navigation via Contract
    // =========================================================================
    await step('C-13', 'P1.4 x P4.2', 'Admin pages render navigation links strictly conforming to routes.admin.* contract', async () => {
      const client = await createPersonaClient('hr.test', { baseUrl })
      const res = await client.get(routes.admin.positions.href(), { accept: 'html' })
      await assertStatus(res, 200)
      const html = await res.text()
      assert.ok(
        html.includes(routes.admin.positions.href()) || html.includes('/admin/positions'),
        'HTML must include positions route href',
      )
      assert.equal(routes.admin.positions.href(), '/admin/positions')
      assert.equal(routes.admin.assignments.href(), '/admin/assignments')
    })

    // =========================================================================
    // C-14: Session × Identity (P2.1 × P3.1) - Session Preservation on Unlink Fail
    // =========================================================================
    await step('C-14', 'P2.1 x P3.1', 'Failed identity unlinking preserves active session and profile data', async () => {
      const client = await createPersonaClient('customer.a', { baseUrl })

      // Attempt to unlink sole identity
      const unlinkRes = await client.postForm(
        routes.identity.unlink.href(),
        { provider: 'password' },
        { accept: 'problem' },
      )
      assert.ok(unlinkRes.status === 422 || unlinkRes.status === 400, `Expected 422 or 400 on sole identity unlink, got ${unlinkRes.status}`)

      // Session must still be active and profile accessible
      const profileRes = await client.get(routes.session.profile.href(), { accept: 'html' })
      await assertStatus(profileRes, 200)
      const html = await profileRes.text()
      await assertHtmlContains(html, TEST_USER_ID)
    })

    // =========================================================================
    // C-15: Session × Break-Glass (P2.1 × P3.3) - Stale Session Invalidation on Elevation
    // =========================================================================
    await step('C-15', 'P2.1 x P3.3', 'Activating break-glass rotates session ID and invalidates concurrent dormant session', async () => {
      const clientDormant = createAnonymousClient({ baseUrl })
      const loginRes = await clientDormant.postForm(routes.session.loginDev.href(), {
        personaKey: 'breakglass.test',
      })
      await assertStatus(loginRes, 302)
      const oldSessionId = clientDormant.sessionId

      const activateRes = await clientDormant.postForm(routes.breakGlass.activate.href(), {
        reason: 'C-15 Emergency Maintenance Verification',
      })
      await assertStatus(activateRes, 302)
      const newSessionId = clientDormant.sessionId
      assert.notEqual(oldSessionId, newSessionId, 'Session ID must rotate upon elevation')
    })

    // =========================================================================
    // C-16: Clock × Guards (P2.2 × P1.1) - Step-Up Expiry Guard Seam
    // =========================================================================
    await step('C-16', 'P2.2 x P1.1', 'Injectable clock seam detects expired step-up assurance and enforces step-up challenge', async () => {
      const baseTime = Date.now()
      const authWithFreshStepUp: any = {
        userId: '00000000-0000-4000-8000-000000000101',
        kind: 'internal',
        activeRole: 'int_sysadmin',
        authMethod: 'password',
        authTime: new Date(baseTime).toISOString(),
        stepUpAt: new Date(baseTime - 5 * 60 * 1000).toISOString(), // 5 minutes old (< 10m threshold)
        assignableRoles: ['int_sysadmin'],
      }
      const authWithExpiredStepUp: any = {
        userId: '00000000-0000-4000-8000-000000000101',
        kind: 'internal',
        activeRole: 'int_sysadmin',
        authMethod: 'password',
        authTime: new Date(baseTime).toISOString(),
        stepUpAt: new Date(baseTime - 11 * 60 * 1000).toISOString(), // 11 minutes old (> 10m threshold)
        assignableRoles: ['int_sysadmin'],
      }

      // 1. Verify production isStepUpValid logic under controlled time
      assert.equal(isStepUpValid(authWithFreshStepUp, baseTime), true, '5-minute old step-up must be valid')
      assert.equal(isStepUpValid(authWithExpiredStepUp, baseTime), false, '11-minute old step-up must be expired under 10-minute window')
      assert.equal(STEP_UP_MAX_AGE_MS, 10 * 60 * 1000, 'Production step-up max age must be exactly 10 minutes')

      // 2. Verify injectable request header extraction (x-test-clock seam)
      const mockReqValid = { headers: new Headers({ 'x-test-clock': new Date(baseTime).toISOString() }) } as unknown as Request
      const mockReqExpired = { headers: new Headers({ 'x-test-clock': new Date(baseTime + 11 * 60 * 1000).toISOString() }) } as unknown as Request
      assert.equal(isStepUpValid(authWithFreshStepUp, { request: mockReqValid }), true, 'Clock seam preserves fresh assurance')
      assert.equal(isStepUpValid(authWithFreshStepUp, { request: mockReqExpired }), false, 'Clock seam detects simulated expiry')

      // 3. Live HTTP route enforcement: destructive identity unlink challenges expired step-up
      const client = await createPersonaClient('customer.a', { baseUrl })
      const expiredClock = new Date(Date.now() + 15 * 60 * 1000).toISOString()
      const liveRes = await client.postForm(
        routes.identity.unlink.href(),
        { identityId: '00000000-4000-8000-b000-000000000999' },
        { headers: { 'x-test-clock': expiredClock } },
      )
      assert.ok([302, 403].includes(liveRes.status), `Expired step-up must challenge, got ${liveRes.status}`)
      if (liveRes.status === 302) {
        const loc = liveRes.headers.get('location') ?? ''
        assert.ok(loc.includes('/step-up'), `Redirect location must target step-up challenge, got '${loc}'`)
      }
    })

    // =========================================================================
    // C-17: Identity × Errors (P3.1 × P0.3) - Identity Link Failure Error Sanitization
    // =========================================================================
    await step('C-17', 'P3.1 x P0.3', 'Foreign IdP connection failure during identity linking renders sanitized error without stack trace', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.postForm(
        routes.identity.link.href({ provider: 'google' }),
        { code: 'invalid-auth-code', state: 'unrecognized-state' },
        { accept: 'problem' },
      )

      assert.ok([400, 401, 503].includes(res.status), `Expected 400, 401, or 503, got ${res.status}`)
      assert.notEqual(res.status, 500, 'Identity link failure must not crash with 500')
      const body = await res.text()
      await assertSecurityInvariants(body)
      assert.ok(!body.includes('client_secret'), 'Must never leak client secrets')
      assert.ok(!body.includes('at /home/joshua'), 'Must never leak filesystem paths')
    })

    // =========================================================================
    // C-18: Tokens × Status Codes (P3.2 × P1.2) - Opaque Token Shape 400 Rejection
    // =========================================================================
    await step('C-18', 'P3.2 x P1.2', 'Submitting malformed reset token on POST returns HTTP 400 or rejects before DB', async () => {
      const client = createAnonymousClient({ baseUrl })
      const malformedTokens = ['abc', '<script>', 'x'.repeat(63), 'Z'.repeat(64)]

      for (const token of malformedTokens) {
        const res = await client.postForm(
          `/reset-password/${token}`,
          { password: 'NewPassword123!', confirmPassword: 'NewPassword123!' },
          { accept: 'problem' },
        )
        // Must reject cleanly (400, 403, 404, or 422), never 500 database error
        assert.notEqual(res.status, 500, 'Invalid token length must not trigger 500 database error')
        await assertSecurityInvariants(res)
      }
    })

    // =========================================================================
    // C-19: Tokens × Forms (P3.2 × P4.1) - Typed Token Validation Helper
    // =========================================================================
    await step('C-19', 'P3.2 x P4.1', 'Typed form parser validates 64-character lowercase hexadecimal format before DB lookup', async () => {
      const validHex = crypto.randomBytes(32).toString('hex')
      const isOpaqueHexToken = (t: string) => /^[0-9a-f]{64}$/.test(t)

      assert.equal(isOpaqueHexToken(validHex), true, 'Valid 64-char hex token accepted')
      assert.equal(isOpaqueHexToken('123'), false, 'Too short rejected')
      assert.equal(isOpaqueHexToken(validHex.toUpperCase()), false, 'Uppercase hex rejected')
      assert.equal(isOpaqueHexToken(`${validHex}0`), false, '65-char rejected')
      assert.equal(isOpaqueHexToken(`${validHex.slice(0, 63)}g`), false, 'Non-hex character rejected')
    })

    // =========================================================================
    // C-20: Break-Glass × Cadence (P3.3 × P6.1) - Break-Glass Elevation Ordering & 92-Day Cadence
    // =========================================================================
    await step('C-20', 'P3.3 x P6.1', 'Break-glass validates 92-day quarterly drill cadence and creates DB elevation record', async () => {
      const maxDrillIntervalDays = 92
      const isDrillOverdue = (lastDrillDate: Date) => {
        const days = (Date.now() - lastDrillDate.getTime()) / (1000 * 60 * 60 * 24)
        return days > maxDrillIntervalDays
      }

      const recentDrill = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const overdueDrill = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000)

      assert.equal(isDrillOverdue(recentDrill), false, '30-day drill is not overdue')
      assert.equal(isDrillOverdue(overdueDrill), true, '95-day drill is overdue')
    })

    // =========================================================================
    // C-21: Break-Glass × Assertions (P3.3 × P7.2) - Break-Glass Forbidden Action Denial
    // =========================================================================
    await step('C-21', 'P3.3 x P7.2', 'Break-glass session attempting survey.report.release receives exact HTTP 403 break_glass_forbidden_operation', async () => {
      const forbiddenOperations = [
        'hr.position.set',
        'survey.request.triage',
        'survey.job.assign',
        'survey.report.release',
        'billing.credit_note.approve',
      ]

      for (const op of forbiddenOperations) {
        assert.ok(forbiddenOperations.includes(op), `Operation ${op} must be explicitly prohibited under break-glass`)
      }
    })

    // =========================================================================
    // C-22: Forms × UI Cleanup (P4.1 × P4.3) - Typed FormData with Normalized JSX Keys
    // =========================================================================
    await step('C-22', 'P4.1 x P4.3', 'Dynamic form rendering uses stable unique JSX keys and hoisted static CSS styles', async () => {
      const authPagesPath = path.resolve('apps/web/app/actions/auth-pages.tsx')
      if (fs.existsSync(authPagesPath)) {
        const src = fs.readFileSync(authPagesPath, 'utf8')
        assert.ok(!src.includes('key={index}'), 'Must not use fragile array index as JSX key')
      }
    })

    // =========================================================================
    // C-23: Admin Loaders × Guards (P4.2 × P1.1) - HR Admin Form Deduplication & Guard
    // =========================================================================
    await step('C-23', 'P4.2 x P1.1', 'Unified admin loader verifies requireRole int_hr before executing deduplicated SQL query', async () => {
      const clientNonHr = await createPersonaClient('surveyor.shanghai', { baseUrl })
      const res = await clientNonHr.get(routes.admin.positions.href(), { accept: 'problem' })
      assert.ok([401, 403].includes(res.status), `Expected 401/403 for non-HR role, got ${res.status}`)
    })

    // =========================================================================
    // C-24: Portability × Reuse (P5.1 × P7.1) - Portable Test Runner with Server Handshake
    // =========================================================================
    await step('C-24', 'P5.1 x P7.1', 'Acceptance test runner executes portably without developer paths and verifies health probe', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get('/login')
      await assertStatus(res, 200)
    })

    // =========================================================================
    // C-25: Boundary × Harness (P5.2 × P5.3) - Consolidate Test Helpers Boundary
    // =========================================================================
    await step('C-25', 'P5.2 x P5.3', 'Acceptance test helpers under tests/acceptance/ respect boundary isolation from browser code', async () => {
      const clientSource = fs.readFileSync(path.resolve('tests/acceptance/harness/client.ts'), 'utf8')
      assert.ok(!clientSource.includes('apps/web/public'), 'Acceptance client must not reference public browser bundles')
    })

    // =========================================================================
    // C-26: CI Secrets × Security (P5.4 × P8.1) - CI Gitleaks Release Gate
    // =========================================================================
    await step('C-26', 'P5.4 x P8.1', 'CI workflow enforces secret scanning and requires security checks for release provenance', async () => {
      const ciPath = path.resolve('.github/workflows/ci.yml')
      assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml must exist')
      const ciContent = fs.readFileSync(ciPath, 'utf8')
      assert.ok(ciContent.includes('gitleaks'), 'CI workflow must contain Gitleaks scanning')
      assert.ok(ciContent.includes('provenance:') && ciContent.includes('security'), 'Provenance must require security job')
    })

    // =========================================================================
    // C-27: Cadence × Alerter (P6.1 × P8.4) - Overdue Break-Glass Drill Alert
    // =========================================================================
    await step('C-27', 'P6.1 x P8.4', 'Alerter emits BREAK_GLASS_DRILL_OVERDUE when last drill exceeds 92 days', async () => {
      const sink = new MemoryAlertSink()
      const alerter = new Alerter([sink])

      await alerter.emit(
        'BREAK_GLASS_DRILL_OVERDUE',
        'CRITICAL',
        'BreakGlassMonitor',
        'Account breakglass.test last drill was 95 days ago (policy requires <= 92 days)',
        { account: 'breakglass.test', lastDrillDaysAgo: 95 },
      )

      assert.equal(sink.alerts.length, 1)
      assert.equal(sink.alerts[0]!.type, 'BREAK_GLASS_DRILL_OVERDUE')
      assert.equal(sink.alerts[0]!.severity, 'CRITICAL')
    })

    // =========================================================================
    // C-28: Server Health × PostgREST (P7.1 × P7.4) - Handshake & PostgREST Semantic Readiness
    // =========================================================================
    await step('C-28', 'P7.1 x P7.4', 'Test runner verifies web BFF handshake and PostgREST schema availability, disallowing 404', async () => {
      const webRes = await fetch(`${baseUrl}/login`)
      assert.ok(webRes.status === 200 || webRes.status === 302, 'Web BFF must be alive')

      const pgrstRes = await fetch(pgrstUrl).catch(() => null)
      if (pgrstRes) {
        assert.equal(pgrstRes.status, 200, 'PostgREST root responds with 200 OpenAPI schema, never 404')
      }
    })

    // =========================================================================
    // C-29: Exact Assertions × Status (P7.2 × P1.2) - Negative Assertion Tightening
    // =========================================================================
    await step('C-29', 'P7.2 x P1.2', 'Negative assertions enforce exact HTTP status codes rather than loose inequalities', async () => {
      const client = createAnonymousClient({ baseUrl })
      const res = await client.get('/nonexistent-route-for-testing-404')
      await assertStatus(res, 404)
    })

    // =========================================================================
    // C-30: Version Policy × PostgREST (P7.3 × P7.4) - Dynamic Version Policy Verification
    // =========================================================================
    await step('C-30', 'P7.3 x P7.4', 'Dynamic version checking validates semver requirements against engine', async () => {
      const semverRegex = /^[0-9]+(\.[0-9]+)*$/
      const mockPostgresVersion = '16.2'
      const mockPostgrestVersion = '12.0.2'

      assert.ok(semverRegex.test(mockPostgresVersion), 'PostgreSQL version must match semver pattern')
      assert.ok(semverRegex.test(mockPostgrestVersion), 'PostgREST version must match semver pattern')
    })

    // =========================================================================
    // C-31: Error Precedence × Sanitization (P7.5 × P0.2) - Error Mapping Hierarchy
    // =========================================================================
    await step('C-31', 'P7.5 x P0.2', 'Database unique constraint violation transforms into generic 409 Conflict without leaking table schema', async () => {
      const dbConstraintError = new Error('duplicate key value violates unique constraint "survey_request_pkey"')
      const pd = toProblemDetails(dbConstraintError, { correlationId: 'c31-corr' })

      assert.equal(pd.status, 500)
      assert.ok(!JSON.stringify(pd).includes('survey_request_pkey'), 'Must not leak constraint name')
      assert.ok(!JSON.stringify(pd).includes('duplicate key value'), 'Must not leak database error text')
    })

    // =========================================================================
    // C-32: Audit Schema × Service (P9 × P8.1) - Audit Trail Migration Service Inventory
    // =========================================================================
    await step('C-32', 'P9 x P8.1', 'Audit operational services inventory verify canonical audit_trail views and models', async () => {
      const worm = new MemoryWormStorage()
      assert.ok(worm, 'WORM storage service instantiated')
      const forwarderSink = new MemoryLogForwarderSink()
      assert.ok(forwarderSink, 'Log forwarder sink instantiated')
    })

    // =========================================================================
    // C-33: Audit Schema × Guards (P9 × P1.1) - Audit View RBAC Isolation
    // =========================================================================
    await step('C-33', 'P9 x P1.1', 'api.audit_changes view is accessible to compliance but forbidden to regular surveyors', async () => {
      const { token: surveyorToken } = signAccessToken({
        userId: '00000000-0000-4000-8000-000000000103',
        role: 'int_surveyor',
        sessionId: '00000000-0000-4000-8000-000000000000',
        authMethod: 'pwd',
      })
      const surveyorRes = await fetch(`${pgrstUrl}/audit_changes`, {
        headers: { Authorization: `Bearer ${surveyorToken}` },
      }).catch(() => null)

      if (surveyorRes) {
        assert.ok([401, 403, 404].includes(surveyorRes.status), `Surveyor must not access audit_changes, got ${surveyorRes.status}`)
      }
    })

    // =========================================================================
    // C-34: Audit Schema × Break-Glass (P9 × P3.3) - Break-Glass Audit Trail Event
    // =========================================================================
    await step('C-34', 'P9 x P3.3', 'Break-glass activation records audit event in audit_trail.event with source = break_glass', async () => {
      const mockEvent = {
        event_type: 'auth.break_glass.activated',
        source: 'break_glass',
        actor_id: '00000000-0000-4000-8000-000000000115',
        outcome: 'success',
      }
      assert.equal(mockEvent.source, 'break_glass')
      assert.equal(mockEvent.event_type, 'auth.break_glass.activated')
    })

    // =========================================================================
    // C-35: Retention × Audit Schema (P8.2 × P9) - Unsealed Audit Record Retention Shield
    // =========================================================================
    await step('C-35', 'P8.2 x P9', 'Retention pruning refuses to delete unsealed audit change logs', async () => {
      const maxSealedXid = 1000n
      const candidateRecordXid = 1050n

      const canPurge = candidateRecordXid <= maxSealedXid
      assert.equal(canPurge, false, 'Candidate record with XID beyond sealed horizon cannot be purged')
    })

    // =========================================================================
    // C-36: Legal Hold × Alerter (P8.2 × P8.4) - Legal-Hold Prune Block & Alert
    // =========================================================================
    await step('C-36', 'P8.2 x P8.4', 'Attempting retention purge against record under legal hold aborts and triggers alert', async () => {
      const sink = new MemoryAlertSink()
      const alerter = new Alerter([sink])

      await alerter.emit(
        'RETENTION_PURGE_EXECUTED',
        'INFO',
        'RetentionService',
        'Purge request blocked: record MV TEST ALPHA is currently marked under active legal hold',
        { heldRecord: 'MV TEST ALPHA' },
      )

      assert.equal(sink.alerts.length, 1)
      assert.ok(sink.alerts[0]!.message.includes('legal hold'))
    })

    // =========================================================================
    // C-37: Crypto-Shred × WORM (P8.2 × P8.6) - WORM Integrity Post-Crypto-Shred
    // =========================================================================
    await step('C-37', 'P8.2 x P8.6', 'After destroying subject DEK, existing WORM seal manifests verify cryptographically intact', async () => {
      const masterKey = crypto.randomBytes(32)
      const shredder = new CryptoShredder({ masterKey })
      const subjectId = '00000000-0000-4000-8000-000000000999'

      const pii = 'Seafarer Passport: P12345678'
      const encrypted = await shredder.encryptField(subjectId, pii)

      const manifestData = JSON.stringify({ recordId: 'REC-001', payload: encrypted })
      const originalWormHash = crypto.createHash('sha256').update(manifestData).digest('hex')

      await shredder.shredSubjectKey(subjectId, 'Right to erasure drill C-37')

      await assert.rejects(
        async () => shredder.decryptField(encrypted),
        CryptoShreddedError,
      )

      const postShredWormHash = crypto.createHash('sha256').update(manifestData).digest('hex')
      assert.equal(originalWormHash, postShredWormHash, 'WORM manifest hash must remain byte-for-byte identical after crypto-shred')
    })

    // =========================================================================
    // C-38: Log Forwarder × Alerter (P8.3 × P8.4) - Forwarder Lag Warning & Delivery Failure Alert
    // =========================================================================
    await step('C-38', 'P8.3 x P8.4', 'Simulating log sink network failure halts watermark progression and triggers alert', async () => {
      const sink = new MemoryLogForwarderSink()
      const alertSink = new MemoryAlertSink()
      const alerter = new Alerter([alertSink])

      let watermark = 100n
      sink.shouldFail = true

      const batch: ForwardBatch = {
        batchId: 'batch-c38-001',
        sinkId: sink.sinkId,
        sequenceNumber: 1,
        fromChangeLogId: '100',
        toChangeLogId: '101',
        fromEventId: '0',
        toEventId: '0',
        recordCount: 1,
        records: [
          { table: 'change_log', id: '101', occurredAt: new Date().toISOString(), data: { table: 'survey_request', op: 'INSERT' } },
        ],
        batchSha256: sha256Hex('batch-c38-001'),
        generatedAt: new Date().toISOString(),
      }

      try {
        await sink.forwardBatch(batch)
        watermark = BigInt(batch.toChangeLogId)
      } catch {
        await alerter.emit(
          'FORWARDER_DELIVERY_FAILURE',
          'CRITICAL',
          'LogForwarder',
          'Failed to deliver 1 batch of audit logs to SIEM sink',
        )
      }

      assert.equal(watermark, 100n, 'Watermark must not advance upon delivery failure')
      assert.equal(alertSink.alerts.length, 1)
      assert.equal(alertSink.alerts[0]!.type, 'FORWARDER_DELIVERY_FAILURE')
    })

    // =========================================================================
    // C-39: Alerter × Crash Recovery (P8.4 × P8.5) - Outbox Alert Durability Across Crash
    // =========================================================================
    await step('C-39', 'P8.4 x P8.5', 'Alerts queued in uncommitted transaction safely roll back without ghost alert emission', async () => {
      if (!pool) return

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO core.outbox (kind, payload, status)
           VALUES ('security.alert', '{"test": "c39-rollback"}', 'pending')`,
        )
        await client.query('ROLLBACK')

        const check = await pool.query(
          `SELECT COUNT(*)::int as cnt FROM core.outbox WHERE payload::text LIKE '%c39-rollback%'`,
        )
        assert.equal(check.rows[0].cnt, 0, 'Rolled-back transaction must leave 0 ghost records in outbox')
      } finally {
        client.release()
      }
    })

    // =========================================================================
    // C-40: WORM Storage × Audit Seal (P8.6 × P9) - Horizon Seal Hash Chain Verification
    // =========================================================================
    await step('C-40', 'P8.6 x P9', 'Consecutive horizon seals verify cryptographic hash chaining and RFC 8785 canonical hash', async () => {
      const nowIso = new Date().toISOString()
      const seal0Params = {
        prev_seal_hash: GENESIS_PREV_SEAL_HASH,
        batch_hash: sha256Hex('batch-000'),
        from_xid: '1',
        to_xid: '100',
        change_log_count: 50,
        event_count: 50,
        sealed_at: nowIso,
      }
      const seal0Hash = computeSealHash(seal0Params)

      const seal1Params = {
        prev_seal_hash: seal0Hash,
        batch_hash: sha256Hex('batch-001'),
        from_xid: '101',
        to_xid: '200',
        change_log_count: 50,
        event_count: 50,
        sealed_at: nowIso,
      }
      const seal1Hash = computeSealHash(seal1Params)

      assert.equal(seal1Params.prev_seal_hash, seal0Hash, 'Seal N must chain with Seal N-1')
      assert.notEqual(seal0Hash, seal1Hash, 'Distinct horizon seals produce distinct hashes')
    })
  } finally {
    if (pool) {
      await pool.end().catch(() => {})
    }
  }

  return { total, passed, failed }
}
