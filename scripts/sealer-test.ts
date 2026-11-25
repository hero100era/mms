import { Pool } from 'pg'
import { parseDatabaseUrl, requireDatabaseUrl } from '../db/scripts/lib.ts'
import { getSealerPool, closeSealerPool } from '../apps/web/app/audit_trail/sealer-client.ts'
import { sealHorizon } from '../apps/web/app/audit_trail/sealer.ts'
import { verifyAuditSeals } from '../apps/web/app/audit_trail/verifier.ts'
import { getWormStorage } from '../apps/web/app/audit_trail/worm-storage.ts'

export async function runSealerTests(): Promise<{
  allPassed: boolean
  tests: { name: string; passed: boolean; detail: string }[]
}> {
  let rawUrl = requireDatabaseUrl()
  let parsed = parseDatabaseUrl(rawUrl)
  let adminPool = new Pool({ connectionString: rawUrl })
  let sealerPool = getSealerPool()
  let wormStorage = getWormStorage()

  let tests: { name: string; passed: boolean; detail: string }[] = []

  try {
    // 1. Audit sealer identity restriction check (R8.6.3 / R8.6.16)
    let sealerClient = await sealerPool.connect()
    try {
      let idCheck = await sealerClient.query<{
        current_user: string
        is_super: boolean
        can_bypass_rls: boolean
      }>(`
        select current_user,
               (select rolsuper from pg_roles where rolname = current_user) as is_super,
               (select rolbypassrls from pg_roles where rolname = current_user) as can_bypass_rls
      `)
      let row = idCheck.rows[0]!
      let passed = row.current_user === 'audit_sealer' && !row.is_super && !row.can_bypass_rls
      tests.push({
        name: 'Sealer identity restriction',
        passed,
        detail: `current_user=${row.current_user}, is_super=${row.is_super}, bypass_rls=${row.can_bypass_rls}`,
      })
    } finally {
      sealerClient.release()
    }

    // 2. Perform a business mutation to generate audit changes / events
    let testOrgId = '00000000-4000-4000-8000-000000000999'
    await adminPool.query(`
      insert into party.organization (id, name, org_type, status)
      values ($1, 'SEALER TEST CO', 'company', 'active')
      on conflict (id) do update set name = 'SEALER TEST CO UPDATED';
    `, [testOrgId])

    let auditCheck = await adminPool.query<{ count: number }>(`
      select count(*)::int as count from audit_trail.change_log where row_id = $1
    `, [testOrgId])
    let hasAudit = auditCheck.rows[0]!.count > 0
    tests.push({
      name: 'Business mutation generates audit records',
      passed: hasAudit,
      detail: `Generated ${auditCheck.rows[0]!.count} change_log entry for test mutation`,
    })

    // 3. Execute sealer (sealHorizon)
    let sealResult = await sealHorizon({
      pool: sealerPool,
      wormStorage,
      allowEmptySeal: true,
      sealedBy: 'sealer-test',
    })
    tests.push({
      name: 'Audit sealer horizon execution (sealHorizon)',
      passed: sealResult.sealed || sealResult.reason === 'empty horizon',
      detail: sealResult.sealed
        ? `Sealed xids ${sealResult.fromXid}..${sealResult.toXid} (${sealResult.changeLogCount} changes, ${sealResult.eventCount} events)`
        : `Already sealed / horizon up to date (${sealResult.reason})`,
    })

    // 4. Verify cryptographic hash chain & WORM storage integrity
    let report = await verifyAuditSeals({
      pool: sealerPool,
      wormStorage,
      verifyLiveDatabase: true,
      fromSealId: sealResult.sealId,
      toSealId: sealResult.sealId,
    })
    let verifyPassed = report.status === 'PASS' && report.errors.length === 0
    tests.push({
      name: 'Audit chain & WORM artifact verification',
      passed: verifyPassed,
      detail: `Report status: ${report.status}, total seals: ${report.totalSeals}, valid: ${report.validSeals}, errors: ${report.errors.length}`,
    })

    // Clean up test org
    await adminPool.query(`delete from party.organization where id = $1`, [testOrgId])
  } finally {
    await adminPool.end()
    await closeSealerPool()
  }

  let allPassed = tests.every((t) => t.passed)
  return { allPassed, tests }
}

async function main() {
  console.log('================================================================')
  console.log('Native Audit Sealer Execution & Chain Verification Test (R8.6.16)')
  console.log('================================================================')

  let { allPassed, tests } = await runSealerTests()

  for (let t of tests) {
    let icon = t.passed ? '✓' : '✗'
    console.log(`  ${icon} [${t.name}]: ${t.detail}`)
  }

  console.log('----------------------------------------------------------------')
  console.log('Notice: A local filesystem or test adapter simulates storage mechanics,')
  console.log('but it must never be described as proving real production WORM immutability.')
  console.log('----------------------------------------------------------------')

  if (allPassed) {
    console.log('PASS: Native audit sealer execution and verification complete.')
    console.log('================================================================')
    process.exit(0)
  } else {
    console.error('FAIL: Sealer test failed.')
    console.log('================================================================')
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('sealer-test.ts')) {
  main().catch((err) => {
    console.error('Fatal sealer test error:', err.message)
    process.exit(1)
  })
}
