// Centralised lossy error mapping for user-facing responses (R3.4, R4.2).
//
// The database raises errors whose messages can carry schema names, function
// names and parameter values. Echoing them into an HTTP response discloses
// internals to unauthenticated callers, so controllers must never interpolate
// `err.message` into a response body. Details are logged server-side instead.
//
// Conforms to RFC 9457 Problem Details for HTTP APIs (application/problem+json).

import type { AnyRequestContext } from './context.ts'
import { getRequestId } from './context.ts'
import { ValidationError } from './validation.ts'

export type DomainErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'LOCKED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'

export interface DomainErrorMetadata {
  status: number
  title: string
  type: string
}

export const DOMAIN_ERROR_METADATA: Record<DomainErrorCode, DomainErrorMetadata> = {
  BAD_REQUEST: {
    status: 400,
    title: 'Bad Request',
    type: 'https://mms.local/problems/bad-request',
  },
  VALIDATION_FAILED: {
    status: 422,
    title: 'Validation Failed',
    type: 'https://mms.local/problems/validation-failed',
  },
  UNAUTHORIZED: {
    status: 401,
    title: 'Unauthorized',
    type: 'https://mms.local/problems/unauthorized',
  },
  FORBIDDEN: {
    status: 403,
    title: 'Forbidden',
    type: 'https://mms.local/problems/forbidden',
  },
  NOT_FOUND: {
    status: 404,
    title: 'Not Found',
    type: 'https://mms.local/problems/not-found',
  },
  CONFLICT: {
    status: 409,
    title: 'Conflict',
    type: 'https://mms.local/problems/conflict',
  },
  LOCKED: {
    status: 423,
    title: 'Resource Locked',
    type: 'https://mms.local/problems/locked',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Payload Too Large',
    type: 'https://mms.local/problems/payload-too-large',
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Internal Server Error',
    type: 'https://mms.local/problems/internal-error',
  },
}

export const SQLSTATE_TO_DOMAIN_CODE: Record<string, DomainErrorCode> = {
  // Authorization / authentication
  '42501': 'FORBIDDEN',
  PT401: 'UNAUTHORIZED',
  PT403: 'FORBIDDEN',
  // Not found
  PGRST116: 'NOT_FOUND',
  P0002: 'NOT_FOUND',
  '42883': 'NOT_FOUND',
  '42P01': 'NOT_FOUND',
  // Conflicts / constraints
  '23505': 'CONFLICT',
  '55P03': 'CONFLICT',
  // Validation / invalid parameters
  '23514': 'VALIDATION_FAILED',
  '23502': 'VALIDATION_FAILED',
  '23503': 'VALIDATION_FAILED',
  '22023': 'VALIDATION_FAILED',
  '22000': 'VALIDATION_FAILED',
  '22P02': 'VALIDATION_FAILED',
}

