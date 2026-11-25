#!/usr/bin/env node
/**
 * Executable Verification of Audit Trail Architecture:
 *
 * Verifies objective security, ownership, ACL, RLS, and PostgREST isolation
 * properties for schema audit_trail as defined in MMS architecture (ADR-0031 / Card H-02).
 */
import { psql, requireDatabaseUrl } from '../db/scripts/lib.ts'

export interface AuditTrailEvidence {
  schemaOwner: string
  legacyAuditSchemaPresent: boolean
  tableCount: number
  tables: Array<{ name: string; owner: string; rlsEnabled: boolean; rlsForced: boolean; oid: string }>
  publicTablePrivileges: number
  publicSchemaUsage: number
  postgrestGrants: number
  securityDefinerRoutinesCount: number
  workerPrivilegeCount: number
  sealerPrivilegeCount: number
  passed: boolean
  errors: string[]
}

export function collectAndVerifyEvidence(dbUrl?: string): AuditTrailEvidence {
  const url = dbUrl ?? requireDatabaseUrl()
  const errors: string[] = []

  // 1. Schema existence and ownership
  const schemaOwnerRes = psql(url, [
    '-Atqc',
    "select pg_catalog.pg_get_userbyid(nspowner) from pg_namespace where nspname = 'audit_trail'",
  ]).stdout.trim()

  if (schemaOwnerRes !== 'mms_owner') {
    errors.push(`Expected schema audit_trail owner to be mms_owner, got: '${schemaOwnerRes}'`)
  }

  const legacyAuditRes = psql(url, [
    '-Atqc',
    "select 1 from pg_namespace where nspname = 'audit'",
  ]).stdout.trim()

  const legacyAuditSchemaPresent = legacyAuditRes === '1'
  if (legacyAuditSchemaPresent) {
    errors.push('Legacy audit schema unexpectedly present in database')
  }

  // 2. Critical Object Counts and Ownership
  const expectedTables = [
    'change_log',
    'controlled_column',
    'crypto_shred_key',
    'entra_sync_run',
    'event',
    'event_type',
    'excluded_column',
    'forwarder_watermark',
    'malware_scan_run',
    'reconciliation_discrepancy',
    'reconciliation_run',
    'regulated_function',
    'retention_class',
    'retention_purge_run',
    'seal',
    'table_retention_policy',
  ]

  const tableRows = psql(url, [
    '-Atqc',
    "select c.relname, pg_catalog.pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, c.oid::text " +
    "from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
    "where n.nspname = 'audit_trail' and c.relkind = 'r' " +
    "order by c.relname",
  ]).stdout.trim().split('\n').filter(Boolean)

  const tables: AuditTrailEvidence['tables'] = []
  for (const row of tableRows) {
    const [name, owner, rls, forced, oid] = row.split('|')
    tables.push({
      name,
      owner,
      rlsEnabled: rls === 't',
      rlsForced: forced === 't',
      oid,
    })
  }

  if (tables.length !== expectedTables.length) {
    errors.push(`Expected exactly ${expectedTables.length} tables in audit_trail, found ${tables.length}`)
  }

  for (const table of tables) {
    if (table.owner !== 'mms_owner') {
      errors.push(`Table audit_trail.${table.name} owned by '${table.owner}', expected 'mms_owner'`)
    }
  }

  // RLS must be enabled on sensitive audit tables
  const rlsRequired = ['change_log', 'event', 'seal', 'crypto_shred_key', 'forwarder_watermark', 'reconciliation_run']
  for (const req of rlsRequired) {
    const found = tables.find((t) => t.name === req)
    if (!found || !found.rlsEnabled) {
      errors.push(`Table audit_trail.${req} must have Row Level Security (RLS) enabled`)
    }
  }

  // 3. PUBLIC Privileges
  const publicPrivCount = parseInt(
    psql(url, [
      '-Atqc',
      "select count(*) from information_schema.table_privileges where table_schema = 'audit_trail' and grantee = 'PUBLIC'",
    ]).stdout.trim(),
    10,
  )
  if (publicPrivCount !== 0) {
    errors.push(`PUBLIC role must have 0 privileges on audit_trail tables, found ${publicPrivCount}`)
  }

  const publicSchemaUsage = parseInt(
    psql(url, [
      '-Atqc',
      "select count(*) from information_schema.usage_privileges where object_schema = 'audit_trail' and grantee = 'PUBLIC'",
    ]).stdout.trim() || '0',
    10,
  )
  if (publicSchemaUsage !== 0) {
    errors.push(`PUBLIC role must have 0 USAGE privileges on audit_trail schema, found ${publicSchemaUsage}`)
  }

  // 4. PostgREST Isolation
  const postgrestGrants = parseInt(
    psql(url, [
      '-Atqc',
      "select count(*) from information_schema.role_table_grants where table_schema = 'audit_trail' and grantee in ('pgrst_anon', 'pgrst_auth', 'web_anon')",
    ]).stdout.trim() || '0',
    10,
  )
  if (postgrestGrants !== 0) {
    errors.push(`PostgREST roles must have 0 direct grants on audit_trail tables, found ${postgrestGrants}`)
  }

  // 5. SECURITY DEFINER Routines & search_path isolation
  const secDefCount = parseInt(
    psql(url, [
      '-Atqc',
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
      "where prosrc ~ 'audit_trail' and prosecdef = true and array_to_string(proconfig, ',') like '%search_path=\"\"%'",
    ]).stdout.trim() || '0',
    10,
  )
  if (secDefCount < 10) {
    errors.push(`Expected at least 10 SECURITY DEFINER routines with search_path="" referencing audit_trail, found ${secDefCount}`)
  }

  // 6. Worker and Sealer Privileges
  const workerPrivCount = parseInt(
    psql(url, [
      '-Atqc',
      "select count(*) from information_schema.role_table_grants where table_schema = 'audit_trail' and grantee = 'worker'",
    ]).stdout.trim() || '0',
    10,
  )
  if (workerPrivCount === 0) {
    errors.push('worker role must have granted privileges on audit_trail tables')
  }

  const sealerPrivCount = parseInt(
    psql(url, [
      '-Atqc',
      "select count(*) from information_schema.role_table_grants where table_schema = 'audit_trail' and grantee = 'audit_sealer'",
    ]).stdout.trim() || '0',
    10,
  )
  if (sealerPrivCount === 0) {
    errors.push('audit_sealer role must have granted privileges on audit_trail tables')
  }

  return {
    schemaOwner: schemaOwnerRes,
    legacyAuditSchemaPresent,
    tableCount: tables.length,
    tables,
    publicTablePrivileges: publicPrivCount,
    publicSchemaUsage,
    postgrestGrants,
    securityDefinerRoutinesCount: secDefCount,
    workerPrivilegeCount: workerPrivCount,
    sealerPrivilegeCount: sealerPrivCount,
    passed: errors.length === 0,
    errors,
  }
}

