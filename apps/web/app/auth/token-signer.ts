// Server-only. This module is the only place that may read the BFF signing key.
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export type AccessTokenClaims = {
  userId: string
  role: string
  sessionId: string
  authMethod: 'entra' | 'microsoft' | 'google' | 'pwd'
  amr?: string[]
  title?: string
  grade?: number
  orgUnitId?: string
  /** Audit attribution for row changes in this window (H-10 sends 'break_glass'). */
  source?: string
  /** End of the break-glass window, epoch seconds; omitted for ordinary sessions. */
  breakGlassUntil?: number
}

export type SignedAccessToken = {
  token: string
  expiresAt: number
}

const AUDIENCE = 'mms-api'
const ISSUER = 'mms-bff'
const TTL_SECONDS = 300

/**
 * The signing key set.
 *
 * One key signs; every key in the set is advertised in the JWKS so a rotation can
 * be staged: publish the new key, let PostgREST pick it up, switch signing to it,
 * then retire the old one once the longest access-token TTL has elapsed. Keeping
 * the verifier's cache in mind, the retired key must stay published for at least
 * `TTL_SECONDS` plus the JWKS refresh interval.
 *
 * Sources, in order:
 * - `MMS_JWT_PRIVATE_KEY` (inline PEM) / `MMS_JWT_KID` — the signing key;
 * - `MMS_JWT_PRIVATE_KEY_FILE` — the same PEM read from a mounted secret, which is
 *   how a Key Vault CSI volume or a Kubernetes secret is consumed;
 * - `MMS_JWT_NEXT_PRIVATE_KEY` / `MMS_JWT_NEXT_KID` — an already-published key
 *   kept for the overlap window of a rotation;
 * - `MMS_JWT_ADDITIONAL_JWKS` — extra public keys (JSON array) for keys whose
 *   private half is not in this process at all.
 */
type SigningKey = { kid: string; pem: string }

type KeyFileCacheEntry = {
  pem: string
  mtimeMs: number
  checkedAt: number
}

export const KEY_FILE_STAT_TTL_MS = 5_000
const keyFileCache = new Map<string, KeyFileCacheEntry>()
const resolvedPathCache = new Map<string, string>()

export const PRIVATE_KEY_CACHE_MAX = 8

// Parsing a PEM is comparatively expensive and `signAccessToken` runs on every
// authenticated request. Keys are cached by their PEM text, so rotating the env
// var to a different key simply produces a different cache entry.
const privateKeyCache = new Map<string, KeyObject>()

function privateKeyFor(pem: string): KeyObject {
  let key = privateKeyCache.get(pem)
  if (key) {
    privateKeyCache.delete(pem)
    privateKeyCache.set(pem, key)
    return key
  }
  key = createPrivateKey(pem)
  if (privateKeyCache.size >= PRIVATE_KEY_CACHE_MAX) {
    let oldest = privateKeyCache.keys().next().value
    if (oldest !== undefined) {
      privateKeyCache.delete(oldest)
    }
  }
  privateKeyCache.set(pem, key)
  return key
}

function resolveKeyFilePath(file: string): string {
  let hit = resolvedPathCache.get(file)
  if (hit) return hit
  let resolved: string
  if (existsSync(file)) {
    resolved = file
  } else {
    let repoPath = resolve(import.meta.dirname, '../../../..', file)
    if (existsSync(repoPath)) {
      resolved = repoPath
    } else {
      let cwdParentPath = resolve(process.cwd(), '../..', file)
      if (existsSync(cwdParentPath)) {
        resolved = cwdParentPath
      } else {
        resolved = file
      }
    }
  }
  resolvedPathCache.set(file, resolved)
  return resolved
}

function readPrivateKey(): string | undefined {
  let inline = process.env.MMS_JWT_PRIVATE_KEY
  if (inline) return inline
  let file = process.env.MMS_JWT_PRIVATE_KEY_FILE
  if (!file) return undefined

  let resolvedPath = resolveKeyFilePath(file)
  let now = Date.now()
  let cached = keyFileCache.get(resolvedPath)
  if (cached && (now - cached.checkedAt) < KEY_FILE_STAT_TTL_MS) {
    return cached.pem
  }

  let stat = statSync(resolvedPath)
  if (cached && stat.mtimeMs === cached.mtimeMs) {
    cached.checkedAt = now
    return cached.pem
  }

  let pem = readFileSync(resolvedPath, 'utf8')
  keyFileCache.set(resolvedPath, {
    pem,
    mtimeMs: stat.mtimeMs,
    checkedAt: now,
  })
  return pem
}

export function clearTokenSignerCaches(): void {
  privateKeyCache.clear()
  keyFileCache.clear()
  resolvedPathCache.clear()
  jwksCache = undefined
}

