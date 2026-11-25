import { createMatcher } from 'remix/route-pattern/match'

import { routes } from './routes.ts'

// Card S-03 / H-05: the quarantine upload is the only route served without a CSRF token.
// The browser PUTs the bytes straight to object storage through a short-lived write-only
// SAS, so there is no form, no same-origin page, and no session to bind a token to -- the
// SAS itself, issued to a specific upload id and expiring in minutes, is the authorisation.
//
// The exemption therefore has to name *that route*, from the route contract, rather than
// describe the URL with a string of its own. A hand-written prefix would silently disagree
// with `routes.ts` the first time the path moves, and it can fail open: if the
// prefix stopped matching, CSRF would start enforcing here (loud) -- but the reverse
// mistake, a prefix that stays true for a route that no longer needs the exemption, and
// would quietly widen it. One matcher, built from the declared pattern, cannot drift from it.
const quarantineUploadMatcher = createMatcher(routes.uploads.quarantine.pattern.source)

/**
 * True only for the declared quarantine upload route, with its declared method.
 *
 * The pattern alone is not quite the whole story: a GET to the same URL is not the SAS
 * upload and must still be CSRF-checked like any other mutating request (safe methods are
 * handled by the middleware itself, so an exact method check here keeps this predicate
 * from becoming a second, divergent set of safe-method rules).
 */
export function isQuarantineUpload(url: URL, method: string): boolean {
  if (method.toUpperCase() !== routes.uploads.quarantine.method) return false
  return quarantineUploadMatcher.match(url) !== null
}
