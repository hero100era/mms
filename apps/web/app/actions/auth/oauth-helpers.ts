import { randomUUID } from 'node:crypto'
import type { AnyRequestContext } from '../context.ts'
import { actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import { entraConfigured, entraProvider } from '../../auth/entra.ts'
import { googleConfigured, googleProvider } from '../../auth/google.ts'

export type SupportedOAuthProvider = 'microsoft' | 'google'

export type ResolvedOAuthProvider =
  | { provider: SupportedOAuthProvider; providerInstance: ReturnType<typeof entraProvider> | ReturnType<typeof googleProvider> }
  | { errorResponse: Response }

export interface SetLinkIntentParams {
  provider: SupportedOAuthProvider
  purpose: 'invite' | 'link' | 'step_up'
  inviteToken?: string
  userId?: string
  returnTo?: string
}

export function resolveOAuthProvider(
  context: AnyRequestContext,
  providerName: unknown,
): ResolvedOAuthProvider {
  if (providerName !== 'microsoft' && providerName !== 'google') {
    if (isJsonOrProblemRequest(context.request)) {
      return {
        errorResponse: actionProblemResponse(context, new Error('Invalid provider'), {
          status: 400,
          title: 'Bad Request',
          code: 'BAD_REQUEST',
          detail: 'Invalid provider',
        }),
      }
    }
    return { errorResponse: new Response('Invalid provider', { status: 400 }) }
  }

  if (providerName === 'microsoft' && !entraConfigured()) {
    if (isJsonOrProblemRequest(context.request)) {
      return {
        errorResponse: actionProblemResponse(context, new Error('Microsoft sign-in is not configured'), {
          status: 503,
          title: 'Service Unavailable',
          detail: 'Microsoft sign-in is not configured',
        }),
      }
    }
    return { errorResponse: new Response('Microsoft sign-in is not configured', { status: 503 }) }
  }

  if (providerName === 'google' && !googleConfigured()) {
    if (isJsonOrProblemRequest(context.request)) {
      return {
        errorResponse: actionProblemResponse(context, new Error('Google sign-in is not configured'), {
          status: 503,
          title: 'Service Unavailable',
          detail: 'Google sign-in is not configured',
        }),
      }
    }
    return { errorResponse: new Response('Google sign-in is not configured', { status: 503 }) }
  }

  return {
    provider: providerName,
    providerInstance: providerName === 'microsoft' ? entraProvider() : googleProvider(),
  }
}

export function setLinkIntent(
  session: { id: string; set: (key: string, val: unknown) => void },
  params: SetLinkIntentParams,
): void {
  session.set('linkIntent', {
    id: randomUUID(),
    sessionId: session.id,
    provider: params.provider,
    purpose: params.purpose,
    inviteToken: params.inviteToken,
    userId: params.userId,
    returnTo: params.returnTo,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  })
}
