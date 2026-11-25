import { spawnSync } from 'node:child_process'
import { parseDatabaseUrl, psql, withDatabase } from '../db/scripts/lib.ts'
import { isDisposableDatabase } from '../db/scripts/testenv-safety.ts'

export interface ServiceStatus {
  name: string
  running: boolean
  detail: string
}

export interface IdentityStatus {
  role: string
  configured: boolean
  effectiveUser: string | null
  nobypassrls: boolean
  nologin: boolean
  isSuperuser: boolean
}

export async function checkTestenvStatus(databaseUrl?: string): Promise<{
  services: ServiceStatus[]
  identities: IdentityStatus[]
}> {
  let rawUrl = databaseUrl ?? process.env.DATABASE_URL
  if (!rawUrl) {
    throw new Error('DATABASE_URL is required. See docs/testing/native-environment.md')
  }
  let parsed = parseDatabaseUrl(rawUrl)
  let pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'
  let webUrl = process.env.APPLICATION_BASE_URL ?? 'http://localhost:3000'

  let services: ServiceStatus[] = []
  let identities: IdentityStatus[] = []

  // 1. Check PostgreSQL service
  let pgRunning = false
  let pgDetail = 'stopped / unreachable'
  try {
    let res = psql(rawUrl, ['-tA', '-c', "SELECT version();"], { allowFailure: true })
    if (res.status === 0 && res.stdout.includes('PostgreSQL')) {
      pgRunning = true
      let firstLine = res.stdout.trim().split('\n')[0]!
      pgDetail = `${firstLine.slice(0, 45)}... on ${parsed.host}:${parsed.port}/${parsed.database}`
    }
  } catch {}
  services.push({ name: 'PostgreSQL', running: pgRunning, detail: pgDetail })

  // 2. Check PostgREST service
  let pgrstRunning = false
  let pgrstDetail = 'stopped'
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 2000)
    let res = await fetch(`${pgrstUrl}/`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 200 || res.status === 404) {
      pgrstRunning = true
      pgrstDetail = `running at ${pgrstUrl} (HTTP ${res.status})`
    }
  } catch {}
  services.push({ name: 'PostgREST 16.5', running: pgrstRunning, detail: pgrstDetail })

  // 3. Check MMS Web service
  let webRunning = false
  let webDetail = 'stopped'
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 2000)
    let res = await fetch(`${webUrl}/login`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 200) {
      webRunning = true
      webDetail = `running at ${webUrl} (HTTP 200)`
    }
  } catch {}
  services.push({ name: 'MMS Remix Web', running: webRunning, detail: webDetail })

  // 4. Check Background processes (Worker, Sealer) via process table
  let psCheck = spawnSync('pgrep', ['-a', 'node'], { encoding: 'utf8' })
  let psOutput = psCheck.stdout ?? ''

  let workerRunning = psOutput.includes('worker.ts')
  services.push({
    name: 'MMS Worker',
    running: workerRunning,
    detail: workerRunning ? 'active daemon process' : 'inactive (run npm run start:worker)',
  })

  let sealerRunning = psOutput.includes('sealer.ts')
  services.push({
    name: 'Audit Sealer',
    running: sealerRunning,
    detail: sealerRunning ? 'active daemon process' : 'inactive (run npm run start:sealer)',
  })

  // 5. Test Scanner & Notification Sink
  let scannerEnabled = process.env.ALLOW_TEST_SCANNER === 'true'
  services.push({
    name: 'Test Scanner Adapter',
    running: scannerEnabled,
    detail: scannerEnabled ? 'ALLOW_TEST_SCANNER=true' : 'standard / inactive',
  })

  let notifUrl = process.env.NOTIFICATION_SINK_URL ?? 'http://127.0.0.1:8025'
  let notifRunning = false
  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 1000)
    let res = await fetch(notifUrl, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status < 500) notifRunning = true
  } catch {}
  services.push({
    name: 'Notification Sink',
    running: notifRunning,
    detail: notifRunning ? `listening at ${notifUrl}` : `local capture / dev-mailbox fallback`,
  })

  // 6. Identity Separation Diagnostic (R8.6.3)
  if (pgRunning) {
    let rolesToCheck = [
      'migrator',
      'authenticator',
      'auth_gateway',
      'worker',
      'audit_sealer',
      'mms_owner',
      'ext_user',
      'int_surveyor',
    ]

    let rolesQuery = psql(
      rawUrl,
      [
        '-tA',
        '-F',
        '|',
        '-c',
        `SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname IN (${rolesToCheck.map((r) => `'${r}'`).join(',')});`,
      ],
      { allowFailure: true },
    )

    let roleRows = rolesQuery.stdout.trim().split('\n').filter(Boolean)
    let roleMap = new Map<string, { canLogin: boolean; superuser: boolean; bypassRls: boolean }>()
    for (let row of roleRows) {
      let [name, login, sup, bypass] = row.split('|')
      if (name) {
        roleMap.set(name, {
          canLogin: login === 't',
          superuser: sup === 't',
          bypassRls: bypass === 't',
        })
      }
    }

    for (let roleName of rolesToCheck) {
      let meta = roleMap.get(roleName)
      if (!meta) {
        identities.push({
          role: roleName,
          configured: false,
          effectiveUser: null,
          nobypassrls: false,
          nologin: false,
          isSuperuser: false,
        })
      } else {
        identities.push({
          role: roleName,
          configured: true,
          effectiveUser: roleName,
          nobypassrls: !meta.bypassRls,
          nologin: !meta.canLogin,
          isSuperuser: meta.superuser,
        })
      }
    }
  }

  return { services, identities }
}

async function main() {
  console.log('================================================================')
  console.log('MMS Local Acceptance Test Environment Status')
  console.log('================================================================')

  let targetDb = process.env.DATABASE_URL ? parseDatabaseUrl(process.env.DATABASE_URL).database : 'mms_acceptance'
  console.log(`Target Database: ${targetDb}`)
  console.log('----------------------------------------------------------------')
  console.log('Services & Subsystems:')

  let { services, identities } = await checkTestenvStatus()

  for (let s of services) {
    let icon = s.running ? '●' : '○'
    console.log(`  ${icon} ${s.name.padEnd(26)} : ${s.detail}`)
  }

  console.log('----------------------------------------------------------------')
  console.log('Database Identity Separation Diagnostic (R8.6.3):')
  console.log('  Role                 Login?  Super?  BYPASSRLS?  Status')
  console.log('  -------------------------------------------------------------')
  for (let id of identities) {
    let loginStr = id.nologin ? 'NO' : 'YES'
    let superStr = id.isSuperuser ? 'YES (UNSAFE)' : 'NO'
    let bypassStr = id.nobypassrls ? 'NO (SECURE)' : 'YES (UNSAFE)'
    let status = !id.isSuperuser && id.nobypassrls ? '✓ Isolated' : '✗ Invariant violated'
    console.log(
      `  ${id.role.padEnd(20)} ${loginStr.padEnd(7)} ${superStr.padEnd(7)} ${bypassStr.padEnd(11)} ${status}`,
    )
  }

  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('testenv-status.ts')) {
  main().catch((err) => {
    console.error('Fatal status check error:', err.message)
    process.exit(1)
  })
}
