// Custom Google provider. Uses authorization code flow with PKCE and
// validates the ID token signature against Google JWKS (or mock test server)
// before returning claims. The protocol itself lives in ./oidc.ts; this module
// owns only Google's endpoints and issuer rules.
import type { OAuthProvider } from 'remix/auth'

import {
  createOidcClient,
  type OidcClaims,
  type OidcConfig,
  type OidcEndpoints,
} from './oidc.ts'
import { getAppBaseUrl } from './entra.ts'

export type GoogleClaims = OidcClaims & {
  nonce?: string
}

export type GoogleConfig = OidcConfig

const GOOGLE_AUTHORITY = 'https://accounts.google.com'

export function googleConfig(): GoogleConfig {
  let clientId = process.env.MMS_GOOGLE_CLIENT_ID
  let clientSecret = process.env.MMS_GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('MMS_GOOGLE_CLIENT_ID and MMS_GOOGLE_CLIENT_SECRET are required')
  }
  let baseUrl = getAppBaseUrl()
  let redirectUri = process.env.MMS_GOOGLE_REDIRECT_URI
    ? new URL(new URL(process.env.MMS_GOOGLE_REDIRECT_URI).pathname, baseUrl).toString()
    : `${baseUrl}/auth/google/callback`
  return {
    clientId,
    clientSecret,
    redirectUri,
    authority: process.env.MMS_GOOGLE_AUTHORITY ?? GOOGLE_AUTHORITY,
  }
}

export function googleConfigured(): boolean {
  return Boolean(
    process.env.MMS_GOOGLE_CLIENT_ID &&
      process.env.MMS_GOOGLE_CLIENT_SECRET &&
      (process.env.MMS_GOOGLE_REDIRECT_URI || process.env.APP_BASE_URL || process.env.NODE_ENV !== 'production'),
  )
}

/**
 * Google's production endpoints live on different hosts from the issuer, while
 * the mock OIDC server used in tests serves everything under `authority`.
 */
function googleEndpoints(c: OidcConfig): OidcEndpoints {
  let isProduction = c.authority === GOOGLE_AUTHORITY
  return {
    authorizationUrl: `${c.authority}/o/oauth2/v2/auth`,
    tokenUrl: isProduction ? 'https://oauth2.googleapis.com/token' : `${c.authority}/token`,
    jwksUrls: isProduction
      ? ['https://www.googleapis.com/oauth2/v3/certs']
      : [`${c.authority}/discovery/v2.0/keys`, `${c.authority}/oauth2/v3/certs`],
    // Google historically issues both the URL and the host-only form.
    acceptedIssuers: [c.authority, GOOGLE_AUTHORITY, 'accounts.google.com'],
  }
}

const client = createOidcClient<GoogleClaims, 'google'>({
  name: 'google',
  config: googleConfig,
  endpoints: googleEndpoints,
  accountId: (claims) => claims.sub,
})

export function googleProvider(): OAuthProvider<GoogleClaims, 'google'> {
  return client.provider()
}

export function validateGoogleIdToken(
  idToken: string,
  config: GoogleConfig,
  expectedNonce: string | undefined,
): Promise<GoogleClaims> {
  return client.validateIdToken(idToken, config, expectedNonce)
}

export function resetGoogleProvider(): void {
  client.reset()
}
