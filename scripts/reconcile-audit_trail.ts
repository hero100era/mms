#!/usr/bin/env node
import { reconcileAuditEvents } from '../apps/web/app/audit_trail/reconciler.ts'
import { getSealerPool, closeSealerPool } from '../apps/web/app/audit_trail/sealer-client.ts'
import { defaultAlerter } from '../apps/web/app/audit_trail/alerter.ts'

async function main() {
  console.log('=================================================================')
  console.log('MMS Tier-2 Daily Audit Event Reconciliation (Card H-02)')
  console.log('=================================================================\n')

  try {
    let args = process.argv.slice(2)
    let fromXid: string | undefined
    let toXid: string | undefined
    let hours = 24
    let alertEnabled = false
    let alertZeroRecords = false
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--from-xid' && args[i + 1]) fromXid = args[++i]
      else if (args[i] === '--to-xid' && args[i + 1]) toXid = args[++i]
      else if (args[i] === '--hours' && args[i + 1]) hours = Number(args[++i])
      else if (args[i] === '--alert') alertEnabled = true
      else if (args[i] === '--alert-zero-records') alertZeroRecords = true
    }

    let windowEnd = new Date()
    let windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1000)

    let pool = getSealerPool()
    let report = await reconcileAuditEvents({
      pool,
      fromXid,
      toXid,
      windowStart,
      windowEnd,
      alerter: alertEnabled ? defaultAlerter : undefined,
      alertOnZeroRecords: alertZeroRecords,
    })

    console.log(`Reconciliation Run ID   : ${report.runId}`)
    console.log(`Window                  : ${report.windowStart} .. ${report.windowEnd}`)
    console.log(`Checked Changes         : ${report.checkedChangeCount}`)
    console.log(`Checked Events          : ${report.checkedEventCount}`)
    console.log(`Discrepancies Detected  : ${report.discrepancyCount}`)
    console.log(`Status                  : ${report.status === 'clean' ? '✅ CLEAN' : '❌ DISCREPANCIES FOUND'}\n`)

    if (report.discrepancies.length > 0) {
      console.error('Discrepancies:')
      for (let d of report.discrepancies) {
        console.error(
          `- [${d.discrepancyType}] Table: ${d.schemaName}.${d.tableName}.${d.columnName}, tx_id: ${d.txId}, change_log_id: ${d.changeLogId}`,
        )
        console.error(`  Details: ${JSON.stringify(d.details)}`)
      }
      await closeSealerPool()
      process.exit(1)
    }

    console.log(
      'Daily audit reconciliation clean: all controlled column mutations matched valid transactional events.',
    )
    await closeSealerPool()
    process.exit(0)
  } catch (error) {
    console.error('Reconciliation failed with fatal error:', error)
    await closeSealerPool().catch(() => {})
    process.exit(1)
  }
}

main()
