import {
  applyBootstrap,
  applyMigrations,
  applySeeds,
  buildPlanDatabase,
  pgschemaPlan,
  psql,
  recreateDatabase,
  requireDatabaseUrl,
  schemaNames,
  withDatabase,
} from './lib.ts'
import { checkOrgDocs } from './check-org-docs.ts'

let url = requireDatabaseUrl()
let checkDb = process.env.CHECK_DB ?? 'mms_check'
let planDb = process.env.PLAN_DB ?? 'mms_plan'
let checkUrl = withDatabase(url, checkDb)
let planUrl = withDatabase(url, planDb)

console.log(`building ${checkDb}`)
recreateDatabase(url, checkDb)
applyBootstrap(checkUrl)
applyMigrations(checkUrl, { skipSeeds: true })
applySeeds(checkUrl)

console.log(`building ${planDb}`)
buildPlanDatabase(url, planDb)

let schemas = schemaNames()
let first = schemas.map((schema) => pgschemaPlan(checkUrl, planUrl, schema))
let second = schemas.map((schema) => pgschemaPlan(checkUrl, planUrl, schema))

let failed = false
for (let plan of first) {
  if (/warning/i.test(`${plan.human}\n${plan.stderr}`)) {
    console.error(`C3 warning in ${plan.schema}:\n${plan.human}\n${plan.stderr}`)
    failed = true
  }
  if (plan.sql.trim().length > 0) {
    console.error(`C5 drift in ${plan.schema}:\n${plan.human}`)
    failed = true
  }
}

for (let index = 0; index < first.length; index++) {
  if (first[index].sql !== second[index].sql) {
    console.error(`C1 non-deterministic plan for ${first[index].schema}`)
    failed = true
  }
}

let auditLint = psql(checkUrl, ['-Atc', `
select c.table_schema || '.' || c.table_name || '.' || c.column_name
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name
where t.table_type = 'BASE TABLE'
  and c.table_schema in ('core', 'party', 'iam', 'audit', 'fleet', 'survey', 'qual')
  and c.column_name ~* '(password|secret|token|hash|key|salary|bank)'
  and not exists (
    select 1 from audit_trail.excluded_column e
    where e.schema_name = c.table_schema
      and e.table_name = c.table_name
      and e.column_name = c.column_name
  )
`]).stdout.trim()
if (auditLint) {
  console.error(`A-01 audit exclusion lint failed:\n`)
  failed = true
}

if (failed) process.exit(1)
checkOrgDocs(checkUrl)
console.log('C1, C3, C5, audit exclusion lint and org docs passed')
