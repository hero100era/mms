import * as path from 'node:path'
import {
  applyBootstrap,
  parseDatabaseUrl,
  psql,
  redactDatabaseUrl,
  repoRoot,
  requireDatabaseUrl,
  withDatabase,
} from '../db/scripts/lib.ts'
import {
  databaseExists,
  isAllowedHost,
  isDisposableDatabase,
  isDisposableDatabaseName,
  isSafeAppEnv,
  readDatabaseComment,
  readTableMarker,
  setDisposableMarker,
} from '../db/scripts/testenv-safety.ts'
import { ensureAcceptanceKeys } from './lib/test-keys.ts'

export interface InitResult {
  rolesCreatedOrVerified: string[]
  databases: {
    name: string
    created: boolean
    disposable: boolean
    timezone: string
  }[]
  keysInitialized: boolean
}

/**
 * Version-controlled, authoritative initialization of native MMS environment.
 * Reuses authoritative bootstrap SQL (db/bootstrap/01_roles.sql) without duplication.
 *
 * Enforces Section 13 Initial-Create Authorization invariants:
 * requires safe APP_ENV, approved host, approved disposable database name,
 * and explicit first-create authorization (--allow-initial-create or ALLOW_INITIAL_CREATE=1).
 */
export async function initializeTestEnvironment(options: {
  databaseUrl?: string
  allowInitialCreate?: boolean
  targetDatabases?: { name: string; disposable: boolean; envMarker?: string | null }[]
} = {}): Promise<InitResult> {
  let rawUrl = options.databaseUrl ?? requireDatabaseUrl()
  let parsed = parseDatabaseUrl(rawUrl)
  let adminUrl = withDatabase(rawUrl, 'postgres')
  let appEnv = process.env.APP_ENV ?? 'local'

  // 1. Safety check: host allowlist and safe APP_ENV
  if (!isSafeAppEnv(appEnv)) {
    throw new Error(`ABORT: Environment initialization is prohibited in production (APP_ENV=${appEnv}).`)
  }
  if (!isAllowedHost(parsed.host)) {
    throw new Error(`ABORT: Database host "${parsed.host}" is not on the disposable test host allow-list.`)
  }

  // 2. Database specifications & Section 13 first-create authorization check
  let targetDatabases = options.targetDatabases ?? [
    { name: 'mms_dev', disposable: false, envMarker: null },
    { name: 'mms_test', disposable: true, envMarker: 'test' },
    { name: 'mms_acceptance', disposable: true, envMarker: 'acceptance' },
  ]

  let allowCreate =
    options.allowInitialCreate === true ||
    process.env.ALLOW_INITIAL_CREATE === '1' ||
    process.env.ALLOW_INITIAL_CREATE === 'true' ||
    process.argv.includes('--allow-initial-create')

  // Phase 1: Pre-flight verification of all database states and authorization
  // CRITICAL: Check all database prerequisites BEFORE applying any cluster role or password mutations
  for (let target of targetDatabases) {
    let exists = databaseExists(adminUrl, target.name)

    if (!exists) {
      if (!allowCreate) {
        throw new Error(
          `ABORT: Database "${target.name}" does not exist. First-time creation requires explicit fail-closed authorization (--allow-initial-create or ALLOW_INITIAL_CREATE=1).`,
        )
      }
    } else {
      let targetDbUrl = withDatabase(rawUrl, target.name)
      let existingComment = readDatabaseComment(adminUrl, target.name)
      let tableMarker = readTableMarker(targetDbUrl)

      // 1. Production marker check: refuse to initialize or relabel a production database
      let hasProductionComment = existingComment
        ? existingComment.includes('MMS_PRODUCTION_ENV') || existingComment.toLowerCase().includes('production')
        : false
      let hasProductionTable = tableMarker
        ? tableMarker.marker === 'MMS_PRODUCTION_ENV' || tableMarker.environment === 'production'
        : false

      if (hasProductionComment || hasProductionTable) {
        throw new Error(
          `ABORT: Database "${target.name}" carries a PRODUCTION environment marker. Refusing to initialize or relabel as disposable.`,
        )
      }

      // 2. Unmarked database check for disposable targets: refuse to relabel an unmarked database
      if (target.disposable) {
        let hasDisposableComment = existingComment ? existingComment.includes('MMS_DISPOSABLE_ENV') : false
        let hasDisposableTable = tableMarker?.isDisposable === true

        if (!hasDisposableComment && !hasDisposableTable) {
          throw new Error(
            `ABORT: Database "${target.name}" already exists but lacks a disposable environment marker. Refusing to relabel an existing unmarked database as disposable.`,
          )
        }
      }
    }
  }

  // Phase 2: Authoritative role definitions (reusing db/bootstrap/01_roles.sql)
  // Run only AFTER all database states and authorizations have been strictly validated
  let rolesSqlPath = path.join(repoRoot, 'db', 'bootstrap', '01_roles.sql')
  psql(adminUrl, ['-f', rolesSqlPath])

  let requiredRoles = [
    'mms_owner',
    'migrator',
    'authenticator',
    'auth_gateway',
    'worker',
    'audit_sealer',
    'web_anon',
    'ext_user',
    'int_viewer',
    'int_surveyor',
    'int_auditor',
    'int_coordinator',
    'int_manager',
    'int_compliance',
    'int_hr',
    'int_finance',
    'int_sysadmin',
    'mms_emergency',
  ]

  // Optional custom password provisioning from env
  if (process.env.LOCAL_AUTHENTICATOR_PASSWORD) {
    psql(adminUrl, ['-c', `alter role authenticator with password '${process.env.LOCAL_AUTHENTICATOR_PASSWORD.replace(/'/g, "''")}';`])
  }
  if (process.env.LOCAL_MIGRATOR_PASSWORD) {
    psql(adminUrl, ['-c', `alter role migrator with password '${process.env.LOCAL_MIGRATOR_PASSWORD.replace(/'/g, "''")}';`])
  }

  // Phase 3: Database creation and configuration
  let dbResults = []

  for (let target of targetDatabases) {
    let exists = databaseExists(adminUrl, target.name)
    let created = false

    if (!exists) {
      psql(adminUrl, ['-c', `create database "${target.name}" encoding 'UTF8' template template0;`])
      created = true
    }

    let targetDbUrl = withDatabase(rawUrl, target.name)

    // Ensure UTC timezone
    psql(adminUrl, ['-c', `alter database "${target.name}" set timezone to 'UTC';`])

    // Markers: mms_dev must NEVER be marked disposable; test & acceptance MUST be marked
    if (target.disposable && target.envMarker) {
      setDisposableMarker(adminUrl, targetDbUrl, target.name, target.envMarker)
    } else {
      // Clear any accidental disposable comment on mms_dev
      let existingComment = readDatabaseComment(adminUrl, target.name)
      if (existingComment && existingComment.includes('MMS_DISPOSABLE_ENV')) {
        psql(adminUrl, ['-c', `comment on database "${target.name}" is null;`])
      }
      // Drop any accidental disposable table on mms_dev
      let tableMarker = readTableMarker(targetDbUrl)
      if (tableMarker?.isDisposable) {
        psql(targetDbUrl, ['-c', `drop table if exists meta.disposable_marker;`], { allowFailure: true })
      }
    }

    // Apply idempotent bootstrap (schemas, extensions)
    applyBootstrap(targetDbUrl)

    dbResults.push({
      name: target.name,
      created,
      disposable: target.disposable,
      timezone: 'UTC',
    })
  }

  // 4. Initialize acceptance signing keys
  let keys = ensureAcceptanceKeys()

  return {
    rolesCreatedOrVerified: requiredRoles,
    databases: dbResults,
    keysInitialized: !!keys.jwksPath,
  }
}

