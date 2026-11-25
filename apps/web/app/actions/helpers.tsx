// The OAuth callback state machine shared by the auth action groups.
//
// The pure helpers that used to live here now live in ./utils.ts: importing
// this module pulls in the auth views, the Document shell, the asset pipeline,
// session secrets and the provider configs, which a controller that only
// wants `parseUuidOrNull` should not have to load. They are re-exported here
// so the original import surface keeps working.
export { authData, devEnabled, isStepUpValid, parseUuidOrNull, safeReturnTo } from './utils.ts'

import type { RequestContext } from 'remix/router'
import type { AnyRequestContext } from './context.ts'
import { completeAuth, finishExternalAuth } from 'remix/auth'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'

import type { SessionAuth } from '../auth/context.ts'
import { getSession, render } from './context.ts'
import { routes } from '../routes.ts'
import { entraConfigured, entraTenantId } from '../auth/entra.ts'
import { googleConfigured } from '../auth/google.ts'
import {
  linkIdentity,
  linkIdentityByToken,
  resolveEntra,
  resolveExternal,
} from '../auth/service.ts'
import { clientIp } from '../middleware/request-context.ts'
import { LoginPage, NoAccessPage } from './auth-pages.tsx'
import { authData, devEnabled, parseUuidOrNull, safeReturnTo } from './utils.ts'
import { safeActionError } from './errors.ts'
import { asErrorLike } from './uploads/shared.ts'

export interface OAuthProfileClaims {
  sub?: string
  oid?: string
  tid?: string
  iss?: string
  email?: string
  preferred_username?: string
  name?: string
  roles?: string[]
}

export interface OAuthLinkIntent {
  id?: string
  sessionId?: string
  provider: 'microsoft' | 'google'
  purpose: 'invite' | 'link' | 'step_up'
  inviteToken?: string
  userId?: string
  returnTo?: string
  createdAt: number
  expiresAt: number
}

function issuerForProvider(profile: OAuthProfileClaims, providerName: 'microsoft' | 'google'): string {
  if (providerName !== 'microsoft') {
    return profile.iss ?? 'https://accounts.google.com'
  }
  let parsed = parseUuidOrNull(profile.tid)
  if (!parsed) {
    throw new Error('id_token_tenant')
  }
  if (profile.iss && profile.iss !== 'https://login.microsoftonline.com') {
    return profile.iss
  }
  return `https://login.microsoftonline.com/${parsed}/v2.0`
}

