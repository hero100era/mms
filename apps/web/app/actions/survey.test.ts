import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { Pool } from 'pg'
import { ensureTestJwtKey, extractFirstCookie, getTestDbUrl } from '@mms/test-utils'

import { sessionStorage, sessionCookie } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { sessionCreate } from '../auth/service.ts'
import { router } from '../router.ts'
import { routes } from '../routes.ts'
import { resetStorageForTest } from '../storage/service.ts'

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

describe('Card S-04: Survey Request & Station Triage Whole-Slice (SLICE-01)', () => {
  let adminPool: Pool

  // Dedicated test UUIDs for S-04 suite (d0000000 prefix)
  const orgAId = 'd0000000-0000-0000-0000-000000000001'
  const orgBId = 'd0000000-0000-0000-0000-000000000002'
  const shipAId = 'd0000000-0000-0000-0000-000000000010'
  const shipBId = 'd0000000-0000-0000-0000-000000000020'

  const userAId = 'd0000000-0000-0000-0000-000000000031' // Alice (ext_user, Org A)
  const userBId = 'd0000000-0000-0000-0000-000000000032' // Bob (ext_user, Org B)

  const coordShaId = 'd0000000-0000-0000-0000-000000000041' // Sam Coord (SHA Station)
  const coordSzxId = 'd0000000-0000-0000-0000-000000000042' // Sally Coord (SZX Station)
  const mgrShaId = 'd0000000-0000-0000-0000-000000000043' // Max Mgr (SHA Station)
  const mgrEastAreaId = 'd0000000-0000-0000-0000-000000000044' // Carl Area Mgr (CN-EAST-RO)
  const internShaId = 'd0000000-0000-0000-0000-000000000045' // Tim Intern (SHA Station)
  const compId = 'd0000000-0000-0000-0000-000000000046' // Helen Compliance (HO-COMP)
  const coordNgbId = 'd0000000-0000-0000-0000-000000000047' // Ned Coord (NGB Station)
  const mgrSzxId = 'd0000000-0000-0000-0000-000000000048' // Simon Mgr (SZX Station)

  let shaStationId: string
  let ngbStationId: string
  let szxStationId: string

  let userA: TestUserSession
  let userB: TestUserSession
  let coordSha: TestUserSession
  let coordSzx: TestUserSession
  let mgrSha: TestUserSession
  let mgrEastArea: TestUserSession
  let internSha: TestUserSession
  let comp: TestUserSession
  let coordNgb: TestUserSession
  let mgrSzx: TestUserSession

  let createdRequestId: string

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    adminPool = new Pool({ connectionString: adminUrl })
    clearSessionCaches()
    resetStorageForTest()

    // 1. Fetch station IDs
    let stRes = await adminPool.query(
      `select id, code from core.org_unit where code in ('SHA', 'NGB', 'SZX', 'CN-EAST-RO')`,
    )
    for (let row of stRes.rows) {
      if (row.code === 'SHA') shaStationId = row.id
      if (row.code === 'NGB') ngbStationId = row.id
      if (row.code === 'SZX') szxStationId = row.id
    }

    // 2. Clean previous test artifacts
    let testUserIds = [
      userAId,
      userBId,
      coordShaId,
      coordSzxId,
      mgrShaId,
      mgrEastAreaId,
      internShaId,
      compId,
      coordNgbId,
      mgrSzxId,
    ]
    await adminPool.query(`delete from iam.session where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(
      `delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`,
      [testUserIds],
    )
    await adminPool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from iam.org_membership where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(
      `delete from core.upload where entity_id in (select id from survey.survey_request where org_id in ($1, $2))`,
      [orgAId, orgBId],
    )
    await adminPool.query(
      `delete from core.document_version where document_id in (select id from core.document where entity_type = 'survey_request' and entity_id in (select id from survey.survey_request where org_id in ($1, $2)))`,
      [orgAId, orgBId],
    )
    await adminPool.query(
      `delete from core.document where entity_type = 'survey_request' and entity_id in (select id from survey.survey_request where org_id in ($1, $2))`,
      [orgAId, orgBId],
    )
    await adminPool.query(`delete from survey.survey_request where org_id in ($1, $2)`, [orgAId, orgBId])
    await adminPool.query(`delete from fleet.ship_party where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship where id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from iam.app_user where id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from party.organization where id in ($1, $2)`, [orgAId, orgBId])

    // 3. Seed Organizations
    await adminPool.query(`
      insert into party.organization (id, name, org_type, status) values
        ('${orgAId}', 'Acme Shipping Line', 'company', 'active'),
        ('${orgBId}', 'Bravo Tankers Corp', 'company', 'active')
      on conflict (id) do nothing;
    `)

    // 4. Seed Ships and Affiliations
    await adminPool.query(`
      insert into fleet.ship (id, imo_number, name, ship_type, flag_code, gross_tonnage, build_year, status) values
        ('${shipAId}', '9111222', 'MV Acme Horizon', 'bulk_carrier', 'PA', 38000, 2019, 'in_service'),
        ('${shipBId}', '9333444', 'MV Bravo Neptune', 'oil_tanker', 'LR', 52000, 2022, 'in_service')
      on conflict (id) do nothing;

      insert into fleet.ship_party (ship_id, org_id, party_role, valid) values
        ('${shipAId}', '${orgAId}', 'registered_owner', tstzrange(now() - interval '1 year', null)),
        ('${shipBId}', '${orgBId}', 'registered_owner', tstzrange(now() - interval '1 year', null))
      on conflict do nothing;
    `)

    // 5. Seed Users
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id) values
        ('${userAId}', 'external', 'Alice Acme Requester', 'alice.s04@example.com', 'active', now(), null, null),
        ('${userBId}', 'external', 'Bob Bravo Requester', 'bob.s04@example.com', 'active', now(), null, null),
        ('${coordShaId}', 'internal', 'Sam Coord Shanghai', 'sam.coord.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${coordShaId}'),
        ('${coordSzxId}', 'internal', 'Sally Coord Shenzhen', 'sally.coord.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${coordSzxId}'),
        ('${mgrShaId}', 'internal', 'Max Mgr Shanghai', 'max.mgr.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${mgrShaId}'),
        ('${mgrEastAreaId}', 'internal', 'Carl Area East', 'carl.area.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${mgrEastAreaId}'),
        ('${internShaId}', 'internal', 'Tim Intern Shanghai', 'tim.intern.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${internShaId}'),
        ('${compId}', 'internal', 'Helen Compliance', 'helen.comp.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${compId}'),
        ('${coordNgbId}', 'internal', 'Ned Coord Ningbo', 'ned.coord.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${coordNgbId}'),
        ('${mgrSzxId}', 'internal', 'Simon Mgr Shenzhen', 'simon.mgr.s04@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${mgrSzxId}')
      on conflict (id) do update set status = 'active';

      insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by) values
        ('${userAId}', 'external', '${orgAId}', 'requester', '00000000-0000-0000-0000-000000000001'),
        ('${userBId}', 'external', '${orgBId}', 'requester', '00000000-0000-0000-0000-000000000001')
      on conflict do nothing;
    `)

    // 6. Seed Positions & Role Assignments
    await adminPool.query(`
      -- Sam: Coordinator @ SHA Station (office_admin, grade 3 -> int_coordinator)
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${coordShaId}', 'internal', 'senior_admins', 'office_admin', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${coordShaId}', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';

      -- Sally: Coordinator @ SZX Station
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${coordSzxId}', 'internal', 'senior_admins', 'office_admin', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SZX';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${coordSzxId}', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SZX';

      -- Ned: Coordinator @ NGB Station
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${coordNgbId}', 'internal', 'senior_admins', 'office_admin', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'NGB';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${coordNgbId}', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'NGB';

      -- Max: Manager @ SHA Station
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${mgrShaId}', 'internal', 'managers', 'management', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${mgrShaId}', 'internal', 'int_manager', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';

      -- Carl: Manager @ East China Regional Office (CN-EAST-RO)
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${mgrEastAreaId}', 'internal', 'managers', 'management', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'CN-EAST-RO';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${mgrEastAreaId}', 'internal', 'int_manager', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'CN-EAST-RO';

      -- Simon: Manager @ SZX Station
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${mgrSzxId}', 'internal', 'managers', 'management', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SZX';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${mgrSzxId}', 'internal', 'int_manager', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SZX';

      -- Tim: Intern @ SHA Station (grade 0 -> int_viewer)
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${internShaId}', 'internal', 'interns', 'office_admin', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${internShaId}', 'internal', 'int_viewer', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';

      -- Helen: Compliance @ HO-COMP (global int_compliance)
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${compId}', 'internal', 'senior_compliance_officers', 'compliance', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'HO-COMP';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason) values
        ('${compId}', 'internal', 'int_compliance', 'global', 'manual', '00000000-0000-0000-0000-000000000001', 'fixture');
    `)

    // Helper for sessions
    async function createTestSession(
      userId: string,
      role: string,
      kind: 'internal' | 'external',
    ): Promise<TestUserSession> {
      let created = await sessionCreate(
        userId,
        kind === 'internal' ? 'entra' : 'pwd',
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
        kind,
        activeRole: role,
        authMethod: kind === 'internal' ? 'entra' : 'pwd',
        // External password users have already satisfied the second factor (H-09)
        // when the BFF lets them past requireMfa().
        mfaVerifiedAt: kind === 'internal' ? undefined : new Date().toISOString(),
        authTime: new Date().toISOString(),
        assignableRoles: [role],
      })
      await sessionStorage.save(session)
      let cookie = await makeSignedSessionCookie(sid)
      return { userId, cookie, csrf }
    }

    userA = await createTestSession(userAId, 'ext_user', 'external')
    userB = await createTestSession(userBId, 'ext_user', 'external')
    coordSha = await createTestSession(coordShaId, 'int_coordinator', 'internal')
    coordSzx = await createTestSession(coordSzxId, 'int_coordinator', 'internal')
    mgrSha = await createTestSession(mgrShaId, 'int_manager', 'internal')
    mgrEastArea = await createTestSession(mgrEastAreaId, 'int_manager', 'internal')
    internSha = await createTestSession(internShaId, 'int_viewer', 'internal')
    comp = await createTestSession(compId, 'int_compliance', 'internal')
    coordNgb = await createTestSession(coordNgbId, 'int_coordinator', 'internal')
    mgrSzx = await createTestSession(mgrSzxId, 'int_manager', 'internal')
  })

  after(async () => {
    if (adminPool) {
      let testUserIds = [
        userAId,
        userBId,
        coordShaId,
        coordSzxId,
        mgrShaId,
        mgrEastAreaId,
        internShaId,
        compId,
        coordNgbId,
        mgrSzxId,
      ]
      await adminPool.query(`delete from iam.session where user_id = any($1::uuid[])`, [testUserIds])
      await adminPool.query(
        `delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`,
        [testUserIds],
      )
      await adminPool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [testUserIds])
      await adminPool.query(`delete from iam.org_membership where user_id = any($1::uuid[])`, [testUserIds])
      await adminPool.query(
        `delete from core.upload where entity_id in (select id from survey.survey_request where org_id in ($1, $2))`,
        [orgAId, orgBId],
      )
      await adminPool.query(
        `delete from core.document_version where document_id in (select id from core.document where entity_type = 'survey_request' and entity_id in (select id from survey.survey_request where org_id in ($1, $2)))`,
        [orgAId, orgBId],
      )
      await adminPool.query(
        `delete from core.document where entity_type = 'survey_request' and entity_id in (select id from survey.survey_request where org_id in ($1, $2))`,
        [orgAId, orgBId],
      )
      await adminPool.query(`delete from survey.survey_request where org_id in ($1, $2)`, [orgAId, orgBId])
      await adminPool.query(`delete from fleet.ship_party where ship_id in ($1, $2)`, [shipAId, shipBId])
      await adminPool.query(`delete from fleet.ship where id in ($1, $2)`, [shipAId, shipBId])
      await adminPool.query(`delete from iam.app_user where id = any($1::uuid[])`, [testUserIds])
      await adminPool.query(`delete from party.organization where id in ($1, $2)`, [orgAId, orgBId])
      resetStorageForTest()
      await adminPool.end()
    }
  })

  // ----------------------------------------------------
  // 1. Unauthenticated Redirection
  // ----------------------------------------------------
  it('unauthenticated access redirects to /login', async () => {
    let endpoints = [
      routes.survey.index.href(),
      routes.survey.new.href(),
      routes.triage.queue.href(),
      routes.triage.detail.href({ id: '00000000-0000-0000-0000-000000000001' }),
    ]
    for (let path of endpoints) {
      let res = await router.fetch(new URL(path, 'http://localhost'))
      assert.equal(res.status, 302, `expected 302 for ${path}`)
      assert.ok(res.headers.get('location')?.startsWith('/login'))
    }
  })

  // ----------------------------------------------------
  // 2. External Access Restrictions on Internal Triage
  // ----------------------------------------------------
  it('external users are denied access to station triage queue and triage decisions (403)', async () => {
    let dummyId = '00000000-0000-0000-0000-000000000001'

    let queueRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(queueRes.status, 403, 'external user cannot view triage queue')

    let detailRes = await router.fetch(new URL(routes.triage.detail.href({ id: dummyId }), 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(detailRes.status, 403, 'external user cannot view triage detail')

    let acceptRes = await router.fetch(new URL(routes.triage.accept.href({ id: dummyId }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: userA.cookie },
    })
    assert.equal(acceptRes.status, 403, 'external user cannot triage accept')

    let transferRes = await router.fetch(new URL(routes.triage.transfer.href({ id: dummyId }), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: userA.cookie },
    })
    assert.equal(transferRes.status, 403, 'external user cannot triage transfer')
  })

  // ----------------------------------------------------
  // 3. Flow 1: External User Creates Draft Request
  // ----------------------------------------------------
  it('Flow 1: external user A creates survey request as draft', async () => {
    let newPageRes = await router.fetch(new URL(routes.survey.new.href(), 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(newPageRes.status, 200)
    let pageHtml = await newPageRes.text()
    assert.ok(pageHtml.includes('MV Acme Horizon'), 'lists eligible fleet vessel')
    assert.ok(pageHtml.includes('Shanghai Station'), 'lists active attending station')

    let form = new FormData()
    form.set('_csrf', userA.csrf)
    form.set('ship_id', shipAId)
    form.set('org_id', orgAId)
    form.set('office_unit_id', shaStationId)
    form.set('port_name', 'Port of Shanghai (Yangshan)')
    form.set('port_country', 'CN')
    form.set('port_code', 'CNSHA')
    form.set('estimated_arrival', new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 16))
    form.set('estimated_departure', new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 16))
    form.append('survey_types', 'annual_hull')
    form.append('survey_types', 'annual_machinery')
    form.set('scope_description', 'Annual class surveys and intermediate drydock inspection.')
    form.set('agent_name', 'Oceanic Port Services')
    form.set('agent_email', 'ops.sha@oceanic.example.com')
    form.set('agent_phone', '+86 21 5555 1234')
    form.set('submit_action', 'draft')

    let createRes = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: userA.cookie },
      body: form,
    })
    assert.equal(createRes.status, 302)
    let location = createRes.headers.get('location') ?? ''
    assert.ok(location.startsWith('/surveys/'), `expected /surveys/:id, got ${location}`)

    createdRequestId = location.split('/surveys/')[1] ?? ''
    assert.ok(createdRequestId.length > 20)

    // Verify DB state
    let rowRes = await adminPool.query(`select * from survey.survey_request where id = $1`, [createdRequestId])
    assert.equal(rowRes.rows.length, 1)
    let r = rowRes.rows[0]
    assert.equal(r.status, 'draft')
    assert.equal(r.ship_id, shipAId)
    assert.equal(r.org_id, orgAId)
    assert.equal(r.office_unit_id, shaStationId)
    assert.deepEqual(r.survey_types, ['annual_hull', 'annual_machinery'])

    // Verify Audit Event
    let eventRes = await adminPool.query(
      `select * from audit_trail.event where subject_id = $1 and event_type = 'survey.request.created'`,
      [createdRequestId],
    )
    assert.equal(eventRes.rows.length, 1)
  })

  // ----------------------------------------------------
  // 4. Flow 2: External User Submits Survey Request
  // ----------------------------------------------------
  it('Flow 2: external user A submits survey request for station attendance', async () => {
    let form = new FormData()
    form.set('_csrf', userA.csrf)
    form.set('reason', 'Notice of upcoming arrival at Shanghai Yangshan port')

    let submitRes = await router.fetch(
      new URL(routes.survey.submit.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: userA.cookie },
        body: form,
      },
    )
    assert.equal(submitRes.status, 302)
    assert.equal(submitRes.headers.get('location'), `/surveys/${createdRequestId}`)

    // Check DB status is submitted
    let rowRes = await adminPool.query(`select status, updated_by from survey.survey_request where id = $1`, [
      createdRequestId,
    ])
    assert.equal(rowRes.rows[0].status, 'submitted')
    assert.equal(rowRes.rows[0].updated_by, userAId)

    // Check audit event
    let eventRes = await adminPool.query(
      `select * from audit_trail.event where subject_id = $1 and event_type = 'survey.request.submitted'`,
      [createdRequestId],
    )
    assert.equal(eventRes.rows.length, 1)
    assert.equal(eventRes.rows[0].actor_id, userAId)
    assert.equal(eventRes.rows[0].reason, 'Notice of upcoming arrival at Shanghai Yangshan port')
  })

  // ----------------------------------------------------
  // 5. Flow 3: Multi-Tenant RLS Isolation (Org B denied)
  // ----------------------------------------------------
  it('Flow 3: Org B cannot view, list, or submit Org A survey requests (404/RLS)', async () => {
    // Org B detail view -> 404
    let detailRes = await router.fetch(
      new URL(routes.survey.detail.href({ id: createdRequestId }), 'http://localhost'),
      {
        headers: { cookie: userB.cookie },
      },
    )
    assert.equal(detailRes.status, 404, 'Org B viewing Org A request must receive 404')

    // Org B submit attempt -> 403 or 404
    let form = new FormData()
    form.set('_csrf', userB.csrf)
    form.set('reason', 'Unauthorized submission from Org B')

    let submitRes = await router.fetch(
      new URL(routes.survey.submit.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: userB.cookie },
        body: form,
      },
    )
    assert.ok(
      submitRes.status === 403 || submitRes.status === 404,
      `expected 403 or 404, got ${submitRes.status}`,
    )

    // Org B list view -> does not contain Org A's request
    let listRes = await router.fetch(new URL(routes.survey.index.href(), 'http://localhost'), {
      headers: { cookie: userB.cookie },
    })
    assert.equal(listRes.status, 200)
    let listHtml = await listRes.text()
    assert.ok(!listHtml.includes(createdRequestId))
    assert.ok(!listHtml.includes('MV Acme Horizon'))

    // Org B create attempt with Org A vessel -> 403 Forbidden
    let fakeCreateForm = new FormData()
    fakeCreateForm.set('_csrf', userB.csrf)
    fakeCreateForm.set('ship_id', shipAId)
    fakeCreateForm.set('org_id', orgBId)
    fakeCreateForm.set('office_unit_id', shaStationId)
    fakeCreateForm.set('port_name', 'Port of Shanghai')
    fakeCreateForm.set('port_country', 'CN')
    fakeCreateForm.append('survey_types', 'annual_hull')
    fakeCreateForm.set('submit_action', 'draft')

    let fakeCreateRes = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: userB.cookie },
      body: fakeCreateForm,
    })
    assert.equal(fakeCreateRes.status, 403, 'Org B attempting to create request for Org A vessel must be 403 Forbidden')
  })

  // ----------------------------------------------------
  // 6. Flow 4: Station Scope Visibility (Shanghai & Area see it, Shenzhen does NOT)
  // ----------------------------------------------------
  it('Flow 4: Shanghai coordinator, Shanghai station manager, and East China area manager see request; Shenzhen station does NOT', async () => {
    // Shanghai Coordinator sees it in triage queue
    let shaCoordRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: coordSha.cookie },
    })
    assert.equal(shaCoordRes.status, 200)
    let shaCoordHtml = await shaCoordRes.text()
    assert.ok(shaCoordHtml.includes(createdRequestId))
    assert.ok(shaCoordHtml.includes('MV Acme Horizon'))
    assert.ok(shaCoordHtml.includes('Triage Decision'))

    // Shanghai Station Manager sees it
    let shaMgrRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: mgrSha.cookie },
    })
    assert.equal(shaMgrRes.status, 200)
    let shaMgrHtml = await shaMgrRes.text()
    assert.ok(shaMgrHtml.includes(createdRequestId))

    // East China Area Manager sees it (regional office covers SHA)
    let areaMgrRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: mgrEastArea.cookie },
    })
    assert.equal(areaMgrRes.status, 200)
    let areaMgrHtml = await areaMgrRes.text()
    assert.ok(areaMgrHtml.includes(createdRequestId))

    // Shenzhen Station Manager does NOT see it in queue
    let szxMgrRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: mgrSzx.cookie },
    })
    assert.equal(szxMgrRes.status, 200)
    let szxMgrHtml = await szxMgrRes.text()
    assert.ok(!szxMgrHtml.includes(createdRequestId), 'Shenzhen manager must not see Shanghai request in queue')

    // Shenzhen Coordinator receives 404 when directly requesting triage detail
    let szxCoordRes = await router.fetch(
      new URL(routes.triage.detail.href({ id: createdRequestId }), 'http://localhost'),
      {
        headers: { cookie: coordSzx.cookie },
      },
    )
    assert.equal(szxCoordRes.status, 404, 'Shenzhen coordinator must receive 404 for out-of-scope station request')
  })

  // ----------------------------------------------------
  // 7. Flow 5: Read-Only / Segregation of Duties Enforcement (Intern & Compliance)
  // ----------------------------------------------------
  it('Flow 5: interns and HO Compliance can view detail, but cannot perform triage decisions (403)', async () => {
    // Intern can view triage detail
    let internViewRes = await router.fetch(
      new URL(routes.triage.detail.href({ id: createdRequestId }), 'http://localhost'),
      {
        headers: { cookie: internSha.cookie },
      },
    )
    assert.equal(internViewRes.status, 200)
    let internHtml = await internViewRes.text()
    assert.ok(internHtml.includes('read-only access'), 'intern sees read-only notice')

    // Intern denied triageAccept (403)
    let formAccept = new FormData()
    formAccept.set('_csrf', internSha.csrf)
    formAccept.set('reason', 'Intern attempting unauthorized acceptance')
    let internAcceptRes = await router.fetch(
      new URL(routes.triage.accept.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: internSha.cookie },
        body: formAccept,
      },
    )
    assert.equal(internAcceptRes.status, 403, 'intern cannot accept')

    // Intern denied triageClarify (403)
    let internClarifyRes = await router.fetch(
      new URL(routes.triage.clarify.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: internSha.cookie },
        body: formAccept,
      },
    )
    assert.equal(internClarifyRes.status, 403, 'intern cannot clarify')

    // Intern denied triageReject (403)
    let internRejectRes = await router.fetch(
      new URL(routes.triage.reject.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: internSha.cookie },
        body: formAccept,
      },
    )
    assert.equal(internRejectRes.status, 403, 'intern cannot reject')

    // Intern denied triageTransfer (403)
    let formTransfer = new FormData()
    formTransfer.set('_csrf', internSha.csrf)
    formTransfer.set('new_office_unit_id', ngbStationId)
    formTransfer.set('reason', 'Intern attempting unauthorized transfer')
    let internTransferRes = await router.fetch(
      new URL(routes.triage.transfer.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: internSha.cookie },
        body: formTransfer,
      },
    )
    assert.equal(internTransferRes.status, 403, 'intern cannot transfer')

    // HO Compliance can view triage detail
    let compViewRes = await router.fetch(
      new URL(routes.triage.detail.href({ id: createdRequestId }), 'http://localhost'),
      {
        headers: { cookie: comp.cookie },
      },
    )
    assert.equal(compViewRes.status, 200)

    // HO Compliance denied triageAccept (403)
    let compAcceptRes = await router.fetch(
      new URL(routes.triage.accept.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: comp.cookie },
        body: formAccept,
      },
    )
    assert.equal(compAcceptRes.status, 403, 'HO compliance cannot accept')

    // HO Compliance denied triageTransfer (403)
    let compTransferRes = await router.fetch(
      new URL(routes.triage.transfer.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: comp.cookie },
        body: formTransfer,
      },
    )
    assert.equal(compTransferRes.status, 403, 'HO compliance cannot transfer')
  })

  // ----------------------------------------------------
  // 8. Flow 6: Mandatory Reason Validation
  // ----------------------------------------------------
  it('Flow 6: coordinator triage decisions reject empty reasons (400)', async () => {
    // Empty reason for Accept -> 400
    let emptyForm = new FormData()
    emptyForm.set('_csrf', coordSha.csrf)
    emptyForm.set('reason', '   ')

    let acceptRes = await router.fetch(
      new URL(routes.triage.accept.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: emptyForm,
      },
    )
    assert.ok(acceptRes.status === 400 || acceptRes.status === 422, 'accept requires mandatory non-whitespace reason')

    // Empty reason for Transfer -> 400
    emptyForm.set('new_office_unit_id', ngbStationId)
    let transferRes = await router.fetch(
      new URL(routes.triage.transfer.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: emptyForm,
      },
    )
    assert.ok(transferRes.status === 400 || transferRes.status === 422, 'transfer requires mandatory non-whitespace reason')

    // Missing target station for Transfer -> 400
    let noStationForm = new FormData()
    noStationForm.set('_csrf', coordSha.csrf)
    noStationForm.set('reason', 'Valid reason but missing destination')
    let noStationRes = await router.fetch(
      new URL(routes.triage.transfer.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: noStationForm,
      },
    )
    assert.ok(noStationRes.status === 400 || noStationRes.status === 422, 'transfer requires target station UUID')

    // Non-existent request UUID returns 404 Not Found
    let nonExistentId = '00000000-0000-0000-0000-999999999999'
    let validForm = new FormData()
    validForm.set('_csrf', coordSha.csrf)
    validForm.set('reason', 'Valid reason on ghost request')
    let notFoundAccept = await router.fetch(
      new URL(routes.triage.accept.href({ id: nonExistentId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: validForm,
      },
    )
    assert.equal(notFoundAccept.status, 404, 'triageAccept on non-existent request returns 404')

    let notFoundTransfer = await router.fetch(
      new URL(routes.triage.transfer.href({ id: nonExistentId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: (() => {
          let f = new FormData()
          f.set('_csrf', coordSha.csrf)
          f.set('new_office_unit_id', ngbStationId)
          f.set('reason', 'Valid reason')
          return f
        })(),
      },
    )
    assert.equal(notFoundTransfer.status, 404, 'triageTransfer on non-existent request returns 404')
  })

  // ----------------------------------------------------
  // 9. Flow 7: Clarification Request and Client Resubmission
  // ----------------------------------------------------
  it('Flow 7: coordinator requests clarification, client resubmits back to submitted', async () => {
    let clarifyForm = new FormData()
    clarifyForm.set('_csrf', coordSha.csrf)
    clarifyForm.set('reason', 'Missing bunker delivery notes (BDN) for fuel tanks')
    clarifyForm.set('notes', 'Please upload fuel test reports and confirm berthing berth 4 at Yangshan')

    let clarifyRes = await router.fetch(
      new URL(routes.triage.clarify.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: clarifyForm,
      },
    )
    assert.equal(clarifyRes.status, 302)
    assert.equal(clarifyRes.headers.get('location'), `/triage/${createdRequestId}`)

    // Check status in DB
    let dbRow = await adminPool.query(`select status, triage_notes from survey.survey_request where id = $1`, [
      createdRequestId,
    ])
    assert.equal(dbRow.rows[0].status, 'clarification_requested')
    assert.ok(dbRow.rows[0].triage_notes.includes('fuel test reports'))

    // Client views detail page and sees clarification requested notice
    let clientDetailRes = await router.fetch(
      new URL(routes.survey.detail.href({ id: createdRequestId }), 'http://localhost'),
      {
        headers: { cookie: userA.cookie },
      },
    )
    assert.equal(clientDetailRes.status, 200)
    let clientHtml = await clientDetailRes.text()
    assert.ok(clientHtml.includes('Clarification Requested'))
    assert.ok(clientHtml.includes('fuel test reports'))

    // Client uploads requested document (fuel_test_report.pdf)
    let samplePdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF')
    let prepRes = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: userA.cookie,
        'X-Csrf-Token': userA.csrf,
      },
      body: JSON.stringify({
        entityType: 'survey_request',
        entityId: createdRequestId,
        docType: 'specification',
        fileName: 'fuel_test_report.pdf',
      }),
    })
    assert.equal(prepRes.status, 200)
    let prepJson = await prepRes.json()

    let upRes = await router.fetch(new URL(prepJson.uploadUrl), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: samplePdfBytes,
    })
    assert.equal(upRes.status, 201)

    let finRes = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: userA.cookie,
        'X-Csrf-Token': userA.csrf,
      },
      body: JSON.stringify({
        uploadId: prepJson.uploadId,
        quarantinePath: prepJson.quarantinePath,
        entityType: 'survey_request',
        entityId: createdRequestId,
        docType: 'specification',
        title: 'Fuel Test Report BDN',
        fileName: 'fuel_test_report.pdf',
      }),
    })
    assert.equal(finRes.status, 200)
    let finJson = await finRes.json()

    // Client detail page now shows attached document
    let detailWithDoc = await router.fetch(
      new URL(routes.survey.detail.href({ id: createdRequestId }), 'http://localhost'),
      {
        headers: { cookie: userA.cookie },
      },
    )
    assert.equal(detailWithDoc.status, 200)
    let detailDocHtml = await detailWithDoc.text()
    assert.ok(detailDocHtml.includes('fuel_test_report.pdf'))

    // Client can download the document
    let downloadRes = await router.fetch(
      new URL(
        routes.uploads.documentDownload.href({
          documentId: finJson.documentId,
          versionId: finJson.versionId,
        }),
        'http://localhost',
      ),
      {
        headers: { cookie: userA.cookie },
      },
    )
    assert.equal(downloadRes.status, 200)
    assert.equal(downloadRes.headers.get('content-type'), 'application/pdf')

    // Client resubmits
    let resubmitForm = new FormData()
    resubmitForm.set('_csrf', userA.csrf)
    resubmitForm.set('reason', 'Uploaded BDN certificate; berth 4 confirmed with port authority')

    let resubmitRes = await router.fetch(
      new URL(routes.survey.submit.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: userA.cookie },
        body: resubmitForm,
      },
    )
    assert.equal(resubmitRes.status, 302)

    let afterResubmit = await adminPool.query(`select status from survey.survey_request where id = $1`, [
      createdRequestId,
    ])
    assert.equal(afterResubmit.rows[0].status, 'submitted')
  })

  // ----------------------------------------------------
  // 10. Flow 8: Station Transfer (SHA -> NGB)
  // ----------------------------------------------------
  it('Flow 8: Shanghai coordinator transfers request to Ningbo station with reason; queues reflect change', async () => {
    let transferForm = new FormData()
    transferForm.set('_csrf', coordSha.csrf)
    transferForm.set('new_office_unit_id', ngbStationId)
    transferForm.set('reason', 'Vessel diverted to Ningbo Beilun port due to weather conditions')

    let transferRes = await router.fetch(
      new URL(routes.triage.transfer.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: transferForm,
      },
    )
    assert.equal(transferRes.status, 302)
    assert.equal(transferRes.headers.get('location'), `/triage/${createdRequestId}`)

    // Verify DB station change
    let dbRow = await adminPool.query(
      `select office_unit_id, status from survey.survey_request where id = $1`,
      [createdRequestId],
    )
    assert.equal(dbRow.rows[0].office_unit_id, ngbStationId, 'office_unit_id must be updated to NGB')
    assert.equal(dbRow.rows[0].status, 'submitted')

    // Audit event emitted
    let auditTransfer = await adminPool.query(
      `select * from audit_trail.event where subject_id = $1 and event_type = 'survey.request.transferred'`,
      [createdRequestId],
    )
    assert.equal(auditTransfer.rows.length, 1)
    assert.equal(auditTransfer.rows[0].actor_id, coordShaId)
    assert.equal(auditTransfer.rows[0].actor_title, 'senior_admins')
    assert.equal(auditTransfer.rows[0].actor_grade, 3)
    assert.equal(auditTransfer.rows[0].reason, 'Vessel diverted to Ningbo Beilun port due to weather conditions')

    // Shanghai Coordinator queue NO LONGER contains the request
    let shaQueueRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: coordSha.cookie },
    })
    let shaQueueHtml = await shaQueueRes.text()
    assert.ok(!shaQueueHtml.includes(createdRequestId), 'Shanghai queue must no longer list transferred request')

    // Ningbo Coordinator queue NOW CONTAINS the request
    let ngbQueueRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: coordNgb.cookie },
    })
    let ngbQueueHtml = await ngbQueueRes.text()
    assert.ok(ngbQueueHtml.includes(createdRequestId), 'Ningbo queue must now list the transferred request')

    // Shenzhen Manager STILL does NOT see it
    let szxMgrRes = await router.fetch(new URL(routes.triage.queue.href(), 'http://localhost'), {
      headers: { cookie: mgrSzx.cookie },
    })
    let szxMgrHtml = await szxMgrRes.text()
    assert.ok(!szxMgrHtml.includes(createdRequestId), 'Shenzhen manager still does not see request')
  })

  // ----------------------------------------------------
  // 11. Flow 9: Target Station Coordinator Accepts Request
  // ----------------------------------------------------
  it('Flow 9: Ningbo coordinator accepts request with reason and attending team notes', async () => {
    let acceptForm = new FormData()
    acceptForm.set('_csrf', coordNgb.csrf)
    acceptForm.set('reason', 'Ningbo surveyor team capacity confirmed for Beilun berth 2')
    acceptForm.set('triage_notes', 'Assigned surveyor lead: Senior Surveyor Zhang; intermediate inspection scheduled')

    let acceptRes = await router.fetch(
      new URL(routes.triage.accept.href({ id: createdRequestId }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordNgb.cookie },
        body: acceptForm,
      },
    )
    assert.equal(acceptRes.status, 302)
    assert.equal(acceptRes.headers.get('location'), `/triage/${createdRequestId}`)

    // Check status in DB
    let dbRow = await adminPool.query(
      `select status, triage_notes, updated_by from survey.survey_request where id = $1`,
      [createdRequestId],
    )
    assert.equal(dbRow.rows[0].status, 'accepted')
    assert.equal(dbRow.rows[0].updated_by, coordNgbId)
    assert.ok(dbRow.rows[0].triage_notes.includes('Senior Surveyor Zhang'))

    // Verify audit event
    let auditAccept = await adminPool.query(
      `select * from audit_trail.event where subject_id = $1 and event_type = 'survey.request.accepted'`,
      [createdRequestId],
    )
    assert.equal(auditAccept.rows.length, 1)
    assert.equal(auditAccept.rows[0].actor_id, coordNgbId)
    assert.equal(auditAccept.rows[0].actor_title, 'senior_admins')
    assert.equal(auditAccept.rows[0].actor_grade, 3)
    assert.equal(auditAccept.rows[0].scope_unit_id, ngbStationId)
  })

  // ----------------------------------------------------
  // 12. Flow 10: Complete Audit Trail Reconstructability
  // ----------------------------------------------------
  it('Flow 10: full operational history reconstructable from audit_trail.* with title, grade, station, reason, and tx_id matching change_log', async () => {
    let eventsRes = await adminPool.query(
      `select e.event_type, e.actor_id, e.actor_title, e.actor_grade, e.scope_unit_id,
              e.reason, e.tx_id, e.occurred_at
         from audit_trail.event e
        where e.subject_id = $1
        order by e.occurred_at asc`,
      [createdRequestId],
    )
    let eventTypes = eventsRes.rows.map((r: any) => r.event_type)

    assert.deepEqual(eventTypes, [
      'survey.request.created',
      'survey.request.submitted',
      'survey.request.clarification_requested',
      'survey.request.submitted',
      'survey.request.transferred',
      'survey.request.accepted',
    ])

    // Verify each event's tx_id matches an entry in audit_trail.change_log
    for (let ev of eventsRes.rows) {
      assert.ok(ev.tx_id, `tx_id must be populated on ${ev.event_type}`)
      let clRes = await adminPool.query(`select 1 from audit_trail.change_log where tx_id = $1 limit 1`, [ev.tx_id])
      assert.ok(clRes.rows.length > 0, `tx_id ${ev.tx_id} for ${ev.event_type} must exist in audit_trail.change_log`)
    }

    // Check specific attribution on clarification event
    let clarifyEv = eventsRes.rows.find((r: any) => r.event_type === 'survey.request.clarification_requested')
    assert.equal(clarifyEv.actor_id, coordShaId)
    assert.equal(clarifyEv.actor_title, 'senior_admins')
    assert.equal(clarifyEv.actor_grade, 3)
    assert.equal(clarifyEv.scope_unit_id, shaStationId)

    // Check specific attribution on transfer event
    let transferEv = eventsRes.rows.find((r: any) => r.event_type === 'survey.request.transferred')
    assert.equal(transferEv.actor_id, coordShaId)
    assert.equal(transferEv.scope_unit_id, ngbStationId)

    // Check specific attribution on accepted event
    let acceptEv = eventsRes.rows.find((r: any) => r.event_type === 'survey.request.accepted')
    assert.equal(acceptEv.actor_id, coordNgbId)
    assert.equal(acceptEv.actor_title, 'senior_admins')
    assert.equal(acceptEv.actor_grade, 3)
    assert.equal(acceptEv.scope_unit_id, ngbStationId)
  })

  // ----------------------------------------------------
  // 13. Flow 11: Save & Submit Single-Step and Rejection Flow
  // ----------------------------------------------------
  it('Flow 11: Save & Submit single-step creates submitted request; coordinator rejection terminates request', async () => {
    let form = new FormData()
    form.set('_csrf', userA.csrf)
    form.set('ship_id', shipAId)
    form.set('org_id', orgAId)
    form.set('office_unit_id', shaStationId)
    form.set('port_name', 'Port of Shanghai (Waigaoqiao)')
    form.set('port_country', 'CN')
    form.set('port_code', 'CNSHA')
    form.set('estimated_arrival', new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 16))
    form.set('estimated_departure', new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 16))
    form.append('survey_types', 'docking')
    form.set('scope_description', 'Emergency drydock inspection following minor hull abrasion')
    form.set('submit_action', 'submit') // Single-step create & submit

    let createRes = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: userA.cookie },
      body: form,
    })
    assert.equal(createRes.status, 302)
    let loc = createRes.headers.get('location') ?? ''
    let req2Id = loc.split('/surveys/')[1] ?? ''

    // Directly in submitted state
    let rowRes = await adminPool.query(`select status from survey.survey_request where id = $1`, [req2Id])
    assert.equal(rowRes.rows[0].status, 'submitted')

    // Coordinator rejects with mandatory reason
    let rejectForm = new FormData()
    rejectForm.set('_csrf', coordSha.csrf)
    rejectForm.set('reason', 'Vessel classification suspended due to overdue conditions of class')
    rejectForm.set('notes', 'Operator must settle outstanding class conditions prior to attendance request')

    let rejectRes = await router.fetch(
      new URL(routes.triage.reject.href({ id: req2Id }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: coordSha.cookie },
        body: rejectForm,
      },
    )
    assert.equal(rejectRes.status, 302)

    let rejectedRow = await adminPool.query(
      `select status, triage_notes from survey.survey_request where id = $1`,
      [req2Id],
    )
    assert.equal(rejectedRow.rows[0].status, 'rejected')
    assert.ok(rejectedRow.rows[0].triage_notes.includes('outstanding class conditions'))

    // Audit event emitted
    let rejectAudit = await adminPool.query(
      `select * from audit_trail.event where subject_id = $1 and event_type = 'survey.request.rejected'`,
      [req2Id],
    )
    assert.equal(rejectAudit.rows.length, 1)
    assert.equal(rejectAudit.rows[0].actor_id, coordShaId)
    assert.equal(rejectAudit.rows[0].reason, 'Vessel classification suspended due to overdue conditions of class')

    // Cannot re-submit a rejected request
    let reSubmitForm = new FormData()
    reSubmitForm.set('_csrf', userA.csrf)
    reSubmitForm.set('reason', 'Attempting resubmit on rejected request')
    let reSubmitRes = await router.fetch(
      new URL(routes.survey.submit.href({ id: req2Id }), 'http://localhost'),
      {
        method: 'POST',
        headers: { cookie: userA.cookie },
        body: reSubmitForm,
      },
    )
    assert.ok(reSubmitRes.status === 400 || reSubmitRes.status === 422, 'resubmit of rejected request must return 400 or 422')
    let afterRejectRow = await adminPool.query(`select status from survey.survey_request where id = $1`, [req2Id])
    assert.equal(afterRejectRow.rows[0].status, 'rejected', 'rejected status is terminal')
  })

  // ----------------------------------------------------
  // 14. Validation Edge Cases
  // ----------------------------------------------------
  it('Validation edge cases: empty survey_types fails with 400; invalid triage filter safely falls back to all', async () => {
    // 1. Create with empty survey_types
    let form = new FormData()
    form.set('_csrf', userA.csrf)
    form.set('ship_id', shipAId)
    form.set('org_id', orgAId)
    form.set('office_unit_id', shaStationId)
    form.set('port_name', 'Port of Shanghai')
    form.set('port_country', 'CN')
    form.set('estimated_arrival', new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 16))
    form.set('estimated_departure', new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 16))
    form.set('submit_action', 'submit')
    // Deliberately no survey_types appended

    let emptyTypeRes = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
      method: 'POST',
      headers: { cookie: userA.cookie },
      body: form,
    })
    assert.ok(emptyTypeRes.status === 400 || emptyTypeRes.status === 422, 'empty survey types must return 400 or 422')
    let emptyHtml = await emptyTypeRes.text()
    assert.ok(emptyHtml.includes('survey_types_required') || emptyHtml.includes('Failed to create'), 'displays constraint error')

    // 2. Triage queue with invalid statusFilter parameter
    let filterRes = await router.fetch(
      new URL(routes.triage.queue.href() + '?status=invalid_status_injection', 'http://localhost'),
      {
        headers: { cookie: coordSha.cookie },
      },
    )
    assert.equal(filterRes.status, 200, 'invalid status filter safely returns 200')
    let filterHtml = await filterRes.text()
    assert.ok(filterHtml.includes('Station Triage Queue'), 'renders queue with fallback')
  })
})
