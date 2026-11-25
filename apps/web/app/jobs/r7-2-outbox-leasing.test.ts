import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { Pool } from 'pg'

import { defaultAlerter, MemoryAlertSink } from '../audit_trail/alerter.ts'
import { sweepExpiredBreakGlass } from './break-glass-alerts.ts'
import { devMailbox } from './dev-mailbox.ts'
import { heartbeatJob, pollOnce } from './poller.ts'
import { getWorkerPool, closeWorkerPool } from './worker-client.ts'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@localhost:55432/mms_dev?host=/tmp'

describe('Phase R7.2: Durable outbox leasing, heartbeat, and dead-letter state machine', () => {
  let adminPool: Pool

  before(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`delete from core.outbox where payload ->> 'test_tag' = 'r7_2_test'`)
  })

  after(async () => {
    await adminPool.query(`delete from core.outbox where payload ->> 'test_tag' = 'r7_2_test'`)
    await adminPool.end()
    await closeWorkerPool()
  })

  beforeEach(async () => {
    devMailbox.clear()
    await adminPool.query(`delete from core.outbox where payload ->> 'test_tag' = 'r7_2_test'`)
  })

  it('1. durable leasing claims pending job, populates leased_by and lease_expires_at, and increments attempts', async () => {
    let insert = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, max_attempts)
      values ('invite_email', '{"email":"leasing_1@example.com","token":"t1","test_tag":"r7_2_test"}'::jsonb, 'pending', 3)
      returning id
    `)
    let jobId = insert.rows[0]!.id

    let client = await getWorkerPool().connect()
    try {
      await client.query('begin')
      let polled = await client.query<{ id: string }>(`select id from private.job_poll(10)`)
      let found = polled.rows.some((r) => r.id === jobId)
      assert.ok(found, 'job is visible to private.job_poll')

      let begun = await client.query<{ job_begin: { status: string; leased_by: string; attempts: number } }>(
        `select private.job_begin($1, 120, 'worker-alpha') as job_begin`,
        [jobId],
      )
      assert.equal(begun.rows[0]?.job_begin?.status, 'processing', 'job status is processing')
      assert.equal(begun.rows[0]?.job_begin?.leased_by, 'worker-alpha', 'leased_by is recorded')
      assert.equal(begun.rows[0]?.job_begin?.attempts, 1, 'attempts is incremented')
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }

    let row = (
      await adminPool.query<{
        status: string
        leased_by: string
        attempts: number
        has_lease: boolean
      }>(
        `select status, leased_by, attempts, (lease_expires_at > now()) as has_lease
           from core.outbox where id = $1`,
        [jobId],
      )
    ).rows[0]!

    assert.equal(row.status, 'processing')
    assert.equal(row.leased_by, 'worker-alpha')
    assert.equal(row.attempts, 1)
    assert.equal(row.has_lease, true)
  })

  it('2. heartbeatJob extends lease_expires_at for active processing jobs', async () => {
    let insert = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, max_attempts, leased_by, lease_expires_at)
      values ('invite_email', '{"email":"leasing_hb@example.com","token":"thb","test_tag":"r7_2_test"}'::jsonb,
              'processing', 3, 'worker-beta', now() + interval '30 seconds')
      returning id
    `)
    let jobId = insert.rows[0]!.id

    await heartbeatJob(jobId, 300)

    let row = (
      await adminPool.query<{ lease_remaining_secs: number }>(
        `select extract(epoch from (lease_expires_at - now()))::int as lease_remaining_secs
           from core.outbox where id = $1`,
        [jobId],
      )
    ).rows[0]!

    assert.ok(
      row.lease_remaining_secs >= 290 && row.lease_remaining_secs <= 305,
      `lease should be extended to ~300 seconds, got ${row.lease_remaining_secs}`,
    )
  })

  it('3. expired lease recovery allows another worker to reclaim abandoned job', async () => {
    let insert = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, attempts, max_attempts, leased_by, lease_expires_at)
      values ('invite_email', '{"email":"reclaim@example.com","token":"trc","test_tag":"r7_2_test"}'::jsonb,
              'processing', 1, 3, 'crashed-worker-99', now() - interval '10 seconds')
      returning id
    `)
    let jobId = insert.rows[0]!.id

    let client = await getWorkerPool().connect()
    try {
      await client.query('begin')
      let polled = await client.query<{ id: string }>(`select id from private.job_poll(10)`)
      let found = polled.rows.some((r) => r.id === jobId)
      assert.ok(found, 'expired processing job is included in job_poll')

      let reclaimed = await client.query<{ job_begin: { status: string; leased_by: string; attempts: number } }>(
        `select private.job_begin($1, 60, 'survivor-worker-01') as job_begin`,
        [jobId],
      )
      assert.equal(reclaimed.rows[0]?.job_begin?.status, 'processing')
      assert.equal(reclaimed.rows[0]?.job_begin?.leased_by, 'survivor-worker-01')
      assert.equal(reclaimed.rows[0]?.job_begin?.attempts, 2, 'attempts incremented to 2')
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }

    let row = (
      await adminPool.query<{
        status: string
        leased_by: string
        attempts: number
      }>(
        `select status, leased_by, attempts from core.outbox where id = $1`,
        [jobId],
      )
    ).rows[0]!

    assert.equal(row.status, 'processing')
    assert.equal(row.leased_by, 'survivor-worker-01')
    assert.equal(row.attempts, 2, 'attempts incremented to 2')
  })

  it('4. transient failures return to pending with exponential backoff delay and last_error_class', async () => {
    let insert = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, max_attempts)
      values ('invite_email', '{"email":"fail_transient@example.com","token":"ft1","test_tag":"r7_2_test"}'::jsonb, 'pending', 3)
      returning id
    `)
    let jobId = insert.rows[0]!.id

    let origSend = devMailbox.send.bind(devMailbox)
    devMailbox.send = () => {
      throw new Error('transient network drop to upstream SMTP')
    }

    try {
      let processed = await pollOnce({
        retryTransient: true,
        defaultRetryDelaySeconds: 15,
        workerId: 'worker-retry',
      })
      assert.ok(processed >= 1)
    } finally {
      devMailbox.send = origSend
    }

    let row = (
      await adminPool.query<{
        status: string
        attempts: number
        last_error_class: string
        leased_by: string | null
        lease_expires_at: string | null
        backoff_secs: number
      }>(
        `select status, attempts, last_error_class, leased_by, lease_expires_at,
                extract(epoch from (next_at - now()))::int as backoff_secs
           from core.outbox where id = $1`,
        [jobId],
      )
    ).rows[0]!

    assert.equal(row.status, 'pending', 'job returned to pending for retry')
    assert.equal(row.attempts, 1)
    assert.equal(row.last_error_class, 'transient')
    assert.equal(row.leased_by, null, 'lease cleared on retry schedule')
    assert.equal(row.lease_expires_at, null)
    assert.ok(row.backoff_secs >= 10 && row.backoff_secs <= 20, `expected ~15s backoff, got ${row.backoff_secs}`)
  })

  it('5. dead-letter transition occurs when attempts reach max_attempts', async () => {
    let insert = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, attempts, max_attempts)
      values ('invite_email', '{"email":"dead_letter@example.com","token":"dl1","test_tag":"r7_2_test"}'::jsonb,
              'pending', 2, 3)
      returning id
    `)
    let jobId = insert.rows[0]!.id

    let origSend = devMailbox.send.bind(devMailbox)
    devMailbox.send = () => {
      throw new Error('third failure - permanent rejection')
    }

    try {
      let processed = await pollOnce({
        retryTransient: true,
        defaultRetryDelaySeconds: 10,
        workerId: 'worker-dl',
      })
      assert.ok(processed >= 1)
    } finally {
      devMailbox.send = origSend
    }

    let row = (
      await adminPool.query<{
        status: string
        attempts: number
        last_error_class: string
        payload: { error?: string }
      }>(
        `select status, attempts, last_error_class, payload from core.outbox where id = $1`,
        [jobId],
      )
    ).rows[0]!

    assert.equal(row.status, 'dead_letter', 'job escalated to dead_letter')
    assert.equal(row.attempts, 3)
    assert.equal(row.last_error_class, 'transient')
    assert.match(row.payload.error ?? '', /third failure/)
  })

  it('6. unrecognised job kinds immediately transition to dead_letter with fatal error class', async () => {
    let insert = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, max_attempts)
      values ('corrupt_unsupported_kind', '{"test_tag":"r7_2_test"}'::jsonb, 'pending', 5)
      returning id
    `)
    let jobId = insert.rows[0]!.id

    let processed = await pollOnce({
      retryTransient: true,
      workerId: 'worker-fatal',
    })
    assert.ok(processed >= 1)

    let row = (
      await adminPool.query<{
        status: string
        attempts: number
        last_error_class: string
        payload: { error?: string }
      }>(
        `select status, attempts, last_error_class, payload from core.outbox where id = $1`,
        [jobId],
      )
    ).rows[0]!

    assert.equal(row.status, 'dead_letter', 'fatal error escalated directly to dead_letter')
    assert.equal(row.last_error_class, 'fatal')
    assert.match(row.payload.error ?? '', /unknown_outbox_kind/)
  })

  it('7. concurrent claims with SKIP LOCKED never allocate same job to multiple workers', async () => {
    let ids: string[] = []
    for (let i = 0; i < 4; i++) {
      let res = await adminPool.query<{ id: string }>(`
        insert into core.outbox (kind, payload, status)
        values ('invite_email', json_build_object('email', 'concurrent_' || ${i} || '@example.com', 'token', 't_' || ${i}, 'test_tag', 'r7_2_test'), 'pending')
        returning id
      `)
      ids.push(res.rows[0]!.id)
    }

    let client1 = await getWorkerPool().connect()
    let client2 = await getWorkerPool().connect()

    try {
      await client1.query('begin')
      await client2.query('begin')

      let claim1 = await client1.query<{ id: string }>(`
        select id from private.job_poll(2)
      `)
      let claim2 = await client2.query<{ id: string }>(`
        select id from private.job_poll(2)
      `)

      let set1 = new Set(claim1.rows.map((r) => r.id))
      let set2 = new Set(claim2.rows.map((r) => r.id))

      // Verify no intersection between concurrent claims
      for (let id of set1) {
        assert.ok(!set2.has(id), `job ${id} was claimed by both client1 and client2`)
      }

      await client1.query('commit')
      await client2.query('commit')
    } catch (err) {
      await client1.query('rollback')
      await client2.query('rollback')
      throw err
    } finally {
      client1.release()
      client2.release()
    }
  })

  it('8. R8.5: security_alert outbox job is processed durably with retry and alert delivery', async () => {
    let memorySink = new MemoryAlertSink()
    defaultAlerter.addSink(memorySink)

    // Enqueue a security alert into core.outbox
    let insert = await adminPool.query<{ id: string }>(`
      select private.enqueue_security_alert(
        'SEAL_TAMPER_DETECTED',
        'CRITICAL',
        'audit_sealer',
        'Cryptographic hash tamper detected in test batch',
        '{"seal_id": 999, "test_tag": "r7_2_test"}'::jsonb
      ) as id
    `)
    let jobId = insert.rows[0]!.id

    // Poll and process the security_alert job
    let processed = await pollOnce({ limit: 5, retryTransient: true })
    assert.ok(processed >= 1, 'poller processed the security_alert job')

    // Verify alert was received by alert sinks
    let delivered = memorySink.findByType('SEAL_TAMPER_DETECTED')
    assert.ok(delivered.length >= 1, 'security alert was dispatched to alerter sinks')
    assert.equal(delivered[0]?.severity, 'CRITICAL')
    assert.equal(delivered[0]?.message, 'Cryptographic hash tamper detected in test batch')

    // Verify outbox row transitioned to done
    let statusRes = await adminPool.query<{ status: string; attempts: number }>(
      'select status, attempts from core.outbox where id = $1',
      [jobId],
    )
    assert.equal(statusRes.rows[0]?.status, 'done')
    assert.equal(statusRes.rows[0]?.attempts, 1)
  })

  it('9. R8.5: sweepExpiredBreakGlass() asynchronously revokes expired sessions and resets activation', async () => {
    let testUserId = 'e9999999-9999-9999-9999-999999999999'
    let testSessionId = 'e9999999-9999-9999-9999-999999999001'

    // Create test user and break-glass account
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, email, status, entra_tenant_id, entra_object_id)
      values ($1, 'internal', 'Expired BG User', 'expired.bg@mms.example.com', 'active',
              '11111111-1111-1111-1111-111111111111', 'e9999999-1111-1111-1111-111111111111')
      on conflict (id) do nothing
    `, [testUserId])

    await adminPool.query(`
      insert into iam.break_glass_account (user_id, label, enabled, activated_at, valid_until, reason)
      values ($1, 'Expired BG Account', true, now() - interval '5 hours', now() - interval '1 hour', 'test expired')
      on conflict (user_id) do update set
        enabled = true,
        activated_at = now() - interval '5 hours',
        valid_until = now() - interval '1 hour',
        reason = 'test expired'
    `, [testUserId])

    // Create active session
    await adminPool.query(`
      insert into iam.session (id, user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
      values ($1, $2, 'internal', 'int_sysadmin', 'entra', now() + interval '1 hour', now() + interval '8 hours')
      on conflict (id) do update set revoked_at = null
    `, [testSessionId, testUserId])

    // Run asynchronous sweep
    let swept = await sweepExpiredBreakGlass()
    assert.ok(swept >= 1, 'sweep cleaned up at least 1 expired account')

    // Verify session was revoked with reason 'break_glass_expired'
    let sessionCheck = await adminPool.query<{ revoked_at: string | null; revoke_reason: string | null }>(
      'select revoked_at, revoke_reason from iam.session where id = $1',
      [testSessionId],
    )
    assert.ok(sessionCheck.rows[0]?.revoked_at !== null, 'session is revoked')
    assert.equal(sessionCheck.rows[0]?.revoke_reason, 'break_glass_expired')

    // Verify break_glass_account was deactivated
    let accountCheck = await adminPool.query<{ activated_at: string | null; valid_until: string | null }>(
      'select activated_at, valid_until from iam.break_glass_account where user_id = $1',
      [testUserId],
    )
    assert.equal(accountCheck.rows[0]?.activated_at, null)
    assert.equal(accountCheck.rows[0]?.valid_until, null)

    // Cleanup
    await adminPool.query('delete from iam.session where id = $1', [testSessionId])
    await adminPool.query('delete from iam.break_glass_account where user_id = $1', [testUserId])
    await adminPool.query('delete from iam.app_user where id = $1', [testUserId])
  })
})
