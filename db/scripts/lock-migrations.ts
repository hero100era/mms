import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { migrationsDir, repoRoot } from './lib.ts'

let lockFile = path.join(repoRoot, 'db', 'migrations.lock.json')
let lock: Record<string, string> = {}
let directories = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

for (let directory of directories) {
  let dir = path.join(migrationsDir, directory)
  let hash = createHash('sha256')
  for (let file of fs.readdirSync(dir).sort()) {
    let full = path.join(dir, file)
    if (!fs.statSync(full).isFile()) continue
    hash.update(file)
    hash.update('\0')
    hash.update(fs.readFileSync(full))
    hash.update('\0')
  }
  lock[directory] = hash.digest('hex')
}

let baselineFile = path.join(repoRoot, 'db', 'production-baseline.lock.json')
if (fs.existsSync(baselineFile)) {
  let baselineLock: Record<string, string> = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  for (let [dirName, baselineHash] of Object.entries(baselineLock)) {
    if (!lock[dirName]) {
      console.error(`FATAL: FIRST_PRODUCTION_BASELINE violation: baseline migration "${dirName}" is missing!`)
      process.exit(1)
    }
    if (lock[dirName] !== baselineHash) {
      console.error(`FATAL: FIRST_PRODUCTION_BASELINE violation: baseline migration "${dirName}" was modified! Historical migrations in FIRST_PRODUCTION_BASELINE are permanently immutable.`)
      process.exit(1)
    }
  }
}

fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
console.log(`locked ${directories.length} migration(s)`)
