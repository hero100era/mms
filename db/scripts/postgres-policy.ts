export const APPROVED_POSTGRES_BASELINE = '18.7'
export const APPROVED_POSTGRES_VERSIONS: readonly string[] = ['18.6', '18.7']

export interface PostgresVersionCheckResult {
  passed: boolean
  detail: string
  error?: string
}

/**
 * Validates a PostgreSQL server version against the MMS accepted policy (Option A: Approved patch baseline).
 *
 * Baseline: 18.7
 * Approved versions: ['18.6', '18.7']
 * Other 18.x patch versions require explicit approval in this file.
 * Major versions other than 18 fail fast.
 */
export function verifyPostgresVersion(serverVersionNum: number, verStr: string): PostgresVersionCheckResult {
  let serverMajor = Math.floor(serverVersionNum / 10000)
  let cleanVerStr = verStr.trim()
  let match = cleanVerStr.match(/^(\d+)\.(\d+)/)
  let detectedVersion = match ? `${match[1]}.${match[2]}` : `${serverMajor}`

  if (serverMajor !== 18) {
    let msg =
      serverMajor < 18
        ? `ERROR: Connected PostgreSQL server version is ${cleanVerStr} (server_version_num: ${serverVersionNum}). MMS baseline requires approved PostgreSQL 18.x (baseline: ${APPROVED_POSTGRES_BASELINE}).`
        : `ERROR: Connected PostgreSQL server version is ${cleanVerStr} (server_version_num: ${serverVersionNum}). PostgreSQL 19.x or higher has not been approved for MMS.`
    return {
      passed: false,
      detail: `PostgreSQL ${cleanVerStr} (server_version_num: ${serverVersionNum})`,
      error: msg,
    }
  }

  if (!APPROVED_POSTGRES_VERSIONS.includes(detectedVersion)) {
    return {
      passed: false,
      detail: `PostgreSQL ${cleanVerStr} (server_version_num: ${serverVersionNum})`,
      error: `ERROR: Connected PostgreSQL server version is ${cleanVerStr}. Allowed approved version(s): [${APPROVED_POSTGRES_VERSIONS.join(', ')}]. Patch version ${detectedVersion} requires explicit approval in db/scripts/postgres-policy.ts.`,
    }
  }

  return {
    passed: true,
    detail: `PostgreSQL ${cleanVerStr} (server_version_num: ${serverVersionNum})`,
  }
}
