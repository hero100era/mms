import { authCall, authQuery } from './gateway-client.ts'

export type ResolvedEntra = {
  user_id: string
  status: string
  assignable_roles: string[]
  /** H-10: this identity is a break-glass account, so it is dormant until activated. */
  break_glass?: boolean
}

export function userRoles(userId: string): Promise<string[]> {
  return authCall<string[]>('auth.user_roles', [userId])
}

export function resolveEntra(args: unknown[]): Promise<ResolvedEntra> {
  return authCall<ResolvedEntra>('auth.resolve_entra', args)
}

export function setSessionRole(sessionId: string, role: string): Promise<void> {
  return authCall<void>('auth.session_set_role', [sessionId, role])
}

/**
 * H-10: the token claims for an active break-glass window, or null. Only the database
 * can say a window is open, so the BFF asks rather than trusting the session cookie.
 */
export function breakGlassClaims(
  userId: string,
): Promise<{ src: string; bg: number } | null> {
  return authCall<{ src: string; bg: number } | null>('auth.break_glass_claims', [userId])
}

export type PasswordLookup = {
  user_id?: string
  hash?: string
  status: 'unknown' | 'invited' | 'active' | 'suspended'
}

export function passwordLookup(loginName: string): Promise<PasswordLookup> {
  return authCall<PasswordLookup>('auth.password_lookup', [loginName])
}

export function isThrottled(loginName: string, ip: string): Promise<boolean> {
  return authCall<boolean>('auth.is_throttled', [loginName, ip])
}

export function recordAttempt(
  loginName: string,
  ip: string,
  outcome: string,
  reason?: string,
): Promise<void> {
  return authCall<void>('auth.record_attempt', [loginName, ip, outcome, reason ?? null])
}

// --- Dedicated Step-Up Throttle Namespace (P0.4) ---
export {
  STEP_UP_MAX_ATTEMPTS,
  STEP_UP_WINDOW_MS,
  MAX_BUCKETS,
  isStepUpThrottled,
  getStepUpRetryAfter,
  recordStepUpAttempt,
  clearStepUpThrottle,
} from './step-up-throttle.ts'
export type { StepUpAttemptRecord } from './step-up-throttle.ts'

export function setPassword(credential: string, hash: string): Promise<{ user_id: string; email?: string }> {
  return authCall<{ user_id: string; email?: string }>('auth.set_password', [credential, hash])
}

export type CreatedSession = {
  session_id: string
  user_id: string
  user_kind: string
  active_role: string
  idle_expires_at: string
  expires_at: string
}

export function sessionCreate(
  userId: string,
  method: string,
  activeRole: string,
  ip: string,
  userAgent: string,
  id?: string,
): Promise<CreatedSession> {
  return authCall<CreatedSession>('auth.session_create', [
    userId,
    method,
    activeRole,
    ip,
    userAgent,
    id ?? null,
  ])
}

export type LinkedIdentity = {
  id: string
  provider: string
  issuer: string
  email_at_link: string | null
  linked_at: string
}

export function resolveExternal(
  provider: string,
  issuer: string,
  subject: string,
): Promise<{ status: 'linked'; user_id: string } | { status: 'not_linked' }> {
  return authCall<{ status: 'linked'; user_id: string } | { status: 'not_linked' }>(
    'auth.resolve_external',
    [provider, issuer, subject],
  )
}

export function linkIdentity(
  sessionId: string,
  provider: string,
  issuer: string,
  subject: string,
  email?: string | null,
  tenantId?: string | null,
  objectId?: string | null,
): Promise<void> {
  return authCall<void>('auth.link_identity', [
    sessionId,
    provider,
    issuer,
    subject,
    email ?? null,
    tenantId ?? null,
    objectId ?? null,
  ])
}

export function linkIdentityByToken(
  token: string,
  provider: string,
  issuer: string,
  subject: string,
  email?: string | null,
  tenantId?: string | null,
  objectId?: string | null,
): Promise<{ user_id: string }> {
  return authCall<{ user_id: string }>('auth.link_identity_by_token', [
    token,
    provider,
    issuer,
    subject,
    email ?? null,
    tenantId ?? null,
    objectId ?? null,
  ])
}

