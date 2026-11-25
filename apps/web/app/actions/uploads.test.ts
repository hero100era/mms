import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { Pool } from 'pg'
import { ensureTestJwtKey, extractCsrfToken, extractFirstCookie, getTestDbUrl } from '@mms/test-utils'

import { sessionStorage, sessionCookie } from '../auth/session-cookie.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { sessionCreate } from '../auth/service.ts'
import { router as appRouter } from '../router.ts'
import { routes } from '../routes.ts'
import { resetStorageForTest } from '../storage/service.ts'
import { sha256Hex } from '../storage/sniff.ts'
import { dbUploadMarkUploaded } from '../storage/upload-repository.ts'

// `cop()` (cross-origin protection) and `csrf()` reject an unsafe request that
// carries no browser provenance, so a bare `router.fetch` is refused with 403
// before it reaches the action. A browser always sends `Origin` and
// `Sec-Fetch-Site` on a same-origin form/fetch submission, so the tests send
// them too instead of asserting against a request no browser would make.
const ORIGIN = 'http://localhost'
const router = {
  fetch(input: URL, init?: RequestInit): Promise<Response> {
    let headers = new Headers(init?.headers)
    if (!headers.has('Origin')) headers.set('Origin', ORIGIN)
    if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin')
    return appRouter.fetch(input, { ...init, headers })
  },
}

const adminUrl = getTestDbUrl()

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

interface TestUserSession {
  cookie: string
  csrf: string
}

