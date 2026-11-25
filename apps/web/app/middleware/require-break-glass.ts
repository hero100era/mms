import { redirect } from 'remix/response/redirect'
import { routes } from '../routes.ts'

import { AuthKey, isBreakGlassAuth, type SessionAuth } from '../auth/context.ts'
import { breakGlassState } from '../auth/service.ts'
import { isBreakGlassPublicPath } from './public-paths.ts'

// H-10: a break-glass account signs in like anyone else, but it is dormant: it holds
// no `iam.role_assignment`, so PostgREST refuses every call and the only page it can
// reach is the one that asks why. That is deliberate. A gate that its owner cannot
// open is worse than no gate, and a standing administrator whose only protection is a
// password would be an ordinary account wearing an alarming name.
//
// Dormancy is read from the database rather than from the session cookie: a cookie can
// say "I am activated" long after the window closed, and the whole point of the design
// is that the window, not the cookie, is what grants authority.
//
// If the state cannot be read the account is treated as dormant: the failure mode of
// this gate is "no access until sign-in is proven", never "unverified access".

export function requireBreakGlass() {
  return async (context: any, next: () => Promise<Response>) => {
    let auth = context.get(AuthKey) as SessionAuth | null
    if (!isBreakGlassAuth(auth)) return next()

    let state = await breakGlassState(auth!.userId).catch(() => null)
    // No row, or the window closed: dormant. Only the allow-list is reachable.
    if (!state || state.dormant) {
      if (isBreakGlassPublicPath(context.url.pathname)) return next()
      return redirect(routes.breakGlass.index.href())
    }
    return next()
  }
}
