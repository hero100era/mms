import { PgrstClient } from '@mms/pgrst-client'
import { signAccessToken } from '../apps/web/app/auth/token-signer.ts'
import { findDevPersona } from '../apps/web/app/auth/dev-personas.ts'
import { sessionCreate } from '../apps/web/app/auth/service.ts'

import { requireDatabaseUrl } from '../db/scripts/lib.ts'
import { ensureAcceptanceKeys } from './lib/test-keys.ts'
import { expectDenied } from './lib/denials.ts'

// Ensure database URL is provided
requireDatabaseUrl()

// Ensure signing key is loaded from centralized protected key lifecycle
ensureAcceptanceKeys()

export async function createPersonaClient(personaKey: string, pgrstUrl = 'http://127.0.0.1:3001'): Promise<PgrstClient> {
  let persona = findDevPersona(personaKey)
  if (!persona) throw new Error(`Unknown persona: ${personaKey}`)

  let created = await sessionCreate(
    persona.userId,
    persona.kind === 'internal' ? 'entra' : 'pwd',
    persona.role,
    '127.0.0.1',
    'postgrest-test',
  )

  let { token } = signAccessToken({
    userId: persona.userId,
    role: persona.role,
    sessionId: created.session_id,
    authMethod: persona.kind === 'internal' ? 'entra' : 'pwd',
  })

  return new PgrstClient({
    baseUrl: pgrstUrl,
    token,
  })
}

