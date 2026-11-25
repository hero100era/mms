import {
  ForbiddenError,
  PgrstError,
  type PgrstErrorBody,
  UnauthorizedError,
} from './errors.ts'
import type { ApiViews } from './types/views.ts'
import type { ApiRpcs } from './types/rpcs.ts'

export type PgrstClientOptions = {
  baseUrl: string
  token: string
  requestId?: string
  traceparent?: string
  clientIp?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export type PgrstRequestOptions = {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  idempotencyKey?: string
  signal?: AbortSignal
}

export class PgrstClient {
  readonly baseUrl: string
  readonly token: string
  readonly requestId: string | undefined
  readonly traceparent: string | undefined
  readonly clientIp: string | undefined
  readonly fetch: typeof fetch
  readonly timeoutMs: number

  constructor(options: PgrstClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.requestId = options.requestId
    this.traceparent = options.traceparent
    this.clientIp = options.clientIp
    this.fetch = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    let headers: Record<string, string> = {}
    if (extra) {
      for (let [k, v] of Object.entries(extra)) {
        let lower = k.toLowerCase()
        if (lower === 'authorization' || lower === 'x-request-id' || lower === 'traceparent' || lower === 'x-client-ip') {
          continue
        }
        headers[k] = v
      }
    }
    headers['Authorization'] = `Bearer ${this.token}`
    if (this.requestId) headers['X-Request-Id'] = this.requestId
    if (this.traceparent) headers['traceparent'] = this.traceparent
    if (this.clientIp) headers['X-Client-Ip'] = this.clientIp
    return headers
  }

  async request<T = unknown>(path: string, options: PgrstRequestOptions = {}): Promise<T> {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith('//')) {
      throw new Error(`PgrstClient.request rejects absolute URLs: ${path}`)
    }
    let url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
    let headers = this.headers(options.headers)

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey
    }

    let init: RequestInit = {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    let res = await this.fetch(url, init)

    if (!res.ok) {
      let body: PgrstErrorBody = {}
      try {
        let text = await res.text()
        try {
          body = JSON.parse(text) as PgrstErrorBody
        } catch {
          body = { message: text || res.statusText }
        }
      } catch {
        body = { message: res.statusText }
      }
      if (res.status === 401) throw new UnauthorizedError(body)
      if (res.status === 403) throw new ForbiddenError(body)
      throw new PgrstError(res.status, body)
    }

    if (res.status === 204) return undefined as T
    let text = await res.text()
    if (!text || text.trim() === '') return undefined as T
    return JSON.parse(text) as T
  }

  select<V extends keyof ApiViews>(
    view: V,
    params?: Record<string, string>,
    options?: PgrstRequestOptions,
  ): Promise<ApiViews[V][]>
  select<T = unknown>(
    view: string,
    params?: Record<string, string>,
    options?: PgrstRequestOptions,
  ): Promise<T[]>
  select<T = unknown>(
    view: string,
    params?: Record<string, string>,
    options: PgrstRequestOptions = {},
  ): Promise<T[]> {
    let qs = ''
    if (params && Object.keys(params).length > 0) {
      let sp = new URLSearchParams()
      for (let [k, v] of Object.entries(params)) {
        sp.set(k, v)
      }
      qs = `?${sp.toString()}`
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(view)) {
      throw new Error(`Invalid PostgREST view identifier: ${view}`)
    }
    return this.request<T[]>(`/${view}${qs}`, { ...options, method: 'GET' })
  }

  rpc<R extends keyof ApiRpcs>(
    fn: R,
    args: ApiRpcs[R]['args'],
    options?: PgrstRequestOptions,
  ): Promise<ApiRpcs[R]['result']>
  rpc<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
    options?: PgrstRequestOptions,
  ): Promise<T>
  rpc<T = unknown>(
    fn: string,
    args: Record<string, unknown> = {},
    options: PgrstRequestOptions = {},
  ): Promise<T> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fn)) {
      throw new Error(`Invalid PostgREST RPC identifier: ${fn}`)
    }
    return this.request<T>(`/rpc/${fn}`, {
      ...options,
      method: 'POST',
      body: args,
    })
  }
}
