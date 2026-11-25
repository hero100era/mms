import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  buildPlanDatabase,
  dbDir,
  pgschemaPlan,
  psql,
  requireDatabaseUrl,
  schemaNames,
  withDatabase,
} from './lib.ts'

let url = requireDatabaseUrl()
let planDb = process.env.PLAN_DB ?? 'mms_plan'
let planUrl = withDatabase(url, planDb)
buildPlanDatabase(url, planDb)

let failed = false
for (let schema of schemaNames()) {
  let plan = pgschemaPlan(url, planUrl, schema)
  if (plan.sql.trim().length > 0) {
    console.error(`drift in ${schema}:\n${plan.human}`)
    failed = true
  }
}

let testsDir = path.join(dbDir, 'tests')
for (let file of fs.readdirSync(testsDir).filter((name) => name.endsWith('.sql')).sort()) {
  console.log(`running ${file}`)
  let result = psql(url, ['-f', path.join(testsDir, file)])
  if (/\bnot ok\b/.test(result.stdout) || result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    failed = true
  }
}

if (failed) process.exit(1)
console.log('database verification passed')
