import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { Pool } from 'pg'
import { ensureTestJwtKey, getTestDbUrl } from '@mms/test-utils'

import { sessionCookie, sessionStorage } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { sessionCreate } from '../auth/service.ts'
import { router } from '../router.ts'
import { routes } from '../routes.ts'

// Card H-13: the HR review of directory-proposed positions. The page under test renders
// the pending queue with guessed values prefilled; the two actions confirm or reject.
// Everything hinges on the same rules — a human decision, with a reason, landing in the
// ordinary position path — so the tests drive the real router and database.
const adminUrl = getTestDbUrl()

const hrId = 'f0000000-0000-0000-0000-000000000001'
const starterId = 'f0000000-0000-0000-0000-000000000002'
const secondId = 'f0000000-0000-0000-0000-000000000003'

describe('Card H-13: position proposals (HR review)', () => {
  let adminPool: Pool
  let hrCookie: string
  let hrCsrf: string
  let starterProposalId: string
  let secondProposalId: string
  let shaUnitId: string

  async function deleteUser(id: string): Promise<void> {
    // Rows rooted at the user, or pointing at a position the user set/contains, must go
    // first: none of the foreign keys cascade. Order matters.
    await adminPool.query(
      'delete from iam.role_assignment where position_id in (select id from iam.staff_position where set_by = $1 or user_id = $1)',
      [id],
    )
    await adminPool.query('delete from iam.position_proposal where user_id = $1 or decided_by = $1 or proposed_by = $1', [id])
    await adminPool.query('delete from iam.staff_position where set_by = $1', [id])
    await adminPool.query('delete from iam.role_assignment where user_id = $1 or granted_by = $1 or revoked_by = $1', [id])
    await adminPool.query('delete from iam.staff_position where user_id = $1', [id])
    await adminPool.query('delete from iam.session where user_id = $1', [id])
    await adminPool.query('delete from iam.app_user where id = $1', [id])
  }

  async function createInternalUser(id: string, displayName: string): Promise<void> {
    await adminPool.query(
      `insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id)
       values ($1, 'internal', $2, $3, 'active', now(), '11111111-1111-1111-1111-111111111111', $1)`,
      [id, displayName, `${displayName.toLowerCase().replace(/\s+/g, '.')}@mms.example.com`],
    )
  }

  async function signedCookieAndSession(userId: string, role: string): Promise<{ cookie: string; csrf: string; sid: string }> {
    let created = await sessionCreate(
      userId,
      role === 'int_sysadmin' ? 'entra' : 'entra',
      role,
      '127.0.0.1',
      'test-agent',
    )
    let sid = created.session_id
    let session = await sessionStorage.read(sid)
    let csrf = 'csrf-' + userId
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
    let raw = await sessionCookie.serialize(
      JSON.stringify({ value: sid, expires: Date.now() + 12 * 60 * 60 * 1000 }),
    )
    return { cookie: raw.split(';')[0] ?? '', csrf, sid }
  }

  // R1.1: the proposal definer is worker/admin-only and now fails closed when
  // called directly without JWT claims. The Entra sync supplies those claims, so
  // this fixture does too, inside one transaction (`set_config(..., true)` is
  // transaction-local).
  async function stageProposal(
    userId: string,
    jobTitleCode: string,
    jobFamily: string,
    unitCode: string,
  ): Promise<string> {
    let client = await adminPool.connect()
    try {
      await client.query('begin')
      await client.query(
        `select set_config('request.jwt.claims', json_build_object('role', 'int_sysadmin', 'sub', '00000000-0000-0000-0000-000000000001')::text, true)`,
      )
      let result = await client.query<{ id: string }>(
        `select private.position_proposal_record($1, $2, $3, $4, '{}'::jsonb, '00000000-0000-0000-0000-000000000001'::uuid) as id`,
        [userId, jobTitleCode, jobFamily, unitCode],
      )
      await client.query('commit')
      return result.rows[0]!.id
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  before(async () => {
    ensureTestJwtKey(import.meta.url)
    adminPool = new Pool({ connectionString: adminUrl })
    clearSessionCaches()

    await deleteUser(hrId)
    await deleteUser(starterId)
    await deleteUser(secondId)

    // HR needs a position (hr.position.set authority) and a global int_hr assignment.
    await createInternalUser(hrId, 'H13 HR Admin')
    await createInternalUser(starterId, 'H13 Starter')
    await createInternalUser(secondId, 'H13 Second')

    shaUnitId = (await adminPool.query<{ id: string }>(
      "select id from core.org_unit where code = 'SHA'",
    )).rows[0].id

    await adminPool.query(
      `insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
       select $1, 'internal', 'hr_directors', 'hr', u.id, tstzrange(now() - interval '1 day', null),
              '00000000-0000-0000-0000-000000000001', 'test bootstrap'
         from core.org_unit u where u.code = 'HO'
      on conflict do nothing`,
      [hrId],
    )
    await adminPool.query(
      `insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
       values ($1, 'internal', 'int_hr', 'global', 'manual',
               '00000000-0000-0000-0000-000000000001', 'fixture')`,
      [hrId],
    )

    // Stage one mapped proposal and one unmapped proposal via the same definer the sync uses.
    // R1.1: this definer now fails closed without JWT claims, so stage through a
    // caller that carries them (see stageProposal below).
    let mapped = await stageProposal(starterId, 'senior_surveyors', 'Survey', 'SHA')
    starterProposalId = mapped
    let unmapped = await stageProposal(secondId, 'Senior Designer', 'Design', 'Workshop 7')
    secondProposalId = unmapped

    let hr = await signedCookieAndSession(hrId, 'int_hr')
    hrCookie = hr.cookie
    hrCsrf = hr.csrf
  })

  after(async () => {
    await deleteUser(hrId)
    await deleteUser(starterId)
    await deleteUser(secondId)
    await adminPool.end()
    clearSessionCaches()
  })

  it('renders the pending queue for an HR user', async () => {
    let res = await router.fetch(new URL(routes.admin.proposals.index.href(), 'http://localhost'), {
      headers: { cookie: hrCookie },
    })
    assert.equal(res.status, 200)
    let text = await res.text()
    assert.ok(text.includes('H13 Starter'), 'page lists the mapped candidate')
    assert.ok(text.includes('H13 Second'), 'page lists the unmapped candidate')
    assert.ok(text.includes('Senior Designer'), 'page keeps the raw directory title for review')
    assert.ok(text.includes('Confirm'), 'page offers the confirm action')
    assert.ok(text.includes('Reject'), 'page offers the reject action')
  })

  it('confirms a proposal and creates the staff position', async () => {
    let res = await router.fetch(
      new URL(routes.admin.proposals.confirm.href(), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: hrCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: hrCsrf,
          id: starterProposalId,
          job_title_code: 'senior_surveyors',
          unit_id: shaUnitId,
          reason: 'test confirmation from the HR page',
        }),
      },
    )
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('Location'), '/admin/proposals')

    let proposal = await adminPool.query<{ status: string; staff_position_id: string | null; decided_by: string | null }>(
      'select status, staff_position_id, decided_by from iam.position_proposal where id = $1',
      [starterProposalId],
    )
    assert.equal(proposal.rows[0]?.status, 'confirmed')
    assert.ok(proposal.rows[0]?.staff_position_id)
    assert.equal(proposal.rows[0]?.decided_by, hrId)

    let position = await adminPool.query<{ count: bigint }>(
      `select count(*)::bigint as count from iam.staff_position
        where user_id = $1 and upper(valid) is null and job_title_code = 'senior_surveyors'`,
      [starterId],
    )
    assert.equal(String(position.rows[0]?.count), '1')
  })

  it('rejects a proposal without creating a position', async () => {
    let res = await router.fetch(
      new URL(routes.admin.proposals.reject.href(), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: hrCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: hrCsrf,
          id: secondProposalId,
          reason: 'onboarding cancelled by the line manager',
        }),
      },
    )
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('Location'), '/admin/proposals')

    let proposal = await adminPool.query<{ status: string; staff_position_id: string | null }>(
      'select status, staff_position_id from iam.position_proposal where id = $1',
      [secondProposalId],
    )
    assert.equal(proposal.rows[0]?.status, 'rejected')
    assert.equal(proposal.rows[0]?.staff_position_id, null)
  })

  it('refuses the page to a non-HR user', async () => {
    let created = await signedCookieAndSession(starterId, 'int_viewer')
    let res = await router.fetch(new URL(routes.admin.proposals.index.href(), 'http://localhost'), {
      headers: { cookie: created.cookie },
    })
    assert.equal(res.status, 403)
  })
})
