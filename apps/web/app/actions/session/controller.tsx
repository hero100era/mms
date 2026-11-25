import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getAuth, getSession, render, requireAuth, forbiddenResponse, type AnyRequestContext } from '../context.ts'
import { entraConfigured, entraLogoutUrl, getAppBaseUrl } from '../../auth/entra.ts'
import { googleConfigured } from '../../auth/google.ts'
import { dummyVerifyPassword, hashPassword, validatePassword, verifyPassword, validateToken } from '../../auth/password.ts'
import { isThrottled, passwordLookup, recordAttempt, requestPasswordReset, revokeAllSessions, revokeSession, setPassword, setSessionRole, userIdentities, userRoles, userSessions } from '../../auth/service.ts'
import { devMailbox } from '../../jobs/dev-mailbox.ts'
import { clientIp } from '../../middleware/request-context.ts'
import { ChooseRolePage, DevLoginPage, ForgotPasswordPage, LoginPage, NoAccessPage, ProfilePage, ResetPasswordPage } from '../auth-pages.tsx'
import { HomePage } from '../home-page.tsx'
import { devEnabled, authData, parseUuidOrNull, safeReturnTo } from '../utils.ts'
import { isDevLoginAllowed } from '../../auth/dev-stub.ts'
import { ensureText, optionalText, requireText, validateEmail } from '../validation.ts'
import { DEV_PERSONAS, findDevPersona, type DevPersona } from '../../auth/dev-personas.ts'
import { authenticateDevPersona } from './dev-auth.ts'