function signingKey(): SigningKey {
  let pem = readPrivateKey()
  if (!pem) throw new Error('MMS_JWT_PRIVATE_KEY or MMS_JWT_PRIVATE_KEY_FILE is required')
  return { kid: process.env.MMS_JWT_KID ?? 'mms-dev', pem }
}

function retainedKeys(): SigningKey[] {
  let keys: SigningKey[] = []
  let nextPem = process.env.MMS_JWT_NEXT_PRIVATE_KEY
  if (nextPem) keys.push({ kid: process.env.MMS_JWT_NEXT_KID ?? 'mms-next', pem: nextPem })
  return keys
}

function additionalPublicJwks(): Record<string, unknown>[] {
  let raw = process.env.MMS_JWT_ADDITIONAL_JWKS
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('MMS_JWT_ADDITIONAL_JWKS must be a JSON array of JWK objects')
  }
  if (!Array.isArray(parsed)) throw new Error('MMS_JWT_ADDITIONAL_JWKS must be a JSON array of JWK objects')
  return parsed as Record<string, unknown>[]
}

export function signAccessToken(claims: AccessTokenClaims): SignedAccessToken {
  let { kid, pem } = signingKey()
  let now = Math.floor(Date.now() / 1000)
  let expiresAt = now + TTL_SECONDS
  let header = { alg: 'ES256', typ: 'JWT', kid }
  let payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: claims.userId,
    role: claims.role,
    sid: claims.sessionId,
    amr: claims.amr ?? [claims.authMethod],
    iat: now,
    exp: expiresAt,
  }
  if (claims.title) payload.title = claims.title
  if (claims.grade !== undefined) payload.grade = claims.grade
  if (claims.orgUnitId) payload.org_unit_id = claims.orgUnitId
  if (claims.source) payload.src = claims.source
  if (claims.breakGlassUntil !== undefined) payload.bg = claims.breakGlassUntil

  let input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  let signature = sign('sha256', Buffer.from(input), {
    key: privateKeyFor(pem),
    dsaEncoding: 'ieee-p1363',
  })
  return { token: `${input}.${base64url(signature)}`, expiresAt }
}

/** Fields that would turn a published public JWK into private key material. */
const PRIVATE_JWK_FIELDS = ['d', 'k', 'p', 'q', 'dp', 'dq', 'qi', 'oth']

/**
 * Normalises an operator-supplied public JWK. The document is served to
 * unauthenticated callers, so an entry may never introduce a private scalar or
 * override the algorithm/purpose this BFF signs with.
 */
function publicOnlyJwk(extra: unknown, index: number): Record<string, unknown> {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    throw new Error(`MMS_JWT_ADDITIONAL_JWKS[${index}] must be a JWK object`)
  }
  let jwk = extra as Record<string, unknown>
  for (let field of PRIVATE_JWK_FIELDS) {
    if (field in jwk) {
      throw new Error(`MMS_JWT_ADDITIONAL_JWKS[${index}] must not contain private key material (${field})`)
    }
  }
  if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) {
    throw new Error(`MMS_JWT_ADDITIONAL_JWKS[${index}] must have a kid`)
  }
  if (jwk.alg !== undefined && jwk.alg !== 'ES256') {
    throw new Error(`MMS_JWT_ADDITIONAL_JWKS[${index}] must use ES256`)
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    throw new Error(`MMS_JWT_ADDITIONAL_JWKS[${index}] must be a signing key`)
  }
  // BFF-owned fields are applied last so they cannot be overridden by the input.
  return { ...jwk, alg: 'ES256', use: 'sig' }
}

let jwksCache: { fingerprint: string; value: { keys: Record<string, unknown>[] } } | undefined

function jwksFingerprint(signing: SigningKey, retained: SigningKey[]): string {
  return JSON.stringify([
    signing.kid,
    signing.pem,
    retained,
    process.env.MMS_JWT_ADDITIONAL_JWKS ?? '',
  ])
}

export function publicJwks(): { keys: Record<string, unknown>[] } {
  let signing = signingKey()
  let retained = retainedKeys()
  let fingerprint = jwksFingerprint(signing, retained)
  if (jwksCache?.fingerprint === fingerprint) return jwksCache.value

  let keys: Record<string, unknown>[] = [jwksFor(signing)]
  for (let key of retained) {
    let jwks = jwksFor(key)
    if (!keys.some((existing) => existing.kid === jwks.kid)) keys.push(jwks)
  }
  additionalPublicJwks().forEach((extra, index) => {
    let jwks = publicOnlyJwk(extra, index)
    if (!keys.some((existing) => existing.kid === jwks.kid)) keys.push(jwks)
  })

  let value = { keys }
  jwksCache = { fingerprint, value }
  return value
}

function jwksFor(key: SigningKey): Record<string, unknown> {
  let jwk = createPublicKey(privateKeyFor(key.pem)).export({ format: 'jwk' }) as Record<string, unknown>
  return { ...jwk, kid: key.kid, alg: 'ES256', use: 'sig' }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
