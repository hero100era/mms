import { createContextKey, type RequestContext } from 'remix/router'
import type { Session } from 'remix/session'
import type { PgrstClient } from '@mms/pgrst-client'
import { redirect } from 'remix/response/redirect'

import { AuthKey, type SessionAuth } from '../auth/context.ts'
import { PgrstKey } from '../middleware/pgrst.ts'
import { RequestIdKey, ClientIpKey, TraceparentKey } from '../middleware/request-context.ts'
import { routes } from '../routes.ts'
import { actionProblemResponse, isJsonOrProblemRequest } from './errors.ts'

export { AuthKey, PgrstKey, RequestIdKey, ClientIpKey, TraceparentKey }
export type { SessionAuth }

export type ContextKey<T> = ReturnType<typeof createContextKey<T>>

export interface RequestContextLike {
  get?<T>(key: ContextKey<T>): T | undefined
  get?<T = unknown>(key: unknown): T | undefined
  session?: Session
  render?(element: unknown, init?: ResponseInit): Response | Promise<Response>
  params?: Record<string, string | undefined>
  request?: Request
  url?: URL
}

export type AnyRequestContext = RequestContext<any, any> | RequestContextLike

export function getSession(context: AnyRequestContext): Session {
  let ctx = context as RequestContextLike
  let s = ctx.session
  if (!s) {
    throw new Error('Session is not installed in request context')
  }
  return s
}

export function getAuth(context: AnyRequestContext): SessionAuth | null {
  let ctx = context as RequestContextLike
  if (typeof ctx.get === 'function') {
    return ctx.get(AuthKey) ?? null
  }
  return null
}

export function unauthorizedResponse(context: AnyRequestContext, detail = 'Authentication required'): Response {
  let ctx = context as RequestContextLike
  let request = ctx.request
  if (isJsonOrProblemRequest(request)) {
    return actionProblemResponse(context, new Error('Unauthorized'), {
      status: 401,
      title: 'Unauthorized',
      type: 'https://mms.local/problems/unauthorized',
      detail,
      code: 'UNAUTHORIZED',
    })
  }
  let url = ctx.url ?? (request ? new URL(request.url) : null)
  let returnTo = url ? url.pathname + url.search : ''
  let loginHref = routes.session.login.href()
  let redirectUrl =
    returnTo && returnTo !== '/' && returnTo !== loginHref
      ? `${loginHref}?returnTo=${encodeURIComponent(returnTo)}`
      : loginHref
  return redirect(redirectUrl)
}

export function forbiddenResponse(context: AnyRequestContext, detail = 'Insufficient privileges'): Response {
  let ctx = context as RequestContextLike
  let request = ctx.request
  if (isJsonOrProblemRequest(request)) {
    return actionProblemResponse(context, new Error('Forbidden'), {
      status: 403,
      title: 'Forbidden',
      type: 'https://mms.local/problems/forbidden',
      detail,
      code: 'FORBIDDEN',
    })
  }
  let headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  let correlationId = getRequestId(context)
  if (correlationId) {
    headers.set('X-Correlation-Id', correlationId)
    headers.set('X-Request-Id', correlationId)
  }
  return new Response(`Forbidden: ${detail}`, {
    status: 403,
    headers,
  })
}

export function requireAuth(context: AnyRequestContext): SessionAuth {
  let auth = getAuth(context)
  if (!auth) {
    throw unauthorizedResponse(context)
  }
  return auth
}

export function requireRole(context: AnyRequestContext, allowedRoles: readonly string[]): SessionAuth {
  let auth = requireAuth(context)
  if (!allowedRoles.includes(auth.activeRole)) {
    throw forbiddenResponse(context, `Role '${auth.activeRole}' is not authorized`)
  }
  return auth
}

export function getPgrst(context: AnyRequestContext): PgrstClient {
  let ctx = context as RequestContextLike
  let client = typeof ctx.get === 'function' ? ctx.get(PgrstKey) : null
  if (!client) {
    throw new Error('PostgREST client is not installed in request context')
  }
  return client as PgrstClient
}

export function render(
  context: AnyRequestContext,
  element: unknown,
  init?: ResponseInit,
): Response | Promise<Response> {
  let ctx = context as RequestContextLike
  let r = ctx.render
  if (typeof r !== 'function') {
    throw new Error('Render function is not installed in request context')
  }
  return r(element, init)
}

export function getRequestId(context: AnyRequestContext): string | undefined {
  let ctx = context as RequestContextLike
  let fromCtx = typeof ctx?.get === 'function' ? (ctx.get(RequestIdKey) ?? ctx.get('requestId')) : undefined
  if (typeof fromCtx === 'string' && fromCtx.length > 0) return fromCtx
  return ctx?.request?.headers?.get('x-request-id') ?? ctx?.request?.headers?.get('x-correlation-id') ?? undefined
}