export default createController(routes.session, {
  actions: {
    home(context) {
      let auth = getAuth(context)
      return render(context, <HomePage auth={auth} csrf={getCsrfToken(context)} />)
    },

    login(context) {
      let message =
        context.url.searchParams.get('reset') === 'success'
          ? 'Password reset successfully. Please sign in with your new password.'
          : undefined
      return render(
        context,
        <LoginPage
          csrf={getCsrfToken(context)}
          entraEnabled={entraConfigured()}
          googleEnabled={googleConfigured()}
          devEnabled={isDevLoginAllowed()}
          message={message}
        />,
      )
    },
    async loginDev(context) {
      if (!isDevLoginAllowed()) return new Response('Not Found', { status: 404 })
      let form = (await context.get(FormData)) as FormData
      let personaKey = optionalText(form, 'personaKey') ?? optionalText(form, 'userId') ?? ''
      let persona = findDevPersona(personaKey)
      if (!persona) {
        return render(
          context,
          <LoginPage
            csrf={getCsrfToken(context)}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            devEnabled={isDevLoginAllowed()}
            error="Please select an approved test persona. Caller-supplied roles and arbitrary identities are strictly prohibited."
          />,
          { status: 422 },
        )
      }
      let returnTo = optionalText(form, 'returnTo') ?? ''
      return authenticateDevPersona(context, persona, returnTo)
    },
    devLogin(context) {
      if (!isDevLoginAllowed()) return new Response('Not Found', { status: 404 })
      let returnTo = context.url.searchParams.get('returnTo') ?? undefined
      return render(
        context,
        <DevLoginPage
          csrf={getCsrfToken(context)}
          personas={DEV_PERSONAS}
          returnTo={returnTo}
        />,
      )
    },
    async devLoginSubmit(context) {
      if (!isDevLoginAllowed()) return new Response('Not Found', { status: 404 })
      let form = (await context.get(FormData)) as FormData
      let personaKey = optionalText(form, 'personaKey') ?? optionalText(form, 'userId') ?? ''
      let persona = findDevPersona(personaKey)
      if (!persona) {
        return render(
          context,
          <DevLoginPage
            csrf={getCsrfToken(context)}
            personas={DEV_PERSONAS}
            error="Unknown test persona."
          />,
          { status: 422 },
        )
      }
      let returnTo = optionalText(form, 'returnTo') ?? ''
      return authenticateDevPersona(context, persona, returnTo)
    },
    async loginPassword(context) {
      let form = (await context.get(FormData)) as FormData
      let email = requireText(form, 'email').toLowerCase()
      let password = requireText(form, 'password')
      let ip = clientIp(context)
      let ua = context.request.headers.get('user-agent') ?? 'unknown'

      if (await isThrottled(email, ip)) {
        await recordAttempt(email, ip, 'failure', 'throttled')
        return render(
          context,
          <LoginPage
            csrf={getCsrfToken(context)}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            devEnabled={devEnabled()}
            error="Too many failed attempts. Account is temporarily locked."
          />,
          { status: 429 },
        )
      }

      let cred = await passwordLookup(email)
      if (!cred || !cred.hash || !cred.user_id) {
        await dummyVerifyPassword(password)
        let reason = !cred || !cred.user_id ? 'user_not_found' : 'missing_password_hash'
        await recordAttempt(email, ip, 'failure', reason)
        return render(
          context,
          <LoginPage
            csrf={getCsrfToken(context)}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            devEnabled={isDevLoginAllowed()}
            error="Invalid email or password."
          />,
          { status: 401 },
        )
      }

      let valid = await verifyPassword(password, cred.hash)
      if (!valid) {
        await recordAttempt(email, ip, 'failure', 'bad_password')
        return render(
          context,
          <LoginPage
            csrf={getCsrfToken(context)}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            devEnabled={isDevLoginAllowed()}
            error="Invalid email or password."
          />,
          { status: 401 },
        )
      }

      if (cred.status !== 'active') {
        let reason = cred.status === 'suspended' ? 'account_disabled' : 'account_inactive'
        await recordAttempt(email, ip, 'failure', reason)
        return render(
          context,
          <LoginPage
            csrf={getCsrfToken(context)}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            devEnabled={devEnabled()}
            error="Invalid email or password."
          />,
          { status: 401 },
        )
      }

      await recordAttempt(email, ip, 'success')
      let roles = await userRoles(cred.user_id)
      let activeRole = roles[0] || 'ext_user'
      let session = getSession(context)
      session.regenerateId(true)
      let authTime = new Date().toISOString()
      session.set('auth', {
        userId: cred.user_id,
        kind: 'external',
        email,
        activeRole,
        authMethod: 'pwd',
        authTime,
        stepUpAt: authTime,
        assignableRoles: roles.length > 0 ? roles : ['ext_user'],
        clientIp: ip,
        userAgent: ua,
      })
      return redirect(`${routes.mfa.challenge.href()}?returnTo=${encodeURIComponent(routes.session.profile.href())}`)
    },
    async logout(context) {
      let auth = getAuth(context)
      let isEntra = auth?.authMethod === 'entra' || (auth?.kind === 'internal' && entraConfigured())
      let session = getSession(context)
      session.destroy()
      if (isEntra && entraConfigured()) {
        let returnUrl = new URL(routes.session.login.href(), getAppBaseUrl()).toString()
        return redirect(entraLogoutUrl(returnUrl))
      }
      return redirect(routes.session.login.href())
    },
    chooseRole(context) {
      let auth = requireAuth(context)
      let roles = auth.assignableRoles ?? [auth.activeRole]
      if (roles.length <= 1) return redirect(routes.session.profile.href())
      return render(
        context,
        <ChooseRolePage csrf={getCsrfToken(context)} roles={roles} current={auth.activeRole} />,
      )
    },
    noAccess(context) {
      return render(context, <NoAccessPage />)
    },
    async sessionRole(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let role = requireText(form, 'role')
      if (!(auth.assignableRoles ?? []).includes(role)) {
        return forbiddenResponse(context, 'Role is not assigned to this user')
      }
      let session = getSession(context)
      await setSessionRole(session.id, role)
      session.regenerateId(true)
      session.set('auth', { ...auth, activeRole: role })
      return redirect(routes.session.profile.href())
    },
    async profile(context) {
      let auth = requireAuth(context)
      let session = getSession(context)
      let identities: any[] = []
      if (auth.kind === 'external') {
        identities = await userIdentities(session.id)
      }
      let sessions = await userSessions(session.id)
      let success = context.url.searchParams.get('success')
      let msg =
        success === 'linked'
          ? 'Account linked successfully.'
          : success === 'unlinked'
          ? 'Account unlinked successfully.'
          : success === 'session_revoked'
          ? 'Session revoked successfully.'
          : success === 'all_sessions_revoked'
          ? 'All other sessions revoked successfully.'
          : undefined
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
          message={msg}
        />,
      )
    },
    devMailbox(context) {
      if ((!devEnabled() && !isDevLoginAllowed()) || process.env.NODE_ENV === 'production') {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(JSON.stringify(devMailbox.getMessages()), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    },
    forgotPassword(context) {
      return render(
        context,
        <ForgotPasswordPage csrf={getCsrfToken(context)} />,
      )
    },
    async forgotPasswordSubmit(context) {
      let form = (await context.get(FormData)) as FormData
      let rawEmail = optionalText(form, 'email')?.toLowerCase() ?? ''
      let ip = clientIp(context)
      if (rawEmail) {
        try {
          let email = validateEmail(rawEmail, 'email')
          await requestPasswordReset(email, ip)
        } catch {
          // Ignore invalid email format to prevent account enumeration
        }
      }
      return render(
        context,
        <ForgotPasswordPage csrf={getCsrfToken(context)} submitted={true} />,
      )
    },
    resetPassword(context) {
      let token = context.params.token
      return render(
        context,
        <ResetPasswordPage token={token} csrf={getCsrfToken(context)} />,
      )
    },
    async resetPasswordSubmit(context) {
      let token = context.params.token
      if (!token || !validateToken(token)) {
        return new Response('Invalid token', { status: 400 })
      }
      let form = (await context.get(FormData)) as FormData
      let password = optionalText(form, 'password') ?? ''
      let confirmPassword = optionalText(form, 'confirmPassword') ?? ''

      if (password !== confirmPassword) {
        return render(
          context,
          <ResetPasswordPage token={token} csrf={getCsrfToken(context)} error="Passwords do not match." />,
          { status: 422 },
        )
      }

      let validation = validatePassword(password)
      if (!validation.valid) {
        return render(
          context,
          <ResetPasswordPage token={token} csrf={getCsrfToken(context)} error={validation.error} />,
          { status: 422 },
        )
      }

      let hash = await hashPassword(password)
      try {
        await setPassword(token, hash)
        let currentSession = getSession(context)
        if (currentSession) {
          currentSession.destroy()
        }
        return redirect(`${routes.session.login.href()}?reset=success`)
      } catch {
        return render(
          context,
          <ResetPasswordPage token={token} csrf={getCsrfToken(context)} error="Invalid or expired reset token." />,
          { status: 422 },
        )
      }
    },
    async profileSessionRevoke(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let sessionId = requireText(form, 'sessionId')
      let currentSession = getSession(context)
      if (!sessionId || !parseUuidOrNull(sessionId)) {
        return new Response('Invalid session id', { status: 400 })
      }
      try {
        if (sessionId === currentSession.id) {
          currentSession.destroy()
          return redirect(routes.session.login.href())
        }
        await revokeSession(currentSession.id, sessionId)
        return redirect(`${routes.session.profile.href()}?success=session_revoked`)
      } catch {
        return redirect(routes.session.profile.href())
      }
    },
    async profileSessionRevokeAll(context) {
      let auth = requireAuth(context)
      let currentSession = getSession(context)
      try {
        await revokeAllSessions(currentSession.id, true)
        return redirect(`${routes.session.profile.href()}?success=all_sessions_revoked`)
      } catch {
        return redirect(routes.session.profile.href())
      }
    },
  },
})
