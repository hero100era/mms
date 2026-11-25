import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import { startExternalAuth } from 'remix/auth'
import { handleOAuthCallback } from '../helpers.tsx'
import { actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import { resolveOAuthProvider } from './oauth-helpers.ts'

export default createController(routes.auth, {
  actions: {
    async start(context) {
      let resolved = resolveOAuthProvider(context, 'microsoft')
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      return startExternalAuth(resolved.providerInstance, context, {
        returnTo: context.url.searchParams.get('returnTo'),
      })
    },
    async callback(context) {
      let resolved = resolveOAuthProvider(context, 'microsoft')
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      try {
        return await handleOAuthCallback(context, 'microsoft', resolved.providerInstance)
      } catch (err) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, err, {
            status: 401,
            title: 'Unauthorized',
            detail: 'Sign-in failed',
            code: 'UNAUTHORIZED',
          })
        }
        return new Response('Sign-in failed', { status: 401 })
      }
    },
    async googleStart(context) {
      let resolved = resolveOAuthProvider(context, 'google')
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      return startExternalAuth(resolved.providerInstance, context, {
        returnTo: context.url.searchParams.get('returnTo'),
      })
    },
    async googleCallback(context) {
      let resolved = resolveOAuthProvider(context, 'google')
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      try {
        return await handleOAuthCallback(context, 'google', resolved.providerInstance)
      } catch (err) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, err, {
            status: 401,
            title: 'Unauthorized',
            detail: 'Sign-in failed',
            code: 'UNAUTHORIZED',
          })
        }
        return new Response('Sign-in failed', { status: 401 })
      }
    },
  },
})
