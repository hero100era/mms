import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  applyBootstrap,
  applyMigrations,
  buildPlanDatabase,
  migrationsDir,
  pgschemaPlan,
  pgschemaVersion,
  psql,
  recreateDatabase,
  repoRoot,
  requireDatabaseUrl,
  schemaNames,
  splitMigrationSql,
  withDatabase,
} from './lib.ts'

function argValue(name: string): string | undefined {
  let index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

let preFile = argValue('--pre')
let postFile = argValue('--post')
let name = argValue('--name')
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('Usage: npm run db:plan -- --name <lowercase-name>')
  process.exit(1)
}

let url = requireDatabaseUrl()
let baselineDb = process.env.BASELINE_DB ?? 'mms_baseline'
let planDb = process.env.PLAN_DB ?? 'mms_plan'
let baselineUrl = withDatabase(url, baselineDb)
let planUrl = withDatabase(url, planDb)

console.log(`building baseline ${baselineDb}`)
recreateDatabase(url, baselineDb)
applyBootstrap(baselineUrl)
applyMigrations(baselineUrl, { skipSeeds: true })
if (preFile) psql(baselineUrl, ['-c', 'set role mms_owner', '-f', preFile])

console.log(`building plan database ${planDb}`)
buildPlanDatabase(url, planDb)


let schemas = schemaNames()
let plans = schemas.map((schema) => pgschemaPlan(baselineUrl, planUrl, schema))
let warnings = plans.filter((plan) => /warning/i.test(`${plan.human}\n${plan.stderr}`))
if (warnings.length > 0) {
  for (let plan of warnings) {
    console.error(`pgschema warning in ${plan.schema}:\n${plan.human}\n${plan.stderr}`)
  }
  process.exit(1)
}

let changes = plans.filter((plan) => plan.sql.trim().length > 0)
if (changes.length === 0) {
  console.log('No schema changes detected.')
  process.exit(0)
}

let stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
let directoryName = `${stamp}_${name}`
let directory = path.join(migrationsDir, directoryName)
if (fs.existsSync(directory)) {
  console.error(`Migration directory already exists: ${directory}`)
  process.exit(1)
}
fs.mkdirSync(directory, { recursive: true })
if (preFile) fs.copyFileSync(preFile, path.join(directory, 'pre.sql'))
if (postFile) fs.copyFileSync(postFile, path.join(directory, 'post.sql'))

let sqlSections: string[] = []
let nontxStatements: string[] = []
let pgschema = pgschemaVersion()
for (let plan of plans) {
  if (plan.sql.length === 0) continue
  let split = splitMigrationSql(plan.sql)
  nontxStatements.push(...split.nontx)
  if (split.transactional.length > 0) {
    sqlSections.push(
      `-- ===== schema: ${plan.schema}  (pgschema ${pgschema}) =====`,
      `set local search_path = ${plan.schema};`,
      split.transactional,
    )
  }
}

if (sqlSections.length === 0 && nontxStatements.length === 0) {
  fs.rmSync(directory, { recursive: true, force: true })
  console.log('No schema changes detected.')
  process.exit(0)
}
if (sqlSections.length === 0) {
  sqlSections.push('-- no transactional changes')
}

fs.writeFileSync(path.join(directory, 'schema.sql'), `${sqlSections.join('\n\n')}\n`)
if (nontxStatements.length > 0) {
  fs.writeFileSync(path.join(directory, 'nontx.sql'), `${nontxStatements.join('\n\n')}\n`)
}
fs.writeFileSync(
  path.join(directory, 'REVIEW.md'),
  `# Migration review: ${directoryName}

- [ ] No renames outside \`pre.sql\`.
- [ ] Destructive statements have an \`allow-destructive\` line with a ticket and reason.
- [ ] Large-table index/constraint changes use \`CONCURRENTLY\` or \`NOT VALID\` then \`VALIDATE\`.
- [ ] Backfills are in \`post.sql\` and are idempotent.
- [ ] Regulated-data impact reviewed.
- [ ] \`nontx.sql\` statements are independent of the transactional part.
- [ ] Round-trip plan is empty (the generator checks this).

## Destructive changes

<!-- allow-destructive: <statement> — <ticket> — <reason> -->
`,
)

console.log(`wrote ${path.relative(repoRoot, directory)}`)

// Round-trip proof: rebuild the previous release, apply the new migration, then re-plan.
console.log('checking round trip')
recreateDatabase(url, baselineDb)
applyBootstrap(baselineUrl)
applyMigrations(baselineUrl, { skipSeeds: true })
let after = schemas.map((schema) => pgschemaPlan(baselineUrl, planUrl, schema))
let drift = after.filter((plan) => plan.sql.trim().length > 0)
if (drift.length > 0) {
  for (let plan of drift) {
    console.error(`round-trip drift in ${plan.schema}:\n${plan.human}`)
  }
  console.error(`Migration left at ${directory}`)
  process.exit(1)
}
console.log('round trip is clean')
