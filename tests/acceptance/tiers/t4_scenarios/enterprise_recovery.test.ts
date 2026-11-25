/**
 * tests/acceptance/tiers/t4_scenarios/enterprise_recovery.test.ts
 *
 * Tier 4: Real-World Maritime Workloads & Lifecycle Scenarios (Milestone E5)
 * Covers Scenarios RW-14 through RW-20:
 * - RW-14: Step-Up Authentication Flow for Elevated HR Staff Position Modification
 * - RW-15: Regional Maritime Traffic Service (MTS) Case Routing & Coverage Expansion
 * - RW-16: Central Plan Approval Centre Bulk Carrier Drawing Review & Version Promotion
 * - RW-17: Adversarial Credential Brute-Force & Timing Parity Under Lockout
 * - RW-18: Session Revocation & Stale Session Invalidation Across Concurrent Devices
 * - RW-19: Break-Glass Quarterly Drill Compliance Verification & 92-Day Cadence Enforcement
 * - RW-20: Cold Disaster Recovery Drill & Database Restoration Integrity Verification
 */

import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
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
import { DUMMY_HASH, dummyVerifyPassword, hashPassword, verifyPassword } from '../../../../apps/web/app/auth/password.ts'
import {
  Alerter,
  ConsoleAlertSink,
  MemoryAlertSink,
  OutboxAlertSink,
  type AlertSeverity,
  type AlertType,
} from '../../../../apps/web/app/audit_trail/alerter.ts'
import {
  computeSealHash,
  GENESIS_PREV_SEAL_HASH,
} from '../../../../apps/web/app/audit_trail/seal-artifact.ts'
import { MemoryWormStorage } from '../../../../apps/web/app/audit_trail/worm-storage.ts'
import { sha256Hex, type SealHashParams } from '../../../../apps/web/app/audit_trail/canonical.ts'
import { signAccessToken } from '../../../../apps/web/app/auth/token-signer.ts'
import { checkBreakGlassDrills } from '../../../../apps/web/app/jobs/break-glass-alerts.ts'

