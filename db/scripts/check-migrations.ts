import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { migrationsDir, repoRoot } from './lib.ts'

let lockFile = path.join(repoRoot, 'db', 'migrations.lock.json')
let lock: Record<string, string> = fs.existsSync(lockFile)
  ? JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  : {}
let errors: string[] = []
let directories = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let destructive = [
  /\bdrop\s+table\b/i,
  /\bdrop\s+column\b/i,
  /\balter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\btype\b/i,
  /\bdrop\s+constraint\b/i,
  /\bdrop\s+policy\b/i,
  /\bdrop\s+function\b/i,
  /\brevoke\b[\s\S]*?\b(int_|ext_|web_)[a-z_]+\b/i,
]

for (let directory of directories) {
  let dir = path.join(migrationsDir, directory)
  let reviewFile = path.join(dir, 'REVIEW.md')
  if (!fs.existsSync(reviewFile)) {
    errors.push(`${directory}: REVIEW.md is missing`)
    continue
  }
  let review = fs.readFileSync(reviewFile, 'utf8')
  let sql = ['schema.sql', 'nontx.sql']
    .map((file) => path.join(dir, file))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')

  for (let pattern of destructive) {
    if (pattern.test(sql) && !/allow-destructive:/i.test(review)) {
      errors.push(`${directory}: destructive statement needs an allow-destructive line in REVIEW.md`)
      break
    }
  }

  let hash = createHash('sha256')
  for (let file of fs.readdirSync(dir).sort()) {
    let full = path.join(dir, file)
    if (!fs.statSync(full).isFile()) continue
    hash.update(file)
    hash.update('\0')
    hash.update(fs.readFileSync(full))
    hash.update('\0')
  }
  let digest = hash.digest('hex')
  if (!lock[directory]) {
    errors.push(`${directory}: not in db/migrations.lock.json; run npm run db:lock`)
  } else if (lock[directory] !== digest) {
    errors.push(`${directory}: hash changed after it was locked`)
  }
}

for (let directory of Object.keys(lock)) {
  if (!directories.includes(directory)) errors.push(`${directory}: locked migration is missing`)
}

let baselineFile = path.join(repoRoot, 'db', 'production-baseline.lock.json')
if (fs.existsSync(baselineFile)) {
  let baselineLock: Record<string, string> = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  for (let [dirName, baselineHash] of Object.entries(baselineLock)) {
    if (!directories.includes(dirName)) {
      errors.push(`FIRST_PRODUCTION_BASELINE violation: baseline migration "${dirName}" is missing`)
    } else if (lock[dirName] !== baselineHash) {
      errors.push(`FIRST_PRODUCTION_BASELINE violation: baseline migration "${dirName}" was modified after baseline freeze`)
    }
  }
}

if (errors.length > 0) {
  for (let error of errors) console.error(`migrations: ${error}`)
  process.exit(1)
}
fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
console.log(`migration checks passed (${directories.length} migrations)`)
