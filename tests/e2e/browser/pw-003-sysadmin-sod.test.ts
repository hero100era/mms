import assert from 'node:assert/strict'
import { createBrowserPersonaContext } from './helpers/browser-auth.ts'

export async function runPW003SysadminSod(baseUrl: string): Promise<void> {
  console.log('Running PW-003: Sysadmin Segregation of Duties (Browser)...')

  let sysadminSession = await createBrowserPersonaContext(baseUrl, 'sysadmin.test')
  try {
    let page = sysadminSession.page

    // 1. Sysadmin can access platform administration surfaces
    let assignmentsRes = await page.goto('/admin/assignments', { waitUntil: 'domcontentloaded' })
    assert.equal(
      assignmentsRes?.status(),
      200,
      `Sysadmin must be allowed to access /admin/assignments, got HTTP ${assignmentsRes?.status()}`,
    )
    let assignmentsHtml = await page.content()
    assert.ok(
      assignmentsHtml.includes('Assignments') || assignmentsHtml.includes('Role'),
      'Admin assignments management interface must be rendered',
    )

    let extUsersRes = await page.goto('/admin/external-users', { waitUntil: 'domcontentloaded' })
    assert.equal(
      extUsersRes?.status(),
      200,
      `Sysadmin must be allowed to access /admin/external-users, got HTTP ${extUsersRes?.status()}`,
    )

    // 2. Sysadmin cannot access HR-only surfaces (Segregation of Duties)
    let positionsRes = await page.goto('/admin/positions', { waitUntil: 'domcontentloaded' })
    assert.equal(
      positionsRes?.status(),
      403,
      `Sysadmin must be forbidden (403) from accessing HR /admin/positions, got HTTP ${positionsRes?.status()}`,
    )

    // 3. Regulated business approval is unavailable in the UI
    let shaRequestId = '00000000-0000-4000-8000-000000000202'
    let triageDetailRes = await page.goto(`/triage/${shaRequestId}`, { waitUntil: 'domcontentloaded' })
    let triageStatus = triageDetailRes?.status() ?? 0

    // Either triage page refuses access (403/404) or UI omits the approval form
    if (triageStatus === 200) {
      let acceptButton = page.locator('button:has-text("Accept"), input[value="Accept"]')
      assert.equal(
        await acceptButton.count(),
        0,
        'Sysadmin UI must NOT offer regulated business approval action',
      )
    }

    // 4. Attempt forced submission: Sysadmin forced POST to triage accept -> denied.
    //    The role gate rejects int_sysadmin with 403 before any database call; a
    //    404 (missing route/record) must not be treated as a denial.
    let forcedAcceptRes = await sysadminSession.context.request.post(`/triage/${shaRequestId}/accept`, {
      form: {
        _csrf: 'sysadmin-tampered-token',
        triageNotes: 'Illegal sysadmin approval',
      },
    })
    assert.equal(
      forcedAcceptRes.status(),
      403,
      `Forced sysadmin business approval must be forbidden (403), got HTTP ${forcedAcceptRes.status()}`,
    )

    // 5. Attempt forced submission: Sysadmin forced POST to triage reject -> denied
    let forcedRejectRes = await sysadminSession.context.request.post(`/triage/${shaRequestId}/reject`, {
      form: {
        _csrf: 'sysadmin-tampered-token',
        triageNotes: 'Illegal sysadmin reject',
      },
    })
    assert.equal(
      forcedRejectRes.status(),
      403,
      `Forced sysadmin business rejection must be forbidden (403), got HTTP ${forcedRejectRes.status()}`,
    )
  } finally {
    await sysadminSession.context.close()
  }

  console.log('✓ PW-003 Sysadmin SoD passed.')
}
