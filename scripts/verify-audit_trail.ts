#!/usr/bin/env node
import { verifyAuditSeals } from '../apps/web/app/audit_trail/verifier.ts'
import { getSealerPool, closeSealerPool } from '../apps/web/app/audit_trail/sealer-client.ts'
import { getWormStorage } from '../apps/web/app/audit_trail/worm-storage.ts'
import { defaultAlerter } from '../apps/web/app/audit_trail/alerter.ts'

async function main() {
  console.log('=================================================================')
  console.log('MMS Tier-2 Audit Evidence Verifier (HO Compliance Department)')
  console.log('=================================================================\n')

  try {
    let args = process.argv.slice(2)
    let fromSealId: string | undefined
    let toSealId: string | undefined
    let alertEnabled = false
    let alertZeroRecords = false
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--from-seal-id' && args[i + 1]) fromSealId = args[++i]
      else if (args[i] === '--to-seal-id' && args[i + 1]) toSealId = args[++i]
      else if (args[i] === '--alert') alertEnabled = true
      else if (args[i] === '--alert-zero-records') alertZeroRecords = true
    }

    let pool = getSealerPool()
    let wormStorage = getWormStorage()

    let report = await verifyAuditSeals({
      pool,
      wormStorage,
      verifyLiveDatabase: true,
      fromSealId,
      toSealId,
      alerter: alertEnabled ? defaultAlerter : undefined,
      alertOnZeroRecords: alertZeroRecords,
    })

    console.log(`Total Seals Analyzed : ${report.totalSeals}`)
    console.log(`Valid Seals Verified : ${report.validSeals}`)
    console.log(`Overall Status       : ${report.status === 'PASS' ? '✅ PASS' : '❌ FAIL'}\n`)

    for (let detail of report.sealDetails) {
      let icon = detail.valid ? '✅' : '❌'
      console.log(
        `${icon} Seal #${detail.sealId} [xid ${detail.fromXid}..${detail.toXid}] — logs: ${detail.changeLogCount}, events: ${detail.eventCount}`,
      )
      console.log(`   Seal Hash : ${detail.sealHash}`)
      console.log(`   Batch Hash: ${detail.batchHash}`)
      console.log(`   WORM URI  : ${detail.wormUri}`)
      if (!detail.valid) {
        for (let err of detail.errors) {
          console.error(`   ⚠️  ERROR [${err.kind}]: ${err.message}`)
          if (err.expected && err.actual) {
            console.error(`       Expected: ${err.expected}`)
            console.error(`       Actual  : ${err.actual}`)
          }
        }
      }
    }

    console.log(`\nNotice: ${report.residualRiskNote}\n`)

    await closeSealerPool()

    if (report.status !== 'PASS') {
      console.error('Audit evidence verification failed!')
      process.exit(1)
    } else {
      console.log('All audit seals and WORM evidence verified cryptographically intact.')
      process.exit(0)
    }
  } catch (error) {
    console.error('Verification failed with fatal error:', error)
    await closeSealerPool().catch(() => {})
    process.exit(1)
  }
}

main()
