import assert from 'node:assert/strict'
import { createPersonaContext } from '../helpers/auth.ts'
import { createPersonaClient } from '../../../scripts/postgrest-test.ts'

export async function runExpiredQualificationTest(baseUrl: string): Promise<void> {
  console.log('Running E2E-004: Expired Qualification...')

  // 1. surveyor.expired signs in
  let expiredSession = await createPersonaContext(baseUrl, 'surveyor.expired')

  // 2. Direct PostgREST / RPC qualification check
  // surveyor.shanghai has active TEST_GENERAL_SURVEY qualification
  // surveyor.expired has expired TEST_GENERAL_SURVEY qualification
  let shaClient = await createPersonaClient('surveyor.shanghai')
  let expClient = await createPersonaClient('surveyor.expired')

  // Check explain_authority for survey.report.release action
  let activeCheck = await shaClient.rpc('explain_authority', {
    p_action_code: 'survey.report.release',
  })
  assert.ok(
    Array.isArray(activeCheck) && activeCheck.length > 0,
    'Active surveyor should have authority record',
  )
  assert.equal(
    activeCheck[0]?.allowed,
    true,
    'surveyor.shanghai with active qualification must be authorized',
  )

  let expiredCheck = await expClient.rpc('explain_authority', {
    p_action_code: 'survey.report.release',
  })
  assert.ok(
    Array.isArray(expiredCheck) && expiredCheck.length > 0,
    'Expired surveyor should have authority record evaluated',
  )
  assert.equal(
    expiredCheck[0]?.allowed,
    false,
    'surveyor.expired with expired qualification must NOT be authorized',
  )
  assert.ok(
    expiredCheck[0]?.reason_code?.includes('expired') || !expiredCheck[0]?.allowed,
    `Reason code must reflect expiration or denial: ${expiredCheck[0]?.reason_code}`,
  )

  console.log('✓ E2E-004 Expired Qualification passed.')
}
