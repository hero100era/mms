export interface EntraUserDirectoryStatus {
  exists: boolean
  accountEnabled: boolean
  hasMmsUserRole: boolean
  deleted: boolean
  userPrincipalName?: string
  /**
   * Directory attributes that describe the person, used by card H-13 to stage a position
   * proposal for a staff member who has none. They are evidence for HR, never authority:
   * nothing here becomes a position until a human confirms it.
   */
  jobTitle?: string
  department?: string
  officeLocation?: string
}

export interface EntraDirectoryClient {
  getUserStatus(tenantId: string, objectId: string): Promise<EntraUserDirectoryStatus>
}

/**
 * Mock directory client for deterministic testing of Entra user states.
 */
export class MockEntraDirectoryClient implements EntraDirectoryClient {
  private userStatuses = new Map<string, EntraUserDirectoryStatus>()

  private key(tenantId: string, objectId: string): string {
    return `${tenantId.toLowerCase()}:${objectId.toLowerCase()}`
  }

  setUserStatus(tenantId: string, objectId: string, status: Partial<EntraUserDirectoryStatus>): void {
    let current = this.userStatuses.get(this.key(tenantId, objectId)) ?? {
      exists: true,
      accountEnabled: true,
      hasMmsUserRole: true,
      deleted: false,
    }
    this.userStatuses.set(this.key(tenantId, objectId), { ...current, ...status })
  }

  removeUser(tenantId: string, objectId: string): void {
    this.userStatuses.set(this.key(tenantId, objectId), {
      exists: false,
      accountEnabled: false,
      hasMmsUserRole: false,
      deleted: true,
    })
  }

  clear(): void {
    this.userStatuses.clear()
  }

  async getUserStatus(tenantId: string, objectId: string): Promise<EntraUserDirectoryStatus> {
    let status = this.userStatuses.get(this.key(tenantId, objectId))
    if (!status) {
      // Default for known internal users in tests is active with MMS.User
      return {
        exists: true,
        accountEnabled: true,
        hasMmsUserRole: true,
        deleted: false,
      }
    }
    return { ...status }
  }
}

/**
 * Fetch helper with retry support for rate-limiting (HTTP 429 Retry-After)
 * and temporary service outages (HTTP 503).
 */