/** Maps any error to a stable domain error code. */
export function toDomainErrorCode(error: unknown): DomainErrorCode {
  if (error instanceof ValidationError) return 'VALIDATION_FAILED'

  let err = error as { status?: number; code?: string; name?: string; message?: string } | null | undefined
  let msg = typeof err?.message === 'string' ? err.message.toLowerCase() : ''
  if (msg.includes('not_found') || msg.includes('not found')) return 'NOT_FOUND'
  if (msg.includes('unauthenticated') || msg === 'unauthorized') return 'UNAUTHORIZED'
  if (
    msg.includes('forbidden') ||
    msg.includes('insufficient_privilege') ||
    msg.includes('permission denied') ||
    msg.includes('creator_cannot_approve') ||
    msg.includes('cannot_confirm_own_proposal') ||
    msg.includes('cannot_grant_self') ||
    msg.includes('cannot_revoke_self') ||
    msg.includes('break_glass_forbidden') ||
    msg.includes('sysadmin_cannot_approve') ||
    msg.includes('in_scope')
  ) {
    return 'FORBIDDEN'
  }
  if (msg.includes('duplicate')) return 'CONFLICT'
  if (msg.includes('payload too large') || msg.includes('exceeds')) return 'PAYLOAD_TOO_LARGE'

  if (err?.status === 400) return 'BAD_REQUEST'
  if (err?.status === 401 || err?.name === 'UnauthorizedError') return 'UNAUTHORIZED'
  if (err?.status === 403 || err?.name === 'ForbiddenError') return 'FORBIDDEN'
  if (err?.status === 404) return 'NOT_FOUND'
  if (err?.status === 409) return 'CONFLICT'
  if (err?.status === 413) return 'PAYLOAD_TOO_LARGE'
  if (err?.status === 422) return 'VALIDATION_FAILED'
  if (err?.status === 423) return 'LOCKED'

  if (typeof err?.code === 'string' && SQLSTATE_TO_DOMAIN_CODE[err.code]) {
    return SQLSTATE_TO_DOMAIN_CODE[err.code]!
  }

  // Coarse fallback on Error names if code is absent
  let name = err?.name ?? ''
  if (name === 'UnauthorizedError') return 'UNAUTHORIZED'
  if (name === 'ForbiddenError') return 'FORBIDDEN'

  return 'INTERNAL_ERROR'
}

/** Converts an HTTP status code to a domain error code when available. */
export function statusToDomainCode(status: number): DomainErrorCode | undefined {
  switch (status) {
    case 400:
      return 'BAD_REQUEST'
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 409:
      return 'CONFLICT'
    case 413:
      return 'PAYLOAD_TOO_LARGE'
    case 422:
      return 'VALIDATION_FAILED'
    case 423:
      return 'LOCKED'
    case 500:
      return 'INTERNAL_ERROR'
    default:
      return undefined
  }
}

/** Converts a domain error code to an HTTP status code. */
export function domainCodeToStatus(code: DomainErrorCode): number {
  return DOMAIN_ERROR_METADATA[code]?.status ?? 500
}

/** Maps an unknown failure to a safe, generic user-facing message. */
export function safeActionError(error: unknown, fallback: string): string {
  let detail =
    error instanceof Error
      ? { name: error.name, message: error.message, code: (error as any).code }
      : { value: String(error) }

  console.error('action failed:', detail)
  return fallback
}

/** RFC 9457 Problem Details object shape */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail: string
  code: DomainErrorCode
  instance?: string
  correlationId?: string
  requestId?: string
  errors?: Record<string, string>
  [key: string]: unknown
}

export interface ProblemDetailsOptions {
  detail?: string
  fallbackMessage?: string
  title?: string
  type?: string
  status?: number
  code?: DomainErrorCode
  instance?: string
  correlationId?: string
  extra?: Record<string, unknown>
}

export {
  type AllowlistedMessageEntry,
  EXACT_MESSAGE_ALLOWLIST,
} from './error-allowlist.ts'
import { EXACT_MESSAGE_ALLOWLIST } from './error-allowlist.ts'

/**
 * Builds an RFC 9457 compliant Problem Details object from any error.
 */