describe('Card S-03: Uploads short-lived write-only SAS to quarantine -> finalize -> promote', () => {
  let adminPool: Pool

  // Test UUIDs
  const orgAId = 'f0000000-0000-0000-0000-000000000001'
  const orgBId = 'f0000000-0000-0000-0000-000000000002'
  const shipAId = 'f0000000-0000-0000-0000-000000000010'
  const userAId = 'f0000000-0000-0000-0000-000000000031' // Alice Acme (ext_user, Org A)
  const userBId = 'f0000000-0000-0000-0000-000000000032' // Bob Bravo (ext_user, Org B)
  const coordShaId = 'f0000000-0000-0000-0000-000000000041' // Sam Coord (SHA Station)
  const internId = 'f0000000-0000-0000-0000-000000000045' // Tim Intern
  const compId = 'f0000000-0000-0000-0000-000000000046' // Helen Compliance

  let testReqActiveId: string
  let testReqRejectedId: string

  let userA: TestUserSession
  let userB: TestUserSession
  let coord: TestUserSession
  let intern: TestUserSession
  let comp: TestUserSession

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    adminPool = new Pool({ connectionString: adminUrl })
    clearSessionCaches()
    resetStorageForTest()

    let userIds = [userAId, userBId, coordShaId, internId, compId]
    await adminPool.query(`delete from iam.session where user_id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.org_membership where user_id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.app_user where id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from fleet.ship_party where ship_id = $1`, [shipAId])
    await adminPool.query(`delete from fleet.ship where id = $1`, [shipAId])
    await adminPool.query(`delete from party.organization where id in ($1, $2)`, [orgAId, orgBId])

    // 1. Seed test organizations
    await adminPool.query(`
      insert into party.organization (id, name, org_type, status) values
        ('${orgAId}', 'Acme Shipping Line', 'company', 'active'),
        ('${orgBId}', 'Bravo Tankers Corp', 'company', 'active')
      on conflict (id) do nothing;
    `)

    // 2. Seed test ship & affiliation
    await adminPool.query(`
      insert into fleet.ship (id, imo_number, name, ship_type, flag_code, gross_tonnage, build_year, status) values
        ('${shipAId}', '9876543', 'MV Acme Pioneer', 'bulk_carrier', 'PA', 35000, 2018, 'in_service')
      on conflict (id) do nothing;

      insert into fleet.ship_party (ship_id, org_id, party_role, valid)
      select '${shipAId}', '${orgAId}', 'registered_owner', tstzrange(now() - interval '1 year', null)
      where not exists (
        select 1 from fleet.ship_party where ship_id = '${shipAId}' and org_id = '${orgAId}' and party_role = 'registered_owner'
      );
    `)

    // 3. Seed test users
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id) values
        ('${userAId}', 'external', 'Alice Acme Requester', 'alice.upload.test@example.com', 'active', now(), null, null),
        ('${userBId}', 'external', 'Bob Bravo Requester', 'bob.upload.test@example.com', 'active', now(), null, null),
        ('${coordShaId}', 'internal', 'Sam Coord Shanghai', 'sam.coord.upload.test@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000041'),
        ('${internId}', 'internal', 'Tim Intern Shanghai', 'tim.intern.upload.test@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000045'),
        ('${compId}', 'internal', 'Helen Compliance', 'helen.comp.upload.test@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000046')
      on conflict (id) do update set status = 'active';

      insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by)
      select '${userAId}', 'external', '${orgAId}', 'requester', '00000000-0000-0000-0000-000000000001'
      where not exists (select 1 from iam.org_membership where user_id = '${userAId}' and org_id = '${orgAId}');

      insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by)
      select '${userBId}', 'external', '${orgBId}', 'requester', '00000000-0000-0000-0000-000000000001'
      where not exists (select 1 from iam.org_membership where user_id = '${userBId}' and org_id = '${orgBId}');
    `)

    // 4. Staff positions and role assignments
    await adminPool.query(`
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${coordShaId}', 'internal', 'senior_admins', 'office_admin', u.id,
             tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'test'
        from core.org_unit u where u.code = 'SHA'
         and not exists (select 1 from iam.staff_position where user_id = '${coordShaId}');

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${coordShaId}', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'test'
        from core.org_unit u where u.code = 'SHA'
         and not exists (select 1 from iam.role_assignment where user_id = '${coordShaId}' and db_role = 'int_coordinator');

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${internId}', 'internal', 'int_viewer', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'test'
        from core.org_unit u where u.code = 'SHA'
         and not exists (select 1 from iam.role_assignment where user_id = '${internId}' and db_role = 'int_viewer');

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${compId}', 'internal', 'int_compliance', 'global', null, 'manual', '00000000-0000-0000-0000-000000000001', 'test'
      where not exists (select 1 from iam.role_assignment where user_id = '${compId}' and db_role = 'int_compliance');
    `)

    // Create session helper
    async function createTestSession(userId: string, role: string, kind: 'internal' | 'external'): Promise<TestUserSession> {
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
        authTime: new Date().toISOString(),
        // External password users have already satisfied the second factor (H-09)
        // when the BFF lets them past requireMfa().
        mfaVerifiedAt: kind === 'internal' ? undefined : new Date().toISOString(),
        assignableRoles: [role],
      })
      await sessionStorage.save(session)
      let cookie = await makeSignedSessionCookie(sid)
      return { cookie, csrf }
    }

    userA = await createTestSession(userAId, 'ext_user', 'external')
    userB = await createTestSession(userBId, 'ext_user', 'external')
    coord = await createTestSession(coordShaId, 'int_coordinator', 'internal')
    intern = await createTestSession(internId, 'int_viewer', 'internal')
    comp = await createTestSession(compId, 'int_compliance', 'internal')

    // Find Shanghai Station unit ID
    let shaUnitRes = await adminPool.query<{ id: string }>(`select id from core.org_unit where code = 'SHA'`)
    let shaUnitId = shaUnitRes.rows[0].id

    // Create test active survey request for Org A
    let reqRes = await adminPool.query<{ id: string }>(
      `insert into survey.survey_request (
         org_id, ship_id, office_unit_id, status, request_no, survey_types,
         port_name, port_country, port_code, scope_description, created_by
       ) values (
         $1, $2, $3, 'draft', 'SR-TEST-UPLOAD-01', array['annual_hull'],
         'Shanghai Port', 'China', 'CNSHA', 'Upload Test Survey Request', $4
       ) returning id`,
      [orgAId, shipAId, shaUnitId, userAId],
    )
    testReqActiveId = reqRes.rows[0].id

    // Create test rejected survey request for Org A
    let rejRes = await adminPool.query<{ id: string }>(
      `insert into survey.survey_request (
         org_id, ship_id, office_unit_id, status, request_no, survey_types,
         port_name, port_country, port_code, scope_description, created_by
       ) values (
         $1, $2, $3, 'rejected', 'SR-TEST-UPLOAD-REJ', array['annual_hull'],
         'Shanghai Port', 'China', 'CNSHA', 'Rejected Upload Request', $4
       ) returning id`,
      [orgAId, shipAId, shaUnitId, userAId],
    )
    testReqRejectedId = rejRes.rows[0].id
  })

  after(async () => {
    delete process.env.MMS_FORCE_PROD_STORAGE
    let userIds = [userAId, userBId, coordShaId, internId, compId]
    // Clean up created documents and requests
    await adminPool.query(`delete from core.upload where entity_id in ($1, $2)`, [testReqActiveId, testReqRejectedId])
    await adminPool.query(`delete from core.document_version where document_id in (select id from core.document where entity_id in ($1, $2))`, [testReqActiveId, testReqRejectedId])
    await adminPool.query(`delete from core.document where entity_id in ($1, $2)`, [testReqActiveId, testReqRejectedId])
    await adminPool.query(`delete from survey.survey_request where id in ($1, $2)`, [testReqActiveId, testReqRejectedId])
    await adminPool.query(`delete from iam.session where user_id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.role_assignment where user_id = any($1::uuid[]) or granted_by = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.staff_position where user_id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.org_membership where user_id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from iam.app_user where id = any($1::uuid[])`, [userIds])
    await adminPool.query(`delete from fleet.ship_party where ship_id = $1`, [shipAId])
    await adminPool.query(`delete from fleet.ship where id = $1`, [shipAId])
    await adminPool.query(`delete from party.organization where id in ($1, $2)`, [orgAId, orgBId])
    await adminPool.end()
  })

  let uploadId: string
  let quarantinePath: string
  let uploadUrl: string
  let documentVersionId: string
  let documentId: string
  const samplePdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Hull Inspection Plan) >>\nendobj\n%%EOF')
  const samplePdfSha256 = sha256Hex(samplePdfBytes)
  const sampleTextBytes = Buffer.from('Specification text notes for machinery survey\n')

  it('unauthenticated request without session or token returns 401 or 403', async () => {
      let anon = await getAnonSession()
      let res = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: anon.cookie,
          'X-Csrf-Token': anon.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })
      assert.equal(res.status, 401)
    })

    it('intern and compliance roles are denied preparing upload (403)', async () => {
      let resIntern = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: intern.cookie,
          'X-Csrf-Token': intern.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })
      assert.equal(resIntern.status, 403)

      let resComp = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: comp.cookie,
          'X-Csrf-Token': comp.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })
      assert.equal(resComp.status, 403)
    })

    it('external user B cannot prepare upload for Org A survey request (404/403)', async () => {
      let res = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userB.cookie,
          'X-Csrf-Token': userB.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })
      assert.ok(res.status === 404 || res.status === 403)
    })

    it('cannot prepare upload for a rejected survey request (400)', async () => {
      let res = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })
      // Active works
      assert.equal(res.status, 200)

      let resRej = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqRejectedId,
          docType: 'specification',
          fileName: 'plan.pdf',
        }),
      })
      assert.equal(resRej.status, 400)
      let json = await resRej.json()
      assert.match(json.error, /cannot attach document to rejected request/)
    })

    it('Step 1: Prepares upload and receives short-lived write-only upload SAS/URL', async () => {
      let res = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'hull_plan.pdf',
          expiresInMinutes: 15,
        }),
      })

      assert.equal(res.status, 200)
      let json = await res.json()
      assert.ok(json.uploadId)
      assert.ok(json.quarantinePath.startsWith(`quarantine/${json.uploadId}/`))
      assert.ok(json.uploadUrl)
      assert.equal(json.writeOnly, true)
      assert.ok(new Date(json.expiresAt).getTime() > Date.now())

      uploadId = json.uploadId
      quarantinePath = json.quarantinePath
      uploadUrl = json.uploadUrl
    })

    it('Step 2: Uploads file bytes to write-only quarantine URL', async () => {
      // Tampered token fails
      let tamperedUrl = uploadUrl.replace(/token=[a-f0-9]+/, 'token=badtoken123')
      let failRes = await router.fetch(new URL(tamperedUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: samplePdfBytes,
      })
      assert.equal(failRes.status, 403)

      // Valid upload succeeds
      let uploadRes = await router.fetch(new URL(uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: samplePdfBytes,
      })
      assert.equal(uploadRes.status, 201)
    })

    it('Step 3: Finalizes upload, computing SHA-256, sniffing MIME, promoting to permanent storage in dev', async () => {
      let res = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          uploadId,
          quarantinePath,
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          title: 'Hull Inspection Plan',
          fileName: 'hull_plan.pdf',
        }),
      })

      assert.equal(res.status, 200)
      let json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.versionId)
      assert.equal(json.sha256, samplePdfSha256)
      assert.equal(json.byteSize, samplePdfBytes.length)
      assert.equal(json.mimeType, 'application/pdf')
      assert.equal(json.status, 'promoted')
      assert.equal(json.isQuarantined, false)
      assert.ok(json.storagePath.startsWith('documents/survey_request/'))

      documentVersionId = json.versionId

      // Retrieve documentId from DB
      let docRes = await adminPool.query<{ document_id: string }>(
        `select document_id from core.document_version where id = $1`,
        [documentVersionId],
      )
      documentId = docRes.rows[0].document_id
    })

    it('Step 4: Owner can download promoted document version with proper headers', async () => {
      let downloadHref = routes.uploads.documentDownload.href({
        documentId,
        versionId: documentVersionId,
      })

      let res = await router.fetch(new URL(downloadHref, 'http://localhost'), {
        method: 'GET',
        headers: { cookie: userA.cookie },
      })

      assert.equal(res.status, 200)
      assert.equal(res.headers.get('Content-Type'), 'application/pdf')
      assert.match(res.headers.get('Content-Disposition') || '', /hull_plan\.pdf/)
      assert.equal(res.headers.get('ETag'), `"${samplePdfSha256}"`)

      let arrayBuffer = await res.arrayBuffer()
      assert.equal(Buffer.from(arrayBuffer).toString('utf8'), samplePdfBytes.toString('utf8'))
    })

    it('Step 5: External user B is denied downloading user A document (404/403)', async () => {
      let downloadHref = routes.uploads.documentDownload.href({
        documentId,
        versionId: documentVersionId,
      })

      let res = await router.fetch(new URL(downloadHref, 'http://localhost'), {
        method: 'GET',
        headers: { cookie: userB.cookie },
      })

      assert.ok(res.status === 404 || res.status === 403)
    })

    it('outside dev, uploads stay quarantined upon finalize', async () => {
      process.env.MMS_FORCE_PROD_STORAGE = '1'
      process.env.MMS_UPLOAD_SECRET = 'test-upload-secret-outside-dev'

      // 1. Prepare
      let prepRes = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'machinery_notes.txt',
        }),
      })
      assert.equal(prepRes.status, 200)
      let prepJson = await prepRes.json()
      uploadId = prepJson.uploadId
      quarantinePath = prepJson.quarantinePath
      uploadUrl = prepJson.uploadUrl

      // 2. Upload
      let upRes = await router.fetch(new URL(uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: sampleTextBytes,
      })
      assert.equal(upRes.status, 201)

      // 3. Finalize outside dev
      let finRes = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          uploadId,
          quarantinePath,
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          title: 'Machinery Notes',
          fileName: 'machinery_notes.txt',
        }),
      })

      assert.equal(finRes.status, 200)
      let finJson = await finRes.json()
      // Outside dev: file stays quarantined!
      assert.equal(finJson.status, 'quarantined')
      assert.equal(finJson.isQuarantined, true)
      assert.ok(finJson.storagePath.startsWith('quarantine/'))

      documentVersionId = finJson.versionId
      let docRes = await adminPool.query<{ document_id: string }>(
        `select document_id from core.document_version where id = $1`,
        [documentVersionId],
      )
      documentId = docRes.rows[0].document_id
    })

    it('download is blocked while file remains in quarantine outside dev (423 Locked)', async () => {
      let downloadHref = routes.uploads.documentDownload.href({
        documentId,
        versionId: documentVersionId,
      })

      let res = await router.fetch(new URL(downloadHref, 'http://localhost'), {
        method: 'GET',
        headers: { cookie: userA.cookie },
      })

      assert.equal(res.status, 423)
      let json = await res.json()
      assert.equal(json.error, 'quarantined_pending_scan')
      assert.match(json.message, /awaiting malware scanning/)
    })

    it('H-05 malware scanning / promotion unblocks the quarantined file and updates database natively', async () => {
      // This flow exercises the production promote path, so make sure the
      // previous test's dev-storage override does not leak into it.
      delete process.env.MMS_FORCE_PROD_STORAGE
      delete process.env.MMS_UPLOAD_SECRET

      let promoteHref = routes.uploads.promote.href({ versionId: documentVersionId })

      // External user cannot promote (403)
      let extFailRes = await router.fetch(new URL(promoteHref, 'http://localhost'), {
        method: 'POST',
        headers: {
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
      })
      assert.equal(extFailRes.status, 403)

      // Intern cannot promote (403)
      let internFailRes = await router.fetch(new URL(promoteHref, 'http://localhost'), {
        method: 'POST',
        headers: {
          cookie: intern.cookie,
          'X-Csrf-Token': intern.csrf,
        },
      })
      assert.equal(internFailRes.status, 403)

      // Authorized coordinator promotes via API
      let res = await router.fetch(new URL(promoteHref, 'http://localhost'), {
        method: 'POST',
        headers: {
          cookie: coord.cookie,
          'X-Csrf-Token': coord.csrf,
        },
      })

      assert.equal(res.status, 200)
      let json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.promotedPath && json.promotedPath.startsWith("documents/survey_request/"), JSON.stringify(json))

      // No adminPool update hack needed! The endpoint updated the DB via PostgREST RPC.
      // Verify download is now unblocked and succeeds directly from clean storage!
      let downloadHref = routes.uploads.documentDownload.href({
        documentId,
        versionId: documentVersionId,
      })

      let dlRes = await router.fetch(new URL(downloadHref, 'http://localhost'), {
        method: 'GET',
        headers: { cookie: userA.cookie },
      })

      assert.equal(dlRes.status, 200)
      let arrayBuffer = await dlRes.arrayBuffer()
      assert.equal(Buffer.from(arrayBuffer).toString('utf8'), sampleTextBytes.toString('utf8'))

      // Calling promote a second time returns 400 (already promoted)
      let secondPromoteRes = await router.fetch(new URL(promoteHref, 'http://localhost'), {
        method: 'POST',
        headers: {
          cookie: coord.cookie,
          'X-Csrf-Token': coord.csrf,
        },
      })
      assert.equal(secondPromoteRes.status, 400)
    })

    it('uploadFinalize rejects mismatched or forged quarantinePath (400)', async () => {
      let prepRes = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'security_test.pdf',
        }),
      })
      let prep = await prepRes.json()

      // Attacking with forged quarantinePath pointing outside upload directory
      let forgedRes = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          uploadId: prep.uploadId,
          quarantinePath: 'documents/survey_request/other/secret.pdf', // Forged path!
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          title: 'Forged Upload',
          fileName: 'security_test.pdf',
        }),
      })
      assert.equal(forgedRes.status, 400)
      let forgedJson = await forgedRes.json()
      assert.equal(forgedJson.error, 'invalid_quarantine_path')
    })

    it('uploadFinalize denies intern and compliance roles before mutating storage (403)', async () => {
      let res = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: intern.cookie,
          'X-Csrf-Token': intern.csrf,
        },
        body: JSON.stringify({
          uploadId: '11111111-1111-1111-1111-111111111111',
          quarantinePath: 'quarantine/11111111-1111-1111-1111-111111111111/test.pdf',
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          title: 'Intern Finalize',
          fileName: 'test.pdf',
        }),
      })
      assert.equal(res.status, 403)
    })

    it('revising a document with the same file name produces unique non-colliding storage paths', async () => {
      delete process.env.MMS_FORCE_PROD_STORAGE
      delete process.env.MMS_UPLOAD_SECRET

      // Upload revision 1
      let prep1 = await (await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: userA.cookie, 'X-Csrf-Token': userA.csrf },
        body: JSON.stringify({ entityType: 'survey_request', entityId: testReqActiveId, docType: 'general_arrangement', fileName: 'ga_plan.pdf' }),
      })).json()

      await router.fetch(new URL(prep1.uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 Revision 1 GA Plan'),
      })

      let fin1 = await (await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: userA.cookie, 'X-Csrf-Token': userA.csrf },
        body: JSON.stringify({
          uploadId: prep1.uploadId,
          quarantinePath: prep1.quarantinePath,
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'general_arrangement',
          title: 'GA Plan',
          fileName: 'ga_plan.pdf',
        }),
      })).json()

      // Upload revision 2 with SAME file name
      let prep2 = await (await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: userA.cookie, 'X-Csrf-Token': userA.csrf },
        body: JSON.stringify({ entityType: 'survey_request', entityId: testReqActiveId, docType: 'general_arrangement', fileName: 'ga_plan.pdf' }),
      })).json()

      await router.fetch(new URL(prep2.uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 Revision 2 GA Plan with updates'),
      })

      let fin2 = await (await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: userA.cookie, 'X-Csrf-Token': userA.csrf },
        body: JSON.stringify({
          uploadId: prep2.uploadId,
          quarantinePath: prep2.quarantinePath,
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'general_arrangement',
          title: 'GA Plan',
          fileName: 'ga_plan.pdf',
        }),
      })).json()

      assert.equal(fin1.success, true)
      assert.equal(fin2.success, true)
      // Storage paths must be distinct!
      assert.notEqual(fin1.storagePath, fin2.storagePath)

      // Retrieve revision 1 and revision 2 downloads and confirm contents are independent
      let docIdRes = await adminPool.query<{ document_id: string }>(`select document_id from core.document_version where id = $1`, [fin1.versionId])
      let docId = docIdRes.rows[0].document_id

      let dl1 = await router.fetch(new URL(routes.uploads.documentDownload.href({ documentId: docId, versionId: fin1.versionId }), 'http://localhost'), {
        method: 'GET',
        headers: { cookie: userA.cookie },
      })
      let dl2 = await router.fetch(new URL(routes.uploads.documentDownload.href({ documentId: docId, versionId: fin2.versionId }), 'http://localhost'), {
        method: 'GET',
        headers: { cookie: userA.cookie },
      })

      let text1 = Buffer.from(await dl1.arrayBuffer()).toString('utf8')
      let text2 = Buffer.from(await dl2.arrayBuffer()).toString('utf8')
      assert.equal(text1, '%PDF-1.4 Revision 1 GA Plan')
      assert.equal(text2, '%PDF-1.4 Revision 2 GA Plan with updates')
    })

    it('finalize with missing quarantine file returns 400', async () => {
      delete process.env.MMS_FORCE_PROD_STORAGE
      delete process.env.MMS_UPLOAD_SECRET
      let prepRes = await (await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: userA.cookie, 'X-Csrf-Token': userA.csrf },
        body: JSON.stringify({ entityType: 'survey_request', entityId: testReqActiveId, docType: 'specification', fileName: 'missing.pdf' }),
      })).json()

      await dbUploadMarkUploaded({
        uploadId: prepRes.uploadId,
        sha256Hex: '0000000000000000000000000000000000000000000000000000000000000000',
        byteSize: 100,
        mimeType: 'application/pdf',
      })

      let res = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          uploadId: prepRes.uploadId,
          quarantinePath: prepRes.quarantinePath,
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          title: 'Missing File',
          fileName: 'missing.pdf',
        }),
      })

      assert.equal(res.status, 400)
      let json = await res.json()
      assert.match(json.error, /quarantine_verification_failed/)
    })

    it('spoofed MIME type is corrected to actual sniffed type', async () => {
      // Upload text file named as pdf
      let prepRes = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          fileName: 'pretend.pdf',
        }),
      })
      let prep = await prepRes.json()

      let textContent = Buffer.from('This is plain text pretending to be a PDF binary.\n')
      let putRes = await router.fetch(new URL(prep.uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' }, // Spoofed header!
        body: textContent,
      })
      assert.equal(putRes.status, 201)

      delete process.env.MMS_FORCE_PROD_STORAGE
      delete process.env.MMS_UPLOAD_SECRET
      let finRes = await router.fetch(new URL(routes.uploads.finalize.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userA.cookie,
          'X-Csrf-Token': userA.csrf,
        },
        body: JSON.stringify({
          uploadId: prep.uploadId,
          quarantinePath: prep.quarantinePath,
          entityType: 'survey_request',
          entityId: testReqActiveId,
          docType: 'specification',
          title: 'Pretend PDF',
          fileName: 'pretend.pdf',
        }),
      })

      assert.equal(finRes.status, 200)
      let fin = await finRes.json()
      // Server sniffed type must NOT be application/pdf
      assert.notEqual(fin.mimeType, 'application/pdf')
      assert.equal(fin.mimeType, 'text/plain')
    })
})