export async function fetchWithGraphRetry(
  url: string | URL,
  init?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0
  while (true) {
    attempt++
    let signal = init?.signal ?? AbortSignal.timeout(15_000)
    let res = await fetch(url, { ...init, signal })
    if (res.status === 429 && attempt <= maxRetries) {
      let retryAfterHeader = res.headers.get('Retry-After')
      let waitMs = 1000 * Math.pow(2, attempt - 1)
      if (retryAfterHeader) {
        let seconds = Number.parseInt(retryAfterHeader, 10)
        if (!Number.isNaN(seconds) && seconds > 0) {
          waitMs = Math.min(seconds * 1000, 10000)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }
    if (res.status === 503 && attempt <= maxRetries) {
      let waitMs = 500 * Math.pow(2, attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }
    return res
  }
}

/**
 * Production Microsoft Graph API client for Microsoft Entra ID.
 */
export class DefaultEntraDirectoryClient implements EntraDirectoryClient {
  private cachedTokens = new Map<string, { token: string; expiresAt: number }>()
  private cachedAppRoleId?: string

  private getAuthority(tenantId: string): string {
    if (process.env.MMS_ENTRA_AUTHORITY) {
      return process.env.MMS_ENTRA_AUTHORITY.replace(/\/+$/, '')
    }
    let tid = tenantId || process.env.MMS_ENTRA_TENANT_ID || 'common'
    return `https://login.microsoftonline.com/${tid}`
  }

  private get graphBaseUrl(): string {
    return process.env.MMS_GRAPH_BASE_URL ?? 'https://graph.microsoft.com/v1.0'
  }

  private get requiredAppRole(): string {
    return process.env.MMS_ENTRA_APP_ROLE ?? 'MMS.User'
  }

  private async getAccessToken(tenantId: string): Promise<string> {
    let now = Date.now()
    let cached = this.cachedTokens.get(tenantId)
    if (cached && cached.expiresAt > now + 60_000) {
      return cached.token
    }

    let clientId = process.env.MMS_ENTRA_CLIENT_ID
    let clientSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new Error('MMS_ENTRA_CLIENT_ID and MMS_ENTRA_CLIENT_SECRET must be configured for Microsoft Graph sync')
    }

    let tokenUrl = `${this.getAuthority(tenantId)}/oauth2/v2.0/token`
    let body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    })

    let res = await fetchWithGraphRetry(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) {
      throw new Error(`Failed to acquire Graph access token: HTTP ${res.status} ${res.statusText}`)
    }

    let json = (await res.json()) as { access_token: string; expires_in: number }
    this.cachedTokens.set(tenantId, {
      token: json.access_token,
      expiresAt: now + json.expires_in * 1000,
    })
    return json.access_token
  }

  /**
   * Resolves the App Role GUID for the required app role (e.g. 'MMS.User').
   * Supports explicit configuration via MMS_ENTRA_APP_ROLE_ID, or dynamic
   * lookup against the Service Principal in Microsoft Graph.
   */
  private cachedServicePrincipalId?: string

  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  private async resolveAppRoleId(token: string): Promise<{ roleId?: string; resourceId?: string }> {
    let envRoleId = process.env.MMS_ENTRA_APP_ROLE_ID
    if (envRoleId && this.cachedServicePrincipalId) {
      return { roleId: envRoleId, resourceId: this.cachedServicePrincipalId }
    }
    if (this.cachedAppRoleId && this.cachedServicePrincipalId) {
      return { roleId: this.cachedAppRoleId, resourceId: this.cachedServicePrincipalId }
    }

    let clientId = process.env.MMS_ENTRA_CLIENT_ID
    if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId)) {
      return { roleId: envRoleId }
    }

    try {
      let filter = encodeURIComponent(`appId eq '${clientId}'`)
      let spUrl = `${this.graphBaseUrl}/servicePrincipals?$filter=${filter}&$select=id,appRoles`
      let spRes = await fetchWithGraphRetry(spUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      })
      if (spRes.ok) {
        let spData = (await spRes.json()) as {
          value?: Array<{
            id: string
            appRoles?: Array<{ id: string; value?: string; displayName?: string }>
          }>
        }
        let sp = spData.value?.[0]
        if (sp?.id) this.cachedServicePrincipalId = sp.id
        let role = sp?.appRoles?.find(
          (r) => r.value === this.requiredAppRole || r.displayName === this.requiredAppRole,
        )
        if (role) {
          this.cachedAppRoleId = role.id
        }
        return { roleId: envRoleId ?? this.cachedAppRoleId, resourceId: this.cachedServicePrincipalId }
      }
    } catch {
      // Non-fatal fallback to envRoleId
    }
    return { roleId: envRoleId ?? this.cachedAppRoleId, resourceId: this.cachedServicePrincipalId }
  }

  async getUserStatus(tenantId: string, objectId: string): Promise<EntraUserDirectoryStatus> {
    if (!DefaultEntraDirectoryClient.UUID_RE.test(objectId)) {
      throw new Error(`Invalid Entra objectId format: ${objectId}`)
    }
    let token = await this.getAccessToken(tenantId)
    let encodedObjectId = encodeURIComponent(objectId)
    let userUrl = `${this.graphBaseUrl}/users/${encodedObjectId}?$select=id,accountEnabled,deletedDateTime,userPrincipalName,jobTitle,department,officeLocation`

    let userRes = await fetchWithGraphRetry(userUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })

    if (userRes.status === 404) {
      return {
        exists: false,
        accountEnabled: false,
        hasMmsUserRole: false,
        deleted: true,
      }
    }

    if (!userRes.ok) {
      throw new Error(`Failed to fetch Entra user ${objectId}: HTTP ${userRes.status} ${userRes.statusText}`)
    }

    let userData = (await userRes.json()) as {
      id: string
      accountEnabled?: boolean
      deletedDateTime?: string | null
      userPrincipalName?: string
      jobTitle?: string | null
      department?: string | null
      officeLocation?: string | null
    }

    let isDeleted = Boolean(userData.deletedDateTime)
    let isEnabled = userData.accountEnabled !== false && !isDeleted

    if (!isEnabled || isDeleted) {
      return {
        exists: true,
        accountEnabled: false,
        hasMmsUserRole: false,
        deleted: isDeleted,
        userPrincipalName: userData.userPrincipalName,
        jobTitle: userData.jobTitle ?? undefined,
        department: userData.department ?? undefined,
        officeLocation: userData.officeLocation ?? undefined,
      }
    }

    // Check app role assignments for MMS.User across all @odata.nextLink pages
    let assignments: Array<{ resourceId?: string; appRoleId?: string; resourceDisplayName?: string }> = []
    let expectedGraphOrigin = new URL(this.graphBaseUrl).origin
    let nextUrl: string | undefined = `${this.graphBaseUrl}/users/${encodedObjectId}/appRoleAssignments`
    let pages = 0
    while (nextUrl) {
      if (pages >= 50) {
        throw new Error(`Entra appRoleAssignments exceeded 50 pages for user ${objectId}`)
      }
      if (new URL(nextUrl).origin !== expectedGraphOrigin) {
        throw new Error(`Entra @odata.nextLink origin mismatch for user ${objectId}`)
      }
      pages++
      let rolesRes = await fetchWithGraphRetry(nextUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ConsistencyLevel: 'eventual',
        },
      })

      if (!rolesRes.ok) {
        // API error must not be silently treated as role revocation
        throw new Error(
          `Failed to fetch Entra app role assignments for user ${objectId}: HTTP ${rolesRes.status} ${rolesRes.statusText}`,
        )
      }

      let rolesData = (await rolesRes.json()) as {
        value?: Array<{ resourceId?: string; appRoleId?: string; resourceDisplayName?: string }>
        '@odata.nextLink'?: string
      }
      if (rolesData.value) assignments.push(...rolesData.value)
      nextUrl = rolesData['@odata.nextLink']
    }

    let { roleId: targetRoleId, resourceId: targetResourceId } = await this.resolveAppRoleId(token)

    let hasRole = assignments.some((a) => {
      let resourceMatches = !targetResourceId || !a.resourceId || a.resourceId === targetResourceId
      let roleMatches =
        (Boolean(targetRoleId) && a.appRoleId === targetRoleId) ||
        a.appRoleId === this.requiredAppRole ||
        a.resourceDisplayName === this.requiredAppRole ||
        (process.env.MMS_ENTRA_APP_ROLE_ID && a.appRoleId === process.env.MMS_ENTRA_APP_ROLE_ID)
      return resourceMatches && roleMatches
    })

    return {
      exists: true,
      accountEnabled: isEnabled,
      hasMmsUserRole: hasRole,
      deleted: isDeleted,
      userPrincipalName: userData.userPrincipalName,
      jobTitle: userData.jobTitle ?? undefined,
      department: userData.department ?? undefined,
      officeLocation: userData.officeLocation ?? undefined,
    }
  }
}

let activeDirectoryClient: EntraDirectoryClient | undefined

export function getEntraDirectoryClient(): EntraDirectoryClient {
  if (!activeDirectoryClient) {
    activeDirectoryClient = new DefaultEntraDirectoryClient()
  }
  return activeDirectoryClient
}

export function setEntraDirectoryClient(client: EntraDirectoryClient): void {
  activeDirectoryClient = client
}

export function resetEntraDirectoryClient(): void {
  activeDirectoryClient = undefined
}

export function hasCustomEntraDirectoryClient(): boolean {
  return Boolean(activeDirectoryClient)
}
