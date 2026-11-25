import assert from 'node:assert/strict'
import { createPersonaContext } from '../helpers/auth.ts'

export async function runStationIsolationTest(baseUrl: string): Promise<void> {
  console.log('Running E2E-001: Station Isolation...')

  let shaRequestId = '00000000-0000-4000-8000-000000000202' // Shanghai submitted request

  // 1. Shanghai Manager accessing Shanghai Station resource -> allowed
  let shaSession = await createPersonaContext(baseUrl, 'manager.shanghai')
  let shaDetailRes = await shaSession.context.get(`/triage/${shaRequestId}`)
  assert.equal(
    shaDetailRes.status(),
    200,
    `Shanghai manager must be able to view Shanghai survey request, got HTTP ${shaDetailRes.status()}`,
  )
  let shaHtml = await shaDetailRes.text()
  assert.ok(shaHtml.includes('SR-TEST-002'), 'Must display request SR-TEST-002')

  // 2. Singapore Surveyor navigating to triage queue -> Shanghai requests must NOT appear
  let sinSession = await createPersonaContext(baseUrl, 'surveyor.singapore')
  let sinQueueRes = await sinSession.context.get('/triage')
  assert.equal(sinQueueRes.status(), 200)
  let sinQueueHtml = await sinQueueRes.text()
  assert.ok(
    !sinQueueHtml.includes('SR-TEST-002'),
    'Singapore surveyor must not see Shanghai request in triage queue',
  )

  // 3. Direct URL access attempt by Singapore surveyor to Shanghai resource -> denied (404/403)
  let sinDirectRes = await sinSession.context.get(`/triage/${shaRequestId}`)
  assert.ok(
    sinDirectRes.status() === 404 || sinDirectRes.status() === 403,
    `Singapore surveyor direct access to Shanghai request must be denied (404/403), got ${sinDirectRes.status()}`,
  )

  // 4. Modified HTTP POST attempt: Singapore surveyor attempts triage action on Shanghai resource.
  //    The accept action rejects any role outside int_coordinator/int_manager before
  //    any database call, so int_surveyor must get a deterministic 403. A 404 would
  //    mean the route is missing and must not be accepted as an isolation denial.
  let sinTamperRes = await sinSession.context.post(`/triage/${shaRequestId}/accept`, {
    form: {
      _csrf: sinSession.csrf,
      triageNotes: 'Tampered triage accept from Singapore',
    },
  })
  assert.equal(
    sinTamperRes.status(),
    403,
    `Singapore surveyor forced triage accept must be forbidden (403), got ${sinTamperRes.status()}`,
  )

  console.log('✓ E2E-001 Station Isolation passed.')
}
