/**
 * tests/acceptance/harness/client.ts
 *
 * Opaque-box HTTP test client (AcceptanceClient) for MMS Acceptance Test Suite.
 * Exercises the MMS web application exclusively via standard HTTP contracts:
 * - Cookie jar management (tracking and persisting __mms_sid across requests)
 * - Automatic CSRF extraction from HTML responses and automatic injection in forms
 * - Content-Type negotiation (text/html vs application/json vs application/problem+json)
 * - Persona authentication via /dev/login (customer.a, surveyor.shanghai, manager.shanghai, etc.)
 */

export interface CookieJarEntry {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: Date
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export class CookieJar {
  private cookies = new Map<string, CookieJarEntry>()

  constructor(initialCookies?: Record<string, string>) {
    if (initialCookies) {
      for (const [name, value] of Object.entries(initialCookies)) {
        this.set(name, value)
      }
    }
  }

  /** Parses Set-Cookie response header(s) and records cookies in the jar. */
  parseSetCookie(headers: string | string[] | null | undefined): void {
    if (!headers) return
    const rawHeaders = Array.isArray(headers) ? headers : [headers]

    for (const raw of rawHeaders) {
      if (!raw) continue
      // Each set-cookie header contains: name=value; attr1=val1; attr2...
      const parts = raw.split(';').map((p) => p.trim())
      const [first, ...attrs] = parts
      if (!first) continue

      const eqIdx = first.indexOf('=')
      if (eqIdx === -1) continue

      const name = first.slice(0, eqIdx).trim()
      const value = first.slice(eqIdx + 1).trim()
      if (!name) continue

      const entry: CookieJarEntry = { name, value }

      for (const attr of attrs) {
        const [k, v] = attr.split('=').map((s) => s.trim())
        const lowerKey = k?.toLowerCase()
        if (lowerKey === 'path') entry.path = v
        else if (lowerKey === 'domain') entry.domain = v
        else if (lowerKey === 'expires' && v) entry.expires = new Date(v)
        else if (lowerKey === 'httponly') entry.httpOnly = true
        else if (lowerKey === 'secure') entry.secure = true
        else if (lowerKey === 'samesite') entry.sameSite = v
      }

      this.cookies.set(name, entry)
    }
  }

  /** Returns formatted "key=val; key2=val2" string for the Cookie request header. */
  getCookieHeader(): string {
    const pairs: string[] = []
    const now = new Date()

    for (const [name, entry] of this.cookies.entries()) {
      if (entry.expires && entry.expires < now) {
        this.cookies.delete(name)
        continue
      }
      pairs.push(`${name}=${entry.value}`)
    }

    return pairs.join('; ')
  }

  get(name: string): string | undefined {
    const entry = this.cookies.get(name)
    if (!entry) return undefined
    if (entry.expires && entry.expires < new Date()) {
      this.cookies.delete(name)
      return undefined
    }
    return entry.value
  }

  set(name: string, value: string, attributes?: Partial<CookieJarEntry>): void {
    this.cookies.set(name, {
      name,
      value,
      ...attributes,
    })
  }

  delete(name: string): void {
    this.cookies.delete(name)
  }

  clear(): void {
    this.cookies.clear()
  }

  getAll(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [name, entry] of this.cookies.entries()) {
      result[name] = entry.value
    }
    return result
  }

  clone(): CookieJar {
    const next = new CookieJar()
    for (const [name, entry] of this.cookies.entries()) {
      next.cookies.set(name, { ...entry })
    }
    return next
  }
}

/** Extracts CSRF token from HTML text. */
export function extractCsrfToken(html: string): string | undefined {
  if (!html) return undefined

  // 1. Standard hidden input: name="_csrf" value="..."
  const nameValueMatch = html.match(/<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/i)
  if (nameValueMatch?.[1]) return nameValueMatch[1]

  // 2. Reversed order: value="..." name="_csrf"
  const valueNameMatch = html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i)
  if (valueNameMatch?.[1]) return valueNameMatch[1]

  // 3. Meta tag: <meta name="csrf-token" content="...">
  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
  if (metaMatch?.[1]) return metaMatch[1]

  return undefined
}

export type AcceptType = 'html' | 'json' | 'problem'

export interface AcceptanceClientOptions {
  baseUrl?: string
  cookieJar?: CookieJar
  csrfToken?: string
  personaKey?: string
  defaultHeaders?: Record<string, string>
  followRedirects?: boolean
}

