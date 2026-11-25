import assert from 'node:assert/strict'
import { createPersonaClient } from '../../../scripts/postgrest-test.ts'
import { expectDenied } from '../../../scripts/lib/denials.ts'

export async function runDirectPostgrestTests(pgrstUrl = 'http://127.0.0.1:3001'): Promise<void> {
  console.log('Running Direct PostgREST Authorization Suite (R8.6.24)...')

  // 1. Allowed persona: Shanghai Surveyor reads Shanghai requests
  let shaClient = await createPersonaClient('surveyor.shanghai', pgrstUrl)
  let shaSurveys = await shaClient.select('survey_requests')
  assert.ok(shaSurveys.length > 0, 'surveyor.shanghai must view Shanghai survey requests')

  // 2. Wrong office: Singapore Surveyor querying survey requests
  let sinClient = await createPersonaClient('surveyor.singapore', pgrstUrl)
  let sinSurveys = await sinClient.select('survey_requests')
  assert.equal(sinSurveys.length, 0, 'surveyor.singapore must NOT see Shanghai survey requests')

  // 3. Wrong organization: Customer A querying ships
  let custAClient = await createPersonaClient('customer.a', pgrstUrl)
  let shipsA = await custAClient.select('ships')
  assert.ok(shipsA.some((s) => s.name === 'MV TEST ALPHA'), 'Customer A sees own ship ALPHA')
  assert.ok(!shipsA.some((s) => s.name === 'MV TEST CHARLIE'), 'Customer A must NOT see Customer B ship CHARLIE')

  // 4. Tampered resource UUID: Customer A directly requesting Customer B ship by ID
  let charlieShipId = '00000000-0000-4000-8000-000000000b01'
  let tamperedResult = await custAClient.select('ships', { id: `eq.${charlieShipId}` })
  assert.equal(
    tamperedResult.length,
    0,
    'Direct lookup with Customer B ship ID by Customer A must return 0 results (non-disclosure)',
  )

  // 5. Wrong role: finance role attempting a regulated triage/accept RPC.
  //    int_finance has no EXECUTE on api.survey_request_accept, so PostgREST
  //    must return a genuine 401/403 authorization denial. A 404/PGRST202
  //    (wrong argument names or a stale schema cache), a connection/setup
  //    error, or a successful call must all FAIL here — otherwise a broken test
  //    looks like a passing denial.
  let financeClient = await createPersonaClient('finance.test', pgrstUrl)
  let denial = await expectDenied(financeClient, 'survey_request_accept', {
    p_id: '00000000-0000-4000-8000-000000000202',
    p_reason: 'Finance unauthorized call',
    p_triage_notes: 'Finance unauthorized call',
  })
  assert.ok(denial.passed, denial.detail)

  // 6. Expired authority / qualification check
  let expClient = await createPersonaClient('surveyor.expired', pgrstUrl)
  let authorityResult = await expClient.rpc('explain_authority', {
    p_action_code: 'survey.report.release',
  })
  assert.equal(
    authorityResult[0]?.allowed,
    false,
    'surveyor.expired must not possess survey.report.release authority',
  )

  console.log('✓ Direct PostgREST Authorization Suite passed.')
}
