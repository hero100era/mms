import { spawnSync } from 'node:child_process'
import { psql, requireDatabaseUrl } from '../db/scripts/lib.ts'

export async function checkPostgrest(pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'): Promise<{
  alive: boolean
  version: string
  endpointsReachable: boolean
  schemaCacheLoaded: boolean
}> {
  let version = 'unknown'
  let versionCheck = spawnSync('postgrest', ['--version'], { encoding: 'utf8' })
  if (versionCheck.status === 0) {
    version = (versionCheck.stdout ?? '').trim()
  }

  let alive = false
  let endpointsReachable = false
  let schemaCacheLoaded = false

  try {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 2000)
    let res = await fetch(`${pgrstUrl}/`, { signal: controller.signal })
    clearTimeout(timer)
    alive = res.status === 200 || res.status === 404

    // Query OpenAPI / root spec if status 200
    if (res.status === 200) {
      endpointsReachable = true
      let body = await res.json()
      if (body.definitions || body.paths) {
        schemaCacheLoaded = true
      }
    }
  } catch (err: any) {
    alive = false
  }

  return { alive, version, endpointsReachable, schemaCacheLoaded }
}

async function main() {
  console.log('================================================================')
  console.log('PostgREST Acceptance Check')
  console.log('================================================================')

  let pgrstUrl = process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'
  let { alive, version, endpointsReachable, schemaCacheLoaded } = await checkPostgrest(pgrstUrl)

  console.log(`Binary:  ${version}`)
  console.log(`URL:     ${pgrstUrl}`)
  console.log(`Status:  ${alive ? '● ONLINE' : '○ OFFLINE'}`)
  console.log(`OpenAPI: ${endpointsReachable ? 'Available' : 'Unreachable'}`)
  console.log(`Schema:  ${schemaCacheLoaded ? 'Loaded' : 'Not Loaded'}`)
  console.log('----------------------------------------------------------------')

  if (!alive) {
    console.error('ERROR: PostgREST is offline. Ensure it is started with native port 3001.')
    process.exit(1)
  }

  console.log('PASS: PostgREST daemon is operational.')
  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('postgrest-check.ts')) {
  main().catch((err) => {
    console.error('Check failed:', err.message)
    process.exit(1)
  })
}
