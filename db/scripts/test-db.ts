import * as fs from 'node:fs'
import * as path from 'node:path'

import { dbDir, psql, requireDatabaseUrl } from './lib.ts'

let url = requireDatabaseUrl()
let testsDir = path.join(dbDir, 'tests')
let failed = false

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
console.log('database tests passed')
