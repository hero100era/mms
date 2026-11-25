import assert from 'node:assert/strict'
import { createBrowserPersonaContext } from './helpers/browser-auth.ts'

export async function runPW001StationIsolation(baseUrl: string): Promise<void> {
  console.log('Running PW-001: Station Isolation (Browser)...')

  let shaRequestId = '00000000-0000-4000-8000-000000000202' // Shanghai submitted request (SR-TEST-002)

  // 1. Shanghai Surveyor signs in through real /dev/login browser interaction
  let shaSession = await createBrowserPersonaContext(baseUrl, 'surveyor.shanghai')
  try {
    let page = shaSession.page

    // Navigate to triage queue
    await page.goto('/triage', { waitUntil: 'domcontentloaded' })
    let triageContent = await page.content()

    // Shanghai resource must be visible in the rendered UI
    assert.ok(
      triageContent.includes('SR-TEST-002'),
      'Shanghai surveyor must see Shanghai request SR-TEST-002 in triage queue UI',
    )

    // Navigate directly to the Shanghai survey request detail
    let shaDetailRes = await page.goto(`/triage/${shaRequestId}`, { waitUntil: 'domcontentloaded' })
    assert.equal(
      shaDetailRes?.status(),
      200,
      `Shanghai surveyor must be able to view Shanghai detail page, got HTTP ${shaDetailRes?.status()}`,
    )
    let detailContent = await page.content()
    assert.ok(
      detailContent.includes('SR-TEST-002') || detailContent.includes('Shanghai'),
      'Shanghai request detail must be rendered in browser',
    )
  } finally {
    await shaSession.context.close()
  }

  // 2. Singapore Surveyor signs in through real /dev/login browser interaction
  let sinSession = await createBrowserPersonaContext(baseUrl, 'surveyor.singapore')
  try {
    let page = sinSession.page

    // Navigate to triage queue
    await page.goto('/triage', { waitUntil: 'domcontentloaded' })
    let sinTriageContent = await page.content()

    // Assert: UI does not display or offer the Shanghai survey request
    assert.ok(
      !sinTriageContent.includes('SR-TEST-002'),
      'Singapore surveyor UI must not display Shanghai request SR-TEST-002 in triage queue',
    )

    // Direct browser navigation to Shanghai request
    let directRes = await page.goto(`/triage/${shaRequestId}`, { waitUntil: 'domcontentloaded' })
    let directStatus = directRes?.status() ?? 0

    assert.ok(
      directStatus === 404 || directStatus === 403,
      `Singapore surveyor direct navigation to Shanghai resource must be denied (404/403), got HTTP ${directStatus}`,
    )

    // Assert: UI does not offer the prohibited triage action
    let acceptButton = page.locator('button:has-text("Accept"), input[value="Accept"]')
    let buttonCount = await acceptButton.count()
    assert.equal(buttonCount, 0, 'UI must not offer the triage accept button to cross-station surveyor')

    // Assert: Forced direct action remains denied
    // Extract CSRF token from page if available, or attempt direct POST
    let csrfToken = (await page.locator('input[name="_csrf"]').first().getAttribute('value').catch(() => null)) ?? 'tampered-csrf'
    let tamperRes = await sinSession.context.request.post(`/triage/${shaRequestId}/accept`, {
      form: {
        _csrf: csrfToken,
        triageNotes: 'Adversarial cross-station triage accept from Singapore',
      },
    })
    assert.ok(
      tamperRes.status() === 404 || tamperRes.status() === 403,
      `Forced cross-station triage POST must fail closed with 403/404, got HTTP ${tamperRes.status()}`,
    )
  } finally {
    await sinSession.context.close()
  }

  console.log('✓ PW-001 Station Isolation passed.')
}
