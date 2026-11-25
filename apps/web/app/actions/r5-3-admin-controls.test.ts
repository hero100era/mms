import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ensureTestJwtKey, extractFirstCookie, getTestDbUrl } from '@mms/test-utils'

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

describe('R5.3: Replace raw UUID administration with authorized controls', () => {
  let pool: Pool
  let hrCookie: string
  let hrCsrf: string
  let sysadminCookie: string
  let sysadminCsrf: string

  const hrUserId = 'c5300000-0000-0000-0000-000000000001'
  const sysadminUserId = 'c5300000-0000-0000-0000-000000000002'
  const targetStaffId = 'c5300000-0000-0000-0000-000000000003'

  let shaUnitId: string
  let szxUnitId: string

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    pool = new Pool({ connectionString: dbUrl })
    clearSessionCaches()

    // 1. Fetch real unit IDs
    let unitRes = await pool.query<{ id: string; code: string }>(
      `select id, code from core.org_unit where code in ('SHA', 'SZX')`,
    )
    for (let row of unitRes.rows) {
      if (row.code === 'SHA') shaUnitId = row.id
      if (row.code === 'SZX') szxUnitId = row.id
    }

    // 2. Clean test users
    let testUserIds = [hrUserId, sysadminUserId, targetStaffId]
    await pool.query(`delete from iam.session where user_id = any($1::uuid[])`, [testUserIds])
    await pool.query(`delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`, [testUserIds])
    await pool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [testUserIds])
    await pool.query(`delete from iam.app_user where id = any($1::uuid[])`, [testUserIds])

    // 3. Seed users
    await pool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id) values
        ('${hrUserId}', 'internal', 'HR Admin', 'hr.admin@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${hrUserId}'),
        ('${sysadminUserId}', 'internal', 'System Admin', 'sys.admin@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${sysadminUserId}'),
        ('${targetStaffId}', 'internal', 'Target Surveyor', 'target.surv@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${targetStaffId}');

      -- HR position and role
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${hrUserId}', 'internal', 'senior_hr', 'hr', '${shaUnitId}', tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'r53 fixture';

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
        ('${hrUserId}', 'internal', 'int_hr', 'global', 'manual', '00000000-0000-0000-0000-000000000001', 'r53 fixture');

      -- Sysadmin position and role
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${sysadminUserId}', 'internal', 'senior_admins', 'office_admin', '${shaUnitId}', tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'r53 fixture';

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
        ('${sysadminUserId}', 'internal', 'int_sysadmin', 'global', 'manual', '00000000-0000-0000-0000-000000000001', 'r53 fixture');

      -- Target surveyor initial position
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${targetStaffId}', 'internal', 'surveyors', 'survey', '${shaUnitId}', tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'r53 fixture';
    `)

    // Helper for sessions
    async function createAdminSession(userId: string, role: string, email: string) {
      let created = await sessionCreate(userId, 'entra', role, '127.0.0.1', 'test-agent')
      let sid = created.session_id
      let session = await sessionStorage.read(sid)
      let csrf = randomUUID()
      session.set('_csrf', csrf)
      session.set('auth', {
        userId,
        kind: 'internal',
        email,
        activeRole: role,
        authMethod: 'entra',
        authTime: new Date().toISOString(),
        stepUpAt: new Date().toISOString(),
        assignableRoles: [role],
      })
      await sessionStorage.save(session)
      let cookie = await makeSignedSessionCookie(sid)
      return { cookie, csrf }
    }

    let hrSession = await createAdminSession(hrUserId, 'int_hr', 'hr.admin@mms.example.com')
    hrCookie = hrSession.cookie
    hrCsrf = hrSession.csrf

    let sysadminSession = await createAdminSession(sysadminUserId, 'int_sysadmin', 'sys.admin@mms.example.com')
    sysadminCookie = sysadminSession.cookie
    sysadminCsrf = sysadminSession.csrf
  })

  after(async () => {
    if (pool) {
      let testUserIds = [hrUserId, sysadminUserId, targetStaffId]
      await pool.query(`delete from iam.session where user_id = any($1::uuid[])`, [testUserIds]).catch(() => {})
      await pool.query(`delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`, [testUserIds]).catch(() => {})
      await pool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [testUserIds]).catch(() => {})
      await pool.query(`delete from iam.app_user where id = any($1::uuid[])`, [testUserIds]).catch(() => {})
      await pool.end().catch(() => {})
    }
  })

  describe('1. Authorized selection controls replacing raw text inputs', () => {
    it('renders authorized unit and job title select dropdowns instead of raw text inputs on /admin/positions', async () => {
      let res = await router.fetch(new URL(routes.admin.positions.href(), 'http://localhost'), {
        headers: { cookie: hrCookie },
      })

      assert.equal(res.status, 200)
      let html = await res.text()

      // Must have select controls for unit_id and job_title_code
      assert.ok(html.includes('<select name="unit_id"'), 'unit_id must be a select element')
      assert.ok(html.includes('<select name="job_title_code"'), 'job_title_code must be a select element')

      // Must NOT have raw text inputs with placeholder="uuid"
      assert.ok(!html.includes('placeholder="uuid"'), 'raw uuid input placeholder must be removed')

      // Options must present human-readable unit code, name, and type
      assert.ok(html.includes('SHA — Shanghai Station'))
      assert.ok(html.includes('SZX — Shenzhen Station'))
    })

    it('renders authorized scope unit select and grantable role dropdown on /admin/assignments', async () => {
      let res = await router.fetch(new URL(routes.admin.assignments.href(), 'http://localhost'), {
        headers: { cookie: sysadminCookie },
      })

      assert.equal(res.status, 200)
      let html = await res.text()

      // Must have select control for scope_unit_id
      assert.ok(html.includes('<select name="scope_unit_id"'), 'scope_unit_id must be a select element')
      assert.ok(html.includes('SHA — Shanghai Station'))

      // Must have database-provided grantable roles dropdown
      assert.ok(html.includes('<select name="db_role"'))
      assert.ok(html.includes('int_surveyor'))
      assert.ok(html.includes('int_coordinator'))

      // Revoke action must have an explicit reason input, NOT a hardcoded hidden field
      assert.ok(html.includes('name="reason"'), 'Revoke form must include reason input')
      assert.ok(!html.includes('value="revoked from admin UI"'), 'Hardcoded revoke reason must be removed')
    })
  })

  describe('2. Scope and reason validations', () => {
    it('sets staff position with authorized unit selection and explicit reason', async () => {
      let form = new FormData()
      form.set('_csrf', hrCsrf)
      form.set('user_id', targetStaffId)
      form.set('job_title_code', 'surveyors')
      form.set('unit_id', shaUnitId)
      form.set('reason', 'Annual surveyor reassignment to Shanghai Station')

      let res = await router.fetch(new URL(routes.admin.positionSet.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: hrCookie,
        },
        body: form,
      })

      assert.equal(res.status, 302)
      assert.equal(res.headers.get('Location'), '/admin/positions')

      // Verify position was recorded with the unit and reason in database
      let posRes = await pool.query(
        `select unit_id, job_title_code, reason from iam.staff_position where user_id = $1 order by valid desc limit 1`,
        [targetStaffId],
      )
      assert.equal(posRes.rows[0].unit_id, shaUnitId)
      assert.equal(posRes.rows[0].job_title_code, 'surveyors')
      assert.equal(posRes.rows[0].reason, 'Annual surveyor reassignment to Shanghai Station')
    })

    it('rejects position set when reason is shorter than 5 characters (400)', async () => {
      let form = new FormData()
      form.set('_csrf', hrCsrf)
      form.set('user_id', targetStaffId)
      form.set('job_title_code', 'surveyors')
      form.set('unit_id', shaUnitId)
      form.set('reason', 'bad') // too short

      let res = await router.fetch(new URL(routes.admin.positionSet.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: hrCookie,
        },
        body: form,
      })

      assert.ok([400, 422].includes(res.status))
      let html = await res.text()
      assert.ok(html.includes('Reason must be at least 5 characters') || html.includes('Could not set position'))
    })

    it('rejects unit-scoped role assignment without a unit (400)', async () => {
      let form = new FormData()
      form.set('_csrf', sysadminCsrf)
      form.set('user_id', targetStaffId)
      form.set('db_role', 'int_surveyor')
      form.set('scope_type', 'unit')
      form.set('scope_unit_id', '') // missing unit for unit scope
      form.set('reason', 'Granting surveyor role at station level')

      let res = await router.fetch(new URL(routes.admin.assignmentGrant.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: sysadminCookie,
        },
        body: form,
      })

      assert.ok([400, 422].includes(res.status))
    })

    it('grants and revokes role assignment with explicit reasons and displays resolved unit in table', async () => {
      // 1. Grant unit-scoped role for Shenzhen Station
      let grantForm = new FormData()
      grantForm.set('_csrf', sysadminCsrf)
      grantForm.set('user_id', targetStaffId)
      grantForm.set('db_role', 'int_surveyor')
      grantForm.set('scope_type', 'unit')
      grantForm.set('scope_unit_id', szxUnitId)
      grantForm.set('reason', 'Granting station surveyor authority for Shenzhen')

      let grantRes = await router.fetch(new URL(routes.admin.assignmentGrant.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: sysadminCookie,
        },
        body: grantForm,
      })

      assert.equal(grantRes.status, 302)

      // 2. Fetch assignments page and verify human-readable unit name and code are rendered
      let pageRes = await router.fetch(new URL(routes.admin.assignments.href(), 'http://localhost'), {
        headers: { cookie: sysadminCookie },
      })
      let pageHtml = await pageRes.text()
      assert.ok(pageHtml.includes('unit: SZX (Shenzhen Station)'), 'Must render unit code and name in scope column')

      // Get assignment id
      let assignRow = await pool.query<{ id: string }>(
        `select id from iam.role_assignment where user_id = $1 and db_role = 'int_surveyor' and scope_unit_id = $2 and revoked_at is null`,
        [targetStaffId, szxUnitId],
      )
      assert.ok(assignRow.rows.length > 0)
      let assignmentId = assignRow.rows[0].id

      // 3. Revoke with explicit reason
      let revokeForm = new FormData()
      revokeForm.set('_csrf', sysadminCsrf)
      revokeForm.set('id', assignmentId)
      revokeForm.set('reason', 'Surveyor rotated to another station per rotation schedule')

      let revokeRes = await router.fetch(new URL(routes.admin.assignmentRevoke.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: sysadminCookie,
        },
        body: revokeForm,
      })

      assert.equal(revokeRes.status, 302)

      // 4. Verify revocation reason in database
      let dbAssign = await pool.query(
        `select revoked_at, revoke_reason from iam.role_assignment where id = $1`,
        [assignmentId],
      )
      assert.ok(dbAssign.rows[0].revoked_at !== null)
      assert.equal(dbAssign.rows[0].revoke_reason, 'Surveyor rotated to another station per rotation schedule')
    })

    it('rejects role assignment revocation when reason is shorter than 5 characters (400)', async () => {
      let form = new FormData()
      form.set('_csrf', sysadminCsrf)
      form.set('id', 'c5300000-0000-0000-0000-000000000099')
      form.set('reason', 'bad') // too short (< 5 chars)

      let res = await router.fetch(new URL(routes.admin.assignmentRevoke.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: sysadminCookie,
        },
        body: form,
      })

      assert.ok([400, 422].includes(res.status))
      let html = await res.text()
      assert.ok(html.includes('Could not revoke assignment') || html.includes('Reason must be at least 5 characters'))
    })

    it('returns RFC 9457 Problem Details when API caller posts invalid revocation data', async () => {
      let form = new FormData()
      form.set('_csrf', sysadminCsrf)
      form.set('id', 'invalid-uuid')
      form.set('reason', 'Valid revocation reason text')

      let res = await router.fetch(new URL(routes.admin.assignmentRevoke.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: sysadminCookie,
          accept: 'application/problem+json',
        },
        body: form,
      })

      assert.ok([400, 422].includes(res.status))
      assert.equal(res.headers.get('Content-Type'), 'application/problem+json; charset=utf-8')
      let problem = await res.json()
      assert.equal(problem.code, 'VALIDATION_FAILED')
      assert.ok(problem.requestId)
    })
  })
})
