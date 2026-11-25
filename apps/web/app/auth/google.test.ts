import { afterAll, beforeAll, describe, it } from 'remix/test'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'

import { validateGoogleIdToken, type GoogleConfig } from './google.ts'

const clientId = 'google-client-test-id'
const nonce = 'google-test-nonce'
const kid = 'google-test-kid'

let server: Server
let authority: string
let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
let jwks: { keys: Record<string, unknown>[] }

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function idToken(overrides: Record<string, unknown> = {}): string {
  let now = Math.floor(Date.now() / 1000)
  let header = { alg: 'RS256', typ: 'JWT', kid }
  let payload = {
    iss: authority,
    aud: clientId,
    sub: 'google-sub-123',
    email: 'user@example.com',
    name: 'Google User',
    nonce,
    iat: now,
    nbf: now,
    exp: now + 300,
    ...overrides,
  }
  let input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`
  let signature = sign('RSA-SHA256', Buffer.from(input), privateKey as any)
  return `${input}.${b64(signature)}`
}

function config(): GoogleConfig {
  return {
    clientId,
    clientSecret: 'secret',
    redirectUri: 'http://localhost/auth/google/callback',
    authority,
  }
}

describe('Google ID token validation', () => {
  beforeAll(async () => {
    let pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    privateKey = pair.privateKey
    jwks = {
      keys: [
        {
          ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
          kid,
          alg: 'RS256',
          use: 'sig',
        },
      ],
    }
    server = createServer((request, response) => {
      if (request.url === '/discovery/v2.0/keys' || request.url === '/oauth2/v3/certs') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(jwks))
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    let address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    authority = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('accepts a valid token', async () => {
    let claims = await validateGoogleIdToken(idToken(), config(), nonce)
    if (claims.sub !== 'google-sub-123') throw new Error('wrong sub')
    if (claims.email !== 'user@example.com') throw new Error('wrong email')
  })

  it('rejects a wrong nonce', async () => {
    let rejected = false
    try {
      await validateGoogleIdToken(idToken({ nonce: 'other' }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects a wrong audience', async () => {
    let rejected = false
    try {
      await validateGoogleIdToken(idToken({ aud: 'other' }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects a wrong issuer', async () => {
    let rejected = false
    try {
      await validateGoogleIdToken(idToken({ iss: 'https://evil-issuer.com' }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects an expired token', async () => {
    let rejected = false
    try {
      await validateGoogleIdToken(idToken({ exp: Math.floor(Date.now() / 1000) - 10 }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects a bad signature', async () => {
    let token = idToken()
    let parts = token.split('.')
    parts[2] = b64(Buffer.from('not-a-signature'))
    let rejected = false
    try {
      await validateGoogleIdToken(parts.join('.'), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects a malformed token', async () => {
    let rejected = false
    try {
      await validateGoogleIdToken('not-a-jwt', config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects non-RS256 alg', async () => {
    let now = Math.floor(Date.now() / 1000)
    let header = { alg: 'HS256', typ: 'JWT', kid }
    let payload = {
      iss: authority,
      aud: clientId,
      sub: 'google-sub-123',
      nonce,
      iat: now,
      exp: now + 300,
    }
    let input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`
    let badToken = `${input}.${b64(Buffer.from('sig'))}`
    let rejected = false
    try {
      await validateGoogleIdToken(badToken, config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects an unknown kid', async () => {
    let now = Math.floor(Date.now() / 1000)
    let header = { alg: 'RS256', typ: 'JWT', kid: 'unknown-kid' }
    let payload = {
      iss: authority,
      aud: clientId,
      sub: 'google-sub-123',
      nonce,
      iat: now,
      exp: now + 300,
    }
    let input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`
    let signature = sign('RSA-SHA256', Buffer.from(input), privateKey as any)
    let badToken = `${input}.${b64(signature)}`
    let rejected = false
    try {
      await validateGoogleIdToken(badToken, config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })
})
