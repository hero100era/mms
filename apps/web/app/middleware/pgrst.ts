import { PgrstClient } from '@mms/pgrst-client'
import { createContextKey } from 'remix/router'

import { AuthKey, isBreakGlassAuth, type SessionAuth } from '../auth/context.ts'
import { breakGlassClaims } from '../auth/service.ts'
import { signAccessToken } from '../auth/token-signer.ts'
import { ClientIpKey, RequestIdKey, TraceparentKey } from './request-context.ts'

export let PgrstKey = createContextKey<PgrstClient>()

export function pgrst() {
  return async (context: any, next: () => Promise<Response>) => {
    let auth = context.get(AuthKey) as SessionAuth | null
    if (auth) {
      // H-10: a break-glass session carries `src` and the end of its window, so the
      // audit trail attributes every act to the activation and PostgREST can name the
      // moment access ends even before the assignment row is revoked.
      let window = isBreakGlassAuth(auth) ? await breakGlassClaims(auth.userId) : null
      let base = {
        userId: auth.userId,
        role: auth.activeRole,
        sessionId: context.session.id,
        authMethod: auth.authMethod,
      }
      let { token } = window
        ? signAccessToken({ ...base, source: window.src, breakGlassUntil: window.bg })
        : signAccessToken(base)
      context.set(
        PgrstKey,
        new PgrstClient({
          baseUrl: process.env.MMS_PGRST_URL ?? 'http://127.0.0.1:3001',
          token,
          requestId: context.get(RequestIdKey) ?? context.get('requestId'),
          traceparent: context.get(TraceparentKey) ?? context.get('traceparent'),
          clientIp: context.get(ClientIpKey) ?? context.get('clientIp'),
        }),
      )
    }
    return next()
  }
}
