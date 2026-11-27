import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { Pool } from 'pg'
import { ensureTestJwtKey, extractFirstCookie, getTestDbUrl } from '@mms/test-utils'

import { sessionStorage, sessionCookie } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { sessionCreate } from '../auth/service.ts'
import { router } from '../router.ts'
import { routes } from '../routes.ts'

const adminUrl = getTestDbUrl()

async function makeSignedSessionCookie(sid: string): Promise<string> {
  let cookieVal = JSON.stringify({
    value: sid,
    expires: Date.now() + 12 * 60 * 60 * 1000,
  })
  let raw = await sessionCookie.serialize(cookieVal)
  return extractFirstCookie(raw)
}

interface TestUserSession {
  userId: string
  cookie: string
  csrf: string
}

describe('Phase R6: Consolidated Authorization Matrix & Segregation of Duties (SoD)', () => {
  let adminPool: Pool

  // Dedicated test UUIDs for R6 SoD suite (f6000000 prefix)
  const orgId = 'f6000000-0000-0000-0000-000000000001'
  const shipId = 'f6000000-0000-0000-0000-000000000010'

  const coord1Id = 'f6000000-0000-0000-0000-000000000021' // Station Coordinator 1 (Creator)
  const coord2Id = 'f6000000-0000-0000-0000-000000000022' // Station Coordinator 2 (Approver)
  const sysadminId = 'f6000000-0000-0000-0000-000000000023' // Sysadmin
  const hrAdminId = 'f6000000-0000-0000-0000-000000000024' // HR Admin
  const candidateId = 'f6000000-0000-0000-0000-000000000025' // Candidate

  let shaStationId: string

  let coord1: TestUserSession
  let coord2: TestUserSession
  let sysadmin: TestUserSession
  let hrAdmin: TestUserSession

  let testRequestId: string

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    adminPool = new Pool({ connectionString: adminUrl })
    clearSessionCaches()

    // Clean up any stale data
    await adminPool.query(`delete from survey.survey_request where ship_id = $1`, [shipId])
    await adminPool.query(`delete from iam.position_proposal where user_id in ($1, $2, $3, $4, $5) or proposed_by in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.role_assignment where user_id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.staff_position where user_id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.session where user_id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.app_user where id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from fleet.ship_party where ship_id = $1`, [shipId])
    await adminPool.query(`delete from fleet.ship where id = $1`, [shipId])
    await adminPool.query(`delete from party.organization where id = $1`, [orgId])

    // Resolve Shanghai station org_unit id
    let shaRes = await adminPool.query<{ id: string }>(`select id from core.org_unit where code = 'SHA'`)
    shaStationId = shaRes.rows[0]!.id

    let hoRes = await adminPool.query<{ id: string }>(`select id from core.org_unit where code = 'HO'`)
    let hoId = hoRes.rows[0]!.id

    // Create party organization and ship
    await adminPool.query(
      `insert into party.organization (id, name, org_type, status)
       values ($1, 'R6 Marine Corp', 'company', 'active')`,
      [orgId],
    )
    await adminPool.query(
      `insert into fleet.ship (id, imo_number, name, type_iacs, type_mms, flag_code, gross_tonnage, build_year, status)
       values ($1, '7654321', 'R6 Integrity', 'GC', 'OC', 'LR', 50000, 2021, 'in_service')`,
      [shipId],
    )
    await adminPool.query(
      `insert into fleet.ship_party (ship_id, org_id, party_role, valid)
       values ($1, $2, 'registered_owner', tstzrange(now() - interval '1 year', null))`,
      [shipId, orgId],
    )

    // Helper to create staff user with position and role
    async function setupStaffUser(
      userId: string,
      displayName: string,
      email: string,
      role: string,
      jobTitle: string,
      unitId: string,
      jobFamily: string,
    ): Promise<TestUserSession> {
      await adminPool.query(
        `insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id)
         values ($1, 'internal', $2, $3, 'active', now(), '11111111-1111-1111-1111-111111111111', $1)`,
        [userId, displayName, email],
      )

      await adminPool.query(
        `insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
         values ($1, 'internal', $2, $3, $4, tstzrange(now() - interval '1 day', null),
                 '00000000-0000-0000-0000-000000000001', 'bootstrap test position')`,
        [userId, jobTitle, jobFamily, unitId],
      )

      await adminPool.query(
        `insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
         values ($1, 'internal', $2, 'unit', $3, 'manual', '00000000-0000-0000-0000-000000000001', 'bootstrap role')`,
        [userId, role, unitId],
      )

      let sess = await sessionCreate(userId, 'entra', role, '127.0.0.1', 'test-agent')
      let session = await sessionStorage.read(sess.session_id)
      let csrf = `csrf-${userId}`
      session.set('_csrf', csrf)
      session.set('auth', {
        userId,
        kind: 'internal',
        activeRole: role,
        authMethod: 'entra',
        authTime: new Date().toISOString(),
        assignableRoles: [role],
      })
      await sessionStorage.save(session)
      let cookie = await makeSignedSessionCookie(sess.session_id)
      return { userId, cookie, csrf }
    }

    coord1 = await setupStaffUser(coord1Id, 'Coord One', 'coord1@mms.example.com', 'int_coordinator', 'senior_admins', shaStationId, 'office_admin')
    coord2 = await setupStaffUser(coord2Id, 'Coord Two', 'coord2@mms.example.com', 'int_coordinator', 'senior_admins', shaStationId, 'office_admin')
    sysadmin = await setupStaffUser(sysadminId, 'Sysadmin User', 'sysadmin@mms.example.com', 'int_sysadmin', 'admins', hoId, 'office_admin')
    hrAdmin = await setupStaffUser(hrAdminId, 'HR Director', 'hr@mms.example.com', 'int_hr', 'hr_directors', hoId, 'hr')

    // Create Candidate user
    await adminPool.query(
      `insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id)
       values ($1, 'internal', 'Candidate User', 'cand@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', $1)`,
      [candidateId],
    )

    // Coordinator 1 creates and submits a survey request
    let client = await adminPool.connect()
    try {
      await client.query('begin')
      await client.query(
        `select set_config('request.jwt.claims', json_build_object('role', 'int_coordinator', 'sub', $1::text)::text, true)`,
        [coord1Id],
      )
      let createRes = await client.query<{ id: string }>(`
        select api.survey_request_create(
          $1, $2, $3, 'Shanghai Beilun', 'CN', 'CNSHA',
          now() + interval '1 day', now() + interval '3 days',
          array['hull'], 'Annual hull inspection', '{}'::jsonb
        ) as id
      `, [shipId, orgId, shaStationId])
      testRequestId = createRes.rows[0]!.id

      await client.query(`select api.survey_request_submit($1, 'Coord 1 submission')`, [testRequestId])
      await client.query('commit')
    } catch (e) {
      await client.query('rollback')
      throw e
    } finally {
      client.release()
    }
  })

  after(async () => {
    await adminPool.query(`delete from survey.survey_request where ship_id = $1`, [shipId])
    await adminPool.query(`delete from iam.position_proposal where user_id in ($1, $2, $3, $4, $5) or proposed_by in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.role_assignment where user_id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.staff_position where user_id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.session where user_id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from iam.app_user where id in ($1, $2, $3, $4, $5)`, [
      coord1Id, coord2Id, sysadminId, hrAdminId, candidateId,
    ])
    await adminPool.query(`delete from fleet.ship_party where ship_id = $1`, [shipId])
    await adminPool.query(`delete from fleet.ship where id = $1`, [shipId])
    await adminPool.query(`delete from party.organization where id = $1`, [orgId])
    await adminPool.end()
    clearSessionCaches()
  })

  // --------------------------------------------------------------------------
  // 1. Four-Eyes Review (Creator Cannot Approve)
  // --------------------------------------------------------------------------
  it('1. SoD: Creator coordinator cannot triage-accept their own survey request (HTTP 403 Problem Details)', async () => {
    let acceptForm = new FormData()
    acceptForm.set('_csrf', coord1.csrf)
    acceptForm.set('reason', 'Coord 1 self-approving request')

    let res = await router.fetch(
      new URL(routes.triage.accept.href({ id: testRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: {
          cookie: coord1.cookie,
          accept: 'application/problem+json',
        },
        body: acceptForm,
      },
    )

    assert.equal(res.status, 403, 'creator self-approval is forbidden (403)')
    let problem = (await res.json()) as { code?: string; detail?: string }
    assert.equal(problem.code, 'FORBIDDEN')
    assert.match(problem.detail ?? '', /creator_cannot_approve/)
  })

  it('2. SoD: Second independent coordinator can triage-accept the survey request (HTTP 302)', async () => {
    let acceptForm = new FormData()
    acceptForm.set('_csrf', coord2.csrf)
    acceptForm.set('reason', 'Coord 2 independent four-eyes review and approval')

    let res = await router.fetch(
      new URL(routes.triage.accept.href({ id: testRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: {
          cookie: coord2.cookie,
        },
        body: acceptForm,
      },
    )

    assert.equal(res.status, 302, 'independent coordinator successfully accepts (302 redirect)')

    let dbCheck = await adminPool.query<{ status: string; updated_by: string }>(
      `select status, updated_by from survey.survey_request where id = $1`,
      [testRequestId],
    )
    assert.equal(dbCheck.rows[0]?.status, 'accepted')
    assert.equal(dbCheck.rows[0]?.updated_by, coord2Id)
  })

  // --------------------------------------------------------------------------
  // 2. Sysadmin Segregation of Duties
  // --------------------------------------------------------------------------
  it('3. SoD: Sysadmin is forbidden from operational survey triage decisions (HTTP 403)', async () => {
    let acceptForm = new FormData()
    acceptForm.set('_csrf', sysadmin.csrf)
    acceptForm.set('reason', 'Sysadmin attempting operational triage')

    let res = await router.fetch(
      new URL(routes.triage.accept.href({ id: testRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: {
          cookie: sysadmin.cookie,
        },
        body: acceptForm,
      },
    )

    assert.equal(res.status, 403, 'sysadmin is denied operational triage')
  })

  async function stageTestProposal(userId: string, jobTitle: string, jobFamily: string, unitCode: string, proposedBy: string): Promise<string> {
    let client = await adminPool.connect()
    try {
      await client.query('begin')
      await client.query(
        `select set_config('request.jwt.claims', json_build_object('role', 'int_sysadmin', 'sub', $1::text)::text, true)`,
        [proposedBy],
      )
      let res = await client.query<{ id: string }>(
        `select private.position_proposal_record($1, $2, $3, $4, '{}'::jsonb, $5::uuid) as id`,
        [userId, jobTitle, jobFamily, unitCode, proposedBy],
      )
      await client.query('commit')
      return res.rows[0]!.id
    } catch (e) {
      await client.query('rollback')
      throw e
    } finally {
      client.release()
    }
  }

  it('4. SoD: Sysadmin cannot confirm regulated HR position proposals (HTTP 403)', async () => {
    let proposalId = await stageTestProposal(candidateId, 'senior_surveyors', 'Survey', 'SHA', '00000000-0000-0000-0000-000000000001')

    let form = new FormData()
    form.set('_csrf', sysadmin.csrf)
    form.set('id', proposalId)
    form.set('job_title_code', 'senior_surveyors')
    form.set('unit_id', shaStationId)
    form.set('reason', 'Sysadmin confirming proposal')

    let res = await router.fetch(
      new URL(routes.admin.proposals.confirm.href(), 'http://localhost'),
      {
        method: 'POST',
        headers: {
          cookie: sysadmin.cookie,
          accept: 'application/problem+json',
        },
        body: form,
      },
    )

    assert.equal(res.status, 403, 'sysadmin cannot confirm position proposals')
    let problem = (await res.json()) as { code?: string }
    assert.equal(problem.code, 'FORBIDDEN')
  })

  // --------------------------------------------------------------------------
  // 3. Position Proposal Self-Confirmation Prohibition
  // --------------------------------------------------------------------------
  it('5. SoD: HR user cannot confirm a position proposal for themselves (HTTP 403 Problem Details)', async () => {
    let selfProposalId = await stageTestProposal(hrAdminId, 'hr_directors', 'hr', 'HO', '00000000-0000-0000-0000-000000000001')

    let form = new FormData()
    form.set('_csrf', hrAdmin.csrf)
    form.set('id', selfProposalId)
    form.set('job_title_code', 'hr_directors')
    form.set('unit_id', shaStationId)
    form.set('reason', 'HR user attempting to confirm their own position')

    let res = await router.fetch(
      new URL(routes.admin.proposals.confirm.href(), 'http://localhost'),
      {
        method: 'POST',
        headers: {
          cookie: hrAdmin.cookie,
          accept: 'application/problem+json',
        },
        body: form,
      },
    )

    assert.equal(res.status, 403, 'self-position confirmation is rejected with 403 Forbidden')
    let problem = (await res.json()) as { code?: string; detail?: string }
    assert.equal(problem.code, 'FORBIDDEN')
    assert.match(problem.detail ?? '', /cannot_confirm_own_proposal/)
  })

  // --------------------------------------------------------------------------
  // 4. Safe Diagnostic Authority Explanation (api.explain_authority)
  // --------------------------------------------------------------------------
  it('6. R6.2: explain_authority diagnostic returns non-sensitive explanation for authorized users', async () => {
    let client = await adminPool.connect()
    try {
      await client.query('begin')
      await client.query(
        `select set_config('request.jwt.claims', json_build_object('role', 'int_coordinator', 'sub', $1::text)::text, true)`,
        [coord1Id],
      )

      let res = await client.query<{ allowed: boolean; reason_code: string }>(
        `select allowed, reason_code from api.explain_authority('survey.request.triage')`,
      )
      assert.equal(res.rows[0]?.allowed, true)
      assert.equal(res.rows[0]?.reason_code, 'ok')

      // Query with record_id of own request
      let resOwn = await client.query<{ allowed: boolean; reason_code: string }>(
        `select allowed, reason_code from api.explain_authority('survey.request.triage', null, null, $1::uuid)`,
        [testRequestId],
      )
      assert.equal(resOwn.rows[0]?.allowed, false)
      assert.equal(resOwn.rows[0]?.reason_code, 'creator_cannot_approve')
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  })
})
