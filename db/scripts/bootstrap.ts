import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { requireDatabaseUrl } from './lib.ts'

const databaseUrl = requireDatabaseUrl()

const bootstrapDir = path.join(import.meta.dirname, '..', 'bootstrap')
const files = fs
  .readdirSync(bootstrapDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()

for (const file of files) {
  console.log(`==> ${file}`)
  let result = spawnSync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(bootstrapDir, file)],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Dev/test convenience only: never set hardcoded passwords in production.
if (process.env.NODE_ENV !== 'production' && process.env.APP_ENV !== 'production') {
  let devPass = process.env.MMS_DEV_ROLE_PASSWORD ?? 'devpassword'
  let sql = [
    'migrator',
    'authenticator',
    'auth_gateway',
    'worker',
    'audit_sealer',
  ]
    .map((r) => `alter role ${r} with password '${devPass.replaceAll("'", "''")}';`)
    .join('\n')
  let passRes = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (passRes.status !== 0) process.exit(passRes.status ?? 1)
}
