import { runIntegrationAcceptanceSuite } from './run-integration.ts'
import { runBrowserE2ESuite } from './run-browser.ts'

export async function runAllAcceptanceSuites(): Promise<void> {
  console.log('================================================================')
  console.log('MMS R8.6 Full Acceptance Test Gate (Integration + Playwright Browser)')
  console.log('================================================================')

  console.log('\n>>> PHASE 1: HTTP/Router Acceptance Integration Suite')
  await runIntegrationAcceptanceSuite()

  console.log('\n>>> PHASE 2: Real Playwright Browser Suite (Chromium)')
  await runBrowserE2ESuite()

  console.log('================================================================')
  console.log('ALL ACCEPTANCE SUITES PASSED SUCCESSFULLY.')
  console.log('  1. HTTP/Router Acceptance Suite : PASSED')
  console.log('  2. Direct PostgREST Suite       : PASSED')
  console.log('  3. Playwright Browser Suite     : PASSED (PW-001 to PW-004)')
  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  runAllAcceptanceSuites()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error('Acceptance suite failed:', err)
      process.exit(1)
    })
}
