import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { generateKeyPairSync } from 'node:crypto'

import { router } from '../router.ts'
import { routes } from '../routes.ts'

// Card H-06: PostgREST verifies every access token against this document, so it
// is the contract that makes key rotation possible without a coordinated deploy.
// It must be reachable without authentication (PostgREST has no session), must
// advertise only public key material, and must be cacheable for a short window.

describe('GET /.well-known/jwks.json', () => {
  let original: Record<string, string | undefined>

  before(() => {
    original = {
      MMS_JWT_PRIVATE_KEY: process.env.MMS_JWT_PRIVATE_KEY,
      MMS_JWT_PRIVATE_KEY_FILE: process.env.MMS_JWT_PRIVATE_KEY_FILE,
      MMS_JWT_KID: process.env.MMS_JWT_KID,
      MMS_JWT_NEXT_PRIVATE_KEY: process.env.MMS_JWT_NEXT_PRIVATE_KEY,
      MMS_JWT_NEXT_KID: process.env.MMS_JWT_NEXT_KID,
      MMS_JWT_ADDITIONAL_JWKS: process.env.MMS_JWT_ADDITIONAL_JWKS,
    }
    let { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    process.env.MMS_JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    process.env.MMS_JWT_KID = 'jwks-test'
    process.env.MMS_JWT_NEXT_KID = 'jwks-previous'
    process.env.MMS_JWT_NEXT_PRIVATE_KEY = process.env.MMS_JWT_PRIVATE_KEY
  })

  after(() => {
    for (let [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('answers without a session and without a CSRF token', async () => {
    let response = await router.fetch(new URL(routes.jwks.href(), 'http://localhost'))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type') ?? '', /application\/json/)
  })

  it('is cacheable for a short window so a rotation reaches PostgREST quickly', async () => {
    let response = await router.fetch(new URL(routes.jwks.href(), 'http://localhost'))
    let cacheControl = response.headers.get('Cache-Control') ?? ''
    assert.match(cacheControl, /max-age=\d+/)
    let maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1])
    // Long enough to avoid a fetch per request, short enough that a retired key
    // cannot outlive its overlap window in a verifier cache.
    assert.ok(maxAge > 0 && maxAge <= 600, `max-age ${maxAge} must be between 1 and 600 seconds`)
  })

  it('returns a JWKS document with public-only ES256 keys', async () => {
    let response = await router.fetch(new URL(routes.jwks.href(), 'http://localhost'))
    let body = (await response.json()) as { keys: Record<string, unknown>[] }
    assert.ok(Array.isArray(body.keys) && body.keys.length >= 1)
    for (let key of body.keys) {
      assert.equal(key.kty, 'EC')
      assert.equal(key.crv, 'P-256')
      assert.equal(key.alg, 'ES256')
      assert.equal(key.use, 'sig')
      assert.equal(typeof key.x, 'string')
      assert.equal(typeof key.y, 'string')
      // The private scalar must never appear: this endpoint is unauthenticated.
      assert.equal('d' in key, false, 'JWKS must not expose the private scalar d')
    }
  })

  it('advertises both the signing key and the retained rotation key', async () => {
    let response = await router.fetch(new URL(routes.jwks.href(), 'http://localhost'))
    let body = (await response.json()) as { keys: Record<string, unknown>[] }
    let kids = body.keys.map((key) => key.kid).sort()
    assert.deepEqual(kids, ['jwks-previous', 'jwks-test'])
  })

  it('does not require a session', async () => {
    // The session middleware runs for every request and may hand out a fresh
    // anonymous session cookie; that is harmless. What matters is that the
    // document is served without one, because PostgREST fetches it with no
    // credentials at all.
    let response = await router.fetch(new URL(routes.jwks.href(), 'http://localhost'))
    assert.equal(response.status, 200)
    let body = (await response.json()) as { keys: unknown[] }
    assert.ok(body.keys.length >= 1)
  })
})
