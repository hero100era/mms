import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import { startExternalAuth } from 'remix/auth'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getSession, render, requireAuth, forbiddenResponse } from '../context.ts'
import { hashPassword, validatePassword, validateToken } from '../../auth/password.ts'
import { setPassword, unlinkIdentity, userIdentities, userSessions } from '../../auth/service.ts'
import { clientIp } from '../../middleware/request-context.ts'
import { InvitePage, ProfilePage } from '../auth-pages.tsx'
import { isStepUpValid } from '../utils.ts'
import { requireText, requireUuid } from '../validation.ts'
import { resolveOAuthProvider, setLinkIntent } from '../auth/oauth-helpers.ts'

export default createController(routes.identity, {
  actions: {
    async linkInvite(context) {
      let token = context.params.token
      let resolved = resolveOAuthProvider(context, context.params.provider)
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      let session = getSession(context)
      setLinkIntent(session, {
        provider: resolved.provider,
        purpose: 'invite',
        inviteToken: token,
      })
      return startExternalAuth(resolved.providerInstance, context)
    },
    async link(context) {
      let auth = requireAuth(context)
      if (auth.kind !== 'external') return forbiddenResponse(context, 'External authentication required')
      let resolved = resolveOAuthProvider(context, context.params.provider)
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      if (!isStepUpValid(auth, context)) {
        return redirect(
          routes.mfa.stepUp.href() + '?returnTo=' + encodeURIComponent(routes.session.profile.href()),
        )
      }
      let session = getSession(context)
      setLinkIntent(session, {
        provider: resolved.provider,
        purpose: 'link',
        userId: auth.userId,
      })
      return startExternalAuth(resolved.providerInstance, context)
    },
    async unlink(context) {
      let auth = requireAuth(context)
      if (auth.kind !== 'external') return forbiddenResponse(context, 'External authentication required')
      let form = (await context.get(FormData)) as FormData
      let identityId: string
      try {
        identityId = requireUuid(form, 'identityId')
      } catch {
        return new Response('Invalid identity id', { status: 400 })
      }
      let session = getSession(context)
      if (!isStepUpValid(auth, context)) {
        return redirect(
          routes.mfa.stepUp.href() + '?returnTo=' + encodeURIComponent(routes.session.profile.href()),
        )
      }
      try {
        await unlinkIdentity(session.id, identityId)
        session.regenerateId(true)
        session.set('auth', { ...auth, stepUpAt: new Date().toISOString() })
        return redirect(routes.session.profile.href() + '?success=unlinked')
      } catch (err: any) {
        if (err.code === '42501' && (err.message?.includes('step_up') || err.message?.includes('step_up_required'))) {
          return redirect(
            routes.mfa.stepUp.href() + '?returnTo=' + encodeURIComponent(routes.session.profile.href()),
          )
        }
        let identities = await userIdentities(session.id)
        let sessions = await userSessions(session.id)
        let errorMsg = (err.code === '42501' && err.message?.includes('last_sign_in_method'))
          ? 'Cannot remove your last remaining sign-in method.'
          : 'Failed to unlink identity.'
        return render(
          context,
          <ProfilePage
            userId={auth.userId}
            role={auth.activeRole}
            roles={auth.assignableRoles ?? [auth.activeRole]}
            csrf={getCsrfToken(context)}
            kind={auth.kind}
            identities={identities}
            sessions={sessions}
            error={errorMsg}
          />,
          { status: 422 },
        )
      }
    },
    // Card H-09: the second factor for external password users. Verification runs
    // in PostgreSQL (`auth.totp_verify`), so the BFF never holds the shared secret
    // beyond the moment it is generated and handed to the database.
    invite(context) {
      let token = context.params.token
      if (!token || !validateToken(token)) {
        return new Response('Invalid token', { status: 400 })
      }
      return render(
        context,
        <InvitePage token={token} csrf={getCsrfToken(context)} />,
      )
    },
    async accept(context) {
      let token = context.params.token
      if (!token || !validateToken(token)) {
        return new Response('Invalid token', { status: 400 })
      }
      let form = (await context.get(FormData)) as FormData
      let password = requireText(form, 'password')
      let confirmPassword = requireText(form, 'confirmPassword')

      if (password !== confirmPassword) {
        return render(
          context,
          <InvitePage token={token} csrf={getCsrfToken(context)} error="Passwords do not match." />,
          { status: 422 },
        )
      }

      let validation = validatePassword(password)
      if (!validation.valid) {
        return render(
          context,
          <InvitePage token={token} csrf={getCsrfToken(context)} error={validation.error} />,
          { status: 422 },
        )
      }

      let hash = await hashPassword(password)
      try {
        let res = await setPassword(token, hash)
        let ip = clientIp(context)
        let ua = context.request.headers.get('user-agent') ?? 'unknown'

        let session = getSession(context)
        session.regenerateId(true)
        let authTime = new Date().toISOString()
        session.set('auth', {
          userId: res.user_id,
          email: res.email,
          kind: 'external',
          activeRole: 'ext_user',
          authMethod: 'pwd',
          authTime,
          stepUpAt: authTime,
          assignableRoles: ['ext_user'],
          clientIp: ip,
          userAgent: ua,
        })
        return redirect(routes.mfa.enrol.href())
      } catch {
        return render(
          context,
          <InvitePage
            token={token}
            csrf={getCsrfToken(context)}
            error="Invalid or expired invitation token."
          />,
          { status: 422 },
        )
      }
    },
  },
})
