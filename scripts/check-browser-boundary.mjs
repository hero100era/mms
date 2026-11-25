import { execFileSync } from 'node:child_process'

const output = execFileSync('npx', ['remix', 'assets'], {
  cwd: 'apps/web',
  encoding: 'utf8',
})
const forbidden = [
  /app\/auth\//,
  /app\/audit_trail\//,
  /app\/jobs\//,
  /token-signer/,
  /gateway-client/,
  /worker-client/,
  /sealer-client/,
  /crypto-shredder/,
  /session-storage/,
  /node_modules\/pg\//,
]
const hits = output.split('\n').filter((line) => forbidden.some((re) => re.test(line)))
if (hits.length > 0) {
  console.error('server-only auth module is browser-reachable:')
  for (let hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
console.log(`browser boundary passed (${output.split('\n').filter(Boolean).length} assets)`)