if (process.argv[1] && process.argv[1].endsWith('verify-migration-evidence.ts')) {
  console.log('=================================================================')
  console.log('MMS Executable Migration Review Evidence Verifier (Card H-02/R8.6)')
  console.log('=================================================================\n')

  const evidence = collectAndVerifyEvidence()
  console.log(`Schema Owner              : ${evidence.schemaOwner}`)
  console.log(`Legacy 'audit' Schema Gone: ${!evidence.legacyAuditSchemaPresent ? '✅ YES' : '❌ NO'}`)
  console.log(`Relational Table Count    : ${evidence.tableCount} tables`)
  console.log(`PUBLIC Table Privileges   : ${evidence.publicTablePrivileges} (required: 0)`)
  console.log(`PUBLIC Schema Usage       : ${evidence.publicSchemaUsage} (required: 0)`)
  console.log(`PostgREST Direct Grants   : ${evidence.postgrestGrants} (required: 0)`)
  console.log(`SECURITY DEFINER Routines : ${evidence.securityDefinerRoutinesCount} routines`)
  console.log(`Worker Grants Count       : ${evidence.workerPrivilegeCount}`)
  console.log(`Sealer Grants Count       : ${evidence.sealerPrivilegeCount}`)
  console.log(`Overall Status            : ${evidence.passed ? '✅ PASS' : '❌ FAIL'}\n`)

  if (!evidence.passed) {
    console.error('Evidence verification failed with errors:')
    for (const err of evidence.errors) {
      console.error(`- ⚠️  ${err}`)
    }
    process.exit(1)
  }

  console.log('All migration security evidence verified objectively against live catalog.')
  process.exit(0)
}
