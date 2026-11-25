import assert from 'node:assert/strict'
import { createBrowserPersonaContext } from './helpers/browser-auth.ts'

export async function runPW002CustomerIsolation(baseUrl: string): Promise<void> {
  console.log('Running PW-002: Customer Isolation (Browser)...')

  let charlieShipId = '00000000-0000-4000-8000-000000000b01' // Customer B's ship (MV TEST CHARLIE)

  // 1. External Customer A signs in through real browser interaction
  let customerASession = await createBrowserPersonaContext(baseUrl, 'customer.a')
  try {
    let page = customerASession.page

    // Navigate to new survey request form
    let navRes = await page.goto('/surveys/new', { waitUntil: 'domcontentloaded' })
    assert.equal(navRes?.status(), 200, 'Customer A should load /surveys/new')

    let formContent = await page.content()

    // Assert: Customer A's ships are visible in the vessel picker
    assert.ok(
      formContent.includes('MV TEST ALPHA'),
      'Customer A must see MV TEST ALPHA in browser vessel dropdown',
    )
    assert.ok(
      formContent.includes('MV TEST BRAVO'),
      'Customer A must see MV TEST BRAVO in browser vessel dropdown',
    )

    // Assert: Prohibited action / cross-customer vessel is absent from UI
    let charlieOption = page.locator(`option[value="${charlieShipId}"], option:has-text("MV TEST CHARLIE")`)
    let charlieCount = await charlieOption.count()
    assert.equal(
      charlieCount,
      0,
      'Customer A UI must not offer Customer B vessel (MV TEST CHARLIE)',
    )

    // Assert: Forced direct action with Customer B vessel remains denied
    let csrfToken = (await page.locator('input[name="_csrf"]').first().getAttribute('value').catch(() => null)) ?? ''
    assert.ok(csrfToken.length > 0, 'CSRF token must be present on page')

    let forcedRes = await customerASession.context.request.post('/surveys/create', {
      form: {
        _csrf: csrfToken,
        ship_id: charlieShipId,
        port_name: 'Adversarial Port',
        port_country: 'CN',
        port_code: 'CNSHA',
        estimated_arrival: new Date(Date.now() + 86400000).toISOString(),
        estimated_departure: new Date(Date.now() + 172800000).toISOString(),
        survey_types: 'annual_hull',
        scope_description: 'Adversarial cross-customer browser test',
      },
    })

    assert.ok(
      forcedRes.status() >= 400,
      `Forced survey creation for cross-customer vessel must be denied (>= 400), got HTTP ${forcedRes.status()}`,
    )
  } finally {
    await customerASession.context.close()
  }

  // 2. Customer B signs in and verifies reciprocal isolation
  let customerBSession = await createBrowserPersonaContext(baseUrl, 'customer.b')
  try {
    let page = customerBSession.page

    await page.goto('/surveys/new', { waitUntil: 'domcontentloaded' })
    let formBContent = await page.content()

    // Customer B must see MV TEST CHARLIE
    assert.ok(
      formBContent.includes('MV TEST CHARLIE'),
      'Customer B must see MV TEST CHARLIE in vessel dropdown',
    )

    // Customer B must NOT see Customer A's vessels
    let alphaOption = page.locator('option:has-text("MV TEST ALPHA")')
    assert.equal(await alphaOption.count(), 0, 'Customer B must not see MV TEST ALPHA in UI')

    let bravoOption = page.locator('option:has-text("MV TEST BRAVO")')
    assert.equal(await bravoOption.count(), 0, 'Customer B must not see MV TEST BRAVO in UI')
  } finally {
    await customerBSession.context.close()
  }

  console.log('✓ PW-002 Customer Isolation passed.')
}
