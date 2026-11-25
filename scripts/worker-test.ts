import { Pool } from 'pg'
import { parseDatabaseUrl, requireDatabaseUrl } from '../db/scripts/lib.ts'
import { getWorkerPool, closeWorkerPool } from '../apps/web/app/jobs/worker-client.ts'
import { pollOnce } from '../apps/web/app/jobs/poller.ts'
import { devMailbox } from '../apps/web/app/jobs/dev-mailbox.ts'

export async function runWorkerTests(): Promise<{
  allPassed: boolean
  tests: { name: string; passed: boolean; detail: string }[]
}> {
  let rawUrl = requireDatabaseUrl()
  let parsed = parseDatabaseUrl(rawUrl)
  let adminPool = new Pool({ connectionString: rawUrl })
  let workerPool = getWorkerPool()

  let tests: { name: string; passed: boolean; detail: string }[] = []

  try {
    // 1. Verify restricted worker database identity (R8.6.3 / R8.6.15)
    let workerClient = await workerPool.connect()
    try {
      let idCheck = await workerClient.query<{
        current_user: string
        session_user: string
        is_super: boolean
        can_bypass_rls: boolean
      }>(`
        select current_user, session_user,
               (select rolsuper from pg_roles where rolname = current_user) as is_super,
               (select rolbypassrls from pg_roles where rolname = current_user) as can_bypass_rls
      `)
      let row = idCheck.rows[0]!
      let passed = row.current_user === 'worker' && !row.is_super && !row.can_bypass_rls
      tests.push({
        name: 'Worker identity restriction',
        passed,
        detail: `current_user=${row.current_user}, is_super=${row.is_super}, bypass_rls=${row.can_bypass_rls}`,
      })
    } finally {
      workerClient.release()
    }

    // 2. Generate outbox job while worker is idle -> verify pending
    let tag = `worker_test_${Date.now()}`
    let insertRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, max_attempts)
      values ('invite_email', $1::jsonb, 'pending', 3)
      returning id
    `, [JSON.stringify({ email: 'worker_test@acceptance.local', token: 'tok123', test_tag: tag })])
    let jobId = insertRes.rows[0]!.id

    let pendingCheck = await adminPool.query<{ status: string }>(
      'select status from core.outbox where id = $1',
      [jobId],
    )
    let isPending = pendingCheck.rows[0]?.status === 'pending'
    tests.push({
      name: 'Outbox job generation & pending state',
      passed: isPending,
      detail: `Job ${jobId} status is ${pendingCheck.rows[0]?.status}`,
    })

    // 3. Worker leases job -> verify leased & processing
    let workerClient2 = await workerPool.connect()
    try {
      let beginRes = await workerClient2.query<{ job: { id: string; status: string; leased_by: string; attempts: number } }>(
        'select private.job_begin($1, 60, $2) as job',
        [jobId, 'worker-test-instance-1'],
      )
      let jobRow = beginRes.rows[0]?.job
      let isProcessing = jobRow?.status === 'processing' && jobRow?.leased_by === 'worker-test-instance-1'
      tests.push({
        name: 'Worker lease acquisition (job_begin)',
        passed: isProcessing,
        detail: `Status=${jobRow?.status}, leased_by=${jobRow?.leased_by}, attempts=${jobRow?.attempts}`,
      })
    } finally {
      workerClient2.release()
    }

    // 4. Duplicate worker cannot acquire same leased job
    let workerClient3 = await workerPool.connect()
    try {
      let threw = false
      try {
        await workerClient3.query(
          'select private.job_begin($1, 60, $2) as job',
          [jobId, 'worker-test-instance-2'],
        )
      } catch (err: any) {
        if (err.message?.includes('job_not_pending') || err.code === '55P03') {
          threw = true
        }
      }
      tests.push({
        name: 'Concurrency guard (duplicate worker cannot acquire leased job)',
        passed: threw,
        detail: threw ? 'Second worker correctly rejected with job_not_pending' : 'Duplicate worker erroneously acquired job',
      })
    } finally {
      workerClient3.release()
    }

    // 5. Complete job -> verify done
    let workerClient4 = await workerPool.connect()
    try {
      await workerClient4.query("select private.job_complete($1, 'done')", [jobId])
      let doneCheck = await adminPool.query<{ status: string }>(
        'select status from core.outbox where id = $1',
        [jobId],
      )
      let isDone = doneCheck.rows[0]?.status === 'done'
      tests.push({
        name: 'Worker job completion (job_complete done)',
        passed: isDone,
        detail: `Status is ${doneCheck.rows[0]?.status}`,
      })
    } finally {
      workerClient4.release()
    }

    // 6. Retry exhaustion to dead letter
    let deadJobRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status, max_attempts)
      values ('unknown_broken_task', $1::jsonb, 'pending', 2)
      returning id
    `, [JSON.stringify({ test_tag: tag })])
    let deadJobId = deadJobRes.rows[0]!.id

    let workerClient5 = await workerPool.connect()
    try {
      // First attempt failure -> status retry with 0 delay so it can be picked up
      await workerClient5.query('select private.job_begin($1, 60, $2)', [deadJobId, 'worker-fail-1'])
      await workerClient5.query("select private.job_complete($1, 'retry', 'Simulated network timeout 1', 'transient', 0)", [deadJobId])

      let retryCheck = await adminPool.query<{ status: string; attempts: number }>(
        'select status, attempts from core.outbox where id = $1',
        [deadJobId],
      )
      let isRetryPending = retryCheck.rows[0]?.status === 'pending' && retryCheck.rows[0]?.attempts === 1

      // Second attempt failure -> max_attempts (2) reached -> dead_letter
      await workerClient5.query('select private.job_begin($1, 60, $2)', [deadJobId, 'worker-fail-2'])
      await workerClient5.query("select private.job_complete($1, 'retry', 'Simulated network timeout 2', 'transient', 0)", [deadJobId])

      let deadCheck = await adminPool.query<{ status: string; attempts: number }>(
        'select status, attempts from core.outbox where id = $1',
        [deadJobId],
      )
      let isDead = deadCheck.rows[0]?.status === 'dead_letter' && deadCheck.rows[0]?.attempts >= 2

      tests.push({
        name: 'Retry exhaustion to dead_letter state',
        passed: isRetryPending && isDead,
        detail: `Attempt 1: status=${retryCheck.rows[0]?.status} (attempts: ${retryCheck.rows[0]?.attempts}); Final: status=${deadCheck.rows[0]?.status} (attempts: ${deadCheck.rows[0]?.attempts})`,
      })
    } finally {
      workerClient5.release()
    }

    // Cleanup
    await adminPool.query(`delete from core.outbox where payload ->> 'test_tag' = $1`, [tag])
  } finally {
    await adminPool.end()
    await closeWorkerPool()
  }

  let allPassed = tests.every((t) => t.passed)
  return { allPassed, tests }
}

async function main() {
  console.log('================================================================')
  console.log('Native MMS Worker Execution & Leasing Test (R8.6.15)')
  console.log('================================================================')

  let { allPassed, tests } = await runWorkerTests()

  for (let t of tests) {
    let icon = t.passed ? '✓' : '✗'
    console.log(`  ${icon} [${t.name}]: ${t.detail}`)
  }

  console.log('----------------------------------------------------------------')
  if (allPassed) {
    console.log('PASS: Native worker lifecycle, leasing, SoD, and dead-letter verified.')
    console.log('================================================================')
    process.exit(0)
  } else {
    console.error('FAIL: Native worker test failed.')
    console.log('================================================================')
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('worker-test.ts')) {
  main().catch((err) => {
    console.error('Fatal worker test error:', err.message)
    process.exit(1)
  })
}
