import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ensureTestJwtKey, extractCsrfToken, extractFirstCookie, getTestDbUrl } from '@mms/test-utils'

import { router } from '../router.ts'
import { routes } from '../routes.ts'
import { sessionStorage, sessionCookie } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { sessionCreate } from '../auth/service.ts'

const dbUrl = getTestDbUrl()

async function makeSignedSessionCookie(sid: string): Promise<string> {
  let cookieVal = JSON.stringify({
    value: sid,
    expires: Date.now() + 12 * 60 * 60 * 1000,
  })
  let raw = await sessionCookie.serialize(cookieVal)
  return extractFirstCookie(raw)
}

async function getAnonSession(): Promise<{ cookie: string; csrf: string }> {
  let res = await router.fetch(new URL(routes.session.login.href(), 'http://localhost'))
  let text = await res.text()
  let csrf = extractCsrfToken(text)
  let cookieHeader = res.headers.get('set-cookie') ?? ''
  let sid = extractFirstCookie(cookieHeader)
  return { csrf, cookie: sid }
}

describe('R4.2: Action response standardization and HTTP correctness', () => {
  let pool: Pool
  let coordinatorCookie: string
  let coordinatorCsrf: string
  const testUserId = 'c4000000-0000-0000-0000-000000000001'
  const testOrgId = 'c4000000-0000-0000-0000-000000000002'
  const testShipId = 'c4000000-0000-0000-0000-000000000003'

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    pool = new Pool({ connectionString: dbUrl })
    clearSessionCaches()

    // 1. Clean previous test artifacts
    await pool.query(`delete from iam.session where user_id = $1`, [testUserId])
    await pool.query(`delete from iam.role_assignment where user_id = $1`, [testUserId])
    await pool.query(`delete from iam.staff_position where user_id = $1`, [testUserId])
    await pool.query(`delete from survey.survey_request where org_id = $1`, [testOrgId])
    await pool.query(`delete from fleet.ship_party where ship_id = $1`, [testShipId])
    await pool.query(`delete from fleet.ship where id = $1`, [testShipId])
    await pool.query(`delete from iam.app_user where id = $1`, [testUserId])
    await pool.query(`delete from party.organization where id = $1`, [testOrgId])

    // 2. Seed Organization, Ship & Affiliation
    await pool.query(`
      insert into party.organization (id, name, org_type, status)
      values ('${testOrgId}', 'R42 Test Org', 'company', 'active')
      on conflict (id) do nothing;
    `)
    await pool.query(`
      insert into fleet.ship (id, imo_number, name, ship_type, flag_code, gross_tonnage, build_year, status)
      values ('${testShipId}', '9888777', 'MV Response Tester', 'bulk_carrier', 'PA', 35000, 2020, 'in_service')
      on conflict (id) do nothing;

      insert into fleet.ship_party (ship_id, org_id, party_role, valid)
      values ('${testShipId}', '${testOrgId}', 'registered_owner', tstzrange(now() - interval '1 year', null))
      on conflict do nothing;
    `)

    // 3. Seed user, position and coordinator role
    await pool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id)
      values ('${testUserId}', 'internal', 'R42 Coordinator', 'r42.coord@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${testUserId}')
      on conflict (id) do update set status = 'active';

      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${testUserId}', 'internal', 'senior_admins', 'office_admin', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'r42 fixture'
        from core.org_unit u where u.code = 'SHA' limit 1;

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${testUserId}', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'r42 fixture'
        from core.org_unit u where u.code = 'SHA' limit 1;
    `)

    // 4. Create Session
    let created = await sessionCreate(
      testUserId,
      'entra',
      'int_coordinator',
      '127.0.0.1',
      'test-agent',
    )
    let sid = created.session_id
    let session = await sessionStorage.read(sid)
    coordinatorCsrf = randomUUID()
    session.set('_csrf', coordinatorCsrf)
    session.set('auth', {
      userId: testUserId,
      kind: 'internal',
      email: 'r42.coord@mms.example.com',
      activeRole: 'int_coordinator',
      authMethod: 'entra',
      authTime: new Date().toISOString(),
      stepUpAt: new Date().toISOString(),
      assignableRoles: ['int_coordinator'],
    })
    await sessionStorage.save(session)
    coordinatorCookie = await makeSignedSessionCookie(sid)
  })

  after(async () => {
    if (pool) {
      await pool.query(`delete from iam.session where user_id = $1`, [testUserId]).catch(() => {})
      await pool.query(`delete from iam.role_assignment where user_id = $1`, [testUserId]).catch(() => {})
      await pool.query(`delete from iam.staff_position where user_id = $1`, [testUserId]).catch(() => {})
      await pool.query(`delete from survey.survey_request where org_id = $1`, [testOrgId]).catch(() => {})
      await pool.query(`delete from fleet.ship_party where ship_id = $1`, [testShipId]).catch(() => {})
      await pool.query(`delete from fleet.ship where id = $1`, [testShipId]).catch(() => {})
      await pool.query(`delete from iam.app_user where id = $1`, [testUserId]).catch(() => {})
      await pool.query(`delete from party.organization where id = $1`, [testOrgId]).catch(() => {})
      await pool.end().catch(() => {})
    }
  })

  describe('1. RFC 9457 Problem Details on API and negotiated error responses', () => {
    it('returns application/problem+json with type URI, title, status, code, and correlation IDs on upload prepare error', async () => {
      let res = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/problem+json',
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
          'X-Csrf-Token': coordinatorCsrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          // missing entityId, docType, fileName
        }),
      })

      assert.ok([400, 422].includes(res.status))
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
      assert.equal(res.headers.get('Cache-Control'), 'no-store')

      let reqId = res.headers.get('X-Request-Id')
      assert.ok(reqId && reqId.length > 0, 'response must include X-Request-Id')

      let body = await res.json()
      assert.equal(body.type, 'https://mms.local/problems/bad-request')
      assert.equal(body.title, 'Bad Request')
      assert.equal(body.status, 400)
      assert.equal(body.code, 'BAD_REQUEST')
      assert.ok(body.detail && body.detail.length > 0)
      assert.equal(body.requestId, reqId)
      assert.equal(body.error, 'missing_parameters')
    })

    it('returns application/problem+json with 401 UNAUTHORIZED when unauthenticated on API call', async () => {
      let anon = await getAnonSession()
      let res = await router.fetch(new URL('/api/uploads/prepare', 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/problem+json',
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: anon.cookie,
          'X-Csrf-Token': anon.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: '00000000-0000-0000-0000-000000000001',
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })

      assert.equal(res.status, 401)
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
      let body = await res.json()
      assert.equal(body.type, 'https://mms.local/problems/unauthorized')
      assert.equal(body.code, 'UNAUTHORIZED')
    })

    it('returns application/problem+json with 404 NOT_FOUND when entity does not exist', async () => {
      let res = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/problem+json',
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
          'X-Csrf-Token': coordinatorCsrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: 'a0000000-0000-0000-0000-000000000099',
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })

      assert.equal(res.status, 404)
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
      let body = await res.json()
      assert.equal(body.type, 'https://mms.local/problems/not-found')
      assert.equal(body.code, 'NOT_FOUND')
    })

    it('returns RFC 9457 Problem Details when quarantine receives invalid upload token with Accept: application/problem+json', async () => {
      let res = await router.fetch(new URL('/uploads/quarantine/bad-upload-id', 'http://localhost'), {
        method: 'PUT',
        headers: {
          'Accept': 'application/problem+json',
        },
        body: 'binary-payload',
      })

      assert.equal(res.status, 403)
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
      let body = await res.json()
      assert.equal(body.code, 'FORBIDDEN')
      assert.ok(body.requestId)
    })
  })

  describe('2. Strict Cache-Control: no-store on sensitive endpoints', () => {
    it('sets Cache-Control: no-store on /login', async () => {
      let res = await router.fetch(new URL('/login', 'http://localhost'))
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
    })

    it('sets Cache-Control: no-store on /profile', async () => {
      let res = await router.fetch(new URL('/profile', 'http://localhost'), {
        headers: { cookie: coordinatorCookie },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
    })

    it('sets Cache-Control: no-store on /admin/positions', async () => {
      let res = await router.fetch(new URL('/admin/positions', 'http://localhost'), {
        headers: { cookie: coordinatorCookie },
      })
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
    })

    it('sets Cache-Control: no-store on /break-glass', async () => {
      let res = await router.fetch(new URL('/break-glass', 'http://localhost'), {
        headers: { cookie: coordinatorCookie },
      })
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
    })

    it('preserves public caching on /.well-known/jwks.json', async () => {
      let res = await router.fetch(new URL(routes.jwks.href(), 'http://localhost'))
      assert.equal(res.status, 200)
      let cc = res.headers.get('Cache-Control') ?? ''
      assert.ok(cc.includes('public') && cc.includes('max-age='))
    })
  })

  describe('3. Post/Redirect/Get (PRG) and safe preservation of validation errors on HTML forms', () => {
    it('preserves form field values safely with HTTP 400 when validation fails on survey create', async () => {
      let form = new FormData()
      form.set('_csrf', coordinatorCsrf)
      // Invalid ship ID to trigger validation failure
      form.set('ship_id', 'not-a-uuid')
      form.set('port_name', 'Port of Singapore Safe Test')
      form.set('port_country', 'SG')
      form.set('port_code', 'SGSIN')
      form.set('estimated_arrival', '2027-01-01T10:00')
      form.set('estimated_departure', '2027-01-05T18:00')
      form.set('scope_description', 'Annual special surveys test description')
      form.set('agent_name', 'Capt. Test Agent')
      form.set('agent_email', 'agent@test.example.com')
      form.set('agent_phone', '+65 6123 4567')

      let res = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
          accept: 'text/html',
        },
        body: form,
      })

      assert.ok([400, 422].includes(res.status))
      assert.equal(res.headers.get('Cache-Control'), 'no-store')

      let html = await res.text()
      // Form must display error message
      assert.ok(html.includes('Failed to create survey request') || html.includes('role="alert"'))

      // Form must safely preserve user-entered values
      assert.ok(html.includes('Port of Singapore Safe Test'))
      assert.ok(html.includes('SGSIN'))
      assert.ok(html.includes('Annual special surveys test description'))
      assert.ok(html.includes('Capt. Test Agent'))
      assert.ok(html.includes('agent@test.example.com'))
      assert.ok(html.includes('+65 6123 4567'))
    })

    it('returns RFC 9457 Problem Details when API caller posts invalid data to survey create with Accept: application/problem+json', async () => {
      let form = new FormData()
      form.set('_csrf', coordinatorCsrf)
      form.set('ship_id', 'invalid-uuid')

      let res = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
          accept: 'application/problem+json',
        },
        body: form,
      })

      assert.ok([400, 422].includes(res.status))
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')

      let problem = await res.json()
      assert.equal(problem.type, 'https://mms.local/problems/validation-failed')
      assert.equal(problem.code, 'VALIDATION_FAILED')
      assert.ok([400, 422].includes(problem.status))
      assert.ok(problem.requestId)
    })

    it('returns HTTP 400 and safe error message when triage rejection fails validation', async () => {
      let form = new FormData()
      form.set('_csrf', coordinatorCsrf)
      form.set('reason', '') // empty reason triggers validation failure

      let res = await router.fetch(
        new URL(routes.triage.reject.href({ id: 'c4000000-0000-0000-0000-000000000001' }), 'http://localhost'),
        {
          method: 'POST',
          headers: {
            'Sec-Fetch-Site': 'same-origin',
            'Origin': 'http://localhost',
            cookie: coordinatorCookie,
          },
          body: form,
        },
      )

      assert.ok([400, 422].includes(res.status))
      let text = await res.text()
      assert.ok(text.length > 0)
    })

    it('P0.5: posting missing email/password to POST /login/password with Accept: application/problem+json returns 422 Problem Details', async () => {
      let { cookie, csrf } = await getAnonSession()
      let form = new FormData()
      form.set('_csrf', csrf)

      let res = await router.fetch(new URL(routes.session.loginPassword.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie,
          accept: 'application/problem+json',
        },
        body: form,
      })

      assert.equal(res.status, 422, 'Missing fields must yield 422 rather than 500')
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
      let problem = await res.json()
      assert.equal(problem.type, 'https://mms.local/problems/validation-failed')
      assert.equal(problem.code, 'VALIDATION_FAILED')
      assert.equal(problem.status, 422)
      assert.ok(problem.requestId)
      assert.ok(problem.errors)
    })

    it('P0.5: handleScan failures scrub raw error messages and never leak internal details', async () => {
      let res = await router.fetch(
        new URL(routes.uploads.scan.href({ versionId: 'c4000000-0000-0000-0000-000000000001' }), 'http://localhost'),
        {
          method: 'POST',
          headers: {
            'Sec-Fetch-Site': 'same-origin',
            'Origin': 'http://localhost',
            cookie: coordinatorCookie,
            accept: 'application/problem+json',
          },
        },
      )

      assert.notEqual(res.status, 500)
      let text = await res.text()
      assert.equal(text.includes('postgresql://'), false, 'must not leak connection strings')
      assert.equal(text.includes('at '), false, 'must not leak stack trace')
      assert.equal(text.includes('node:internal'), false, 'must not leak internal paths')
    })
  })
})
