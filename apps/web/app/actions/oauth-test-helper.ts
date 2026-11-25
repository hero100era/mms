import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'
import { Pool } from 'pg'
import * as assert from 'remix/assert'

import { router as _router } from '../router.ts'
import { resetEntraProvider } from '../auth/entra.ts'
import { resetGoogleProvider } from '../auth/google.ts'
import { clearSessionCaches } from '../auth/session-storage.ts'
import { withRole } from '../db/role-pool.ts'

export const staffTenantId = '11111111-1111-1111-1111-111111111111'
export const entraClientId = '22222222-2222-2222-2222-222222222222'
export const googleClientId = 'google-client-id-xyz'
export const kid = 'test-kid-1'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

const gatewayUrl =
  process.env.AUTH_GATEWAY_DATABASE_URL ||
  process.env.MMS_GATEWAY_DATABASE_URL ||
  withRole(adminUrl, 'auth_gateway')

process.env.AUTH_GATEWAY_DATABASE_URL = gatewayUrl

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

export interface OauthTestEnvironment {
  router: { fetch(input: URL, init?: RequestInit): Promise<Response> }
  adminPool: Pool
  activeTokens: Map<string, string>
  authority: string
  makeToken: (payload: Record<string, unknown>) => string
  makeGoogleToken: (claims: {
    nonce: string
    sub: string
    email?: string
    name?: string
    iss?: string
    aud?: string
    exp?: number
  }) => string
  makeEntraToken: (claims: {
    nonce: string
    tid: string
    oid: string
    sub?: string
    preferred_username?: string
    name?: string
    roles?: string[]
    iss?: string
    aud?: string
    exp?: number
  }) => string
  getCsrfAndCookie: (path: string, existingCookie?: string) => Promise<{ csrf: string; cookie: string }>
  sessionCsrf: (existingCookie: string) => Promise<string>
  sessionIdOf: (existingCookie: string) => string | null
  satisfyMfa: (userId: string) => Promise<void>
  grantStepUp: (cookie: string) => Promise<void>
  clearThrottleFor: (loginName: string) => Promise<void>
  teardown: () => Promise<void>
}