export async function runPostgrestTests(pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'): Promise<{
  allPassed: boolean
  tests: { name: string; passed: boolean; detail: string }[]
}> {
  let tests: { name: string; passed: boolean; detail: string }[] = []

  // 1. Unauthenticated request to a protected relation (api.survey_requests).
  //    The anonymous role has no SELECT on the view, so PostgREST must answer
  //    with a genuine authorization denial (401/403). A 404 (PGRST205) would
  //    mean the relation name is wrong or the schema cache is stale, not that
  //    the caller was denied, so it must FAIL here.
  try {
    let unauthRes = await fetch(`${pgrstUrl}/survey_requests`, {
      headers: { Accept: 'application/json' },
    })
    let passed = unauthRes.status === 401 || unauthRes.status === 403
    let code = ''
    if (!passed) {
      try {
        let body = (await unauthRes.json()) as { code?: string; message?: string }
        code = body.code ? ` (code ${body.code})` : ''
      } catch {}
    }
    tests.push({
      name: 'Unauthenticated caller',
      passed,
      detail: `HTTP status ${unauthRes.status}${code} (expected 401/403 authorization denial)`,
    })
  } catch (err: any) {
    tests.push({
      name: 'Unauthenticated caller',
      passed: false,
      detail: `Connection error: ${err.message}`,
    })
  }

  // 2. Authenticated valid persona: Shanghai Surveyor (int_surveyor)
  try {
    let client = await createPersonaClient('surveyor.shanghai', pgrstUrl)
    let surveys = await client.select('survey_requests')
    let passed = Array.isArray(surveys) && surveys.length > 0
    tests.push({
      name: 'Authenticated surveyor.shanghai query',
      passed,
      detail: `Returned ${surveys?.length ?? 0} scoped survey request(s)`,
    })
  } catch (err: any) {
    tests.push({
      name: 'Authenticated surveyor.shanghai query',
      passed: false,
      detail: `Failed: ${err.message}`,
    })
  }

  // 3. Station isolation: surveyor.singapore querying requests
  try {
    let clientSin = await createPersonaClient('surveyor.singapore', pgrstUrl)
    let sinSurveys = await clientSin.select('survey_requests')
    // All current fixture survey requests are for Shanghai (SHA) station, so Singapore surveyor should see 0
    let passed = Array.isArray(sinSurveys) && sinSurveys.length === 0
    tests.push({
      name: 'Station isolation (surveyor.singapore cannot see Shanghai requests)',
      passed,
      detail: `Returned ${sinSurveys?.length ?? 0} requests (expected 0 due to station RLS)`,
    })
  } catch (err: any) {
    tests.push({
      name: 'Station isolation (surveyor.singapore cannot see Shanghai requests)',
      passed: false,
      detail: `Failed: ${err.message}`,
    })
  }

  // 4. Customer isolation: Customer A vs Customer B vessels
  try {
    let clientA = await createPersonaClient('customer.a', pgrstUrl)
    let clientB = await createPersonaClient('customer.b', pgrstUrl)

    // Customer A ships
    let shipsA = await clientA.select('ships')
    let shipsB = await clientB.select('ships')

    let customerAPeesAlpha = shipsA.some((s) => s.name === 'MV TEST ALPHA')
    let customerASeesCharlie = shipsA.some((s) => s.name === 'MV TEST CHARLIE')
    let customerBSeesCharlie = shipsB.some((s) => s.name === 'MV TEST CHARLIE')
    let customerBSeesAlpha = shipsB.some((s) => s.name === 'MV TEST ALPHA')

    let passed = customerAPeesAlpha && !customerASeesCharlie && customerBSeesCharlie && !customerBSeesAlpha
    tests.push({
      name: 'Customer isolation (Customer A & B cannot see each other vessels)',
      passed,
      detail: `Customer A saw ${shipsA.length} ships (has Alpha: ${customerAPeesAlpha}, has Charlie: ${customerASeesCharlie}); Customer B saw ${shipsB.length} ships (has Charlie: ${customerBSeesCharlie}, has Alpha: ${customerBSeesAlpha})`,
    })
  } catch (err: any) {
    tests.push({
      name: 'Customer isolation (Customer A & B cannot see each other vessels)',
      passed: false,
      detail: `Failed: ${err.message}`,
    })
  }

  // 5. Segregation of Duties: sysadmin must not perform a REGULATED approval.
  //    int_sysadmin is intentionally allowed to draft survey requests, but the
  //    EXECUTE grant on api.survey_request_accept lists only
  //    int_viewer/int_coordinator/int_manager/int_compliance, so this denial is
  //    enforced at the grant layer (the body would also reject it via
  //    `sysadmin_cannot_approve`). The old check called survey_request_create
  //    with wrong argument names, so it "passed" on a 404/PGRST202 schema-cache
  //    miss instead of a real SoD denial.
  try {
    let clientSysadmin = await createPersonaClient('sysadmin.test', pgrstUrl)
    let result = await expectDenied(clientSysadmin, 'survey_request_accept', {
      p_id: '00000000-0000-4000-8000-000000000202',
      p_reason: 'Sysadmin SoD test',
      p_triage_notes: 'Sysadmin must not approve business surveys',
    })
    tests.push({
      name: 'Sysadmin SoD (sysadmin cannot approve business survey operations)',
      ...result,
    })
  } catch (err: any) {
    tests.push({
      name: 'Sysadmin SoD (sysadmin cannot approve business survey operations)',
      passed: false,
      detail: `Setup/connection error: ${err.message}`,
    })
  }

  // 6. Role boundary: int_finance cannot triage/accept survey requests.
  //    Like the sysadmin case this is a grant-layer denial: int_finance is not
  //    in the EXECUTE list, so a 401/403 is the only acceptable outcome.
  try {
    let clientFinance = await createPersonaClient('finance.test', pgrstUrl)
    let result = await expectDenied(clientFinance, 'survey_request_accept', {
      p_id: '00000000-0000-4000-8000-000000000202',
      p_reason: 'Finance unauthorized attempt',
      p_triage_notes: 'Finance unauthorized attempt',
    })
    tests.push({
      name: 'Role boundary (int_finance cannot execute triage acceptance)',
      ...result,
    })
  } catch (err: any) {
    tests.push({
      name: 'Role boundary (int_finance cannot execute triage acceptance)',
      passed: false,
      detail: `Setup/connection error: ${err.message}`,
    })
  }

  let allPassed = tests.every((t) => t.passed)
  return { allPassed, tests }
}

async function main() {
  console.log('================================================================')
  console.log('PostgREST Direct Security & Acceptance Tests (R8.6.14 / R8.6.24)')
  console.log('================================================================')

  let pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'
  let { allPassed, tests } = await runPostgrestTests(pgrstUrl)

  for (let t of tests) {
    let icon = t.passed ? '✓' : '✗'
    console.log(`  ${icon} [${t.name}]: ${t.detail}`)
  }

  console.log('----------------------------------------------------------------')
  if (allPassed) {
    console.log('PASS: All PostgREST direct authorization checks passed.')
    console.log('================================================================')
    process.exit(0)
  } else {
    console.error('FAIL: PostgREST direct authorization checks failed.')
    console.log('================================================================')
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('postgrest-test.ts')) {
  main().catch((err) => {
    console.error('Fatal PostgREST test error:', err.message)
    process.exit(1)
  })
}
