import assert from 'node:assert/strict'
import { after, before, describe, it, test } from 'node:test'
import { Pool } from 'pg'

import { defaultAlerter } from '../audit_trail/alerter.ts'
import { devMailbox } from './dev-mailbox.ts'
import { pollOnce } from './poller.ts'
import { closeWorkerPool } from './worker-client.ts'

test('dev mailbox captures messages', () => {
  devMailbox.clear()
  assert.equal(devMailbox.getMessages().length, 0)

  devMailbox.send({
    to: 'partner@example.com',
    subject: 'Invitation to MMS',
    payload: { token: 'sample-token', inviteUrl: '/invite/sample-token' },
  })

  let messages = devMailbox.getMessages()
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.to, 'partner@example.com')
  assert.equal(devMailbox.findInvite('PARTNER@EXAMPLE.COM')?.payload.token, 'sample-token')

  devMailbox.clear()
  assert.equal(devMailbox.getMessages().length, 0)
})

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_dev'

describe('outbox poller worker execution', () => {
  let adminPool: Pool

  before(() => {
    adminPool = new Pool({ connectionString: adminUrl })
  })

  after(async () => {
    await adminPool.query(`delete from core.outbox where payload ->> 'email' = 'poller_test@example.com'
      or kind in ('break_glass_alert', 'unknown_kind_for_test')`)
    await adminPool.end()
    await closeWorkerPool()
  })

  it('polls pending invite email, delivers to devMailbox, and marks done', async () => {
    devMailbox.clear()
    await adminPool.query(`delete from core.outbox where payload ->> 'email' = 'poller_test@example.com'`)

    let insertRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status)
      values ('invite_email', '{"email":"poller_test@example.com","token":"secret123"}'::jsonb, 'pending')
      returning id
    `)
    let jobId = insertRes.rows[0]!.id

    let processed = await pollOnce()
    assert.ok(processed >= 1, 'at least 1 job processed')

    let msg = devMailbox.findInvite('poller_test@example.com')
    assert.ok(msg, 'message was delivered to dev mailbox')
    assert.equal(msg?.payload.token, 'secret123')
    assert.equal(msg?.payload.inviteUrl, '/invite/secret123')

    let statusRes = await adminPool.query<{ status: string; attempts: number }>(
      'select status, attempts from core.outbox where id = $1',
      [jobId],
    )
    assert.equal(statusRes.rows[0]?.status, 'done')
    assert.equal(statusRes.rows[0]?.attempts, 1)

    // Polling again finds no more pending jobs
    let secondPoll = await pollOnce()
    assert.equal(secondPoll, 0)
  })

  it('skips non-pending jobs', async () => {
    await adminPool.query(`
      insert into core.outbox (kind, payload, status)
      values ('invite_email', '{"email":"poller_test@example.com","token":"secret456"}'::jsonb, 'processing')
    `)
    let processed = await pollOnce()
    assert.equal(processed, 0)
  })

  it('R1.6: break_glass_alert outbox rows are actually emitted, not silently acknowledged', async () => {
    let before = defaultAlerter.getHistory().filter((a) => a.type === 'BREAK_GLASS_ACTIVATED').length
    let insertRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status)
      values ('break_glass_alert',
        '{"user_id":"f0000000-0000-0000-0000-0000000000aa","label":"Emergency","reason":"lockout","valid_until":"2026-11-06T12:00:00Z","audience":"it_security"}'::jsonb,
        'pending')
      returning id
    `)
    let jobId = insertRes.rows[0]!.id

    let processed = await pollOnce()
    assert.ok(processed >= 1)

    let emitted = defaultAlerter.getHistory().filter((a) => a.type === 'BREAK_GLASS_ACTIVATED')
    assert.equal(emitted.length, before + 1, 'the activation alert left the process')
    assert.equal(
      (emitted.at(-1)?.details as { userId?: string } | undefined)?.userId,
      'f0000000-0000-0000-0000-0000000000aa',
    )

    let statusRes = await adminPool.query<{ status: string }>(
      'select status from core.outbox where id = $1',
      [jobId],
    )
    assert.equal(statusRes.rows[0]?.status, 'done')
  })

  it('R1.6/R7.2: an unrecognised outbox kind is marked dead_letter, not silently done', async () => {
    let insertRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status)
      values ('unknown_kind_for_test', '{}'::jsonb, 'pending')
      returning id
    `)
    let jobId = insertRes.rows[0]!.id

    await pollOnce()

    let statusRes = await adminPool.query<{ status: string; payload: { error?: string } }>(
      'select status, payload from core.outbox where id = $1',
      [jobId],
    )
    assert.equal(statusRes.rows[0]?.status, 'dead_letter')
    assert.match(statusRes.rows[0]?.payload.error ?? '', /unknown_outbox_kind/)
  })

  it('R7.2: marks job as retry/pending when processing throws', async () => {
    let insertRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status)
      values ('invite_email', '{"email":"poller_test@example.com","token":"fail-token"}'::jsonb, 'pending')
      returning id
    `)
    let jobId = insertRes.rows[0]!.id

    let origSend = devMailbox.send.bind(devMailbox)
    devMailbox.send = () => {
      throw new Error('simulated delivery failure')
    }
    try {
      let processed = await pollOnce()
      assert.ok(processed >= 1)

      let statusRes = await adminPool.query<{ status: string; attempts: number; payload: { error?: string } }>(
        'select status, attempts, payload from core.outbox where id = $1',
        [jobId],
      )
      assert.equal(statusRes.rows[0]?.status, 'pending')
      assert.equal(statusRes.rows[0]?.attempts, 1)
      assert.equal(statusRes.rows[0]?.payload.error, 'simulated delivery failure')
    } finally {
      devMailbox.send = origSend
    }
  })
})
