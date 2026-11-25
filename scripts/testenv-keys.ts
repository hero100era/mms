import { ensureAcceptanceKeys, rotateAcceptanceKeys, ACCEPTANCE_JWKS_PATH, ACCEPTANCE_PRIVATE_KEY_PATH } from './lib/test-keys.ts'

function main() {
  let isRotate = process.argv.includes('--rotate')
  let keys = isRotate ? rotateAcceptanceKeys() : ensureAcceptanceKeys()

  console.log('================================================================')
  console.log(`MMS Acceptance Test JWT Key Lifecycle (${isRotate ? 'ROTATED' : 'VERIFIED'})`)
  console.log('================================================================')
  console.log(`Private Key: ${ACCEPTANCE_PRIVATE_KEY_PATH} (mode 0600)`)
  console.log(`Public JWKS: ${ACCEPTANCE_JWKS_PATH} (mode 0644)`)
  console.log(`Active KID:  ${keys.kid}`)
  console.log(`JWKS Keys:   ${keys.publicJwks.keys.length} key(s) registered`)
  console.log('----------------------------------------------------------------')
  console.log('PASS: Centralized acceptance signing keys ready.')
  console.log('================================================================')
}

if (process.argv[1] && process.argv[1].endsWith('testenv-keys.ts')) {
  try {
    main()
  } catch (err: any) {
    console.error('Failed to configure acceptance keys:', err.message)
    process.exit(1)
  }
}
