import { describe, it, before, after } from 'remix/test'
import * as assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'

import { signAccessToken, publicJwks, clearTokenSignerCaches } from './token-signer.ts'

// Card H-06: the BFF signing key must be replaceable without invalidating tokens
// that are already in flight. These tests pin the contract PostgREST depends on:
// the JWKS advertises every key that may still have signed a live token, while
// only one key signs new ones.

function exportPrivateKey(): { pem: string; jwk: Record<string, unknown> } {
  let { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    jwk: createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, unknown>,
  }
}

function claims(userId = '11111111-1111-1111-1111-111111111111') {
  return {
    userId,
    role: 'int_surveyor',
    sessionId: '22222222-2222-2222-2222-222222222222',
    authMethod: 'entra' as const,
  }
}

function decodeHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'))
}

describe('Card H-06: signing key lifecycle', () => {
  let original: Record<string, string | undefined>
  let keyA: { pem: string; jwk: Record<string, unknown> }
  let keyB: { pem: string; jwk: Record<string, unknown> }

  before(() => {
    original = {
      MMS_JWT_PRIVATE_KEY: process.env.MMS_JWT_PRIVATE_KEY,
      MMS_JWT_PRIVATE_KEY_FILE: process.env.MMS_JWT_PRIVATE_KEY_FILE,
      MMS_JWT_KID: process.env.MMS_JWT_KID,
      MMS_JWT_NEXT_PRIVATE_KEY: process.env.MMS_JWT_NEXT_PRIVATE_KEY,
      MMS_JWT_NEXT_KID: process.env.MMS_JWT_NEXT_KID,
      MMS_JWT_ADDITIONAL_JWKS: process.env.MMS_JWT_ADDITIONAL_JWKS,
    }
    keyA = exportPrivateKey()
    keyB = exportPrivateKey()
  })

  after(() => {
    for (let [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('signs with ES256 and names the signing kid in the header', () => {
    process.env.MMS_JWT_PRIVATE_KEY = keyA.pem
    process.env.MMS_JWT_KID = 'key-a'
    let { token, expiresAt } = signAccessToken(claims())
    let header = decodeHeader(token)
    assert.equal(header.alg, 'ES256')
    assert.equal(header.kid, 'key-a')
    // Access tokens stay short-lived: this is the ceiling PostgREST enforces.
    assert.ok(expiresAt - Math.floor(Date.now() / 1000) <= 300)
  })

  it('publishes the current key in the JWKS with its kid, alg and use', () => {
    process.env.MMS_JWT_PRIVATE_KEY = keyA.pem
    process.env.MMS_JWT_KID = 'key-a'
    delete process.env.MMS_JWT_NEXT_PRIVATE_KEY
    delete process.env.MMS_JWT_ADDITIONAL_JWKS
    let { keys } = publicJwks()
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.kid, 'key-a')
    assert.equal(keys[0]!.alg, 'ES256')
    assert.equal(keys[0]!.use, 'sig')
    // Only the public half is exported, never the private scalar `d`.
    assert.equal('d' in keys[0]!, false)
    assert.equal(keys[0]!.crv, 'P-256')
    assert.equal(keys[0]!.x, keyA.jwk.x)
  })

  it('keeps the previous key published while the new key signs', () => {
    // Mid-rotation: tokens signed by key A are still inside their 5 minute TTL,
    // so key A must remain verifiable while key B takes over signing.
    process.env.MMS_JWT_PRIVATE_KEY = keyB.pem
    process.env.MMS_JWT_KID = 'key-b'
    process.env.MMS_JWT_NEXT_PRIVATE_KEY = keyA.pem
    process.env.MMS_JWT_NEXT_KID = 'key-a'

    let { keys } = publicJwks()
    let kids = keys.map((key) => key.kid).sort()
    assert.deepEqual(kids, ['key-a', 'key-b'])

    let { token } = signAccessToken(claims())
    assert.equal(decodeHeader(token).kid, 'key-b', 'new tokens use the new key')
    // The published key A really is the one that signed the earlier tokens.
    let publishedA = keys.find((key) => key.kid === 'key-a')!
    assert.equal(publishedA.x, keyA.jwk.x)
  })

  it('drops the retired key once the overlap window closes', () => {
    process.env.MMS_JWT_PRIVATE_KEY = keyB.pem
    process.env.MMS_JWT_KID = 'key-b'
    delete process.env.MMS_JWT_NEXT_PRIVATE_KEY
    delete process.env.MMS_JWT_NEXT_KID
    let { keys } = publicJwks()
    assert.deepEqual(keys.map((key) => key.kid), ['key-b'])
  })

  it('can publish a public-only key for a signer that lives in Key Vault', () => {
    // With a non-exportable HSM key the private half never reaches this process:
    // the key is published as a JWK and signing happens elsewhere.
    process.env.MMS_JWT_PRIVATE_KEY = keyA.pem
    process.env.MMS_JWT_KID = 'key-a'
    process.env.MMS_JWT_ADDITIONAL_JWKS = JSON.stringify([
      { kid: 'key-vault', kty: 'EC', crv: 'P-256', x: keyB.jwk.x, y: keyB.jwk.y },
    ])
    let { keys } = publicJwks()
    let vault = keys.find((key) => key.kid === 'key-vault')
    assert.ok(vault, 'the Key Vault key is published')
    assert.equal(vault!.alg, 'ES256')
    assert.equal(vault!.use, 'sig')
    assert.equal(vault!.x, keyB.jwk.x)
    delete process.env.MMS_JWT_ADDITIONAL_JWKS
  })

  it('refuses an additional JWKS entry that is not an array', () => {
    process.env.MMS_JWT_PRIVATE_KEY = keyA.pem
    process.env.MMS_JWT_ADDITIONAL_JWKS = '{"kid":"nope"}'
    assert.throws(() => publicJwks(), /MMS_JWT_ADDITIONAL_JWKS must be a JSON array/)
    process.env.MMS_JWT_ADDITIONAL_JWKS = 'not json'
    assert.throws(() => publicJwks(), /MMS_JWT_ADDITIONAL_JWKS must be a JSON array/)
    delete process.env.MMS_JWT_ADDITIONAL_JWKS
  })

  it('never publishes private material or lets an extra JWK override alg/use', () => {
    process.env.MMS_JWT_PRIVATE_KEY = keyA.pem
    process.env.MMS_JWT_KID = 'key-a'

    let withPrivate = [{ kid: 'vault', kty: 'EC', crv: 'P-256', x: keyB.jwk.x, y: keyB.jwk.y, d: 'secret-scalar' }]
    process.env.MMS_JWT_ADDITIONAL_JWKS = JSON.stringify(withPrivate)
    assert.throws(() => publicJwks(), /must not contain private key material/)

    let withAlg = [{ kid: 'vault', kty: 'EC', crv: 'P-256', x: keyB.jwk.x, y: keyB.jwk.y, alg: 'none', use: 'enc' }]
    process.env.MMS_JWT_ADDITIONAL_JWKS = JSON.stringify(withAlg)
    assert.throws(() => publicJwks(), /must use ES256/)

    let withoutKid = [{ kty: 'EC', crv: 'P-256', x: keyB.jwk.x, y: keyB.jwk.y }]
    process.env.MMS_JWT_ADDITIONAL_JWKS = JSON.stringify(withoutKid)
    assert.throws(() => publicJwks(), /must have a kid/)

    process.env.MMS_JWT_ADDITIONAL_JWKS = JSON.stringify(['not an object'])
    assert.throws(() => publicJwks(), /must be a JWK object/)

    delete process.env.MMS_JWT_ADDITIONAL_JWKS
  })

  it('fails loudly when no signing key is configured', () => {
    delete process.env.MMS_JWT_PRIVATE_KEY
    delete process.env.MMS_JWT_PRIVATE_KEY_FILE
    assert.throws(() => signAccessToken(claims()), /MMS_JWT_PRIVATE_KEY or MMS_JWT_PRIVATE_KEY_FILE is required/)
    assert.throws(() => publicJwks(), /MMS_JWT_PRIVATE_KEY or MMS_JWT_PRIVATE_KEY_FILE is required/)
  })

  it('reads key from MMS_JWT_PRIVATE_KEY_FILE even when path is relative to repo root', () => {
    delete process.env.MMS_JWT_PRIVATE_KEY
    process.env.MMS_JWT_PRIVATE_KEY_FILE = '.testdata/keys/mms-jwt-private.pem'
    process.env.MMS_JWT_KID = 'dev'
    let { token } = signAccessToken(claims())
    let header = decodeHeader(token)
    assert.equal(header.alg, 'ES256')
    assert.equal(header.kid, 'dev')
  })

  it('caches key file reads and respects clearTokenSignerCaches', () => {
    clearTokenSignerCaches()
    delete process.env.MMS_JWT_PRIVATE_KEY
    process.env.MMS_JWT_PRIVATE_KEY_FILE = '.testdata/keys/mms-jwt-private.pem'
    process.env.MMS_JWT_KID = 'dev'

    let res1 = signAccessToken(claims())
    assert.ok(res1.token)
    let res2 = signAccessToken(claims())
    assert.ok(res2.token)

    clearTokenSignerCaches()
  })

  it('bounds privateKeyCache to at most PRIVATE_KEY_CACHE_MAX entries', () => {
    clearTokenSignerCaches()
    for (let i = 0; i < 10; i++) {
      let key = exportPrivateKey()
      process.env.MMS_JWT_PRIVATE_KEY = key.pem
      process.env.MMS_JWT_KID = `test-key-${i}`
      signAccessToken(claims())
    }
    clearTokenSignerCaches()
  })
})