export async function handleOAuthCallback(
  context: AnyRequestContext,
  providerName: 'microsoft' | 'google',
  provider: unknown,
) {
  let { result, returnTo } = await finishExternalAuth(provider as any, context as any)
  let profile = (result?.profile ?? {}) as OAuthProfileClaims
  let session = getSession(context)
  let intent = session.get('linkIntent') as OAuthLinkIntent | undefined

  if (intent) {
    // Single use: consume before validating so a failed attempt cannot replay.
    session.unset('linkIntent')

    if (!intent.id || !intent.sessionId || intent.sessionId !== session.id) {
      return new Response('Linking intent is invalid. Please try again.', { status: 400 })
    }

    if (Date.now() > intent.expiresAt || intent.provider !== providerName) {
      return new Response('Linking intent has expired or is invalid. Please try again.', { status: 400 })
    }

    if (providerName === 'microsoft' && profile.tid === entraTenantId()) {
      return new Response('Internal staff accounts cannot be linked to external users.', { status: 400 })
    }

    let issuer = issuerForProvider(profile, providerName)
    let subject = profile.oid ?? profile.sub ?? ''
    let email = profile.preferred_username ?? profile.email ?? null
    let tenantId = parseUuidOrNull(profile.tid)
    let objectId = parseUuidOrNull(profile.oid)
    let ip = clientIp(context)
    let ua = context.request?.headers.get('user-agent') ?? 'unknown'

    if (intent.purpose === 'invite') {
      try {
        let res = await linkIdentityByToken(
          intent.inviteToken!,
          providerName,
          issuer,
          subject,
          email,
          tenantId,
          objectId,
        )
        // The real session row is created by DbSessionStorage.save with the
        // rotated cookie id below; calling sessionCreate here would orphan one.
        session.regenerateId(true)
        session.set('auth', {
          userId: res.user_id,
          kind: 'external',
          email: email ?? undefined,
          activeRole: 'ext_user',
          authMethod: providerName,
          authTime: new Date().toISOString(),
          stepUpAt: new Date().toISOString(),
          mfaVerifiedAt: new Date().toISOString(),
          assignableRoles: ['ext_user'],
          clientIp: ip,
          userAgent: ua,
        })
        return redirect(safeReturnTo(returnTo ?? routes.session.profile.href()))
      } catch (err: unknown) {
        let errLike = asErrorLike(err)
        if (errLike.message?.includes('duplicate') || errLike.code === '23505') {
          return new Response('This account is already linked to another MMS user.', { status: 409 })
        }
        return new Response(safeActionError(err, 'Failed to link account during invitation.'), { status: 400 })
      }
    } else if (intent.purpose === 'link') {
      // R1.5: the intent is bound to the user who started it. Without this
      // check a callback could be replayed against a different signed-in user.
      let currentAuth = session.get('auth') as SessionAuth | undefined
      if (
        !currentAuth ||
        currentAuth.kind !== 'external' ||
        !intent.userId ||
        currentAuth.userId !== intent.userId
      ) {
        return new Response('Unauthorized link attempt.', { status: 403 })
      }
      try {
        await linkIdentity(
          session.id,
          providerName,
          issuer,
          subject,
          email,
          tenantId,
          objectId,
        )
        session.regenerateId(true)
        let auth = session.get('auth') as SessionAuth | undefined
        session.set('auth', { ...auth, stepUpAt: new Date().toISOString(), mfaVerifiedAt: new Date().toISOString() })
        return redirect(safeReturnTo(returnTo ?? `${routes.session.profile.href()}?success=linked`))
      } catch (err: unknown) {
        let errLike = asErrorLike(err)
        if (errLike.message?.includes('duplicate') || errLike.code === '23505') {
          return new Response('This account is already linked to an MMS user.', { status: 409 })
        }
        if (errLike.message?.includes('step_up_required') || errLike.code === '42501') {
          return new Response('Recent authentication is required to link an account.', { status: 403 })
        }
        return new Response(safeActionError(err, 'Failed to link account.'), { status: 400 })
      }
    } else if (intent.purpose === 'step_up') {
      let currentAuth = session.get('auth') as SessionAuth | undefined
      if (
        !currentAuth ||
        currentAuth.kind !== 'external' ||
        !intent.userId ||
        currentAuth.userId !== intent.userId
      ) {
        return new Response('Unauthorized step-up attempt.', { status: 403 })
      }
      let resolved = await resolveExternal(providerName, issuer, subject)
      if (resolved.status !== 'linked' || resolved.user_id !== currentAuth.userId) {
        return new Response('The external account used does not match your linked MMS account.', { status: 403 })
      }
      session.regenerateId(true)
      let now = new Date().toISOString()
      session.set('auth', { ...currentAuth, stepUpAt: now })
      return redirect(safeReturnTo(intent.returnTo))
    } else {
      // An unrecognised purpose must never fall through to the regular
      // sign-in path, which would turn a link intent into a login.
      return new Response('Linking intent is invalid. Please try again.', { status: 400 })
    }
  }

  // Regular Sign-In
  if (providerName === 'microsoft' && profile.tid === entraTenantId()) {
    // Flow A: Staff login
    let resolved = await resolveEntra([
      profile.tid,
      profile.oid,
      profile.preferred_username ?? profile.email ?? null,
      profile.name ?? null,
      profile.roles ?? [],
    ])
    // H-10: an emergency identity is recognised by the database, never by an email
    // address or a name in this file. It is dormant, so it has no assignable roles;
    // without this branch it would look like an account with no access and the one
    // account that exists to break a lockout would be locked out itself.
    if (resolved.break_glass) {
      let emergencySession = completeAuth(context as any)
      emergencySession.set('auth', {
        ...authData(resolved.user_id, 'int_sysadmin', ['int_sysadmin']),
        breakGlass: true,
      })
      return redirect(routes.breakGlass.index.href())
    }
    let roles = resolved.assignable_roles ?? []
    if (roles.length === 0) return render(context, <NoAccessPage />)
    let role = roles.includes('int_viewer') ? 'int_viewer' : roles[0]!
    let newSession = completeAuth(context as any)
    newSession.set('auth', authData(resolved.user_id, role, roles))
    return redirect(roles.length > 1 ? routes.session.chooseRole.href() : safeReturnTo(returnTo))
  }

  // External OAuth login
  let issuer = issuerForProvider(profile, providerName)
  let subject = profile.oid ?? profile.sub ?? ''
  let resolved = await resolveExternal(providerName, issuer, subject)

  if (resolved.status === 'linked') {
    let ip = clientIp(context)
    let ua = context.request?.headers.get('user-agent') ?? 'unknown'
    // The real session row is created by DbSessionStorage.save with the
    // rotated cookie id; a standalone call here orphans an untracked session.
    let newSession = completeAuth(context as any)
    newSession.set('auth', {
      userId: resolved.user_id,
      kind: 'external',
      email: profile.preferred_username ?? profile.email ?? undefined,
      activeRole: 'ext_user',
      authMethod: providerName,
      authTime: new Date().toISOString(),
      stepUpAt: new Date().toISOString(),
      assignableRoles: ['ext_user'],
      clientIp: ip,
      userAgent: ua,
    })
    return redirect(safeReturnTo(returnTo))
  }

  // Unlinked identity refused; matching email never authenticates!
  return render(
    context,
    <LoginPage
      csrf={getCsrfToken(context as RequestContext<any, any>)}
      entraEnabled={entraConfigured()}
      googleEnabled={googleConfigured()}
      devEnabled={devEnabled()}
      error="This account is not linked to any MMS user."
    />,
    { status: 401 },
  )
}
