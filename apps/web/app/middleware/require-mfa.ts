import { redirect } from 'remix/response/redirect'
import { routes } from '../routes.ts'

import { AuthKey, type SessionAuth } from '../auth/context.ts'
import { isMfaPublicPath } from './public-paths.ts'

// H-09: an external user who signed in with a password holds a session that is only
// half-authenticated until the second factor is satisfied. The session exists (so
// the OAuth step-up flow can use it) but no page other than the challenge itself,
// enrolment and sign-in is reachable.
//
// Ordering matters: this middleware sits after `sessionAuth()`, which is where the
// session becomes the `AuthKey` context value, and before `pgrst()`, which mints
// token claims, so a half-authenticated session never receives a PostgREST token.
//
// The allow-list is derived from the route contract (`./public-paths.ts`), so it
// cannot drift into matching a path that is not an actual route. OAuth start/callback
// routes are deliberately NOT reachable for a half-authenticated session: without
// this, completing an OAuth flow would "upgrade" the auth method and silently drop the
// second factor. Unauthenticated users are unaffected — this middleware passes them
// through.

export function requireMfa() {
  return async (context: any, next: () => Promise<Response>) => {
    let auth = context.get(AuthKey) as SessionAuth | null
    if (!auth || auth.kind !== 'external' || auth.authMethod !== 'pwd') return next()
    if (auth.mfaVerifiedAt) return next()
    if (isMfaPublicPath(context.url.pathname)) return next()

    let returnTo = context.url.pathname + context.url.search
    return redirect(`${routes.mfa.challenge.href()}?returnTo=${encodeURIComponent(returnTo)}`)
  }
}