export function unlinkIdentity(sessionId: string, identityId: string): Promise<void> {
  return authCall<void>('auth.unlink_identity', [sessionId, identityId])
}

export function userIdentities(sessionId: string): Promise<LinkedIdentity[]> {
  return authQuery<LinkedIdentity>(
    'select id, provider, issuer, email_at_link, linked_at from auth.user_identities($1)',
    [sessionId],
  )
}

export type UserSession = {
  id: string
  active_role: string
  auth_method: string
  created_at: string
  last_seen_at: string
  idle_expires_at: string
  expires_at: string
  client_ip: string | null
  user_agent: string | null
  is_current: boolean
}

export function userSessions(sessionId: string): Promise<UserSession[]> {
  return authQuery<UserSession>(
    'select id, active_role, auth_method, created_at, last_seen_at, idle_expires_at, expires_at, client_ip, user_agent, is_current from auth.user_sessions($1)',
    [sessionId],
  )
}

export function revokeSession(actorSid: string, targetSid: string): Promise<void> {
  return authCall<void>('auth.session_revoke', [actorSid, targetSid])
}

export function revokeAllSessions(actorSid: string, keepCurrent = false): Promise<void> {
  return authCall<void>('auth.session_revoke_all', [actorSid, keepCurrent])
}

export function requestPasswordReset(email: string, ip?: string | null): Promise<void> {
  return authCall<void>('auth.request_password_reset', [email, ip ?? null])
}

export function logAuthEvent(
  eventType: string,
  outcome: string,
  subjectId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  return authCall<void>('auth.log_event', [eventType, outcome, subjectId, detail])
}


export type TotpStatus = {
  required: boolean
  enrolled: boolean
  locked: boolean
}

export function totpStatus(userId: string): Promise<TotpStatus> {
  return authCall<TotpStatus>('auth.totp_status', [userId])
}

export function totpVerify(userId: string, code: string): Promise<boolean> {
  return authCall<boolean>('auth.totp_verify', [userId, code])
}

export function totpEnrol(userId: string, secret: string, algorithm = 'sha1'): Promise<void> {
  return authCall<void>('auth.totp_enrol', [userId, secret, algorithm])
}

/** H-10: what the break-glass page needs to decide which form to show. */
export type BreakGlassStatus = {
  label: string
  enabled: boolean
  dormant: boolean
  valid_until: string | null
  reason: string | null
  last_drill_at: string | null
  drill_overdue: boolean
}

export function breakGlassActivate(
  userId: string,
  reason: string,
  validUntil?: string | null,
): Promise<{ activated: boolean; reason?: string; valid_until?: string; assignment_id?: string }> {
  return authCall<{
    activated: boolean
    reason?: string
    valid_until?: string
    assignment_id?: string
  }>('auth.break_glass_activate', [userId, reason, validUntil ?? null])
}

export function breakGlassDeactivate(userId: string, reason: string): Promise<number> {
  return authCall<number>('auth.break_glass_deactivate', [userId, reason])
}

export function breakGlassState(userId: string): Promise<BreakGlassStatus | null> {
  return authCall<BreakGlassStatus | null>('auth.break_glass_state', [userId])
}

/** H-10: one break-glass account whose drill has lapsed, as the scheduler sees it. */
export type BreakGlassOverdue = {
  user_id: string
  label: string
  last_drill_at: string | null
  days_since_drill: number | null
}

/**
 * H-10: every enabled break-glass account whose drill is overdue. The per-caller
 * `breakGlassState` flag is only observed when a human opens the page, which is
 * precisely what does not happen while the account is dormant, so the overdue check
 * also runs from the scheduler outside the request path.
 */
export function breakGlassDrillOverdue(): Promise<BreakGlassOverdue[]> {
  return authQuery<BreakGlassOverdue>('select * from auth.break_glass_drill_overdue()')
}

export type PositionProposal = {
  id: string
  user_id: string
  display_name: string
  email: string
  status: string
  job_title_code: string | null
  job_title_label: string | null
  unit_id: string | null
  unit_code: string | null
  unit_name: string | null
  entra_job_title: string | null
  entra_department: string | null
  entra_office: string | null
  source: string
  proposed_at: string
  decided_at: string | null
  decided_by: string | null
  decision_reason: string | null
}
