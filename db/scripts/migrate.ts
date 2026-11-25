import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { migrationsDir, psql, repoRoot, requireDatabaseUrl } from './lib.ts'

const databaseUrl = requireDatabaseUrl()
const pgschemaVersion = process.env.PGSCHEMA_VERSION ?? '1.14.1'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function ensureLedger(): void {
  psql(databaseUrl, [
    '-c',
    'set role mms_owner',
    '-c',
    `create table if not exists public.schema_migrations (
       directory text primary key,
       sha256 text not null,
       applied_at timestamptz not null default now(),
       applied_by text not null default session_user,
       pgschema_version text,
       result text not null default 'applied'
     )`,
    '-c',
    `create table if not exists public.schema_migration_statements (
       directory text not null references public.schema_migrations(directory) on delete cascade,
       statement_index integer not null,
       sha256 text not null,
       applied_at timestamptz not null default now(),
       primary key (directory, statement_index)
     )`,
  ])
}

function appliedDirectories(): Set<string> {
  let result = psql(databaseUrl, [
    '-Atq',
    '-c',
    'set role mms_owner',
    '-c',
    'select directory from public.schema_migrations order by directory',
  ])
  return new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
}

function migrationFiles(directory: string): string[] {
  let dir = path.join(migrationsDir, directory)
  return ['pre.sql', 'schema.sql', 'post.sql']
    .map((file) => path.join(dir, file))
    .filter((file) => fs.existsSync(file))
}

function migrationHashFiles(directory: string): string[] {
  let dir = path.join(migrationsDir, directory)
  return ['pre.sql', 'schema.sql', 'post.sql', 'nontx.sql']
    .map((file) => path.join(dir, file))
    .filter((file) => fs.existsSync(file))
}

function appliedNontxIndices(directory: string): Set<number> {
  let out = psql(databaseUrl, [
    '-Atq',
    '-c',
    'set role mms_owner',
    '-c',
    `select statement_index from public.schema_migration_statements where directory = '${directory.replaceAll("'", "''")}'`,
  ]).stdout
  return new Set(
    out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n)),
  )
}

function applyNontxStatements(directory: string): number {
  let nontx = path.join(migrationsDir, directory, 'nontx.sql')
  if (!fs.existsSync(nontx)) return 0
  let stripped = fs
    .readFileSync(nontx, 'utf8')
    .replace(/--[^\n]*/g, '')
  let statements = stripped
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
  let done = appliedNontxIndices(directory)
  let executed = 0
  statements.forEach((statement, index) => {
    if (done.has(index)) return
    psql(databaseUrl, ['-c', 'set role mms_owner', '-c', statement])
    psql(databaseUrl, [
      '-c',
      'set role mms_owner',
      '-c',
      `insert into public.schema_migration_statements (directory, statement_index, sha256) values ('${directory.replaceAll("'", "''")}', ${index}, '${sha256(statement)}') on conflict do nothing`,
    ])
    executed++
  })
  return executed
}

function migrationHash(files: string[]): string {
  let hash = createHash('sha256')
  for (let file of files) {
    hash.update(path.basename(file))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function applyMigration(directory: string): void {
  let files = migrationFiles(directory)
  let schemaFile = path.join(migrationsDir, directory, 'schema.sql')
  if (!fs.existsSync(schemaFile)) {
    throw new Error(`Migration ${directory} has no schema.sql`)
  }

  let sql = ['begin;', 'set local role mms_owner;', "set local check_function_bodies = off;", "set local lock_timeout = '5s';"]
  for (let file of files) {
    sql.push(`\\i '${file.replaceAll("'", "''")}'`)
  }
  let hashFiles = migrationHashFiles(directory)
  sql.push(
    `insert into public.schema_migrations (directory, sha256, applied_by, pgschema_version) values ('${directory.replaceAll("'", "''")}', '${migrationHash(hashFiles)}', session_user, '${pgschemaVersion.replaceAll("'", "''")}');`,
  )
  sql.push('commit;')

  let temp = path.join(os.tmpdir(), `mms-migrate-${directory}.sql`)
  fs.writeFileSync(temp, sql.join('\n'))
  try {
    psql(databaseUrl, ['-f', temp], { cwd: repoRoot })
  } finally {
    fs.rmSync(temp, { force: true })
  }

  applyNontxStatements(directory)
}

ensureLedger()

let applied = appliedDirectories()
let targetMigration = process.env.MIGRATE_TARGET
let directories = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let count = 0
for (let directory of directories) {
  if (targetMigration && directory > targetMigration) break
  if (applied.has(directory)) {
    let resumed = applyNontxStatements(directory)
    if (resumed > 0) console.log(`resumed ${resumed} nontx statement(s) for ${directory}`)
    continue
  }
  console.log(`applying ${directory}`)
  applyMigration(directory)
  count++
}

let seedDir = path.join(repoRoot, 'db', 'seed')
if (process.env.SKIP_SEEDS !== '1' && fs.existsSync(seedDir)) {
  for (let file of fs.readdirSync(seedDir).filter((name) => name.endsWith('.sql')).sort()) {
    console.log(`seeding ${file}`)
    psql(databaseUrl, ['-c', 'set role mms_owner', '-f', path.join(seedDir, file)])
  }
}

console.log(count === 0 ? 'no pending migrations' : `applied ${count} migration(s)`)
