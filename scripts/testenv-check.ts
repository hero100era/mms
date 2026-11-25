import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseDatabaseUrl, psql, redactDatabaseUrl, repoRoot } from '../db/scripts/lib.ts'
import { verifyPostgresVersion } from '../db/scripts/postgres-policy.ts'
import { isDisposableDatabase } from '../db/scripts/testenv-safety.ts'

export type CheckResult = {
  name: string
  passed: boolean
  detail: string
  error?: string
}

export async function runTestenvCheck(options: { databaseUrl?: string; pgrstUrl?: string } = {}): Promise<{
  allPassed: boolean
  results: CheckResult[]
}> {
  let results: CheckResult[] = []

  let rawUrl = options.databaseUrl ?? process.env.DATABASE_URL
  let parsed = rawUrl ? parseDatabaseUrl(rawUrl) : undefined
  let pgrstUrl = options.pgrstUrl ?? process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'

  // 1. Node.js version
  let nodeVersion = process.version
  let pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  let expectedNode = pkg.engines?.node ?? '^24.7.0 || ^26.0.0'
  let nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0]!, 10)
  let nodePassed = nodeMajor === 24 || nodeMajor === 26
  results.push({
    name: 'Node.js runtime',
    passed: nodePassed,
    detail: `${nodeVersion} (expected ${expectedNode})`,
    error: nodePassed
      ? undefined
      : `ERROR: Incompatible Node.js version ${nodeVersion} detected. Expected ${expectedNode}.`,
  })

  // 2. npm version
  let npmCheck = spawnSync('npm', ['--version'], { encoding: 'utf8' })
  let npmVersion = (npmCheck.stdout ?? '').trim()
  let npmPassed = npmCheck.status === 0 && npmVersion.length > 0
  results.push({
    name: 'npm package manager',
    passed: npmPassed,
    detail: npmPassed ? `v${npmVersion}` : 'not found',
    error: npmPassed ? undefined : 'ERROR: npm was not found in PATH or failed to execute.',
  })

  // 3. PostgreSQL client binary
  let psqlCheck = spawnSync('psql', ['--version'], { encoding: 'utf8' })
  let psqlOutput = (psqlCheck.stdout ?? '').trim()
  let psqlClientMatch = psqlOutput.match(/psql \(PostgreSQL\) (\d+)\.(\d+)/)
  let psqlClientPassed = !!psqlClientMatch
  results.push({
    name: 'PostgreSQL client binary (psql)',
    passed: psqlClientPassed,
    detail: psqlOutput || 'not found in PATH',
    error: psqlClientPassed ? undefined : 'ERROR: psql client binary not found in PATH.',
  })

  // 4. Connected PostgreSQL server version & reachability (checks server_version_num)
  let pgReachable = false
  let pgServerVersionPassed = false
  let pgServerVersionDetail = 'unreachable'
  let pgServerVersionError: string | undefined

  if (!rawUrl || !parsed) {
    pgServerVersionError = 'ERROR: DATABASE_URL is required. See docs/testing/native-environment.md'
    pgServerVersionDetail = 'missing DATABASE_URL'
  } else {
    try {
      let check = psql(
        rawUrl,
        ['-tA', '-c', "SELECT current_setting('server_version_num') || '|' || current_setting('server_version');"],
        { allowFailure: true },
      )
      if (check.status === 0 && check.stdout.trim().includes('|')) {
        pgReachable = true
        let [numStr, verStr] = check.stdout.trim().split('|')
        let serverVersionNum = Number.parseInt(numStr!, 10)
        let vCheck = verifyPostgresVersion(serverVersionNum, verStr!)
        pgServerVersionPassed = vCheck.passed
        pgServerVersionDetail = `${vCheck.detail} on ${parsed.host}:${parsed.port}/${parsed.database}`
        pgServerVersionError = vCheck.error
      } else {
        pgServerVersionError = `ERROR: Cannot connect to PostgreSQL at ${parsed.host}:${parsed.port}/${parsed.database}.\n${check.stderr}`
      }
    } catch (err: any) {
      pgServerVersionError = `ERROR: Cannot connect to PostgreSQL at ${parsed.host}:${parsed.port}/${parsed.database}: ${err.message}`
    }
  }

  results.push({
    name: 'PostgreSQL reachability',
    passed: pgReachable,
    detail: pgReachable && parsed ? `${parsed.host}:${parsed.port}/${parsed.database}` : (pgServerVersionDetail || 'unreachable'),
    error: pgReachable ? undefined : pgServerVersionError,
  })

  results.push({
    name: 'PostgreSQL server version (server_version_num)',
    passed: pgServerVersionPassed,
    detail: pgServerVersionDetail,
    error: pgServerVersionError,
  })

  // 5. PostgREST binary & version
  let pgrstCheck = spawnSync('postgrest', ['--version'], { encoding: 'utf8' })
  let pgrstOutput = (pgrstCheck.stdout ?? '').trim()
  let pgrstMatch = pgrstOutput.match(/PostgREST (\d+)\.(\d+)/)
  let pgrstMajor = pgrstMatch ? Number.parseInt(pgrstMatch[1]!, 10) : 0
  let pgrstMinor = pgrstMatch ? Number.parseInt(pgrstMatch[2]!, 10) : 0
  let pgrstVersionPassed = pgrstMajor === 16 && pgrstMinor === 5

  results.push({
    name: 'PostgREST binary version',
    passed: pgrstVersionPassed,
    detail: pgrstMatch ? `PostgREST ${pgrstMajor}.${pgrstMinor} (baseline 16.5)` : 'not found / invalid',
    error: pgrstVersionPassed
      ? undefined
      : `ERROR: PostgREST 16.5 is required by R8.6 baseline, found "${pgrstOutput}".`,
  })

  // 6. PostgREST reachability
  let pgrstReachable = false
  let pgrstDetail = 'unreachable'
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 2000)
    let res = await fetch(`${pgrstUrl}/`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 200 || res.status === 404) {
      pgrstReachable = true
      pgrstDetail = `${pgrstUrl} (status ${res.status})`
    }
  } catch {
    pgrstDetail = `unreachable at ${pgrstUrl}`
  }

  results.push({
    name: 'PostgREST reachability',
    passed: pgrstReachable,
    detail: pgrstDetail,
    error: pgrstReachable
      ? undefined
      : `ERROR: PostgREST is unreachable at ${pgrstUrl}. Native PostgREST is part of the canonical acceptance environment. Start with 'npm run postgrest:start' or run 'postgrest'.`,
  })

  // Database-dependent checks (only run if PG is reachable)
  if (pgReachable) {
    // 7. Database encoding (UTF8)
    let encCheck = psql(rawUrl, ['-tA', '-c', 'SHOW server_encoding;'], { allowFailure: true })
    let encoding = encCheck.stdout.trim()
    let encPassed = encoding.toUpperCase() === 'UTF8'
    results.push({
      name: 'Database encoding',
      passed: encPassed,
      detail: encoding,
      error: encPassed ? undefined : `ERROR: Database server_encoding is ${encoding}, required UTF8.`,
    })

    // 8. Database timezone (UTC)
    let tzCheck = psql(rawUrl, ['-tA', '-c', 'SHOW TimeZone;'], { allowFailure: true })
    let tz = tzCheck.stdout.trim()
    let tzPassed = ['UTC', 'ETC/UTC'].includes(tz.toUpperCase())
    results.push({
      name: 'Database timezone',
      passed: tzPassed,
      detail: tz,
      error: tzPassed ? undefined : `ERROR: Database TimeZone is ${tz}, required UTC.`,
    })

    // 9. Required extensions
    let extCheck = psql(
      rawUrl,
      ['-tA', '-c', "SELECT extname FROM pg_extension WHERE extname IN ('btree_gist', 'pgcrypto') ORDER BY extname;"],
      { allowFailure: true },
    )
    let extensions = extCheck.stdout.trim().split('\n').filter(Boolean)
    let extPassed = extensions.includes('btree_gist') && extensions.includes('pgcrypto')
    results.push({
      name: 'Required extensions',
      passed: extPassed,
      detail: extensions.join(', ') || 'none',
      error: extPassed ? undefined : `ERROR: Missing required extensions (found: ${extensions.join(', ') || 'none'}).`,
    })

    // 10. Required database roles
    let requiredRoles = [
      'migrator',
      'authenticator',
      'auth_gateway',
      'worker',
      'audit_sealer',
      'mms_owner',
      'int_surveyor',
      'ext_user',
    ]
    let rolesCheck = psql(
      rawUrl,
      [
        '-tA',
        '-c',
        `SELECT rolname FROM pg_roles WHERE rolname IN (${requiredRoles.map((r) => `'${r}'`).join(',')});`,
      ],
      { allowFailure: true },
    )
    let foundRoles = rolesCheck.stdout.trim().split('\n').filter(Boolean)
    let missingRoles = requiredRoles.filter((r) => !foundRoles.includes(r))
    let rolesPassed = missingRoles.length === 0
    results.push({
      name: 'Required database roles',
      passed: rolesPassed,
      detail: `${foundRoles.length}/${requiredRoles.length} present`,
      error: rolesPassed ? undefined : `ERROR: Missing database roles: ${missingRoles.join(', ')}.`,
    })

    // 11. Test environment positive identification
    let isDisposable = isDisposableDatabase(rawUrl, parsed.database)
    let isTestOrAcceptance = ['mms_test', 'mms_acceptance'].includes(parsed.database)
    let envIdentified = isDisposable && isTestOrAcceptance
    results.push({
      name: 'Disposable test environment marker',
      passed: envIdentified,
      detail: isDisposable ? `positively marked (${parsed.database})` : `UNMARKED (${parsed.database})`,
      error: envIdentified
        ? undefined
        : `ERROR: Target database "${parsed.database}" lacks the durable disposable marker. Reconstruct using 'npm run testenv:reset'.`,
    })

    // 12. Migration state
    let migrationDir = path.join(repoRoot, 'db', 'migrations')
    let repoMigrations = fs
      .readdirSync(migrationDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    let appliedCheck = psql(
      rawUrl,
      ['-tA', '-c', 'SELECT directory FROM public.schema_migrations ORDER BY directory;'],
      { allowFailure: true },
    )
    let appliedMigrations = appliedCheck.stdout.trim().split('\n').filter(Boolean)
    let unapplied = repoMigrations.filter((m) => !appliedMigrations.includes(m))
    let migrationsPassed = unapplied.length === 0 && appliedMigrations.length > 0
    results.push({
      name: 'MMS migration state',
      passed: migrationsPassed,
      detail: `${appliedMigrations.length}/${repoMigrations.length} applied`,
      error: migrationsPassed
        ? undefined
        : `ERROR: Migration drift detected. ${unapplied.length} migration(s) unapplied: ${unapplied.slice(0, 3).join(', ')}...`,
    })
  }

  let allPassed = results.every((r) => r.passed)
  return { allPassed, results }
}

async function main() {
  console.log('================================================================')
  console.log('R8.6 Native Local Acceptance Test Environment Checker')
  console.log('================================================================')

  let { allPassed, results } = await runTestenvCheck()

  for (let r of results) {
    let icon = r.passed ? '✓' : '✗'
    console.log(`  ${icon} [${r.name}]: ${r.detail}`)
    if (!r.passed && r.error) {
      console.log(`    -> ${r.error}`)
    }
  }

  console.log('----------------------------------------------------------------')
  if (allPassed) {
    console.log('RESULT: PASS - All native prerequisites and invariants verified.')
    console.log('================================================================')
    process.exit(0)
  } else {
    console.error('RESULT: FAIL - Environment drift or missing prerequisites detected.')
    console.log('================================================================')
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('testenv-check.ts')) {
  main().catch((err) => {
    console.error('Fatal check error:', err.message)
    process.exit(1)
  })
}
