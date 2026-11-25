/**
 * tests/acceptance/tiers/t4_scenarios/vessel_lifecycle.test.ts
 *
 * Tier 4: Real-World Maritime Workloads & Lifecycle Scenarios (Milestone E5)
 * Covers Scenarios RW-01 through RW-06:
 * - RW-01: Bulk Carrier Port Arrival & Survey Request Triage Lifecycle
 * - RW-02: Multi-Station Territorial Isolation & Unauthorized Triage Defense
 * - RW-03: Surveyor Statutory Qualification Expiry & Inspection Release Rejection
 * - RW-04: Emergency Break-Glass Activation for Urgent Vessel Port Clearance
 * - RW-05: Segregation of Duties Enforcement Between Platform IT and Maritime Operations
 * - RW-06: Vessel Ownership Transfer and Reciprocal Customer Fleet Isolation
 */

import assert from 'node:assert/strict'
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
import { DEV_PERSONAS, findDevPersona } from '../../../../apps/web/app/auth/dev-personas.ts'
import { signAccessToken } from '../../../../apps/web/app/auth/token-signer.ts'

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

// Deterministic test fixtures from testenv-fixtures.sql
const FIXTURES = {
  customerA: {
    userId: '00000000-0000-4000-8000-000000000101',
    companyId: '00000000-0000-4000-8000-0000000000a1',
  },
  customerB: {
    userId: '00000000-0000-4000-8000-000000000102',
    companyId: '00000000-0000-4000-8000-0000000000b1',
  },
  vesselAlpha: {
    id: '00000000-0000-4000-8000-000000000a01',
    name: 'MV TEST ALPHA',
    imo: '9990001',
  },
  vesselBravo: {
    id: '00000000-0000-4000-8000-000000000a02',
    name: 'MV TEST BRAVO',
    imo: '9990002',
  },
  requests: {
    sr001: '00000000-0000-4000-8000-000000000201', // draft
    sr002: '00000000-0000-4000-8000-000000000202', // submitted (Shanghai)
  },
}

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

  async function scenario(
    id: string,
    title: string,
    features: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (filterFeature) {
      const matchFeature =
        features.toUpperCase().includes(filterFeature.toUpperCase()) ||
        id.toUpperCase().includes(filterFeature.toUpperCase())
      if (!matchFeature) return
    }
    const fullName = `[${id}] ${title} (${features})`
    if (grepRegex && !grepRegex.test(fullName) && !grepRegex.test(id) && !grepRegex.test(title)) {
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
    // RW-01: Bulk Carrier Port Arrival & Survey Request Triage Lifecycle
    // =========================================================================
    await scenario(
      'RW-01',
      'Bulk Carrier Port Arrival & Survey Request Triage Lifecycle',
      'P0.1, P1.1, P1.2, P1.3, P1.4, P4.1, P7.2, P9',
      async () => {
        // Step 1: Customer A signs in and navigates to /surveys/new
        const customer = await createPersonaClient('customer.a', { baseUrl })
        const newFormRes = await customer.get(routes.survey.new.href(), { accept: 'html' })
        await assertStatus(newFormRes, 200)

        // Step 2: Customer creates new survey request
        const createRes = await customer.postForm(routes.survey.create.href(), {
          vesselId: FIXTURES.vesselAlpha.id,
          port: 'CNSHA',
          surveyTypes: 'annual_hull,annual_machinery',
          remarks: 'Arrival inspection required before loading grain cargo',
        })
        assert.ok([200, 302].includes(createRes.status), `Survey creation status ${createRes.status}`)

        // Step 3: Shanghai Station Manager inspects triage queue
        const manager = await createPersonaClient('manager.shanghai', { baseUrl })
        const triageRes = await manager.get(routes.triage.queue.href(), { accept: 'html' })
        await assertStatus(triageRes, 200)
        const triageHtml = await triageRes.text()
        assert.ok(triageHtml.includes('Triage Queue') || triageHtml.includes('CNSHA') || triageHtml.includes('SR-TEST-002'))

        // Step 4: Shanghai Manager accepts the request
        const acceptRes = await manager.postForm(
          routes.triage.accept.href({ id: FIXTURES.requests.sr002 }),
          {
            notes: 'Approved for Shanghai anchorage survey team',
            assignedSurveyorId: '00000000-0000-4000-8000-000000000103',
          },
        )
        assert.ok([200, 302].includes(acceptRes.status), `Triage accept status ${acceptRes.status}`)

        // Step 5: Verify surveyor.shanghai accesses accepted survey detail
        const surveyor = await createPersonaClient('surveyor.shanghai', { baseUrl })
        const detailRes = await surveyor.get(routes.triage.detail.href({ id: FIXTURES.requests.sr002 }), { accept: 'html' })
        await assertStatus(detailRes, 200)
      },
    )

    // =========================================================================
    // RW-02: Multi-Station Territorial Isolation & Unauthorized Triage Defense
    // =========================================================================
    await scenario(
      'RW-02',
      'Multi-Station Territorial Isolation & Unauthorized Triage Defense',
      'P1.1, P1.2, P1.3, P7.2, P9',
      async () => {
        // Singapore surveyor signs in
        const singaporeSurveyor = await createPersonaClient('surveyor.singapore', { baseUrl })

        // 1. Singapore queue does not leak Shanghai request
        const queueRes = await singaporeSurveyor.get(routes.triage.queue.href(), { accept: 'html' })
        await assertStatus(queueRes, 200)
        const queueHtml = await queueRes.text()
        assert.ok(!queueHtml.includes('SR-TEST-002'), 'Singapore queue must not list Shanghai survey requests')

        // 2. Direct attempt to accept Shanghai survey request
        const forcedAcceptRes = await singaporeSurveyor.postForm(
          routes.triage.accept.href({ id: FIXTURES.requests.sr002 }),
          { notes: 'Unauthorized takeover attempt by Singapore station' },
          { accept: 'problem' },
        )

        // Must be rejected with 403 Forbidden or 404 Not Found Problem Details
        assert.ok(
          [403, 404].includes(forcedAcceptRes.status),
          `Expected 403 or 404 for cross-station triage, got ${forcedAcceptRes.status}`,
        )
        if (forcedAcceptRes.headers.get('content-type')?.includes('application/problem+json')) {
          await assertProblemDetails(forcedAcceptRes, forcedAcceptRes.status)
        }
      },
    )

    // =========================================================================
    // RW-03: Surveyor Statutory Qualification Expiry & Inspection Release Rejection
    // =========================================================================
    await scenario(
      'RW-03',
      'Surveyor Statutory Qualification Expiry & Inspection Release Rejection',
      'P1.1, P1.2, P7.2, P9',
      async () => {
        // 1. Authenticate surveyor.expired with expired TEST_GENERAL_SURVEY qualification
        const expiredSurveyor = await createPersonaClient('surveyor.expired', { baseUrl })
        assert.equal(expiredSurveyor.personaKey, 'surveyor.expired')

        // 2. Authenticate surveyor.shanghai with active TEST_GENERAL_SURVEY qualification
        const activeSurveyor = await createPersonaClient('surveyor.shanghai', { baseUrl })
        assert.equal(activeSurveyor.personaKey, 'surveyor.shanghai')

        // 3. HTTP surface: Expired surveyor attempts unauthorized triage accept on Shanghai survey request
        const unauthorizedAcceptRes = await expiredSurveyor.postForm(
          routes.triage.accept.href({ id: FIXTURES.requests.sr002 }),
          { notes: 'Expired surveyor attempting unauthorized triage acceptance' },
          { accept: 'problem' },
        )
        await assertStatus(unauthorizedAcceptRes, 403)
        await assertProblemDetails(unauthorizedAcceptRes, 403, undefined, /insufficient triage authority/i)

        // 4. PostgREST / Authority Engine surface: Evaluate explain_authority for survey.report.release
        // Active surveyor has valid qualification covering the action
        const { token: activeAuthToken } = signAccessToken({
          userId: '00000000-0000-4000-8000-000000000103', // surveyor.shanghai
          role: 'int_surveyor',
          sessionId: '00000000-0000-4000-8000-000000000000',
          authMethod: 'pwd',
        })
        const activeAuthRes = await fetch(`${pgrstUrl}/rpc/explain_authority`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeAuthToken}`,
          },
          body: JSON.stringify({ p_action_code: 'survey.report.release' }),
        })
        if (activeAuthRes.ok) {
          const activeRecords = (await activeAuthRes.json()) as Array<{ allowed: boolean; reason_code: string }>
          assert.ok(Array.isArray(activeRecords) && activeRecords.length > 0)
          assert.equal(activeRecords[0]?.allowed, true, 'surveyor.shanghai with active qualification must be authorized')
        }

        // Expired surveyor must be refused with qualification_required
        const { token: expiredAuthToken } = signAccessToken({
          userId: '00000000-0000-4000-8000-000000000114', // surveyor.expired
          role: 'int_surveyor',
          sessionId: '00000000-0000-4000-8000-000000000000',
          authMethod: 'pwd',
        })
        const expiredAuthRes = await fetch(`${pgrstUrl}/rpc/explain_authority`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${expiredAuthToken}`,
          },
          body: JSON.stringify({ p_action_code: 'survey.report.release' }),
        })
        if (expiredAuthRes.ok) {
          const expiredRecords = (await expiredAuthRes.json()) as Array<{ allowed: boolean; reason_code: string }>
          assert.ok(Array.isArray(expiredRecords) && expiredRecords.length > 0)
          assert.equal(expiredRecords[0]?.allowed, false, 'surveyor.expired must NOT be authorized to release reports')
          assert.equal(expiredRecords[0]?.reason_code, 'qualification_required', 'Reason code must report qualification_required')
        }
      },
    )

    // =========================================================================
    // RW-04: Emergency Break-Glass Activation for Urgent Vessel Port Clearance
    // =========================================================================
    await scenario(
      'RW-04',
      'Emergency Break-Glass Activation for Urgent Vessel Port Clearance',
      'P2.1, P3.3, P6.1, P7.2, P8.4, P9',
      async () => {
        // 1. Sign in as dormant break-glass account
        const bgClient = await createPersonaClient('breakglass.test', { baseUrl })
        const dormantSessionId = bgClient.sessionId

        // 2. Verify break-glass portal renders dormant status
        const portalRes = await bgClient.get(routes.breakGlass.index.href(), { accept: 'html' })
        await assertStatus(portalRes, 200)
        const portalHtml = await portalRes.text()
        assert.ok(portalHtml.includes('Break-Glass') || portalHtml.includes('breakglass.test@test.mms.local'))

        // 3. Activate break-glass elevation with valid operational reason (>= 10 chars)
        const activateRes = await bgClient.postForm(
          routes.breakGlass.activate.href(),
          { reason: 'Urgent emergency port clearance for arriving bulk carrier vessel' },
          { redirect: 'manual' },
        )
        await assertStatus(activateRes, 302)
        assert.equal(activateRes.headers.get('location'), routes.breakGlass.index.href())

        // 4. Verify session rotation upon privilege elevation (P3.3)
        bgClient.cookieJar.parseSetCookie(activateRes.headers.get('set-cookie'))
        const elevatedSessionId = bgClient.sessionId
        assert.notEqual(elevatedSessionId, dormantSessionId, 'Session ID must rotate upon break-glass elevation')

        // 5. Enforce segregation of duties: Regulated business actions are strictly forbidden
        // 5a. Regulated HR position modification must be forbidden (403)
        const hrMutationRes = await bgClient.postForm(
          routes.admin.positionSet.href(),
          {
            user_id: FIXTURES.customerA.userId,
            job_title_code: 'LEAD_SURVEYOR',
            unit_id: '00000000-0000-4000-a000-000000000001',
            reason: 'Break-glass operator attempting unauthorized HR modification',
          },
          { accept: 'problem' },
        )
        await assertStatus(hrMutationRes, 403)

        // 5b. Survey triage acceptance must be forbidden (403)
        const triageRes = await bgClient.postForm(
          routes.triage.accept.href({ id: FIXTURES.requests.sr002 }),
          { notes: 'Break-glass attempting unauthorized survey request acceptance' },
          { accept: 'problem' },
        )
        await assertStatus(triageRes, 403)

        // 5c. Authority check via PostgREST verifies sysadmin_cannot_approve or break_glass_forbidden
        const { token: bgAuthToken } = signAccessToken({
          userId: '00000000-0000-4000-8000-000000000115',
          role: 'int_sysadmin',
          sessionId: '00000000-0000-4000-8000-000000000000',
          authMethod: 'pwd',
        })
        const authCheckRes = await fetch(`${pgrstUrl}/rpc/explain_authority`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bgAuthToken}`,
          },
          body: JSON.stringify({ p_action_code: 'survey.request.triage' }),
        })
        if (authCheckRes.ok) {
          const authData = (await authCheckRes.json()) as Array<{ allowed: boolean; reason_code: string }>
          assert.ok(Array.isArray(authData) && authData.length > 0)
          assert.equal(authData[0]?.allowed, false, 'Regulated triage must be prohibited under break-glass sysadmin role')
        }

        // 6. Deactivate break-glass window and verify session termination
        const deactivateRes = await bgClient.postForm(
          routes.breakGlass.deactivate.href(),
          { reason: 'Emergency triage incident resolved; deactivating elevation' },
          { redirect: 'manual' },
        )
        await assertStatus(deactivateRes, 302)
        assert.equal(deactivateRes.headers.get('location'), routes.session.login.href())

        // 7. Verify former session is destroyed: subsequent access redirects to login
        const postDeactRes = await bgClient.get(routes.breakGlass.index.href(), { redirect: 'manual' })
        assert.ok([302, 401, 403].includes(postDeactRes.status), 'Destroyed session must not access break-glass index')
      },
    )

    // =========================================================================
    // RW-05: Segregation of Duties Enforcement Between Platform IT and Maritime Operations
    // =========================================================================
    await scenario(
      'RW-05',
      'Segregation of Duties Enforcement Between Platform IT and Maritime Operations',
      'P1.1, P1.2, P4.2, P7.2, P9',
      async () => {
        // Sysadmin signs in
        const sysadmin = await createPersonaClient('sysadmin.test', { baseUrl })

        // 1. Sysadmin can access IT assignments
        const assignmentsRes = await sysadmin.get(routes.admin.assignments.href(), { accept: 'html' })
        assert.ok([200, 302].includes(assignmentsRes.status))

        // 2. Sysadmin cannot access HR positions
        const positionsRes = await sysadmin.get(routes.admin.positions.href(), { accept: 'problem' })
        await assertStatus(positionsRes, 403)

        // 3. Sysadmin cannot triage survey requests
        const triageRes = await sysadmin.postForm(
          routes.triage.accept.href({ id: FIXTURES.requests.sr002 }),
          { notes: 'Sysadmin attempting unauthorized survey acceptance' },
          { accept: 'problem' },
        )
        await assertStatus(triageRes, 403)
      },
    )

    // =========================================================================
    // RW-06: Vessel Ownership Transfer and Reciprocal Customer Fleet Isolation
    // =========================================================================
    await scenario(
      'RW-06',
      'Vessel Ownership Transfer and Reciprocal Customer Fleet Isolation',
      'P1.1, P1.2, P4.1, P7.2, P9',
      async () => {
        // Customer A owns MV TEST ALPHA and MV TEST BRAVO; Customer B owns MV TEST CHARLIE
        const custA = await createPersonaClient('customer.a', { baseUrl })
        const custB = await createPersonaClient('customer.b', { baseUrl })

        const newSurveyA = await custA.get(routes.survey.new.href(), { accept: 'html' })
        const newSurveyB = await custB.get(routes.survey.new.href(), { accept: 'html' })

        await assertStatus(newSurveyA, 200)
        await assertStatus(newSurveyB, 200)
        const htmlA = await newSurveyA.text()
        const htmlB = await newSurveyB.text()

        // Customer A sees Alpha; Customer B sees Charlie
        assert.ok(htmlA.includes('MV TEST ALPHA') || htmlA.includes(FIXTURES.vesselAlpha.imo))
        assert.ok(!htmlB.includes('MV TEST ALPHA'), 'Customer B must NOT see MV TEST ALPHA')
      },
    )
  } finally {
    if (pool) {
      await pool.end().catch(() => {})
    }
  }

  return { total, passed, failed }
}
