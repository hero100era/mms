import assert from 'node:assert/strict'
import { createPersonaContext } from '../helpers/auth.ts'

export async function runCustomerIsolationTest(baseUrl: string): Promise<void> {
  console.log('Running E2E-002: Customer Isolation...')

  let charlieShipId = '00000000-0000-4000-8000-000000000b01' // Customer B's ship (MV TEST CHARLIE)
  let alphaShipId = '00000000-0000-4000-8000-000000000a01' // Customer A's ship (MV TEST ALPHA)

  // 1. Customer A signs in and navigates to surveys list and new survey page
  let customerASession = await createPersonaContext(baseUrl, 'customer.a')

  let newSurveyPageRes = await customerASession.context.get('/surveys/new')
  assert.equal(newSurveyPageRes.status(), 200)
  let htmlA = await newSurveyPageRes.text()

  // Must see Customer A ships
  assert.ok(htmlA.includes('MV TEST ALPHA'), 'Customer A must see MV TEST ALPHA')
  assert.ok(htmlA.includes('MV TEST BRAVO'), 'Customer A must see MV TEST BRAVO')

  // Must NOT see Customer B ships
  assert.ok(
    !htmlA.includes('MV TEST CHARLIE'),
    'Customer A must NOT discover MV TEST CHARLIE in vessel picker',
  )

  // 2. Customer A attempts to submit a survey request for Customer B's ship (Charlie)
  let csrfMatch = htmlA.match(/name="_csrf"\s+value="([^"]+)"/)
  let csrf = csrfMatch ? csrfMatch[1]! : customerASession.csrf

  let forgedCreateRes = await customerASession.context.post('/surveys/create', {
    form: {
      _csrf: csrf,
      ship_id: charlieShipId,
      port_name: 'Adversarial Port',
      port_country: 'CN',
      port_code: 'CNSHA',
      estimated_arrival: new Date(Date.now() + 86400000).toISOString(),
      estimated_departure: new Date(Date.now() + 172800000).toISOString(),
      survey_types: 'annual_hull',
      scope_description: 'Adversarial cross-customer request',
    },
  })

  // Must be rejected (403, 400, or 404 following non-disclosure policy)
  assert.ok(
    forgedCreateRes.status() >= 400,
    `Adversarial survey creation for cross-customer vessel must be rejected (>= 400), got ${forgedCreateRes.status()}`,
  )

  // 3. Customer B signs in and verifies reciprocal isolation
  let customerBSession = await createPersonaContext(baseUrl, 'customer.b')
  let pageBRes = await customerBSession.context.get('/surveys/new')
  assert.equal(pageBRes.status(), 200)
  let htmlB = await pageBRes.text()

  assert.ok(htmlB.includes('MV TEST CHARLIE'), 'Customer B must see MV TEST CHARLIE')
  assert.ok(!htmlB.includes('MV TEST ALPHA'), 'Customer B must NOT see MV TEST ALPHA')
  assert.ok(!htmlB.includes('MV TEST BRAVO'), 'Customer B must NOT see MV TEST BRAVO')

  console.log('✓ E2E-002 Customer Isolation passed.')
}
