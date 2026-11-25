/**
 * tests/acceptance/run.ts
 *
 * Main unified acceptance test runner for MMS Acceptance & E2E Test Suite.
 *
 * Supports execution:
 * - Full suite: npm run test:acceptance
 * - By tier: --tier 1 | --tier 2 | --tier 3 | --tier 4
 * - By feature: --feature P0.1 | --feature P1.1
 * - Name regex filter: --grep <pattern>
 *
 * Provides structured tier-by-tier execution summary and exits with code 0 on pass, non-zero on fail.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureServerReady, startInProcessServerIfNeeded } from './harness/handshake.ts'
import { runHarnessSmokeSuite } from './harness/harness.test.ts'

export interface TierStats {
  name: string
  total: number
  passed: number
  failed: number
  durationMs: number
}

export interface AcceptanceRunnerOptions {
  tier?: string // '1' | '2' | '3' | '4' | 'harness' | 'all'
  feature?: string // e.g. 'P0.1'
  grep?: string
  baseUrl?: string
  pgrstUrl?: string
  timeoutMs?: number
  help?: boolean
}

export function parseCliArgs(args: string[]): AcceptanceRunnerOptions {
  const options: AcceptanceRunnerOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--tier' || arg === '-t') {
      options.tier = args[++i]
    } else if (arg.startsWith('--tier=')) {
      options.tier = arg.split('=')[1]
    } else if (arg === '--feature' || arg === '-f') {
      options.feature = args[++i]
    } else if (arg.startsWith('--feature=')) {
      options.feature = arg.split('=')[1]
    } else if (arg === '--grep' || arg === '-g') {
      options.grep = args[++i]
    } else if (arg.startsWith('--grep=')) {
      options.grep = arg.split('=')[1]
    } else if (arg === '--baseUrl' || arg === '-u') {
      options.baseUrl = args[++i]
    } else if (arg.startsWith('--baseUrl=')) {
      options.baseUrl = arg.split('=')[1]
    } else if (arg === '--pgrstUrl') {
      options.pgrstUrl = args[++i]
    } else if (arg.startsWith('--pgrstUrl=')) {
      options.pgrstUrl = arg.split('=')[1]
    }
  }

  return options
}

function printHelp(): void {
  console.log(`
MMS Acceptance Test Runner
Usage: node --import remix/node-tsx tests/acceptance/run.ts [options]

Options:
  --tier, -t <1|2|3|4|harness> Filter tests by tier
  --feature, -f <code|name>     Filter tests by feature code (e.g. P0.1, P1.1)
  --grep, -g <regex>            Filter tests matching pattern
  --baseUrl, -u <url>           Target MMS Web application base URL (default: http://localhost:44100)
  --pgrstUrl <url>              PostgREST target URL (default: http://127.0.0.1:3001)
  --help, -h                    Display this help message
`)
}

export async function runAcceptanceSuite(options: AcceptanceRunnerOptions = {}): Promise<boolean> {
  const overallStart = Date.now()

  const baseUrl = options.baseUrl ?? process.env.APPLICATION_BASE_URL ?? 'http://localhost:44100'
  const pgrstUrl = options.pgrstUrl ?? process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001'
  const selectedTier = options.tier?.trim().toLowerCase()
  const selectedFeature = options.feature?.trim().toUpperCase()

  console.log('================================================================')
  console.log('MMS ACCEPTANCE TEST RUNNER (Milestones E0–E5)')
  console.log('================================================================')
  console.log(`Target Web Server : ${baseUrl}`)
  console.log(`PostgREST URL     : ${pgrstUrl}`)
  console.log(`Tier Filter       : ${selectedTier ?? 'ALL'}`)
  console.log(`Feature Filter    : ${selectedFeature ?? 'ALL'}`)
  if (options.grep) console.log(`Grep Filter       : ${options.grep}`)
  console.log('----------------------------------------------------------------')

  // 1. In-process server check & startup if needed
  let inProcessHandle: { server: unknown; close: () => Promise<void> } | null = null
  try {
    inProcessHandle = await startInProcessServerIfNeeded({ baseUrl })
  } catch (err) {
    console.warn(`[Runner] Note: in-process server probe encountered: ${err}`)
  }

  // 2. Perform Server Handshake Probe
  let handshake
  try {
    handshake = await ensureServerReady({
      baseUrl,
      pgrstUrl,
      timeoutMs: options.timeoutMs ?? 15000,
    })
    console.log(
      `Handshake Ready   : Web Server OK (${handshake.webServer.endpoint}, status ${handshake.webServer.status}) | PostgREST OK (status ${handshake.postgrest.status}) [${handshake.totalTimeMs}ms]`,
    )
  } catch (err: unknown) {
    console.error(`Handshake Failed  : ${err instanceof Error ? err.message : String(err)}`)
    if (inProcessHandle) await inProcessHandle.close()
    return false
  }

  const tierStats: Record<string, TierStats> = {
    harness: { name: 'Harness & Baseline Smoke', total: 0, passed: 0, failed: 0, durationMs: 0 },
    tier1: { name: 'Tier 1 (Feature Coverage)', total: 0, passed: 0, failed: 0, durationMs: 0 },
    tier2: { name: 'Tier 2 (Boundary & Negative)', total: 0, passed: 0, failed: 0, durationMs: 0 },
    tier3: { name: 'Tier 3 (Cross-Feature)', total: 0, passed: 0, failed: 0, durationMs: 0 },
    tier4: { name: 'Tier 4 (Real-World Scenarios)', total: 0, passed: 0, failed: 0, durationMs: 0 },
  }

  try {
    // Phase 0: Baseline Harness Smoke Suite
    const shouldRunHarness = !selectedTier || selectedTier === 'harness' || selectedTier === '0' || selectedTier === 'all'
    if (shouldRunHarness && (!selectedFeature || selectedFeature.includes('HARNESS'))) {
      const hStart = Date.now()
      const smokeResult = await runHarnessSmokeSuite({ baseUrl, pgrstUrl })
      tierStats.harness.total = smokeResult.total
      tierStats.harness.passed = smokeResult.passed
      tierStats.harness.failed = smokeResult.failed
      tierStats.harness.durationMs = Date.now() - hStart
    }

    // Phase 1 to 4: Dynamic execution of Tier Test Suites (as implemented across E1–E5)
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const tiersDir = path.join(__dirname, 'tiers')

    const tierMappings = [
      { key: 'tier1', tierNum: '1', dir: 't1_features' },
      { key: 'tier2', tierNum: '2', dir: 't2_boundaries' },
      { key: 'tier3', tierNum: '3', dir: 't3_pairwise' },
      { key: 'tier4', tierNum: '4', dir: 't4_scenarios' },
    ]

    for (const mapping of tierMappings) {
      const isSelected = !selectedTier || selectedTier === mapping.tierNum || selectedTier === 'all'
      if (!isSelected) continue

      const targetDir = path.join(tiersDir, mapping.dir)
      if (!fs.existsSync(targetDir)) continue

      const files = fs
        .readdirSync(targetDir)
        .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.js'))

      for (const file of files) {
        const filePath = path.join(targetDir, file)
        const stat = tierStats[mapping.key]
        if (!stat) continue

        const tStart = Date.now()
        try {
          const testModule = await import(filePath)
          if (typeof testModule.runSuite === 'function') {
            console.log(`\nExecuting ${mapping.key} suite: ${file}...`)
            const res = await testModule.runSuite({ baseUrl, pgrstUrl, feature: selectedFeature, grep: options.grep })
            stat.total += res?.total ?? 0
            stat.passed += res?.passed ?? 0
            stat.failed += res?.failed ?? 0
          }
        } catch (suiteErr) {
          console.error(`Error running suite ${file}:`, suiteErr)
          stat.total += 1
          stat.failed += 1
        }
        stat.durationMs += Date.now() - tStart
      }
    }
  } finally {
    if (inProcessHandle) {
      await inProcessHandle.close()
    }
  }

  // 3. Format & Print Execution Summary
  const totalDuration = ((Date.now() - overallStart) / 1000).toFixed(2)
  let grandTotal = 0
  let grandPassed = 0
  let grandFailed = 0

  for (const stat of Object.values(tierStats)) {
    grandTotal += stat.total
    grandPassed += stat.passed
    grandFailed += stat.failed
  }

  console.log('\n================================================================')
  console.log('ACCEPTANCE TEST SUITE SUMMARY')
  console.log('================================================================')
  for (const stat of Object.values(tierStats)) {
    const padName = stat.name.padEnd(30, ' ')
    const padTotal = String(stat.total).padStart(3, ' ')
    const padPassed = String(stat.passed).padStart(3, ' ')
    const padFailed = String(stat.failed).padStart(3, ' ')
    const durSec = (stat.durationMs / 1000).toFixed(2)
    console.log(`${padName}: ${padTotal} total | ${padPassed} passed | ${padFailed} failed (${durSec}s)`)
  }
  console.log('----------------------------------------------------------------')
  const statusStr = grandFailed === 0 && grandTotal > 0 ? 'ALL TESTS PASSED' : grandFailed > 0 ? 'SOME TESTS FAILED' : 'NO TESTS RUN'
  console.log(
    `TOTAL: ${grandTotal} | PASSED: ${grandPassed} | FAILED: ${grandFailed} | DURATION: ${totalDuration}s`,
  )
  console.log(`STATUS: ${statusStr}`)
  console.log('================================================================')

  return grandFailed === 0 && grandTotal > 0
}

// Direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  const options = parseCliArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    process.exit(0)
  }

  runAcceptanceSuite(options)
    .then((success) => {
      process.exit(success ? 0 : 1)
    })
    .catch((err) => {
      console.error('Fatal runner failure:', err)
      process.exit(1)
    })
}