export function toProblemDetails(
  error: unknown,
  options?: ProblemDetailsOptions,
): ProblemDetails {
  if (error instanceof ValidationError) {
    let meta = DOMAIN_ERROR_METADATA.VALIDATION_FAILED
    let correlationId = options?.correlationId
    let fieldErrors = error.fields ?? (error as any).errors ?? {}
    return {
      type: options?.type ?? meta.type,
      title: options?.title ?? meta.title,
      status: options?.status ?? meta.status,
      detail: options?.detail ?? options?.fallbackMessage ?? 'The submitted data failed validation.',
      code: 'VALIDATION_FAILED',
      instance: options?.instance,
      correlationId,
      requestId: correlationId,
      errors: fieldErrors,
      fields: fieldErrors,
      error: 'validation_failed',
      ...(options?.extra ?? {}),
    }
  }

  let domainCode =
    options?.code ??
    (options?.status ? statusToDomainCode(options.status) : undefined) ??
    toDomainErrorCode(error)
  let meta = DOMAIN_ERROR_METADATA[domainCode] ?? DOMAIN_ERROR_METADATA.INTERNAL_ERROR
  let err = error as { message?: string } | null | undefined
  let rawMsg = typeof err?.message === 'string' ? err.message.trim() : undefined
  let allowlisted = rawMsg && EXACT_MESSAGE_ALLOWLIST[rawMsg]
    ? EXACT_MESSAGE_ALLOWLIST[rawMsg].publicMessage
    : undefined

  let detail = options?.detail ?? options?.fallbackMessage ?? allowlisted ?? meta.title
  let correlationId = options?.correlationId

  return {
    type: options?.type ?? meta.type,
    title: options?.title ?? meta.title,
    status: options?.status ?? meta.status,
    detail,
    code: domainCode,
    instance: options?.instance,
    correlationId,
    requestId: correlationId,
    error: (options?.extra?.error as string) ?? domainCode.toLowerCase(),
    ...(options?.extra ?? {}),
  }
}

/**
 * Returns an HTTP response with Content-Type: application/problem+json conforming to RFC 9457.
 */
export function problemResponse(
  error: unknown,
  options?: ProblemDetailsOptions & { headers?: HeadersInit },
): Response {
  let problem = toProblemDetails(error, options)
  let correlationId = options?.correlationId ?? problem.correlationId

  let headers = new Headers(options?.headers)
  headers.set('Content-Type', 'application/problem+json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  if (correlationId) {
    headers.set('X-Correlation-Id', correlationId)
    headers.set('X-Request-Id', correlationId)
  }

  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  })
}

/** Returns a standard RFC 9457 Problem Details Response with the appropriate status code. */
export function actionErrorToResponse(
  error: unknown,
  fallbackMessage: string,
  correlationId?: string,
): Response {
  let domainCode = toDomainErrorCode(error)
  let status = domainCodeToStatus(domainCode)

  console.error('action error:', {
    domainCode,
    status,
    correlationId: correlationId ?? 'none',
    errorType: error instanceof Error ? error.name : typeof error,
  })

  return problemResponse(error, {
    fallbackMessage,
    detail: fallbackMessage,
    correlationId,
    status,
  })
}

/**
 * Convenience helper to return an RFC 9457 Problem Details response automatically
 * drawing the correlation ID from the active RequestContext.
 */
export function actionProblemResponse(
  context: AnyRequestContext,
  error: unknown,
  options?: ProblemDetailsOptions & { headers?: HeadersInit },
): Response {
  let correlationId = options?.correlationId ?? getRequestId(context)
  let instance = options?.instance ?? (context as any)?.request?.url
  return problemResponse(error, {
    correlationId,
    instance,
    ...options,
  })
}

/** Determines whether a request prefers or accepts JSON / Problem Details. */
export function isJsonOrProblemRequest(request?: Request | null): boolean {
  if (!request) return false
  let accept = request.headers.get('accept') ?? ''
  let contentType = request.headers.get('content-type') ?? ''
  return (
    accept.includes('application/problem+json') ||
    accept.includes('application/json') ||
    contentType.includes('application/json')
  )
}

/** Coarse classification used to choose an HTTP status without string matching. */
export type ActionErrorKind = 'conflict' | 'privilege' | 'not_found' | 'bad_request' | 'unknown'

/**
 * Classify a failure from the PostgREST client / gateway for status selection.
 * Derived directly from toDomainErrorCode to eliminate duplicate string/SQLSTATE tables.
 */
export function classifyActionError(error: unknown): ActionErrorKind {
  let domainCode = toDomainErrorCode(error)
  switch (domainCode) {
    case 'VALIDATION_FAILED':
    case 'BAD_REQUEST':
      return 'bad_request'
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 'privilege'
    case 'NOT_FOUND':
      return 'not_found'
    case 'CONFLICT':
      return 'conflict'
    default:
      return 'unknown'
  }
}
