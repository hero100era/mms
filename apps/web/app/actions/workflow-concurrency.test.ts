import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'

// R2.2 required test: two independent PostgreSQL connections attempt the first
// revision of the SAME logical document concurrently. The unique logical-document
// constraint plus the row lock must produce one document with revisions 1 and 2,
// never two documents or a duplicate revision.
const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

const ORG = 'f3333333-0000-0000-0000-000000000001'
const SHIP = 'f3333333-0000-0000-0000-000000000010'
const USER = 'f3333333-0000-0000-0000-000000000031'
const REQUEST = 'f3333333-0000-0000-0000-000000000020'

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

describe('R2.2 concurrent first revision', () => {
  let pool: Pool

  before(async () => {
    pool = new Pool({ connectionString: adminUrl, max: 4 })
    // Committed fixtures: both connections must see the same request row.
    await pool.query(
      `insert into party.organization (id, name, org_type, status)
       values ($1, 'Concurrency Shipping', 'company', 'active')
       on conflict (id) do nothing`,
      [ORG],
    )
    await pool.query(
      `insert into fleet.ship (id, imo_number, name, type_iacs, type_mms, flag_code, gross_tonnage, build_year, status)
       values ($1, '9123777', 'MV Concurrency', 'BC', 'BC', 'PA', 30000, 2020, 'in_service')
       on conflict (id) do nothing`,
      [SHIP],
    )
    await pool.query(
      `insert into iam.app_user (id, kind, display_name, email, status)
       values ($1, 'external', 'Concurrency Requester', 'concurrency@example.com', 'active')
       on conflict (id) do nothing`,
      [USER],
    )
    await pool.query(
      `insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by)
       values ($1, 'external', $2, 'requester', '00000000-0000-0000-0000-000000000001')
       on conflict do nothing`,
      [USER, ORG],
    )
    await pool.query(
      `delete from core.document_version
        where document_id in (select id from core.document where entity_id = $1)`,
      [REQUEST],
    )
    await pool.query('delete from core.document where entity_id = $1', [REQUEST])
    await pool.query('delete from survey.survey_request where id = $1', [REQUEST])
    await pool.query(
      `insert into survey.survey_request (id, request_no, ship_id, org_id, office_unit_id, port_name, survey_types)
       values ($1, 'CONC-1', $2, $3, (select id from core.org_unit where code = 'SHA'), 'Shanghai', array['annual_hull'])`,
      [REQUEST, SHIP, ORG],
    )
  })

  after(async () => {
    await pool.query(
      `delete from core.document_version
        where document_id in (select id from core.document where entity_id = $1)`,
      [REQUEST],
    )
    await pool.query('delete from core.document where entity_id = $1', [REQUEST])
    await pool.query('delete from survey.survey_request where id = $1', [REQUEST])
    await pool.query('delete from iam.org_membership where user_id = $1', [USER])
    await pool.query('delete from iam.app_user where id = $1', [USER])
    await pool.query('delete from fleet.ship where id = $1', [SHIP])
    await pool.query('delete from party.organization where id = $1', [ORG])
    await pool.end()
  })

  it('two independent connections create one logical document with revisions 1 and 2', async () => {
    let a = await pool.connect()
    let b = await pool.connect()
    try {
      let run = async (client: typeof a, label: string) => {
        await client.query('begin')
        try {
          await client.query(
            `select set_config('request.jwt.claims', jsonb_build_object(
               'sub', $1::text, 'role', 'ext_user',
               'sid', 'f3333333-0000-0000-0000-000000000099')::text, true)`,
            [USER],
          )
          let result = await client.query<{ id: string }>(
            `select api.document_create_version(
               'survey_request', $1, 'specification', 'Concurrent spec', $2,
               'application/pdf', 1024, $3, $4) as id`,
            [REQUEST, `${label}.pdf`, digest(label), `quarantine/concurrency/${label}.pdf`],
          )
          await client.query('commit')
          return result.rows[0]!.id
        } catch (error) {
          await client.query('rollback')
          throw error
        }
      }

      // No artificial delay: both transactions start together and the database
      // must serialize them via the logical-document row lock.
      let [first, second] = await Promise.all([run(a, 'first'), run(b, 'second')])
      assert.notEqual(first, second, 'each caller receives its own version id')

      let docs = await pool.query<{ id: string; title: string }>(
        `select id, title from core.document
          where entity_type = 'survey_request' and entity_id = $1 and doc_type = 'specification'`,
        [REQUEST],
      )
      assert.equal(docs.rows.length, 1, 'exactly one logical document exists')

      let revisions = await pool.query<{ revision_no: number }>(
        `select revision_no from core.document_version
          where document_id = $1 order by revision_no`,
        [docs.rows[0]!.id],
      )
      assert.deepEqual(
        revisions.rows.map((row) => row.revision_no),
        [1, 2],
        'revisions are distinct and sequential',
      )
    } finally {
      a.release()
      b.release()
    }
  })
})
