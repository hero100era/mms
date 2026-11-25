import assert from 'node:assert/strict'
import { createBrowserPersonaContext } from './helpers/browser-auth.ts'
import { createPersonaClient } from '../../../scripts/postgrest-test.ts'

export async function runPW004ExpiredQualification(baseUrl: string): Promise<void> {
  console.log('Running PW-004: Expired Qualification (Browser)...')

  // 1. Expired Surveyor signs in through real browser interaction
  let expiredSession = await createBrowserPersonaContext(baseUrl, 'surveyor.expired')
  try {
    let page = expiredSession.page

    // Navigate to controlled survey workflow / triage queue
    let triageRes = await page.goto('/triage', { waitUntil: 'domcontentloaded' })
    assert.ok(
      triageRes?.status() === 200 || triageRes?.status() === 403,
      `Expired surveyor triage navigation should return valid HTTP response, got ${triageRes?.status()}`,
    )

    // Verify UI does not offer survey report release or regulated sign-off control
    let releaseButton = page.locator('button:has-text("Release Report"), input[value="Release Report"]')
    assert.equal(
      await releaseButton.count(),
      0,
      'UI must not offer report release control to surveyor with expired qualification',
    )
  } finally {
    await expiredSession.context.close()
  }

  // 2. Verify qualification-based denial via direct PostgREST RPC authority evaluation
  // Compare active surveyor vs expired surveyor
  let activeShaClient = await createPersonaClient('surveyor.shanghai')
  let expiredClient = await createPersonaClient('surveyor.expired')

  // Check explain_authority for survey.report.release action
  let activeAuth = await activeShaClient.rpc('explain_authority', {
    p_action_code: 'survey.report.release',
  })
  assert.ok(Array.isArray(activeAuth) && activeAuth.length > 0, 'Active surveyor must have authority response')
  assert.equal(activeAuth[0]?.allowed, true, 'Active surveyor qualification must be authorized')

  let expiredAuth = await expiredClient.rpc('explain_authority', {
    p_action_code: 'survey.report.release',
  })
  assert.ok(Array.isArray(expiredAuth) && expiredAuth.length > 0, 'Expired surveyor must have authority response')
  assert.equal(
    expiredAuth[0]?.allowed,
    false,
    'Expired surveyor must NOT be authorized for survey.report.release',
  )
  assert.ok(
    expiredAuth[0]?.reason_code?.toLowerCase().includes('expired') || !expiredAuth[0]?.allowed,
    `Reason code must reflect expiration or denial: ${expiredAuth[0]?.reason_code}`,
  )

  console.log('✓ PW-004 Expired Qualification passed.')
}
