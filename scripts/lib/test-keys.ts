import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { repoRoot } from '../../db/scripts/lib.ts'

export const TEST_KEYS_DIR = path.resolve(repoRoot, '.testdata', 'keys')
export const ACCEPTANCE_PRIVATE_KEY_PATH = path.join(TEST_KEYS_DIR, 'mms-jwt-private.pem')
export const ACCEPTANCE_JWKS_PATH = path.join(TEST_KEYS_DIR, 'mms-jwks.json')
export const DEFAULT_ACCEPTANCE_KID = 'mms-dev'

export interface AcceptanceKeySet {
  privateKeyPem: string
  privateKeyPath: string
  jwksPath: string
  kid: string
  publicJwks: { keys: Record<string, unknown>[] }
}

/**
 * Ensures acceptance test signing keys are generated and stored in the protected
 * .testdata/keys directory with 0700 / 0600 permissions.
 *
 * Refuses startup if production environment is detected.
 */
export function ensureAcceptanceKeys(options: { rotate?: boolean; kid?: string; dir?: string } = {}): AcceptanceKeySet {
  let appEnv = (process.env.APP_ENV ?? '').toLowerCase().trim()
  let nodeEnv = (process.env.NODE_ENV ?? '').toLowerCase().trim()
  if (appEnv === 'production' || nodeEnv === 'production') {
    throw new Error('FATAL: Acceptance test keys cannot be generated or accessed in production environment.')
  }

  let keysDir = options.dir ?? TEST_KEYS_DIR
  let privateKeyPath = options.dir ? path.join(keysDir, 'mms-jwt-private.pem') : ACCEPTANCE_PRIVATE_KEY_PATH
  let jwksPath = options.dir ? path.join(keysDir, 'mms-jwks.json') : ACCEPTANCE_JWKS_PATH
  let kid = options.kid ?? process.env.MMS_JWT_KID ?? DEFAULT_ACCEPTANCE_KID

  // 1. Ensure protected directory exists with 0700 permissions
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  }
  try {
    fs.chmodSync(keysDir, 0o700)
  } catch {}

  let needGenerate = options.rotate || !fs.existsSync(privateKeyPath)

  let privateKeyPem: string
  if (needGenerate) {
    let pair = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    privateKeyPem = pair.privateKey
    fs.writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 })
  } else {
    privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8')
  }

  try {
    fs.chmodSync(privateKeyPath, 0o600)
  } catch {}

  // 2. Generate public JWKS strictly matching private key (without private fields)
  let privKeyObj = crypto.createPrivateKey(privateKeyPem)
  let pubKeyObj = crypto.createPublicKey(privKeyObj)
  let publicJwk = pubKeyObj.export({ format: 'jwk' }) as Record<string, unknown>

  // Never include private scalar fields
  delete publicJwk.d
  delete publicJwk.k

  let publicJwks = {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: 'ES256',
        use: 'sig',
      },
      ...(kid !== 'test'
        ? [{ ...publicJwk, kid: 'test', alg: 'ES256', use: 'sig' }]
        : []),
      ...(kid !== 'dev'
        ? [{ ...publicJwk, kid: 'dev', alg: 'ES256', use: 'sig' }]
        : []),
    ],
  }

  fs.writeFileSync(jwksPath, JSON.stringify(publicJwks, null, 2), { mode: 0o644 })

  // Set environment variables for in-process consumers
  process.env.MMS_JWT_PRIVATE_KEY = privateKeyPem
  process.env.MMS_JWT_PRIVATE_KEY_FILE = privateKeyPath
  process.env.MMS_JWT_KID = kid

  return {
    privateKeyPem,
    privateKeyPath,
    jwksPath,
    kid,
    publicJwks,
  }
}

export function rotateAcceptanceKeys(options: { kid?: string; dir?: string } = {}): AcceptanceKeySet {
  return ensureAcceptanceKeys({ rotate: true, kid: options.kid, dir: options.dir })
}
