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
}

describe('Fleet Ships List & Particular Details (/ships, /ships/:id)', () => {
  let adminPool: Pool

  // Dedicated UUIDs for ships test suite (e1000000 prefix)
  const orgAId = 'e1000000-0000-0000-0000-000000000001'
  const orgBId = 'e1000000-0000-0000-0000-000000000002'
  const shipAId = 'e1000000-0000-0000-0000-000000000010'
  const shipBId = 'e1000000-0000-0000-0000-000000000020'

  const userAId = 'e1000000-0000-0000-0000-000000000031'
  const surveyorId = 'e1000000-0000-0000-0000-000000000041'

  let userA: TestUserSession
  let surveyor: TestUserSession

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    adminPool = new Pool({ connectionString: adminUrl })
    clearSessionCaches()

    let testUserIds = [userAId, surveyorId]
    await adminPool.query(`delete from iam.session where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(
      `delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`,
      [testUserIds],
    )
    await adminPool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from iam.org_membership where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from fleet.finding_comment where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship_breakdown where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship_party where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship where id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from iam.app_user where id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from party.organization where id in ($1, $2)`, [orgAId, orgBId])

    await adminPool.query(`
      insert into party.organization (id, name, org_type, status) values
        ('${orgAId}', 'ShipTest Maritime Ltd', 'company', 'active'),
        ('${orgBId}', 'ShipTest Rival Shipping', 'company', 'active');

      insert into fleet.ship (
        id, imo_number, name, type_iacs, type_mms, flag_code, gross_tonnage, build_year, status,
        call_sign, port_of_registry, deadweight, length_oa, moulded_breadth, design_draft, main_class
      ) values
        (
          '${shipAId}', '9777001', 'MV ShipTest Alpha', 'BC', 'BC', 'PA', 42500, 2020, 'in_service',
          '3EST1', 'Panama', 75000, 225.50, 32.20, 14.10, '*CSA'
        ),
        (
          '${shipBId}', '9777002', 'MV ShipTest Bravo', 'OT', 'OT', 'SG', 61000, 2021, 'laid_up',
          '9VST2', 'Singapore', 105000, 249.00, 44.00, 15.20, '*CSM'
        );

      insert into fleet.ship_party (ship_id, org_id, party_role, valid) values
        ('${shipAId}', '${orgAId}', 'registered_owner', tstzrange(now() - interval '1 year', null)),
        ('${shipBId}', '${orgBId}', 'registered_owner', tstzrange(now() - interval '1 year', null));
    `)

    // Breakdown + node + particulars for Ship A
    let bdRes = await adminPool.query<{ id: number }>(
      `insert into fleet.ship_breakdown (ship_id, name, description, revision, is_active)
       values ($1, 'Hull & Machinery Breakdown', 'Primary vessel breakdown', 1, true)
       returning id`,
      [shipAId],
    )
    let nodeRes = await adminPool.query<{ id: number }>(
      `insert into fleet.ship_breakdown_node (ship_breakdown_id, code, name, category, node_type, level, sort_order)
       values ($1, 'ME-01', 'Main Propulsion Engine', 'Machinery', 'equipment', 1, 1)
       returning id`,
      [bdRes.rows[0]!.id],
    )
    await adminPool.query(
      `insert into fleet.ship_breakdown_node_particular (
        ship_breakdown_node_id, attr_key, attr_title, attr_value, data_type, unit, sort_order
      ) values ($1, 'MCR_KW', 'Maximum Continuous Rating', '14200', 'decimal', 'kW', 1)`,
      [nodeRes.rows[0]!.id],
    )

    // Public and private finding comments (ensure core lookup codes exist)
    await adminPool.query(`
      insert into core.finding_type (code, name) values ('CO', 'Condition of Class') on conflict (code) do nothing;
      insert into core.finding_status (code, name) values ('O', 'Open') on conflict (code) do nothing;
      insert into fleet.finding_comment (
        ship_id, finding_type, is_private, date_issued, place_issued, status, mms_reference, subject, body
      ) values
        ('${shipAId}', 'CO', false, current_date, 'Shanghai', 'O', 'CC-2026-001', 'Public Hold Note', 'Inspect hatch coaming gasket'),
        ('${shipAId}', 'CO', true, current_date, 'Shanghai', 'O', 'INT-2026-002', 'Internal Surveyor Note', 'Confidential internal observation');
    `)

    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id) values
        ('${userAId}', 'external', 'ShipTest External User', 'shiptest.ext@example.com', 'active', now(), null, null),
        ('${surveyorId}', 'internal', 'ShipTest Internal Surveyor', 'shiptest.surv@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${surveyorId}')
      on conflict (id) do update set status = 'active';

      insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by) values
        ('${userAId}', 'external', '${orgAId}', 'requester', '00000000-0000-0000-0000-000000000001')
      on conflict do nothing;

      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${surveyorId}', 'internal', 'senior_surveyors', 'survey', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${surveyorId}', 'internal', 'int_surveyor', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'fixture'
        from core.org_unit u where u.code = 'SHA';
    `)

    async function createSession(userId: string, role: string, kind: 'internal' | 'external'): Promise<TestUserSession> {
      let created = await sessionCreate(userId, kind === 'internal' ? 'entra' : 'pwd', role, '127.0.0.1', 'test-agent')
      let session = await sessionStorage.read(created.session_id)
      session.set('_csrf', 'csrf-' + userId)
      session.set('auth', {
        userId,
        kind,
        activeRole: role,
        authMethod: kind === 'internal' ? 'entra' : 'pwd',
        mfaVerifiedAt: kind === 'internal' ? undefined : new Date().toISOString(),
        authTime: new Date().toISOString(),
        assignableRoles: [role],
      })
      await sessionStorage.save(session)
      return { userId, cookie: await makeSignedSessionCookie(created.session_id) }
    }

    userA = await createSession(userAId, 'ext_user', 'external')
    surveyor = await createSession(surveyorId, 'int_surveyor', 'internal')
  })

  after(async () => {
    let testUserIds = [userAId, surveyorId]
    await adminPool.query(`delete from iam.session where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(
      `delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`,
      [testUserIds],
    )
    await adminPool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from iam.org_membership where user_id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from fleet.finding_comment where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship_breakdown where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship_party where ship_id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from fleet.ship where id in ($1, $2)`, [shipAId, shipBId])
    await adminPool.query(`delete from iam.app_user where id = any($1::uuid[])`, [testUserIds])
    await adminPool.query(`delete from party.organization where id in ($1, $2)`, [orgAId, orgBId])
    await adminPool.end()
  })

  it('redirects unauthenticated browser requests to /login and returns 401 Problem Details for API requests', async () => {
    let htmlRes = await router.fetch(new URL(routes.ships.index.href(), 'http://localhost'), {
      headers: { Accept: 'text/html' },
    })
    assert.equal(htmlRes.status, 302)
    assert.equal(htmlRes.headers.get('location'), '/login?returnTo=%2Fships')

    let probRes = await router.fetch(new URL(routes.ships.detail.href({ id: shipAId }), 'http://localhost'), {
      headers: { Accept: 'application/problem+json' },
    })
    assert.equal(probRes.status, 401)
    assert.match(probRes.headers.get('content-type') ?? '', /application\/problem\+json/)
  })

  it('GET /ships lists only affiliated vessels for ext_user and supports search/status filters', async () => {
    let res = await router.fetch(new URL(routes.ships.index.href(), 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(res.status, 200)
    let html = await res.text()
    assert.ok(html.includes('MV ShipTest Alpha'), 'External user should see affiliated vessel')
    assert.ok(!html.includes('MV ShipTest Bravo'), 'External user must not see rival organization vessel')
    assert.ok(!/\sstyle\s*=/i.test(html), 'Rendered /ships HTML must not contain inline style attributes')

    // Search filter
    let filteredRes = await router.fetch(new URL(`${routes.ships.index.href()}?q=NoMatchXYZ`, 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(filteredRes.status, 200)
    let filteredHtml = await filteredRes.text()
    assert.ok(!filteredHtml.includes('MV ShipTest Alpha'))
    assert.ok(filteredHtml.includes('No vessels found'))

    // JSON negotiation
    let jsonRes = await router.fetch(new URL(routes.ships.index.href(), 'http://localhost'), {
      headers: { cookie: userA.cookie, Accept: 'application/json' },
    })
    assert.equal(jsonRes.status, 200)
    let payload = (await jsonRes.json()) as { ships: Array<{ id: string; name: string }> }
    assert.equal(payload.ships.length, 1)
    assert.equal(payload.ships[0]?.id, shipAId)
  })

  it('GET /ships/:id displays vessel particulars, breakdown particulars, and public findings while hiding private findings', async () => {
    let res = await router.fetch(new URL(routes.ships.detail.href({ id: shipAId }), 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(res.status, 200)
    let html = await res.text()
    assert.ok(html.includes('MV ShipTest Alpha'))
    assert.ok(html.includes('3EST1'), 'Should display call sign')
    assert.ok(html.includes('Panama'), 'Should display port of registry')
    assert.ok(html.includes('75,000 t'), 'Should display deadweight')
    assert.ok(html.includes('Main Propulsion Engine'), 'Should display breakdown node')
    assert.ok(html.includes('14200'), 'Should display breakdown node particular value')
    assert.ok(html.includes('Public Hold Note'), 'Should display non-private finding')
    assert.ok(!html.includes('Internal Surveyor Note'), 'External user must not see private findings')
    assert.ok(!/\sstyle\s*=/i.test(html), 'Rendered /ships/:id HTML must not contain inline style attributes')

    // JSON detail negotiation
    let jsonRes = await router.fetch(new URL(routes.ships.detail.href({ id: shipAId }), 'http://localhost'), {
      headers: { cookie: userA.cookie, Accept: 'application/json' },
    })
    assert.equal(jsonRes.status, 200)
    let detail = (await jsonRes.json()) as {
      ship: { id: string; call_sign: string }
      breakdownParticulars: Array<{ attr_key: string; attr_value: string }>
      findings: Array<{ subject: string }>
    }
    assert.equal(detail.ship.id, shipAId)
    assert.equal(detail.ship.call_sign, '3EST1')
    assert.equal(detail.breakdownParticulars[0]?.attr_key, 'MCR_KW')
    assert.equal(detail.findings.length, 1)
    assert.equal(detail.findings[0]?.subject, 'Public Hold Note')
  })

  it('GET /ships/:id enforces 404 non-disclosure for inaccessible vessels and malformed UUIDs', async () => {
    let otherShipHtml = await router.fetch(new URL(routes.ships.detail.href({ id: shipBId }), 'http://localhost'), {
      headers: { cookie: userA.cookie },
    })
    assert.equal(otherShipHtml.status, 404)

    let otherShipProblem = await router.fetch(new URL(routes.ships.detail.href({ id: shipBId }), 'http://localhost'), {
      headers: { cookie: userA.cookie, Accept: 'application/problem+json' },
    })
    assert.equal(otherShipProblem.status, 404)
    assert.match(otherShipProblem.headers.get('content-type') ?? '', /application\/problem\+json/)

    let badUuidProblem = await router.fetch(new URL('/ships/not-a-valid-uuid', 'http://localhost'), {
      headers: { cookie: userA.cookie, Accept: 'application/problem+json' },
    })
    assert.equal(badUuidProblem.status, 404)
    assert.match(badUuidProblem.headers.get('content-type') ?? '', /application\/problem\+json/)
  })

  it('internal staff sees all vessels and private findings', async () => {
    let listRes = await router.fetch(new URL(routes.ships.index.href(), 'http://localhost'), {
      headers: { cookie: surveyor.cookie },
    })
    assert.equal(listRes.status, 200)
    let listHtml = await listRes.text()
    assert.ok(listHtml.includes('MV ShipTest Alpha'))
    assert.ok(listHtml.includes('MV ShipTest Bravo'))

    let detailRes = await router.fetch(new URL(routes.ships.detail.href({ id: shipAId }), 'http://localhost'), {
      headers: { cookie: surveyor.cookie },
    })
    assert.equal(detailRes.status, 200)
    let detailHtml = await detailRes.text()
    assert.ok(detailHtml.includes('Public Hold Note'))
    assert.ok(detailHtml.includes('Internal Surveyor Note'))
  })
})