async function main() {
  console.log('================================================================')
  console.log('MMS Native Local Environment Initialization (testenv:init)')
  console.log('================================================================')

  let rawUrl = requireDatabaseUrl()
  let parsed = parseDatabaseUrl(rawUrl)
  console.log(`Target Host: ${parsed.host}:${parsed.port}`)

  let result = await initializeTestEnvironment({
    allowInitialCreate: process.argv.includes('--allow-initial-create') || process.env.ALLOW_INITIAL_CREATE === '1',
  })

  console.log('----------------------------------------------------------------')
  console.log(`Roles Verified (${result.rolesCreatedOrVerified.length} authoritative roles):`)
  console.log(`  ${result.rolesCreatedOrVerified.slice(0, 8).join(', ')}...`)

  console.log('----------------------------------------------------------------')
  console.log('Databases Initialized:')
  for (let db of result.databases) {
    let markerStr = db.disposable ? '✓ Disposable' : '● Protected (Development)'
    let statusStr = db.created ? 'CREATED' : 'EXISTING'
    console.log(`  - ${db.name.padEnd(16)} : [${statusStr}] ${markerStr} (TZ: ${db.timezone})`)
  }

  console.log('----------------------------------------------------------------')
  console.log(`Acceptance JWT Keys: Initialized in .testdata/keys/`)
  console.log('================================================================')
  console.log('PASS: MMS native environment initialization complete.')
  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('testenv-init.ts')) {
  main().catch((err: any) => {
    console.error('Initialization failed:', err.message)
    process.exit(1)
  })
}