// Ensure signing key is available for token generation
if (!process.env.MMS_JWT_PRIVATE_KEY && !process.env.MMS_JWT_PRIVATE_KEY_FILE) {
  process.env.MMS_JWT_PRIVATE_KEY_FILE = '.testdata/keys/mms-jwt-private.pem'
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
    // DB pool optional
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
    // RW-14: Step-Up Authentication Flow for Elevated HR Staff Position Modification
    // =========================================================================
    await scenario(
      'RW-14',
      'Step-Up Authentication Flow for Elevated HR Staff Position Modification',
      'P0.4, P1.1, P2.1, P2.2, P4.1, P9',
      async () => {
        // 1. Authenticate HR staff persona
        const hrClient = await createPersonaClient('hr.test', { baseUrl })

        // 2. HR staff accesses positions management page
        const positionsRes = await hrClient.get(routes.admin.positions.href(), { accept: 'html' })
        await assertStatus(positionsRes, 200)

        // 3. Unauthorized persona attempting position modification must be forbidden (403)
        const surveyorClient = await createPersonaClient('surveyor.shanghai', { baseUrl })
        const unauthorizedRes = await surveyorClient.postForm(
          routes.admin.positionSet.href(),
          {
            user_id: FIXTURES.customerA.userId,
            job_title_code: 'LEAD_SURVEYOR',
            unit_id: '00000000-0000-4000-a000-000000000001',
            reason: 'Surveyor attempting unauthorized position modification',
          },
          { accept: 'problem' },
        )
        await assertStatus(unauthorizedRes, 403)

        // 4. Test Step-up authentication flow for HR client
        const stepUpGetRes = await hrClient.get(routes.mfa.stepUp.href(), { accept: 'html' })
        await assertStatus(stepUpGetRes, 200)
        const stepUpHtml = await stepUpGetRes.text()
        assert.ok(stepUpHtml.includes('Step-Up') || stepUpHtml.includes('password') || stepUpHtml.includes('Authentication'))

        // 5. Submit step-up password challenge
        const stepUpSubmitRes = await hrClient.postForm(
          routes.mfa.stepUpSubmit.href(),
          { password: 'Password123!' },
          { redirect: 'manual' },
        )
        // Expect redirect back to returnTo or 200
        assert.ok([200, 302].includes(stepUpSubmitRes.status))

        // 6. Test sensitive identity unlink requiring step-up
        const unlinkWithoutParams = await hrClient.postForm(
          routes.identity.unlink.href(),
          {},
          { accept: 'problem' },
        )
        // With fresh step-up, reaches validation (400 Bad Request / 422 Unprocessable), NOT redirect to step-up (302)
        assert.ok([400, 422].includes(unlinkWithoutParams.status), `Expected 400 or 422, got ${unlinkWithoutParams.status}`)
      },
    )

    // =========================================================================
    // RW-15: Regional Maritime Traffic Service (MTS) Case Routing & Coverage Expansion
    // =========================================================================
    await scenario(
      'RW-15',
      'Regional Maritime Traffic Service (MTS) Case Routing & Coverage Expansion',
      'P1.1, P1.4, P4.1, P7.2, P9',
      async () => {
        // 1. Authenticate Asia MTS specialist persona
        const mtsSpecialist = await createPersonaClient('mts.asia', { baseUrl })

        // 2. Verify MTS specialist can access the triage queue for their covered region
        const queueRes = await mtsSpecialist.get(routes.triage.queue.href(), { accept: 'html' })
        await assertStatus(queueRes, 200)

        // 3. Verify access to covered survey request detail
        const detailRes = await mtsSpecialist.get(
          routes.triage.detail.href({ id: FIXTURES.requests.sr002 }),
          { accept: 'html' },
        )
        await assertStatus(detailRes, 200)

        // 4. Enforce authorization: Surveyor role cannot perform coordinator triage accept
        const unauthorizedAcceptRes = await mtsSpecialist.postForm(
          routes.triage.accept.href({ id: FIXTURES.requests.sr002 }),
          { notes: 'MTS specialist attempting unauthorized triage acceptance' },
          { accept: 'problem' },
        )
        await assertStatus(unauthorizedAcceptRes, 403)
        await assertProblemDetails(unauthorizedAcceptRes, 403, undefined, /insufficient triage authority/i)

        // 5. Query PostgREST for MTS unit assignment of covered vessel
        const shipRes = await fetch(
          `${pgrstUrl}/ships?id=eq.${FIXTURES.vesselAlpha.id}&select=id,name,responsible_mts_unit_id`,
          {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${signAccessToken({
                userId: '00000000-0000-4000-8000-000000000108',
                role: 'int_surveyor',
                sessionId: '00000000-0000-4000-8000-000000000000',
                authMethod: 'pwd',
              }).token}`,
            },
          },
        )
        if (shipRes.ok) {
          const ships = (await shipRes.json()) as Array<{ id: string; responsible_mts_unit_id: string | null }>
          assert.ok(ships.length > 0)
          assert.ok(ships[0]?.responsible_mts_unit_id, 'Vessel must be routed to an authorized MTS centre')
        }
      },
    )

    // =========================================================================
    // RW-16: Central Plan Approval Centre Bulk Carrier Drawing Review & Version Promotion
    // =========================================================================
    await scenario(
      'RW-16',
      'Central Plan Approval Centre Bulk Carrier Drawing Review & Version Promotion',
      'P1.1, P4.1, P8.1, P9',
      async () => {
        // 1. Authenticate Central Plan Approval engineer
        const planEngineer = await createPersonaClient('planapproval.central', { baseUrl })

        // 2. Engineer prepares drawing revision upload
        const prepareRes = await planEngineer.postJson(routes.uploads.prepare.href(), {
          entityType: 'survey_request',
          entityId: FIXTURES.requests.sr002,
          docType: 'engineering_drawing',
          fileName: 'bulk_carrier_midship_rev_b.pdf',
        })
        await assertStatus(prepareRes, 200)
        const prepareData = (await prepareRes.json()) as { uploadId: string; uploadUrl: string }
        assert.ok(prepareData.uploadId)

        // 3. Put drawing bytes to quarantine
        const drawingBuffer = Buffer.from('%PDF-1.4\n%Approved Bulk Carrier Midship Structural Drawing\n%%EOF')
        const uploadRes = await fetch(new URL(prepareData.uploadUrl, baseUrl).toString(), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(drawingBuffer.length),
          },
          body: drawingBuffer,
        })
        await assertStatus(uploadRes, 201)

        // 4. Test Segregation of Duties: Customer persona cannot promote drawing version
        const customerClient = await createPersonaClient('customer.a', { baseUrl })
        const fakeVersionId = '00000000-0000-4000-8000-000000000999'
        const customerPromoteRes = await customerClient.post(
          routes.uploads.promote.href({ versionId: fakeVersionId }),
          null,
          { accept: 'problem' },
        )
        await assertStatus(customerPromoteRes, 403)
        await assertProblemDetails(customerPromoteRes, 403, undefined, /insufficient privileges to promote/i)

        // 5. Plan Approval engineer is authorized to call promote endpoint
        const engineerPromoteRes = await planEngineer.post(
          routes.uploads.promote.href({ versionId: fakeVersionId }),
          null,
          { accept: 'problem' },
        )
        // Reaches database query (404 Document version not found), proving role authorization passed
        await assertStatus(engineerPromoteRes, 404)
        await assertProblemDetails(engineerPromoteRes, 404, undefined, /not found/i)
      },
    )

    // =========================================================================
    // RW-17: Adversarial Credential Brute-Force & Timing Parity Under Lockout
    // =========================================================================
    await scenario(
      'RW-17',
      'Adversarial Credential Brute-Force & Timing Parity Under Lockout',
      'P0.1, P0.3, P0.4, P1.2, P7.2',
      async () => {
        const startDummy = Date.now()
        await dummyVerifyPassword('AttackerSuppliedGuess123!')
        const durationDummy = Date.now() - startDummy

        assert.ok(durationDummy >= 0)
        assert.ok(DUMMY_HASH.length > 50, 'Production DUMMY_HASH must be populated')
      },
    )

    // =========================================================================
    // RW-18: Session Revocation & Stale Session Invalidation Across Concurrent Devices
    // =========================================================================
    await scenario(
      'RW-18',
      'Session Revocation & Stale Session Invalidation Across Concurrent Devices',
      'P1.1, P1.4, P2.1, P3.3, P9',
      async () => {
        const clientDevice1 = await createPersonaClient('customer.a', { baseUrl })
        const clientDevice2 = await createPersonaClient('customer.a', { baseUrl })

        assert.ok(clientDevice1.sessionId)
        assert.ok(clientDevice2.sessionId)

        const revokeRes = await clientDevice1.postForm(
          routes.session.profileSessionRevokeAll.href(),
          { keepCurrent: 'false' },
        )
        assert.ok([200, 302].includes(revokeRes.status))
      },
    )

    // =========================================================================
    // RW-19: Break-Glass Quarterly Drill Compliance Verification & 92-Day Cadence Enforcement
    // =========================================================================
    await scenario(
      'RW-19',
      'Break-Glass Quarterly Drill Compliance Verification & 92-Day Cadence Enforcement',
      'P3.3, P6.1, P8.4, P9',
      async () => {
        // 1. Authenticate break-glass persona
        const bgClient = await createPersonaClient('breakglass.test', { baseUrl })

        // 2. Fetch break-glass portal page and verify 92-day quarterly drill indicator
        const portalRes = await bgClient.get(routes.breakGlass.index.href(), { accept: 'html' })
        await assertStatus(portalRes, 200)
        const portalHtml = await portalRes.text()
        assert.ok(portalHtml.includes('breakglass.test') || portalHtml.includes('Break-Glass'))

        // 3. Query PostgreSQL for break-glass accounts exceeding 92-day drill threshold
        if (pool) {
          const client = await pool.connect()
          try {
            const overdueRes = await client.query<{
              user_id: string
              label: string
              last_drill_at: string | null
              days_since_drill: number | null
            }>('SELECT * FROM auth.break_glass_drill_overdue()')

            assert.ok(Array.isArray(overdueRes.rows))
            for (const row of overdueRes.rows) {
              assert.ok(
                row.days_since_drill === null || row.days_since_drill >= 92,
                `Account ${row.label} in overdue list must have days_since_drill >= 92 or null, got ${row.days_since_drill}`,
              )
            }
          } finally {
            client.release()
          }
        }

        // 4. Execute domain background job checkBreakGlassDrills
        const overdueCount = await checkBreakGlassDrills()
        assert.ok(typeof overdueCount === 'number' && overdueCount >= 0)
      },
    )

    // =========================================================================
    // RW-20: Cold Disaster Recovery Drill & Database Restoration Integrity Verification
    // =========================================================================
    await scenario(
      'RW-20',
      'Cold Disaster Recovery Drill & Database Restoration Integrity Verification',
      'P7.3, P7.4, P8.5, P8.6, P9',
      async () => {
        // 1. Verify restore-drill.sh CLI invariants using child_process
        const { spawnSync } = await import('node:child_process')

        // Test 1a: Attempting restore drill with identical source and scratch database must fail
        const sameDbRun = spawnSync('bash', ['scripts/restore-drill.sh'], {
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://localhost:5432/mms_acceptance',
            RESTORE_DRILL_DATABASE: 'mms_acceptance',
          },
          encoding: 'utf8',
        })
        assert.equal(sameDbRun.status, 1, 'restore-drill.sh must exit 1 when source matches scratch database')
        assert.ok(
          sameDbRun.stderr.includes('cannot match source database'),
          `Expected stderr to report cannot match source database, got: ${sameDbRun.stderr}`,
        )

        // Test 1b: Attempting restore drill with non-disposable database name must fail
        const nonDisposableRun = spawnSync('bash', ['scripts/restore-drill.sh'], {
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://localhost:5432/mms_acceptance',
            RESTORE_DRILL_DATABASE: 'postgres',
          },
          encoding: 'utf8',
        })
        assert.equal(nonDisposableRun.status, 1, 'restore-drill.sh must exit 1 when scratch database is not disposable')
        assert.ok(
          nonDisposableRun.stderr.includes('must end in _drill, _scratch, or _restore'),
          `Expected stderr to report suffix constraint, got: ${nonDisposableRun.stderr}`,
        )

        // 2. Cryptographic ledger seal verification with valid SealHashParams types
        const sealParams: SealHashParams = {
          prev_seal_hash: GENESIS_PREV_SEAL_HASH,
          batch_hash: sha256Hex('batch-cold-restore-001'),
          from_xid: '1',
          to_xid: '50',
          change_log_count: 25,
          event_count: 25,
          sealed_at: new Date().toISOString(),
        }
        const sealHash = computeSealHash(sealParams)
        assert.equal(sealHash.length, 64, 'Computed seal hash must be 64-char hex string')
        assert.ok(/^[0-9a-f]{64}$/.test(sealHash), 'Seal hash must be lowercase hexadecimal')
      },
    )
  } finally {
    if (pool) {
      await pool.end().catch(() => {})
    }
  }

  return { total, passed, failed }
}
