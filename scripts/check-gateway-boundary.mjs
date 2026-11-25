import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = 'apps/web/app'
const offenders = []
function walk(dir) {
  for (let entry of readdirSync(dir)) {
    let path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walk(path)
      continue
    }
    if (!/\.(ts|tsx)$/.test(path)) continue
    let text = readFileSync(path, 'utf8')
    let importsGateway =
      /(?:from\s+|import\s*\(\s*)['"][^'"]*gateway-client(\.ts)?['"]/.test(text)
    if (importsGateway && !path.startsWith('apps/web/app/auth/')) {
      offenders.push(`gateway-client in ${path}`)
    }
    let importsWorker =
      /(?:from\s+|import\s*\(\s*)['"][^'"]*worker-client(\.ts)?['"]/.test(text)
    if (
      importsWorker &&
      !path.startsWith('apps/web/app/jobs/') &&
      path !== 'apps/web/app/storage/upload-repository.ts' &&
      !path.endsWith('.test.ts')
    ) {
      offenders.push(`worker-client in ${path}`)
    }
    let importsSealer =
      /(?:from\s+|import\s*\(\s*)['"][^'"]*sealer-client(\.ts)?['"]/.test(text)
    if (importsSealer && !path.startsWith('apps/web/app/audit_trail/') && !path.endsWith('.test.ts')) {
      offenders.push(`sealer-client in ${path}`)
    }
  }
}
walk(root)
if (offenders.length > 0) {
  console.error('auth_gateway client imported outside app/auth/:')
  for (let path of offenders) console.error(`  ${path}`)
  process.exit(1)
}
console.log('gateway boundary passed')
