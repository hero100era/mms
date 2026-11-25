import assert from 'node:assert/strict'
import { createPersonaContext } from '../helpers/auth.ts'

export async function runSysadminSodTest(baseUrl: string): Promise<void> {
  console.log('Running E2E-003: Sysadmin Segregation of Duties (SoD)...')

  let sysadminSession = await createPersonaContext(baseUrl, 'sysadmin.test')

  // 1. Sysadmin can access legitimate platform administration surfaces
  let assignmentsRes = await sysadminSession.context.get('/admin/assignments')
  assert.equal(
    assignmentsRes.status(),
    200,
    `Sysadmin must be allowed to access /admin/assignments, got HTTP ${assignmentsRes.status()}`,
  )

  let extUsersRes = await sysadminSession.context.get('/admin/external-users')
  assert.equal(
    extUsersRes.status(),
    200,
    `Sysadmin must be allowed to access /admin/external-users, got HTTP ${extUsersRes.status()}`,
  )

  // 2. Sysadmin cannot access HR-only surfaces (SoD between IT Platform Admin and HR)
  let hrPositionsRes = await sysadminSession.context.get('/admin/positions')
  assert.equal(
    hrPositionsRes.status(),
    403,
    `Sysadmin must be forbidden from /admin/positions (HR-only), got HTTP ${hrPositionsRes.status()}`,
  )

  // 3. Sysadmin attempts business survey triage approval -> strictly denied (SoD)
  let requestId = '00000000-0000-4000-8000-000000000202'
  let triageAttemptRes = await sysadminSession.context.post(`/triage/${requestId}/accept`, {
    form: {
      _csrf: sysadminSession.csrf,
      triageNotes: 'Sysadmin illegal approval attempt',
    },
  })

  // The triage routes exist and the role gate rejects int_sysadmin before any
  // database call, so the only correct outcome is 403. A 404 would mean the
  // route is missing (or the request id is not found before the role check) and
  // must NOT be treated as a segregation-of-duties denial.
  assert.equal(
    triageAttemptRes.status(),
    403,
    `Sysadmin must be forbidden (403) from business survey triage accept, got ${triageAttemptRes.status()}`,
  )

  // 4. Sysadmin attempts survey request rejection
  let rejectAttemptRes = await sysadminSession.context.post(`/triage/${requestId}/reject`, {
    form: {
      _csrf: sysadminSession.csrf,
      triageNotes: 'Sysadmin illegal rejection attempt',
    },
  })

  assert.equal(
    rejectAttemptRes.status(),
    403,
    `Sysadmin must be forbidden (403) from business survey rejection, got ${rejectAttemptRes.status()}`,
  )

  console.log('✓ E2E-003 Sysadmin SoD passed.')
}
