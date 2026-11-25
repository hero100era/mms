import { parseDatabaseUrl, psql } from './lib.ts'

export interface DisposableMarkerInfo {
  isDisposable: boolean
  environment: string
  marker: string
  markedAt?: string
  databaseComment?: string
}

export interface SafetyCheckOptions {
  databaseUrl: string
  targetDatabase?: string
  appEnv?: string
  allowedHosts?: string[]
  allowInitialCreate?: boolean
}

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '/tmp', '/var/run/postgresql']
const SAFE_ENVIRONMENTS = new Set(['local', 'test', 'acceptance', 'development'])

export function isSafeAppEnv(env?: string): boolean {
  let appEnv = (env ?? process.env.APP_ENV ?? 'local').toLowerCase().trim()
  let nodeEnv = (process.env.NODE_ENV ?? '').toLowerCase().trim()
  if (appEnv === 'production' || nodeEnv === 'production') return false
  return SAFE_ENVIRONMENTS.has(appEnv)
}

export function isDisposableDatabaseName(database: string): boolean {
  let name = database.toLowerCase().trim()
  // Explicitly prohibited databases
  if (name === 'postgres' || name === 'mms_dev' || name === 'template0' || name === 'template1') {
    return false
  }
  if (name.includes('prod') || name.includes('production') || name.includes('live')) {
    return false
  }
  // Must end with or contain an approved disposable suffix/name
  return (
    name === 'mms_acceptance' ||
    name === 'mms_test' ||
    name.endsWith('_acceptance') ||
    name.endsWith('_test') ||
    name.endsWith('_drill') ||
    name.endsWith('_scratch') ||
    name.endsWith('_restore')
  )
}

export function isAllowedHost(host: string, customAllowedHosts?: string[]): boolean {
  let allowed = customAllowedHosts ?? (
    process.env.MMS_ALLOWED_TEST_HOSTS
      ? process.env.MMS_ALLOWED_TEST_HOSTS.split(',').map((h) => h.trim().toLowerCase())
      : DEFAULT_ALLOWED_HOSTS
  )
  let cleanHost = host.toLowerCase().trim()
  return allowed.some((h) => h === cleanHost || (h.startsWith('/') && cleanHost.startsWith(h)))
}

export function readDatabaseComment(adminUrl: string, database: string): string | null {
  try {
    let result = psql(
      adminUrl,
      [
        '-Atc',
        `select pg_catalog.shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = '${database.replace(/'/g, "''")}'`,
      ],
      { allowFailure: true },
    )
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim()
    }
  } catch {
    // ignore
  }
  return null
}

export function readTableMarker(dbUrl: string): DisposableMarkerInfo | null {
  try {
    let result = psql(
      dbUrl,
      [
        '-Atc',
        `select json_build_object('marker', marker, 'environment', environment, 'markedAt', marked_at) from meta.disposable_marker limit 1`,
      ],
      { allowFailure: true },
    )
    if (result.status === 0 && result.stdout.trim()) {
      let data = JSON.parse(result.stdout.trim())
      return {
        isDisposable: data.marker === 'MMS_DISPOSABLE_ENV',
        environment: data.environment,
        marker: data.marker,
        markedAt: data.markedAt,
      }
    }
  } catch {
    // table might not exist
  }
  return null
}

export function isDisposableDatabase(dbUrl: string, database?: string, adminUrl?: string): boolean {
  let tableMarker = readTableMarker(dbUrl)
  if (tableMarker?.isDisposable) return true
  if (adminUrl && database) {
    let comment = readDatabaseComment(adminUrl, database)
    if (comment && comment.includes('MMS_DISPOSABLE_ENV')) return true
  }
  return false
}

export function databaseExists(adminUrl: string, database: string): boolean {
  let result = psql(
    adminUrl,
    ['-Atc', `select 1 from pg_database where datname = '${database.replace(/'/g, "''")}'`],
    { allowFailure: true },
  )
  return result.status === 0 && result.stdout.trim() === '1'
}

