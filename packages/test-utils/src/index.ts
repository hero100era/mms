import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Ensures that MMS_JWT_KID and MMS_JWT_PRIVATE_KEY environment variables are populated
 * for test environments. Searches standard relative paths for the dev test key, or
 * falls back to generating an ephemeral P-256 key pair.
 */
export function ensureTestJwtKey(baseMetaUrl?: string): void {
  if (!process.env.MMS_JWT_KID) {
    process.env.MMS_JWT_KID = 'mms-dev'
  }
  if (process.env.MMS_JWT_PRIVATE_KEY) {
    return
  }

  const keyCandidates: Array<string | URL> = []
  if (baseMetaUrl) {
    keyCandidates.push(
      new URL('../../../../.testdata/keys/mms-jwt-private.pem', baseMetaUrl),
      new URL('../../../.testdata/keys/mms-jwt-private.pem', baseMetaUrl),
      new URL('../../.testdata/keys/mms-jwt-private.pem', baseMetaUrl),
      new URL('../.testdata/keys/mms-jwt-private.pem', baseMetaUrl),
    )
  }
  keyCandidates.push(
    '.testdata/keys/mms-jwt-private.pem',
    '../.testdata/keys/mms-jwt-private.pem',
    '../../.testdata/keys/mms-jwt-private.pem',
    '../../../.testdata/keys/mms-jwt-private.pem',
  )

  for (const c of keyCandidates) {
    try {
      const p = typeof c === 'string' ? c : fileURLToPath(c)
      if (existsSync(p)) {
        process.env.MMS_JWT_PRIVATE_KEY = readFileSync(p, 'utf8')
        return
      }
    } catch {
      // Continue to next candidate
    }
  }

  const ecPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  process.env.MMS_JWT_PRIVATE_KEY = ecPair.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string
}

/**
 * Extracts a CSRF token from an HTML response body.
 * Supports standard form inputs and meta tags.
 */
export function extractCsrfToken(html: string): string {
  if (!html) return ''

  // 1. Standard hidden input: name="_csrf" value="..."
  const nameValueMatch = html.match(/<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/i)
  if (nameValueMatch?.[1]) return nameValueMatch[1]

  // 2. Reversed order: value="..." name="_csrf"
  const valueNameMatch = html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i)
  if (valueNameMatch?.[1]) return valueNameMatch[1]

  // 3. Simple fallback regex: name="_csrf" value="..."
  const simpleMatch = html.match(/name="_csrf"\s+value="([^"]+)"/)
  if (simpleMatch?.[1]) return simpleMatch[1]

  // 4. Meta tag: <meta name="csrf-token" content="...">
  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
  if (metaMatch?.[1]) return metaMatch[1]

  return ''
}

/**
 * Extracts the first cookie token (before the first semicolon) from a Set-Cookie header.
 */
export function extractFirstCookie(setCookieHeader: string | null | undefined): string {
  if (!setCookieHeader) return ''
  return setCookieHeader.split(';')[0]?.trim() ?? ''
}

/**
 * Resolves the database connection URL for test suites.
 */
export function getTestDbUrl(
  defaultUrl: string = 'postgresql://postgres@127.0.0.1:5432/mms_acceptance',
): string {
  return (
    process.env.MMS_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    defaultUrl
  )
}
