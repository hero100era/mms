// Shared OIDC authorization-code flow: PKCE, token exchange, JWKS-backed ID-token
// validation. Entra and Google differ only in endpoints, accepted issuers and a
// couple of provider-specific claim checks; everything else is protocol and must
// live in exactly one place. A fix to signature/nonce/expiry handling here reaches
// both providers, which is the reason this module exists.
//
// The interface is deliberately small: a provider supplies a `OidcSpec` (settings,
// endpoints, account-id rule, optional extra claim checks) and receives a client
// exposing `provider()`, `validateIdToken()` and `reset()`.
import {
  createOAuthProvider,
  type OAuthProvider,
  type OAuthTokens,
  type OAuthTransaction,
  type OIDCAuthProfile,
} from 'remix/auth'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'

/** Claims the shared validator reads. `OIDCAuthProfile` has an index signature, so
 *  naming these fields keeps the checks type-safe instead of `unknown` casts. */
export type OidcClaims = OIDCAuthProfile & {
  nonce?: string
  tid?: string
  oid?: string
  roles?: string[]
  iss?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
}

/** Everything the shared protocol logic needs from a provider's settings. */
export type OidcConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
  authority: string
  /** Entra only: the tenant whose `tid` claim is trusted. */
  tenantId?: string
}

/** Provider-specific URLs and trust rules derived from an `OidcConfig`. */
export type OidcEndpoints = {
  authorizationUrl: string
  tokenUrl: string
  /** Tried in order; the first successful response supplies the keys. */
  jwksUrls: string[]
  /** Accepted `iss` values when issuer checking is enabled. */
  acceptedIssuers: string[]
}

export type OidcValidationOptions = { allowExternalTenant?: boolean }

export type OidcSpec<Claims extends OidcClaims, Name extends string> = {
  name: Name
  /** Reads settings from the environment. Called once per provider instance. */
  config: () => OidcConfig
  /** Resolves endpoints from settings. Also used by the exported validator so tests
   *  can pass a hand-built config without touching `process.env`. */
  endpoints: (config: OidcConfig) => OidcEndpoints
  /** Stable, provider-namespaced account identifier. */
  accountId: (claims: Claims) => string
  /** Extra claim checks beyond iss/aud/exp/nbf/nonce. */
  validateClaims?: (
    claims: Claims,
    config: OidcConfig,
    options?: OidcValidationOptions,
  ) => void
  /** Extra form fields on the token exchange. */
  extraTokenParams?: (config: OidcConfig) => Record<string, string>
  /** Skip issuer/tenant checks on the callback (multi-tenant account linking). */
  allowExternalTenant?: boolean
}

export type OidcClient<Claims extends OidcClaims, Name extends string> = {
  provider(): OAuthProvider<Claims, Name>
  validateIdToken(
    idToken: string,
    config: OidcConfig,
    expectedNonce: string | undefined,
    options?: OidcValidationOptions,
  ): Promise<Claims>
  reset(): void
}

const OIDC_HTTP_TIMEOUT_MS = 10_000
const JWKS_TTL_MS = 60 * 60 * 1000
const SCOPE = 'openid profile email'

type JwksCacheEntry = { keys: Record<string, unknown>[]; at: number }

