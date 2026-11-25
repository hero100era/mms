import {
  applyBootstrap,
  applyMigrations,
  parseDatabaseUrl,
  recreateDatabase,
  requireDatabaseUrl,
} from './lib.ts'

let url = requireDatabaseUrl()
let database = parseDatabaseUrl(url).database
if (!process.argv.includes('--force') && process.env.ALLOW_DB_RESET !== '1') {
  console.error(`Refusing to drop and recreate ${database}. Re-run with --force.`)
  process.exit(1)
}
recreateDatabase(url, database)
applyBootstrap(url)
applyMigrations(url)
console.log(`reset ${database}`)
