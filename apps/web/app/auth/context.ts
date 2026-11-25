import { createContextKey } from 'remix/router'

export type SessionAuth = {
  userId: string
  kind: 'internal' | 'external'
  email?: string
  activeRole: string
  authMethod: 'entra' | 'microsoft' | 'google' | 'pwd'
  authTime: string
  stepUpAt?: string
  mfaVerifiedAt?: string
  linkIntent?: unknown
  oauthTxn?: unknown
  assignableRoles?: string[]
  clientIp?: string | null
  userAgent?: string | null

  /** H-10: this identity is a break-glass account, so dormancy is enforced per request. */
  breakGlass?: boolean
}

export let AuthKey = createContextKey<SessionAuth | null>()

/** The single predicate for "this session is a break-glass (emergency) identity".
 *  Every gate must agree on this, so it is not spelled out per middleware or controller. */
export function isBreakGlassAuth(auth: SessionAuth | null | undefined): boolean {
  return Boolean(auth && auth.kind === 'internal' && auth.breakGlass === true)
}

/** Matches the actions' five divergent `['a','b'].includes(auth.activeRole)` spellings. */
export function hasRole(auth: SessionAuth, ...roles: string[]): boolean {
  return roles.includes(auth.activeRole)
}