export function setDisposableMarker(adminUrl: string, dbUrl: string, database: string, env = 'acceptance'): void {
  // 1. Database comment on PostgreSQL database
  psql(
    adminUrl,
    [
      '-c',
      `comment on database "${database.replace(/"/g, '""')}" is 'MMS_DISPOSABLE_ENV:${env}'`,
    ],
  )

  // 2. Metadata table inside the database
  psql(
    dbUrl,
    [
      '-c',
      `
      create schema if not exists meta;
      create table if not exists meta.disposable_marker (
        id int primary key default 1,
        marker text not null,
        environment text not null,
        marked_at timestamptz not null default now()
      );
      insert into meta.disposable_marker (id, marker, environment, marked_at)
      values (1, 'MMS_DISPOSABLE_ENV', '${env.replace(/'/g, "''")}', now())
      on conflict (id) do update set
        marker = excluded.marker,
        environment = excluded.environment,
        marked_at = now();
      `,
    ],
  )
}

export function assertCanDestroyDatabase(options: SafetyCheckOptions): void {
  let parts = parseDatabaseUrl(options.databaseUrl)
  let target = options.targetDatabase ?? parts.database
  let appEnv = options.appEnv ?? process.env.APP_ENV

  // 1. APP_ENV check
  if (!isSafeAppEnv(appEnv)) {
    throw new Error(
      `ABORT: Destructive test operations are prohibited in production environment (APP_ENV=${appEnv ?? 'undefined'}, NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}).`,
    )
  }

  // 2. Database name checks
  if (target === 'postgres') {
    throw new Error(`ABORT: Destructive reset of administrative database "postgres" is strictly forbidden.`)
  }
  if (target === 'mms_dev') {
    throw new Error(`ABORT: Destructive reset of development database "mms_dev" is forbidden. Use manual reset only.`)
  }
  if (!isDisposableDatabaseName(target)) {
    throw new Error(
      `ABORT: Database "${target}" is not an authorized disposable database name (must end in _acceptance, _test, _drill, _scratch, _restore).`,
    )
  }

  // 3. Host allowlist check
  if (!isAllowedHost(parts.host, options.allowedHosts)) {
    throw new Error(
      `ABORT: Database host "${parts.host}" is not on the disposable test host allow-list (${(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).join(', ')}).`,
    )
  }

  // 4. Inspect existing database for markers
  let parsedUrl = new URL(options.databaseUrl)
  parsedUrl.pathname = '/postgres'
  let adminUrl = parsedUrl.toString()

  let exists = databaseExists(adminUrl, target)
  if (exists) {
    let comment = readDatabaseComment(adminUrl, target)
    if (comment && comment.includes('MMS_PRODUCTION_ENV')) {
      throw new Error(`ABORT: Database "${target}" carries a PRODUCTION environment marker. Aborting.`)
    }

    let targetDbUrl = new URL(options.databaseUrl)
    targetDbUrl.pathname = `/${target}`
    let tableMarker = readTableMarker(targetDbUrl.toString())

    let hasDisposableComment = comment ? comment.includes('MMS_DISPOSABLE_ENV') : false
    let hasDisposableTable = tableMarker?.isDisposable === true

    if (!hasDisposableComment && !hasDisposableTable) {
      throw new Error(
        `ABORT: Database "${target}" exists but lacks the required disposable environment marker. Refusing destructive reset.`,
      )
    }
  } else {
    // Database does not exist yet. Destructive resets require a durable disposable marker.
    // First-time creation requires a separately verified, fail-closed authorization.
    let authorized =
      options.allowInitialCreate === true ||
      process.env.ALLOW_INITIAL_CREATE === '1' ||
      process.env.ALLOW_INITIAL_CREATE === 'true' ||
      process.argv.includes('--allow-initial-create')

    if (!authorized) {
      throw new Error(
        `ABORT: Database "${target}" does not exist and lacks a verified disposable marker. First-time creation requires explicit fail-closed authorization (--allow-initial-create or ALLOW_INITIAL_CREATE=1).`,
      )
    }
  }
}

export function terminateDatabaseSessions(adminUrl: string, targetDatabase: string): number {
  let result = psql(
    adminUrl,
    [
      '-Atc',
      `
      select count(*) from pg_stat_activity
      where datname = '${targetDatabase.replace(/'/g, "''")}'
        and pid <> pg_backend_pid();
      `,
    ],
    { allowFailure: true },
  )
  let count = Number(result.stdout.trim()) || 0

  if (count > 0) {
    psql(
      adminUrl,
      [
        '-c',
        `
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = '${targetDatabase.replace(/'/g, "''")}'
          and pid <> pg_backend_pid();
        `,
      ],
      { allowFailure: true },
    )
  }
  return count
}
