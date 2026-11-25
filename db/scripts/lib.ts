import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const repoRoot = path.resolve(import.meta.dirname, '..', '..')
export const dbDir = path.join(repoRoot, 'db')
export const migrationsDir = path.join(dbDir, 'migrations')

// Load .env if present
try {
  let envFile = path.join(repoRoot, '.env')
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile)
  }
} catch {}

export type DatabaseParts = {
  url: string
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function redactDatabaseUrl(url: string): string {
  try {
    let parsed = new URL(url)
    if (parsed.password) {
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    return url.replace(/:([^@/]+)@/, ':***@')
  }
}

export function requireDatabaseUrl(): string {
  let url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required. See docs/testing/native-environment.md')
  }
  return url
}

export function parseDatabaseUrl(url: string): DatabaseParts {
  let parsed = new URL(url)
  let database = parsed.pathname.replace(/^\//, '') || 'postgres'
  let host = parsed.searchParams.get('host') || parsed.hostname || 'localhost'
  return {
    url,
    host,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database,
  }
}

export function withDatabase(url: string, database: string): string {
  let parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

export function schemaNames(): string[] {
  return fs
    .readFileSync(path.join(dbDir, 'schemas.txt'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  let result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  let output = {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  }
  if (output.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${output.status}\n${output.stderr}\n${output.stdout}`,
    )
  }
  return output
}

export function psql(
  url: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  let parts = parseDatabaseUrl(url)
  let password = parts.password || (process.env.NODE_ENV === 'test' && parts.user !== 'postgres' ? 'devpassword' : '')
  return run(
    'psql',
    [url, '-v', 'ON_ERROR_STOP=1', ...args],
    {
      cwd: options.cwd,
      allowFailure: options.allowFailure,
      env: password ? { PGPASSWORD: password } : undefined,
    },
  )
}

export function recreateDatabase(url: string, database: string): void {
  let adminUrl = withDatabase(url, 'postgres')
  psql(adminUrl, ['-c', `drop database if exists "${database}" with (force)`])
  psql(adminUrl, ['-c', `create database "${database}"`])
  psql(adminUrl, ['-c', `grant create on database "${database}" to mms_owner`], { allowFailure: true })
}

export function applyBootstrap(url: string): void {
  run(process.execPath, [path.join(dbDir, 'scripts', 'bootstrap.ts')], {
    env: { DATABASE_URL: url },
  })
}

export function schemaSourceFiles(schema: string): string[] {
  let schemaDir = path.join(dbDir, 'src', schema)
  return fs
    .readdirSync(schemaDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => path.join(schemaDir, file))
}

export function applySchemaSources(url: string): void {
  for (let schema of schemaNames()) {
    let schemaDir = path.join(dbDir, 'src', schema)
    let files = schemaSourceFiles(schema)
    if (files.length === 0) {
      throw new Error(`No SQL files in ${schemaDir}`)
    }
    for (let file of files) {
      psql(url, ['-c', 'set role mms_owner', '-c', 'set check_function_bodies = off', '-c', "set search_path = ''", '-f', path.basename(file)], {
        cwd: schemaDir,
      })
    }
  }
}

export function buildPlanDatabase(url: string, database: string): string {
  let planUrl = withDatabase(url, database)
  recreateDatabase(url, database)
  applyBootstrap(planUrl)
  applySchemaSources(planUrl)
  return planUrl
}

export function applyMigrations(url: string, options: { skipSeeds?: boolean; target?: string } = {}): void {
  run(process.execPath, [path.join(dbDir, 'scripts', 'migrate.ts')], {
    env: {
      DATABASE_URL: url,
      ...(options.skipSeeds ? { SKIP_SEEDS: '1' } : {}),
      ...(options.target ? { MIGRATE_TARGET: options.target } : {}),
    },
  })
}

export type PgschemaPlan = {
  schema: string
  sql: string
  human: string
  json: string
  stderr: string
  status: number
}

/**
 * Plans a schema. A non-zero exit from pgschema is always a gate failure: callers
 * must never have to remember to inspect `.status`, or a crashed diff that printed
 * nothing would be read as "no drift".
 */
export function pgschemaPlan(
  baselineUrl: string,
  planUrl: string,
  schema: string,
): PgschemaPlan {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), `mms-desired-${schema}-`))
  let desiredFile = path.join(dir, 'desired.sql')
  let sources = schemaSourceFiles(schema)
  if (sources.length === 0) throw new Error(`No SQL files for schema ${schema}`)
  fs.writeFileSync(
    desiredFile,
    sources
      .map((file) => `-- ${path.basename(file)}\n${fs.readFileSync(file, 'utf8')}`)
      .join('\n\n'),
  )
  try {
    let plan = pgschemaPlanFile(baselineUrl, planUrl, schema, desiredFile)
    if (plan.status !== 0) {
      throw new Error(
        `pgschema plan for schema "${schema}" failed (exit ${plan.status}):\n${plan.stderr}\n${plan.human}`,
      )
    }
    return plan
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function pgschemaPlanFile(
  baselineUrl: string,
  planUrl: string,
  schema: string,
  desiredFile: string,
): PgschemaPlan {
  let baseline = parseDatabaseUrl(baselineUrl)
  let plan = parseDatabaseUrl(planUrl)
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), `mms-plan-${schema}-`))
  let sqlFile = path.join(dir, 'plan.sql')
  let humanFile = path.join(dir, 'plan.txt')
  let jsonFile = path.join(dir, 'plan.json')
  let args = [
    'plan',
    '--host',
    baseline.host,
    '--port',
    String(baseline.port),
    '--user',
    baseline.user,
    '--db',
    baseline.database,
    '--plan-host',
    plan.host,
    '--plan-port',
    String(plan.port),
    '--plan-user',
    plan.user,
    '--plan-db',
    plan.database,
    '--schema',
    schema,
    '--file',
    desiredFile,
    '--output-sql',
    sqlFile,
    '--output-human',
    humanFile,
    '--output-json',
    jsonFile,
    '--no-color',
  ]
  let result = run('pgschema', args, {
    allowFailure: true,
    env: baseline.password ? { PGPASSWORD: baseline.password } : undefined,
  })
  let read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  let planResult = {
    schema,
    sql: read(sqlFile).trim(),
    human: read(humanFile).trim(),
    json: read(jsonFile).trim(),
    stderr: result.stderr.trim(),
    status: result.status,
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return planResult
}

export function pgschemaVersion(): string {
  let result = run('pgschema', ['--version'])
  let match = result.stdout.match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : 'unknown'
}

export function splitMigrationSql(sql: string): { transactional: string; nontx: string[] } {
  let withoutWait = sql.replace(/--\s*pgschema:wait[\s\S]*?;\s*/gi, '')
  let nontx: string[] = []
  let transactional = withoutWait.replace(
    /(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY[\s\S]*?;/gi,
    (statement) => {
      nontx.push(statement.trim())
      return ''
    },
  )
  return { transactional: transactional.trim(), nontx }
}

export function applySeeds(url: string): void {
  let seedDir = path.join(repoRoot, 'db', 'seed')
  if (!fs.existsSync(seedDir)) return
  for (let file of fs.readdirSync(seedDir).filter((name) => name.endsWith('.sql')).sort()) {
    psql(url, ['-c', 'set role mms_owner', '-f', path.join(seedDir, file)])
  }
}
