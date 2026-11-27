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
import {
  DOCUMENT_CATEGORY_LIMITS,
  getMaxUploadBytesForDocType,
  inspectQuarantineFile,
  putQuarantineFile,
  putQuarantineStream,
  resetStorageForTest,
} from '../storage/service.ts'
import { sha256Hex } from '../storage/sniff.ts'
import { MAX_FORM_BODY_BYTES, MAX_JSON_BODY_BYTES } from '../middleware/body-limits.ts'
import { readJsonWithLimit } from './uploads/controller.tsx'

const dbUrl = getTestDbUrl()

async function makeSignedSessionCookie(sid: string): Promise<string> {
  let cookieVal = JSON.stringify({
    value: sid,
    expires: Date.now() + 12 * 60 * 60 * 1000,
  })
  let raw = await sessionCookie.serialize(cookieVal)
  return extractFirstCookie(raw)
}

describe('R4.3: Request-body and upload limits with streaming quarantine', () => {
  let pool: Pool
  let coordinatorCookie: string
  let coordinatorCsrf: string
  const testUserId = 'c4300000-0000-0000-0000-000000000001'
  const testOrgId = 'c4300000-0000-0000-0000-000000000002'
  const testShipId = 'c4300000-0000-0000-0000-000000000003'
  let testSurveyReqId: string

  before(async () => {
    ensureTestJwtKey(import.meta.url)

    pool = new Pool({ connectionString: dbUrl })
    clearSessionCaches()
    resetStorageForTest()

    // 1. Clean previous artifacts
    await pool.query(`delete from iam.session where user_id = $1`, [testUserId])
    await pool.query(`delete from iam.role_assignment where user_id = $1`, [testUserId])
    await pool.query(`delete from iam.staff_position where user_id = $1`, [testUserId])
    await pool.query(`delete from survey.survey_request where org_id = $1`, [testOrgId])
    await pool.query(`delete from fleet.ship_party where ship_id = $1`, [testShipId])
    await pool.query(`delete from fleet.ship where id = $1`, [testShipId])
    await pool.query(`delete from iam.app_user where id = $1`, [testUserId])
    await pool.query(`delete from party.organization where id = $1`, [testOrgId])

    // 2. Seed Org, Ship, User
    await pool.query(`
      insert into party.organization (id, name, org_type, status)
      values ('${testOrgId}', 'R43 Test Org', 'company', 'active')
      on conflict (id) do nothing;
    `)
    await pool.query(`
      insert into fleet.ship (id, imo_number, name, type_iacs, type_mms, flag_code, gross_tonnage, build_year, status)
      values ('${testShipId}', '9777666', 'MV Limits Tester', 'BC', 'BC', 'PA', 40000, 2021, 'in_service')
      on conflict (id) do nothing;

      insert into fleet.ship_party (ship_id, org_id, party_role, valid)
      values ('${testShipId}', '${testOrgId}', 'registered_owner', tstzrange(now() - interval '1 year', null))
      on conflict do nothing;
    `)
    await pool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, email_verified_at, entra_tenant_id, entra_object_id)
      values ('${testUserId}', 'internal', 'R43 Coordinator', 'r43.coord@mms.example.com', 'active', now(), '11111111-1111-1111-1111-111111111111', '${testUserId}')
      on conflict (id) do update set status = 'active';

      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      select '${testUserId}', 'internal', 'senior_admins', 'office_admin', u.id, tstzrange(now() - interval '1 day', null), '00000000-0000-0000-0000-000000000001', 'r43 fixture'
        from core.org_unit u where u.code = 'SHA' limit 1;

      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
      select '${testUserId}', 'internal', 'int_coordinator', 'unit', u.id, 'manual', '00000000-0000-0000-0000-000000000001', 'r43 fixture'
        from core.org_unit u where u.code = 'SHA' limit 1;
    `)

    // Create a survey request for upload tests
    let reqRes = await pool.query<{ id: string }>(`
      insert into survey.survey_request (
        org_id, ship_id, office_unit_id, status, request_no, survey_types,
        port_name, port_country, port_code, scope_description, created_by
      )
      select '${testOrgId}', '${testShipId}', u.id, 'submitted', 'SR-R43-TEST', array['annual_hull'],
             'Shanghai Port', 'CN', 'CNSHA', 'Limits Test Survey Request', '${testUserId}'
      from core.org_unit u where u.code = 'SHA' limit 1
      returning id;
    `)
    testSurveyReqId = reqRes.rows[0].id

    // Create session
    let created = await sessionCreate(testUserId, 'entra', 'int_coordinator', '127.0.0.1', 'test-agent')
    let sid = created.session_id
    let session = await sessionStorage.read(sid)
    coordinatorCsrf = randomUUID()
    session.set('_csrf', coordinatorCsrf)
    session.set('auth', {
      userId: testUserId,
      kind: 'internal',
      email: 'r43.coord@mms.example.com',
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

  describe('1. Maximum ordinary form and JSON body limits', () => {
    it('rejects an ordinary form post exceeding 2 MiB with 413 Payload Too Large', async () => {
      // Create a 2.5 MiB string payload
      let oversized = 'x'.repeat(MAX_FORM_BODY_BYTES + 100 * 1024)
      let form = new FormData()
      form.set('_csrf', coordinatorCsrf)
      form.set('scope_description', oversized)

      let res = await router.fetch(new URL(routes.survey.create.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
        },
        body: form,
      })

      assert.equal(res.status, 413)
      let problem = await res.json()
      assert.equal(problem.code, 'PAYLOAD_TOO_LARGE')
      assert.equal(problem.type, 'https://mms.local/problems/payload-too-large')
    })

    it('rejects an ordinary JSON post exceeding 1 MiB with 413 Payload Too Large', async () => {
      let oversized = 'x'.repeat(MAX_JSON_BODY_BYTES + 50 * 1024)
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
          entityId: testSurveyReqId,
          docType: 'specification',
          fileName: 'test.pdf',
          extraData: oversized,
        }),
      })

      assert.equal(res.status, 413)
      let problem = await res.json()
      assert.equal(problem.code, 'PAYLOAD_TOO_LARGE')
      assert.equal(problem.type, 'https://mms.local/problems/payload-too-large')
    })

    it('readJsonWithLimit aborts chunked JSON streams chunk-by-chunk without Content-Length when limit is exceeded', async () => {
      let chunksProduced = 0
      let stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksProduced < 20) {
            chunksProduced++
            controller.enqueue(new TextEncoder().encode('{"data":"' + 'x'.repeat(100) + '"}'))
          } else {
            controller.close()
          }
        },
      })

      let req = new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
        // @ts-expect-error duplex required for streaming bodies in Node
        duplex: 'half',
      })

      // Set maxBytes = 250 so that it aborts after 2 chunks instead of reading all 20
      await assert.rejects(
        async () => {
          await readJsonWithLimit(req, 250)
        },
        (err: any) => {
          assert.equal(err.status, 413)
          assert.ok(chunksProduced < 10, `Stream should have aborted early, produced ${chunksProduced} chunks`)
          return true
        },
      )
    })
  })

  describe('2. Document category upload limits', () => {
    it('resolves correct category limits for drawings, specifications, and certificates', () => {
      assert.equal(getMaxUploadBytesForDocType('general_arrangement'), 100 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('spec_drawing'), 100 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('specification'), 25 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('hull_report'), 25 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('boiler_log'), 25 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('certificate'), 10 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('identity'), 10 * 1024 * 1024)
      assert.equal(getMaxUploadBytesForDocType('unknown_doc_type'), 10 * 1024 * 1024)
    })

    it('binds the category limit to the signed token claims on prepare', async () => {
      let prepRes = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
          'X-Csrf-Token': coordinatorCsrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testSurveyReqId,
          docType: 'certificate',
          fileName: 'tonnage_cert.pdf',
        }),
      })

      assert.equal(prepRes.status, 200)
      let json = await prepRes.json()
      let uploadUrl = new URL(json.uploadUrl)
      assert.equal(uploadUrl.searchParams.get('maxBytes'), String(10 * 1024 * 1024))
    })

    it('rejects an upload exceeding its category limit before buffering when Content-Length is present', async () => {
      // 1. Prepare certificate upload (10 MiB limit)
      let prepRes = await router.fetch(new URL(routes.uploads.prepare.href(), 'http://localhost'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin',
          'Origin': 'http://localhost',
          cookie: coordinatorCookie,
          'X-Csrf-Token': coordinatorCsrf,
        },
        body: JSON.stringify({
          entityType: 'survey_request',
          entityId: testSurveyReqId,
          docType: 'certificate',
          fileName: 'oversized_cert.pdf',
        }),
      })

      assert.equal(prepRes.status, 200)
      let { uploadUrl } = await prepRes.json()

      // 2. PUT with declared Content-Length exceeding the 10 MiB certificate limit (12 MiB declared)
      let res = await router.fetch(new URL(uploadUrl), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(12 * 1024 * 1024),
        },
        body: Buffer.from('%PDF-1.4 simulated header'),
      })

      assert.equal(res.status, 413)
      let text = await res.text()
      assert.ok(text.includes('Payload Too Large'))
    })
  })

  describe('3. Direct streaming quarantine upload without full in-memory buffering', () => {
    it('streams chunks directly to storage, recording byte count and SHA-256 while streaming', async () => {
      let content = Buffer.from('%PDF-1.4\nTest Streamed Quarantine Content\n%%EOF\n')
      let expectedSha256Hex = sha256Hex(content)

      // Convert buffer into a streaming ReadableStream
      let stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // split into small chunks
          let chunkSize = 8
          for (let i = 0; i < content.length; i += chunkSize) {
            controller.enqueue(content.subarray(i, i + chunkSize))
          }
          controller.close()
        },
      })

      let result = await putQuarantineStream(
        'quarantine/stream-test/test.pdf',
        stream,
        'test.pdf',
        'application/pdf',
        25 * 1024 * 1024,
      )

      assert.equal(result.byteSize, content.length)
      assert.equal(result.sha256Hex, expectedSha256Hex)
    })

    it('aborts chunked stream immediately when byte count exceeds category limit without buffering entire body', async () => {
      let limit = 50 // small 50-byte limit
      let bytesProduced = 0

      // Generator that produces chunks up to 1000 bytes
      let stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesProduced < 1000) {
            bytesProduced += 20
            controller.enqueue(new Uint8Array(20).fill(65))
          } else {
            controller.close()
          }
        },
      })

      await assert.rejects(
        async () => {
          await putQuarantineStream(
            'quarantine/abort-test/file.bin',
            stream,
            'file.bin',
            'application/octet-stream',
            limit,
          )
        },
        (err: any) => {
          assert.equal(err.status, 413)
          assert.ok(err.message.includes('upload_too_large'))
          // Verify streaming stopped early and did not consume the full 1000 bytes
          assert.ok(bytesProduced < 200, `Stream should have aborted early, produced ${bytesProduced} bytes`)
          return true
        },
      )
    })

    it('rejects empty upload streams with HTTP 400', async () => {
      let emptyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })

      await assert.rejects(
        async () => {
          await putQuarantineStream(
            'quarantine/empty-test/file.bin',
            emptyStream,
            'file.bin',
            'application/octet-stream',
            1000,
          )
        },
        (err: any) => {
          assert.equal(err.status, 400)
          assert.ok(err.message.includes('upload_empty'))
          return true
        },
      )
    })

    it('inspectQuarantineFile checks file.size metadata and rejects oversized files before memory buffering', async () => {
      let qPath = 'quarantine/size-test/file.pdf'
      await putQuarantineFile(qPath, Buffer.from('%PDF-1.4 test buffer'), 'file.pdf', 'application/pdf')

      // Asking to inspect with a limit smaller than the file's size
      await assert.rejects(
        async () => {
          await inspectQuarantineFile(qPath, 5) // limit 5 bytes < length
        },
        (err: any) => {
          assert.ok(err.message.includes('upload_too_large'))
          return true
        },
      )
    })
  })
})