export async function createOauthTestEnvironment(testIp: string): Promise<OauthTestEnvironment> {
  const router = {
    fetch(input: URL, init?: RequestInit): Promise<Response> {
      return _router.fetch(input, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': testIp },
      })
    },
  }

  let pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let privateKey = pair.privateKey
  let jwks = {
    keys: [
      {
        ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
        kid,
        alg: 'RS256',
        use: 'sig',
      },
    ],
  }

  if (!process.env.MMS_JWT_PRIVATE_KEY) {
    let ecPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    process.env.MMS_JWT_PRIVATE_KEY = ecPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  }

  let activeTokens = new Map<string, string>()

  let server: Server = createServer(async (req, res) => {
    let url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === '/discovery/v2.0/keys') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(jwks))
      return
    }
    if (url.pathname === '/oauth2/v2.0/token' || url.pathname === '/token') {
      let body = ''
      for await (let chunk of req) body += chunk
      let params = new URLSearchParams(body)
      let code = params.get('code') ?? ''
      let idTok = activeTokens.get(code)
      if (!idTok) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          access_token: 'mock-access-token',
          id_token: idTok,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      )
      return
    }
    res.statusCode = 404
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  let authority = `http://127.0.0.1:${address.port}`

  process.env.MMS_ENTRA_TENANT_ID = staffTenantId
  process.env.MMS_ENTRA_CLIENT_ID = entraClientId
  process.env.MMS_ENTRA_CLIENT_SECRET = 'entra-secret'
  process.env.MMS_ENTRA_REDIRECT_URI = 'http://localhost/auth/microsoft/callback'
  process.env.MMS_ENTRA_AUTHORITY = authority

  process.env.MMS_GOOGLE_CLIENT_ID = googleClientId
  process.env.MMS_GOOGLE_CLIENT_SECRET = 'google-secret'
  process.env.MMS_GOOGLE_REDIRECT_URI = 'http://localhost/auth/google/callback'
  process.env.MMS_GOOGLE_AUTHORITY = authority

  resetEntraProvider()
  resetGoogleProvider()

  let adminPool = new Pool({ connectionString: adminUrl })
  await adminPool.query(`
    insert into auth.config (singleton, entra_tenant_id, entra_app_role)
    values (true, $1, 'MMS.User')
    on conflict (singleton) do update
       set entra_tenant_id = excluded.entra_tenant_id,
           entra_app_role = excluded.entra_app_role
  `, [staffTenantId])

  const userTarget = `where email like '%oauth_test_%' or entra_object_id in ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '99999999-9999-9999-9999-999999999999')`
  const cleanupUsers = async () => {
    await adminPool.query(`delete from iam.user_identity where email_at_link like '%oauth_test_%' or user_id in (select id from iam.app_user ${userTarget})`)
    await adminPool.query(`delete from iam.role_assignment where user_id in (select id from iam.app_user ${userTarget}) or granted_by in (select id from iam.app_user ${userTarget})`)
    await adminPool.query(`delete from iam.session where user_id in (select id from iam.app_user ${userTarget})`)
    await adminPool.query(`delete from iam.password_credential where user_id in (select id from iam.app_user ${userTarget})`)
    await adminPool.query(`delete from iam.one_time_token where user_id in (select id from iam.app_user ${userTarget})`)
    await adminPool.query(`delete from iam.app_user ${userTarget}`)
    await adminPool.query(`delete from iam.login_attempt where login_name like '%oauth_test%'`)
  }

  await cleanupUsers()

  function makeToken(payload: Record<string, unknown>): string {
    let header = { alg: 'RS256', typ: 'JWT', kid }
    let input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`
    let signature = sign('RSA-SHA256', Buffer.from(input), privateKey)
    return `${input}.${b64(signature)}`
  }

  function makeGoogleToken(claims: {
    nonce: string
    sub: string
    email?: string
    name?: string
    iss?: string
    aud?: string
    exp?: number
  }): string {
    let now = Math.floor(Date.now() / 1000)
    return makeToken({
      iss: claims.iss ?? authority,
      aud: claims.aud ?? googleClientId,
      sub: claims.sub,
      email: claims.email ?? `${claims.sub}@example.com`,
      name: claims.name ?? 'Google Test User',
      nonce: claims.nonce,
      iat: now,
      nbf: now,
      exp: claims.exp ?? now + 300,
    })
  }

  function makeEntraToken(claims: {
    nonce: string
    tid: string
    oid: string
    sub?: string
    preferred_username?: string
    name?: string
    roles?: string[]
    iss?: string
    aud?: string
    exp?: number
  }): string {
    let now = Math.floor(Date.now() / 1000)
    return makeToken({
      iss: claims.iss ?? authority,
      aud: claims.aud ?? entraClientId,
      tid: claims.tid,
      oid: claims.oid,
      sub: claims.sub ?? claims.oid,
      preferred_username: claims.preferred_username ?? `${claims.oid}@example.com`,
      name: claims.name ?? 'Microsoft Test User',
      roles: claims.roles ?? [],
      nonce: claims.nonce,
      iat: now,
      nbf: now,
      exp: claims.exp ?? now + 300,
    })
  }

  async function getCsrfAndCookie(path: string, existingCookie?: string): Promise<{ csrf: string; cookie: string }> {
    let headers: Record<string, string> = {}
    if (existingCookie) headers['cookie'] = existingCookie
    let res = await router.fetch(new URL(path, 'http://localhost'), { headers })
    let text = await res.text()
    let match = text.match(/name="_csrf"\s+value="([^"]+)"/)
    let cookieHeader = res.headers.get('set-cookie') ?? existingCookie ?? ''
    let sid = cookieHeader.split(';')[0] ?? ''
    return { csrf: match?.[1] ?? '', cookie: sid }
  }

  async function sessionCsrf(existingCookie: string): Promise<string> {
    let match = existingCookie.match(/__mms_sid=([^;]+)/)
    if (!match) return ''
    let value = decodeURIComponent(match[1]!)
    let payload = JSON.parse(Buffer.from(value.split('.')[0] ?? '', 'base64url').toString('utf8'))
    let row = await adminPool.query<{ csrf: string }>(
      "select data->0->>'_csrf' as csrf from iam.session where id = $1",
      [payload.value],
    )
    return row.rows[0]?.csrf ?? ''
  }

  function sessionIdOf(existingCookie: string): string | null {
    let match = existingCookie.match(/__mms_sid=([^;]+)/)
    if (!match) return null
    let value = decodeURIComponent(match[1]!)
    let payload = JSON.parse(Buffer.from(value.split('.')[0] ?? '', 'base64url').toString('utf8'))
    return typeof payload.value === 'string' ? payload.value : null
  }

  async function satisfyMfa(userId: string): Promise<void> {
    await adminPool.query(
      `update iam.session
          set data = jsonb_set(
            case when jsonb_typeof(data) = 'array' then data else jsonb_build_array(data) end,
            '{0,auth,mfaVerifiedAt}',
            to_jsonb(now()::text)
          )
        where user_id = $1`,
      [userId],
    )
    clearSessionCaches()
  }

  async function grantStepUp(cookie: string): Promise<void> {
    let sessionId = sessionIdOf(cookie)
    assert.ok(sessionId, 'a session cookie is required for step-up')
    let current = await adminPool.query<{ data: [Record<string, any>, Record<string, any>] }>(
      'select data from iam.session where id = $1',
      [sessionId],
    )
    let row = current.rows[0]
    assert.ok(row, `session ${sessionId} should exist before step-up`)
    let now = new Date().toISOString()
    let [values, flashes] = row.data
    values!.auth = { ...values!.auth, stepUpAt: now }
    let gateway = new Pool({ connectionString: gatewayUrl })
    try {
      await gateway.query('select auth.session_write($1, $2::jsonb)', [
        sessionId,
        JSON.stringify([values, flashes]),
      ])
    } finally {
      await gateway.end()
    }
    clearSessionCaches()
  }

  async function clearThrottleFor(loginName: string): Promise<void> {
    await adminPool.query('delete from iam.login_attempt where login_name = $1', [loginName])
  }

  async function teardown(): Promise<void> {
    await cleanupUsers()
    await adminPool.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return {
    router,
    adminPool,
    activeTokens,
    authority,
    makeToken,
    makeGoogleToken,
    makeEntraToken,
    getCsrfAndCookie,
    sessionCsrf,
    sessionIdOf,
    satisfyMfa,
    grantStepUp,
    clearThrottleFor,
    teardown,
  }
}
