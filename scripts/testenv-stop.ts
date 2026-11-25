import { spawnSync } from 'node:child_process'

export function stopAcceptanceProcesses(): { stopped: string[] } {
  let stopped: string[] = []

  // Patterns of acceptance test processes (excluding postgres)
  let patterns = [
    { name: 'MMS Web Server', pattern: 'server.ts' },
    { name: 'MMS Worker', pattern: 'worker.ts' },
    { name: 'MMS Sealer', pattern: 'sealer.ts' },
    { name: 'PostgREST Daemon', pattern: 'postgrest', exact: true },
  ]

  for (let { name, pattern, exact } of patterns) {
    let args = exact ? ['-x', pattern] : ['-f', pattern]
    let pgrep = spawnSync('pgrep', args, { encoding: 'utf8' })
    if (pgrep.status === 0 && pgrep.stdout.trim()) {
      let pids = pgrep.stdout.trim().split('\n').filter(Boolean)
      for (let pid of pids) {
        if (pid !== String(process.pid)) {
          spawnSync('kill', ['-15', pid])
          stopped.push(`${name} (PID ${pid})`)
        }
      }
    }
  }

  return { stopped }
}

function main() {
  console.log('================================================================')
  console.log('Stopping MMS Acceptance Test Processes...')
  console.log('================================================================')

  let { stopped } = stopAcceptanceProcesses()

  if (stopped.length === 0) {
    console.log('No background MMS application processes were active.')
  } else {
    for (let item of stopped) {
      console.log(`  Terminated: ${item}`)
    }
  }

  console.log('Note: PostgreSQL service was NOT stopped and remains active.')
  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('testenv-stop.ts')) {
  main()
}
