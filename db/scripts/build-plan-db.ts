import { buildPlanDatabase, requireDatabaseUrl } from './lib.ts'

let url = requireDatabaseUrl()
let database = process.env.PLAN_DB ?? 'mms_plan'
let planUrl = buildPlanDatabase(url, database)
console.log(`plan database ready: ${planUrl}`)
