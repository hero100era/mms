import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it } from 'node:test'
import {
  ACCEPTANCE_JWKS_PATH,
  ACCEPTANCE_PRIVATE_KEY_PATH,
  ensureAcceptanceKeys,
  rotateAcceptanceKeys,
  TEST_KEYS_DIR,
} from './lib/test-keys.ts'

describe('R8.6-F06 Centralized Acceptance JWT Signing-Key Lifecycle', () => {
  it('1. Generates acceptance key in protected directory when missing', () => {
    let keys = ensureAcceptanceKeys()
    assert.ok(fs.existsSync(TEST_KEYS_DIR), 'Keys directory must exist')
    assert.ok(fs.existsSync(ACCEPTANCE_PRIVATE_KEY_PATH), 'Private key must exist')
    assert.ok(fs.existsSync(ACCEPTANCE_JWKS_PATH), 'Public JWKS must exist')

    let statDir = fs.statSync(TEST_KEYS_DIR)
    let modeDir = statDir.mode & 0o777
    assert.equal(modeDir, 0o700, 'Keys directory must have 0700 permissions')

    let statPriv = fs.statSync(ACCEPTANCE_PRIVATE_KEY_PATH)
    let modePriv = statPriv.mode & 0o777
    assert.equal(modePriv, 0o600, 'Private key must have 0600 permissions')
  })

  it('2. Public JWKS matches generated private key and verifies signatures', () => {
    let keys = ensureAcceptanceKeys()
    let privKey = crypto.createPrivateKey(keys.privateKeyPem)

    // Sign test data with private key
    let data = Buffer.from('mms-acceptance-test-payload')
    let sign = crypto.createSign('SHA256')
    sign.update(data)
    let signature = sign.sign({ key: privKey, dsaEncoding: 'ieee-p1363' })

    // Verify using public JWKS
    let jwks = JSON.parse(fs.readFileSync(ACCEPTANCE_JWKS_PATH, 'utf8'))
    assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'JWKS must have keys array')

    let jwk = jwks.keys[0]
    let pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })

    let verify = crypto.createVerify('SHA256')
    verify.update(data)
    let verified = verify.verify({ key: pubKey, dsaEncoding: 'ieee-p1363' }, signature)
    assert.equal(verified, true, 'Public key from JWKS must verify signatures minted by private key')
  })

  it('3. Private JWK material is NEVER exposed in public JWKS', () => {
    let jwks = JSON.parse(fs.readFileSync(ACCEPTANCE_JWKS_PATH, 'utf8'))
    for (let key of jwks.keys) {
      assert.equal(key.d, undefined, 'Public JWK must never contain private scalar "d"')
      assert.equal(key.k, undefined, 'Public JWK must never contain symmetric secret "k"')
      assert.equal(key.alg, 'ES256')
      assert.equal(key.use, 'sig')
    }
  })

  it('4. Rotation produces a new key pair and updates JWKS', () => {
    let testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-key-rotation-test-'))
    try {
      let initial = ensureAcceptanceKeys({ dir: testDir })
      let rotated = rotateAcceptanceKeys({ dir: testDir })
      assert.notEqual(rotated.privateKeyPem, initial.privateKeyPem, 'Rotated key must differ from original')

      let newPem = fs.readFileSync(rotated.privateKeyPath, 'utf8')
      assert.equal(newPem, rotated.privateKeyPem, 'Disk private key must match rotated key')
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('5. Production environment strictly refuses test key generation/access', () => {
    let origAppEnv = process.env.APP_ENV
    let origNodeEnv = process.env.NODE_ENV
    try {
      process.env.APP_ENV = 'production'
      assert.throws(
        () => ensureAcceptanceKeys(),
        { message: /FATAL: Acceptance test keys cannot be generated or accessed in production environment/ },
      )

      process.env.APP_ENV = 'test'
      process.env.NODE_ENV = 'production'
      assert.throws(
        () => ensureAcceptanceKeys(),
        { message: /FATAL: Acceptance test keys cannot be generated or accessed in production environment/ },
      )
    } finally {
      process.env.APP_ENV = origAppEnv
      process.env.NODE_ENV = origNodeEnv
    }
  })
})
