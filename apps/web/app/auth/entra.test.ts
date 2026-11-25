import { afterAll, beforeAll, describe, it } from 'remix/test'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'

import { validateIdToken, validateAppBaseUrl, getAppBaseUrl, entraLogoutUrl } from './entra.ts'

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const clientId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const nonce = 'test-nonce'
const kid = 'test-kid'

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
    sub: 'subject',
    tid: tenantId,
    oid: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    preferred_username: 'user@example.com',
    name: 'Test User',
    roles: ['MMS.User'],
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

function config(): {
  tenantId: string
  clientId: string
  clientSecret: string
  redirectUri: string
  authority: string
} {
  return {
    tenantId,
    clientId,
    clientSecret: 'secret',
    redirectUri: 'http://localhost:44100/auth/microsoft/callback',
    authority,
  }
}

describe('Entra ID token validation', () => {
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
      if (request.url === '/discovery/v2.0/keys') {
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
    let claims = await validateIdToken(idToken(), config(), nonce)
    if (claims.tid !== tenantId) throw new Error('wrong tid')
    if (claims.oid !== 'cccccccc-cccc-cccc-cccc-cccccccccccc') throw new Error('wrong oid')
  })

  it('rejects a wrong nonce', async () => {
    let rejected = false
    try {
      await validateIdToken(idToken({ nonce: 'other' }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects a wrong audience', async () => {
    let rejected = false
    try {
      await validateIdToken(idToken({ aud: 'other' }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects a wrong tenant', async () => {
    let rejected = false
    try {
      await validateIdToken(idToken({ tid: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('rejects an expired token', async () => {
    let rejected = false
    try {
      await validateIdToken(idToken({ exp: Math.floor(Date.now() / 1000) - 10 }), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('accepts a token from another tenant only when the multi-tenant policy is explicit', async () => {
    // The production callback passes { allowExternalTenant: true } so an external
    // user linked from ANY Entra tenant can complete linking/step-up. That is a
    // deliberate multi-tenant policy, not an omission. This test pins it: strict
    // validation must reject the token, the multi-tenant path must accept it.
    let externalTenant = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    let token = idToken({
      tid: externalTenant,
      iss: `https://login.microsoftonline.com/${externalTenant}/v2.0`,
    })

    let strict = false
    try {
      await validateIdToken(token, config(), nonce)
    } catch {
      strict = true
    }
    if (!strict) throw new Error('strict validation must reject a token from another tenant')

    let claims = await validateIdToken(token, config(), nonce, { allowExternalTenant: true })
    if (claims.tid !== externalTenant) throw new Error('expected the external tenant claim to survive validation')
    if (claims.aud !== clientId) throw new Error('audience must still be checked on the multi-tenant path')
  })

  it('R1.5: the multi-tenant path still binds issuer to tenant', async () => {
    let externalTenant = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    let issuerFor = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`

    // The issuer must name the same tenant as the tid claim.
    let confused = idToken({
      tid: externalTenant,
      iss: issuerFor('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
    })
    for (let [label, token] of [
      ['unrelated issuer', idToken({ tid: externalTenant, iss: 'https://evil.example/v2.0' })],
      ['issuer for another tenant', confused],
      ['plaintext issuer', idToken({ tid: externalTenant, iss: 'http://evil.example/v2.0' })],
      ['non-UUID tenant', idToken({ tid: 'not-a-uuid', iss: issuerFor(externalTenant) })],
    ] as const) {
      let rejected = false
      try {
        await validateIdToken(token, config(), nonce, { allowExternalTenant: true })
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error(`expected rejection: ${label}`)
    }
  })

  it('rejects a bad signature', async () => {
    let token = idToken()
    let parts = token.split('.')
    parts[2] = b64(Buffer.from('not-a-signature'))
    let rejected = false
    try {
      await validateIdToken(parts.join('.'), config(), nonce)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected rejection')
  })

  it('P0.7: validateAppBaseUrl enforces canonical URL rules', () => {
    // Valid HTTPS URL
    let httpsOrigin = validateAppBaseUrl('https://mms.example.com', true)
    if (httpsOrigin !== 'https://mms.example.com') throw new Error(`expected https://mms.example.com, got ${httpsOrigin}`)

    // Rejects HTTP in production
    let threwHttpProd = false
    try {
      validateAppBaseUrl('http://mms.example.com', true)
    } catch {
      threwHttpProd = true
    }
    if (!threwHttpProd) throw new Error('expected HTTP in production to throw')

    // Accepts localhost in non-production
    let localhostOrigin = validateAppBaseUrl('http://localhost:3000', false)
    if (localhostOrigin !== 'http://localhost:3000') throw new Error(`expected http://localhost:3000, got ${localhostOrigin}`)

    let ipOrigin = validateAppBaseUrl('http://127.0.0.1:44100', false)
    if (ipOrigin !== 'http://127.0.0.1:44100') throw new Error(`expected http://127.0.0.1:44100, got ${ipOrigin}`)

    // Rejects userinfo / credentials
    let threwCreds = false
    try {
      validateAppBaseUrl('https://user:pass@mms.example.com', true)
    } catch {
      threwCreds = true
    }
    if (!threwCreds) throw new Error('expected credentials to throw')

    // Rejects query parameters
    let threwQuery = false
    try {
      validateAppBaseUrl('https://mms.example.com?foo=bar', true)
    } catch {
      threwQuery = true
    }
    if (!threwQuery) throw new Error('expected query to throw')

    // Rejects fragment
    let threwFragment = false
    try {
      validateAppBaseUrl('https://mms.example.com#section', true)
    } catch {
      threwFragment = true
    }
    if (!threwFragment) throw new Error('expected fragment to throw')

    // Rejects path prefix
    let threwPath = false
    try {
      validateAppBaseUrl('https://mms.example.com/prefix', true)
    } catch {
      threwPath = true
    }
    if (!threwPath) throw new Error('expected path prefix to throw')
  })

  it('P0.7: entraLogoutUrl strictly pins post_logout_redirect_uri to canonical base URL', () => {
    let savedBase = process.env.APP_BASE_URL
    let savedTenant = process.env.MMS_ENTRA_TENANT_ID
    let savedClient = process.env.MMS_ENTRA_CLIENT_ID
    let savedSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    try {
      process.env.APP_BASE_URL = 'https://mms.example.com'
      process.env.MMS_ENTRA_TENANT_ID = tenantId
      process.env.MMS_ENTRA_CLIENT_ID = clientId
      process.env.MMS_ENTRA_CLIENT_SECRET = 'secret'

      // Normal logout URL
      let logoutUrl = entraLogoutUrl()
      let parsed = new URL(logoutUrl)
      if (parsed.searchParams.get('post_logout_redirect_uri') !== 'https://mms.example.com/login') {
        throw new Error(`expected https://mms.example.com/login, got ${parsed.searchParams.get('post_logout_redirect_uri')}`)
      }

      // Attacker passes an external redirect URI to entraLogoutUrl
      let spoofedLogoutUrl = entraLogoutUrl('https://evil.example.com/steal-creds')
      let parsedSpoofed = new URL(spoofedLogoutUrl)
      let postLogout = parsedSpoofed.searchParams.get('post_logout_redirect_uri') ?? ''
      if (postLogout.includes('evil.example.com')) {
        throw new Error(`evil host leaked into post_logout_redirect_uri: ${postLogout}`)
      }
      if (!postLogout.startsWith('https://mms.example.com')) {
        throw new Error(`post_logout_redirect_uri not pinned to base: ${postLogout}`)
      }
    } finally {
      if (savedBase) process.env.APP_BASE_URL = savedBase
      else delete process.env.APP_BASE_URL
      if (savedTenant) process.env.MMS_ENTRA_TENANT_ID = savedTenant
      else delete process.env.MMS_ENTRA_TENANT_ID
      if (savedClient) process.env.MMS_ENTRA_CLIENT_ID = savedClient
      else delete process.env.MMS_ENTRA_CLIENT_ID
      if (savedSecret) process.env.MMS_ENTRA_CLIENT_SECRET = savedSecret
      else delete process.env.MMS_ENTRA_CLIENT_SECRET
    }
  })
})