export function createOidcClient<Claims extends OidcClaims, Name extends string>(
  spec: OidcSpec<Claims, Name>,
): OidcClient<Claims, Name> {
  let cachedProvider: OAuthProvider<Claims, Name> | undefined
  // Keyed by the endpoint set, not module-global: two providers (or two test
  // authorities) must never reuse each other's signing keys.
  let jwksCache = new Map<string, JwksCacheEntry>()

  let jwksForceRefreshAt = new Map<string, number>()

  function getJwks(urls: string[], forceRefresh = false): Promise<Record<string, unknown>[]> {
    let key = urls.join('\0')
    let cached = jwksCache.get(key)
    if (!forceRefresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return Promise.resolve(cached.keys)

    let firstFailureStatus = 0
    let attempt = (index: number): Promise<Record<string, unknown>[]> =>
      fetch(urls[index]!, { signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS) }).then(async (response) => {
        if (!response.ok) {
          if (firstFailureStatus === 0) firstFailureStatus = response.status
          if (index + 1 < urls.length) return attempt(index + 1)
          throw new Error(`jwks_fetch_failed:${firstFailureStatus}`)
        }
        let json = (await response.json()) as { keys: Record<string, unknown>[] }
        jwksCache.set(key, { keys: json.keys, at: Date.now() })
        return json.keys
      })

    return attempt(0)
  }

  async function validateIdToken(
    idToken: string,
    config: OidcConfig,
    expectedNonce: string | undefined,
    options?: OidcValidationOptions,
  ): Promise<Claims> {
    let parts = idToken.split('.')
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('id_token_malformed')
    let [headerPart, payloadPart, signaturePart] = parts
    let header: { alg?: string; kid?: string }
    try {
      header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as { alg?: string; kid?: string }
    } catch {
      throw new Error('id_token_malformed')
    }
    if (header.alg !== 'RS256') throw new Error('id_token_alg')

    let endpoints = spec.endpoints(config)
    let matchesSigningKey = (candidate: Record<string, unknown>) =>
      candidate.kid === header.kid &&
      candidate.kty === 'RSA' &&
      (!candidate.use || candidate.use === 'sig')

    let jwks = await getJwks(endpoints.jwksUrls)
    let jwk = jwks.find(matchesSigningKey)
    if (!jwk) {
      let cacheKey = endpoints.jwksUrls.join('\0')
      let lastRefresh = jwksForceRefreshAt.get(cacheKey) ?? 0
      if (Date.now() - lastRefresh >= 60_000) {
        jwksForceRefreshAt.set(cacheKey, Date.now())
        jwks = await getJwks(endpoints.jwksUrls, true)
        jwk = jwks.find(matchesSigningKey)
      }
    }
    if (!jwk) throw new Error('id_token_kid')
    let publicKey = createPublicKey({ key: jwk as never, format: 'jwk' })
    let valid = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart, 'base64url'),
    )
    if (!valid) throw new Error('id_token_signature')

    let claims: Claims & { azp?: string }
    try {
      claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Claims & { azp?: string }
    } catch {
      throw new Error('id_token_malformed')
    }
    let now = Math.floor(Date.now() / 1000)
    if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('id_token_expired')
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) {
      throw new Error('id_token_not_yet_valid')
    }
    // Multi-tenant linking deliberately accepts tokens from other tenants; the
    // caller must still check the tenant before granting internal access.
    if (!options?.allowExternalTenant && !endpoints.acceptedIssuers.includes(claims.iss ?? '')) {
      throw new Error('id_token_issuer')
    }
    let audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audience.includes(config.clientId)) throw new Error('id_token_audience')
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) {
      throw new Error('id_token_azp')
    }
    spec.validateClaims?.(claims, config, options)
    if (!expectedNonce || claims.nonce !== expectedNonce) throw new Error('id_token_nonce')
    return claims
  }

  async function exchangeCode(
    config: OidcConfig,
    endpoints: OidcEndpoints,
    code: string,
    verifier: string,
  ): Promise<OAuthTokens> {
    let body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
      ...spec.extraTokenParams?.(config),
    })
    let response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`token_exchange_failed:${response.status}`)
    let json = (await response.json()) as {
      access_token: string
      refresh_token?: string
      token_type?: string
      expires_in?: number
      scope?: string
      id_token?: string
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
      scope: json.scope?.split(' '),
      idToken: json.id_token,
    }
  }

  function createAuthorizationUrl(
    config: OidcConfig,
    endpoints: OidcEndpoints,
    transaction: OAuthTransaction,
  ): URL {
    let nonce = randomBytes(24).toString('base64url')
    transaction.providerState = nonce
    let url = new URL(endpoints.authorizationUrl)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', config.redirectUri)
    url.searchParams.set('response_mode', 'query')
    url.searchParams.set('scope', SCOPE)
    url.searchParams.set('state', transaction.state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set(
      'code_challenge',
      createHash('sha256').update(transaction.codeVerifier).digest('base64url'),
    )
    url.searchParams.set('code_challenge_method', 'S256')
    return url
  }

  function provider(): OAuthProvider<Claims, Name> {
    if (cachedProvider) return cachedProvider
    let config = spec.config()
    let endpoints = spec.endpoints(config)
    cachedProvider = createOAuthProvider<Claims, Name>(spec.name, {
      createAuthorizationURL(transaction) {
        return createAuthorizationUrl(config, endpoints, transaction)
      },
      async handleCallback(context, transaction) {
        let code = context.url.searchParams.get('code')
        if (!code) throw new Error('missing_authorization_code')
        let tokens = await exchangeCode(config, endpoints, code, transaction.codeVerifier)
        if (!tokens.idToken) throw new Error('missing_id_token')
        let claims = await validateIdToken(
          tokens.idToken,
          config,
          transaction.providerState,
          spec.allowExternalTenant ? { allowExternalTenant: true } : undefined,
        )
        return {
          provider: spec.name,
          account: { provider: spec.name, providerAccountId: spec.accountId(claims) },
          profile: claims,
          tokens,
        }
      },
    })
    return cachedProvider
  }

  return {
    provider,
    validateIdToken,
    reset() {
      cachedProvider = undefined
      jwksCache.clear()
    },
  }
}