export interface AcceptanceRequestInit extends RequestInit {
  accept?: AcceptType | string
  skipCsrfExtraction?: boolean
}

export class AcceptanceClient {
  readonly baseUrl: string
  readonly cookieJar: CookieJar
  csrfToken?: string
  personaKey?: string
  readonly defaultHeaders: Record<string, string>
  readonly followRedirects: boolean

  constructor(options?: AcceptanceClientOptions) {
    this.baseUrl = (options?.baseUrl ?? process.env.APPLICATION_BASE_URL ?? 'http://localhost:44100').replace(/\/+$/, '')
    this.cookieJar = options?.cookieJar ?? new CookieJar()
    this.csrfToken = options?.csrfToken
    this.personaKey = options?.personaKey
    this.defaultHeaders = {
      'x-forwarded-for': '203.0.113.199',
      ...(options?.defaultHeaders ?? {}),
    }
    this.followRedirects = options?.followRedirects ?? false
  }

  get sessionId(): string | undefined {
    return this.cookieJar.get('__mms_sid')
  }

  /** Resolves relative or absolute path against baseUrl. */
  resolveUrl(pathOrUrl: string): string {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return pathOrUrl
    }
    const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
    return `${this.baseUrl}${cleanPath}`
  }

  /** Core dispatch method executing an opaque HTTP request. */
  async request(pathOrUrl: string, init?: AcceptanceRequestInit): Promise<Response> {
    const url = this.resolveUrl(pathOrUrl)
    const headers = new Headers(init?.headers ?? {})

    // Set default headers if missing
    for (const [k, v] of Object.entries(this.defaultHeaders)) {
      if (!headers.has(k)) {
        headers.set(k, v)
      }
    }

    // Attach Cookie header from cookie jar
    const cookieHeader = this.cookieJar.getCookieHeader()
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader)
    }

    // Apply Accept negotiation shorthand
    if (init?.accept) {
      if (init.accept === 'html') {
        headers.set('Accept', 'text/html, application/xhtml+xml, */*')
      } else if (init.accept === 'json') {
        headers.set('Accept', 'application/json')
      } else if (init.accept === 'problem') {
        headers.set('Accept', 'application/problem+json')
      } else {
        headers.set('Accept', init.accept)
      }
    }

    const redirectMode: RequestRedirect = init?.redirect ?? (this.followRedirects ? 'follow' : 'manual')

    const response = await fetch(url, {
      ...init,
      headers,
      redirect: redirectMode,
    })

    // Extract set-cookie headers
    // Node.js Headers provides getSetCookie() returning string[]
    const getSetCookieFn = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
    let setCookieList: string[] = []
    if (typeof getSetCookieFn === 'function') {
      setCookieList = getSetCookieFn.call(response.headers)
    } else {
      const single = response.headers.get('set-cookie')
      if (single) setCookieList = [single]
    }
    if (setCookieList.length > 0) {
      this.cookieJar.parseSetCookie(setCookieList)
    }

    // Parse CSRF token from HTML responses unless skipped
    if (!init?.skipCsrfExtraction) {
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/html')) {
        try {
          const cloned = response.clone()
          const html = await cloned.text()
          const token = extractCsrfToken(html)
          if (token) {
            this.csrfToken = token
          }
        } catch {
          // Ignore stream consumption error on non-readable body
        }
      }
    }

    return response
  }

  async get(path: string, options?: AcceptanceRequestInit): Promise<Response> {
    return this.request(path, { ...options, method: 'GET' })
  }

  async post(path: string, body?: BodyInit | null, options?: AcceptanceRequestInit): Promise<Response> {
    return this.request(path, { ...options, method: 'POST', body })
  }

  async put(path: string, body?: BodyInit | null, options?: AcceptanceRequestInit): Promise<Response> {
    return this.request(path, { ...options, method: 'PUT', body })
  }

  async patch(path: string, body?: BodyInit | null, options?: AcceptanceRequestInit): Promise<Response> {
    return this.request(path, { ...options, method: 'PATCH', body })
  }

  async delete(path: string, options?: AcceptanceRequestInit): Promise<Response> {
    return this.request(path, { ...options, method: 'DELETE' })
  }

  /**
   * Posts form data with automatic CSRF injection and Content-Type: application/x-www-form-urlencoded
   * (or multipart/form-data when FormData with files is supplied).
   */
  async postForm(
    path: string,
    fields: Record<string, unknown> | URLSearchParams | FormData,
    options?: AcceptanceRequestInit,
  ): Promise<Response> {
    const headers = new Headers(options?.headers)
    let body: BodyInit

    if (fields instanceof FormData) {
      // If _csrf is missing and we have a cached csrfToken, add it
      if (this.csrfToken && !fields.has('_csrf')) {
        fields.append('_csrf', this.csrfToken)
      }
      body = fields
    } else if (fields instanceof URLSearchParams) {
      if (this.csrfToken && !fields.has('_csrf')) {
        fields.append('_csrf', this.csrfToken)
      }
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded')
      }
      body = fields.toString()
    } else {
      const params = new URLSearchParams()
      if (this.csrfToken && !('_csrf' in fields)) {
        params.append('_csrf', this.csrfToken)
      }
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) {
          params.append(k, String(v))
        }
      }
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded')
      }
      body = params.toString()
    }

    return this.request(path, {
      ...options,
      method: 'POST',
      headers,
      body,
    })
  }

  /** Posts JSON payload with automatic Content-Type and optional X-CSRF-Token header. */
  async postJson(path: string, data: unknown, options?: AcceptanceRequestInit): Promise<Response> {
    const headers = new Headers(options?.headers)
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    if (this.csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', this.csrfToken)
    }

    return this.request(path, {
      ...options,
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    })
  }

  /**
   * Establishes an authenticated session for a dev persona using the real /dev/login flow.
   *
   * Supported personas:
   * - customer.a, customer.b
   * - surveyor.shanghai, auditor.shanghai, manager.shanghai, surveyor.singapore
   * - coordinator.asia, mts.asia, planapproval.central
   * - compliance.ho, hr.test, finance.test, sysadmin.test
   * - surveyor.expired, breakglass.test
   */
  async loginAs(personaKey: string): Promise<this> {
    // 1. Fetch CSRF token from /dev/login
    const getRes = await this.get('/dev/login', { accept: 'html' })
    if (getRes.status !== 200) {
      throw new Error(
        `Failed to GET /dev/login (status ${getRes.status}): verify ALLOW_DEV_LOGIN=true and APP_ENV in {local, test}`,
      )
    }

    const html = await getRes.text()
    const csrf = extractCsrfToken(html) ?? this.csrfToken
    if (!csrf) {
      throw new Error('CSRF token not found in /dev/login response')
    }
    this.csrfToken = csrf

    // 2. Submit dev login
    const postRes = await this.postForm('/dev/login', {
      _csrf: csrf,
      personaKey,
    })

    // Expect 302 Redirect to /profile (or 200)
    if (postRes.status !== 302 && postRes.status !== 200) {
      const errBody = await postRes.text().catch(() => '')
      throw new Error(`Failed to login as persona '${personaKey}': HTTP ${postRes.status}. Body: ${errBody.slice(0, 300)}`)
    }

    this.personaKey = personaKey

    // 3. Follow redirect or fetch /profile to refresh CSRF token for subsequent action POSTs
    const profileRes = await this.get('/profile', { accept: 'html' })
    if (profileRes.status === 200) {
      const profileHtml = await profileRes.text()
      const nextCsrf = extractCsrfToken(profileHtml)
      if (nextCsrf) {
        this.csrfToken = nextCsrf
      }
    }

    return this
  }

  /** Clones this client instance with an independent copy of its cookie jar and CSRF state. */
  clone(): AcceptanceClient {
    return new AcceptanceClient({
      baseUrl: this.baseUrl,
      cookieJar: this.cookieJar.clone(),
      csrfToken: this.csrfToken,
      personaKey: this.personaKey,
      defaultHeaders: { ...this.defaultHeaders },
      followRedirects: this.followRedirects,
    })
  }
}

/** Creates a fresh AcceptanceClient. */
export function createAcceptanceClient(options?: AcceptanceClientOptions): AcceptanceClient {
  return new AcceptanceClient(options)
}

/** Creates an unauthenticated AcceptanceClient. */
export function createAnonymousClient(options?: AcceptanceClientOptions): AcceptanceClient {
  return new AcceptanceClient(options)
}

/** Creates an AcceptanceClient logged in as the specified persona. */
export async function createPersonaClient(
  personaKey: string,
  options?: AcceptanceClientOptions,
): Promise<AcceptanceClient> {
  const client = new AcceptanceClient(options)
  await client.loginAs(personaKey)
  return client
}
