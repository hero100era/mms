// Custom Entra provider. remix/auth's built-in OIDC provider reads only the
// UserInfo endpoint; this provider validates the ID token (iss/aud/signature/
// nonce/tid) before returning claims, so tid/oid/roles are trustworthy.
// The protocol lives in ./oidc.ts; this module owns only Entra's endpoints,
// tenant rules and logout URL.
import type { OAuthProvider } from 'remix/auth'

import {
  createOidcClient,
  type OidcClaims,
  type OidcConfig,
  type OidcEndpoints,
} from './oidc.ts'

type EntraClaims = OidcClaims & {
  tid?: string
  oid?: string
  roles?: string[]
  nonce?: string
}

export type EntraConfig = OidcConfig & { tenantId: string }

/**
 * Canonical application base URL validation.
 *
 * Rules (P0.7):
 * - Production: absolute HTTPS URL required.
 * - Local / test: permits https: or http://localhost(:port) or http://127.0.0.1(:port).
 * - Reject credentials (userinfo), query strings, fragments, and non-root path prefixes.
 * - Returns normalized origin string.
 */
export function validateAppBaseUrl(rawUrl: string, isProduction = process.env.NODE_ENV === 'production'): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid APP_BASE_URL: "${rawUrl}" is not a valid absolute URL.`)
  }

  if (url.username || url.password) {
    throw new Error('APP_BASE_URL must not contain credentials (username or password).')
  }
  if (url.search) {
    throw new Error('APP_BASE_URL must not contain a query string.')
  }
  if (url.hash) {
    throw new Error('APP_BASE_URL must not contain a fragment.')
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error(`APP_BASE_URL must not contain a path prefix ("${url.pathname}").`)
  }

  if (url.protocol === 'https:') {
    return url.origin
  }

  if (url.protocol === 'http:') {
    if (isProduction) {
      throw new Error(`APP_BASE_URL must use HTTPS in production. Received: "${rawUrl}".`)
    }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return url.origin
    }
    throw new Error(`HTTP APP_BASE_URL is only permitted for localhost or 127.0.0.1 in non-production. Received: "${rawUrl}".`)
  }

  throw new Error(`APP_BASE_URL must use HTTPS (or HTTP for localhost in non-production). Received: "${rawUrl}".`)
}

export function getAppBaseUrl(): string {
  let raw = process.env.APP_BASE_URL
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_BASE_URL environment variable is required in production.')
    }
    if (process.env.MMS_ENTRA_REDIRECT_URI) {
      try {
        let u = new URL(process.env.MMS_ENTRA_REDIRECT_URI)
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin
      } catch {
        // ignore
      }
    }
    return 'http://localhost'
  }
  return validateAppBaseUrl(raw)
}

function config(): EntraConfig {
  let tenantId = process.env.MMS_ENTRA_TENANT_ID
  let clientId = process.env.MMS_ENTRA_CLIENT_ID
  let clientSecret = process.env.MMS_ENTRA_CLIENT_SECRET
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('MMS_ENTRA_TENANT_ID, MMS_ENTRA_CLIENT_ID and MMS_ENTRA_CLIENT_SECRET are required')
  }
  let baseUrl = getAppBaseUrl()
  let redirectUri = process.env.MMS_ENTRA_REDIRECT_URI
    ? new URL(new URL(process.env.MMS_ENTRA_REDIRECT_URI).pathname, baseUrl).toString()
    : `${baseUrl}/auth/microsoft/callback`
  return {
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    authority: process.env.MMS_ENTRA_AUTHORITY ?? `https://login.microsoftonline.com/${tenantId}/v2.0`,
  }
}

export function entraConfigured(): boolean {
  return Boolean(
    process.env.MMS_ENTRA_TENANT_ID &&
      process.env.MMS_ENTRA_CLIENT_ID &&
      process.env.MMS_ENTRA_CLIENT_SECRET &&
      (process.env.MMS_ENTRA_REDIRECT_URI || process.env.APP_BASE_URL || process.env.NODE_ENV !== 'production'),
  )
}

export function entraTenantId(): string {
  return config().tenantId
}

export function entraLogoutUrl(postLogoutRedirectUri?: string): string {
  let c = config()
  let base = getAppBaseUrl()
  let uri = postLogoutRedirectUri ?? `${base}/login`
  // Guarantee post_logout_redirect_uri is pinned to canonical base URL
  let parsedUri = new URL(uri, base)
  if (parsedUri.origin !== new URL(base).origin) {
    parsedUri = new URL(parsedUri.pathname + parsedUri.search, base)
  }
  let url = new URL(`${c.authority}/oauth2/v2.0/logout`)
  url.searchParams.set('post_logout_redirect_uri', parsedUri.toString())
  return url.toString()
}

function entraEndpoints(c: OidcConfig): OidcEndpoints {
  return {
    authorizationUrl: `${c.authority}/oauth2/v2.0/authorize`,
    tokenUrl: `${c.authority}/oauth2/v2.0/token`,
    jwksUrls: [`${c.authority}/discovery/v2.0/keys`],
    acceptedIssuers: [c.authority],
  }
}

const TENANT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const client = createOidcClient<EntraClaims, 'microsoft'>({
  name: 'microsoft',
  config,
  endpoints: entraEndpoints,
  accountId: (claims) => claims.oid ?? claims.sub,
  // A staff sign-in must come from the configured tenant. External account
  // linking deliberately allows other tenants (see `allowExternalTenant`),
  // and helpers.tsx rejects an internal tenant on that path.
  validateClaims(claims, c, options) {
    // The tenant is the key that binds the issuer to the token. It must be a
    // real UUID on both paths; accepting an arbitrary string would let a token
    // claim an unrelated tenant and issuer together.
    if (typeof claims.tid !== 'string' || !TENANT_PATTERN.test(claims.tid)) {
      throw new Error('id_token_tenant')
    }
    if (options?.allowExternalTenant) {
      // oidc.ts skips its strict issuer check on the multi-tenant path. Restore
      // issuer validation here: the issuer must be either the configured
      // authority or the v2.0 issuer for the tenant named in the token. A
      // token may not assert an arbitrary issuer while carrying a different
      // tid (tenant-confusion). See R1.5 of docs/plans/rectification-implementation-plan.md.
      let issuerOk = claims.iss === c.authority
      if (!issuerOk && typeof claims.iss === 'string') {
        try {
          let expectedOrigin = new URL(c.authority).origin
          let parsedIss = new URL(claims.iss)
          issuerOk =
            parsedIss.protocol === 'https:' &&
            (parsedIss.origin === expectedOrigin || parsedIss.origin === 'https://login.microsoftonline.com') &&
            parsedIss.pathname === `/${claims.tid}/v2.0`
        } catch {
          issuerOk = false
        }
      }
      if (!issuerOk) throw new Error('id_token_issuer')
      return
    }
    if (claims.tid !== c.tenantId) {
      throw new Error('id_token_tenant')
    }
  },
  extraTokenParams: () => ({ scope: 'openid profile email' }),
  allowExternalTenant: true,
})

export function entraProvider(): OAuthProvider<EntraClaims, 'microsoft'> {
  return client.provider()
}

export async function validateIdToken(
  idToken: string,
  c: EntraConfig,
  expectedNonce: string | undefined,
  options?: { allowExternalTenant?: boolean },
): Promise<EntraClaims> {
  return client.validateIdToken(idToken, c, expectedNonce, options)
}

export function resetEntraProvider(): void {
  client.reset()
}
