import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import { startExternalAuth } from 'remix/auth'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getAuth, getRequestId, getSession, render, requireAuth, forbiddenResponse } from '../context.ts'
import { actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import { clientIp } from '../../middleware/request-context.ts'
import { entraConfigured } from '../../auth/entra.ts'
import { timingSafeEqual } from 'node:crypto'
import { PERIOD_SECONDS, base32Decode, base32Encode, buildOtpauthUri, formatSecretForDisplay, generateTotpSecret, totpCode } from '@mms/totp'
import { googleConfigured } from '../../auth/google.ts'
import { verifyPassword } from '../../auth/password.ts'
import {
  getStepUpRetryAfter,
  isStepUpThrottled,
  logAuthEvent,
  passwordLookup,
  recordStepUpAttempt,
  totpEnrol,
  totpStatus,
  totpVerify,
} from '../../auth/service.ts'
import { MfaEnrolPage, MfaPage, StepUpPage } from '../auth-pages.tsx'
import { isStepUpValid, safeReturnTo } from '../utils.ts'
import { optionalText, requireText } from '../validation.ts'
import { resolveOAuthProvider, setLinkIntent } from '../auth/oauth-helpers.ts'

function verifyPendingTotpCode(secretBase32: string, submittedCode: string): boolean {
  let trimmed = submittedCode.trim()
  if (!/^[0-9]{6}$/.test(trimmed)) return false
  let secretBytes = base32Decode(secretBase32)
  let currentStep = Math.floor(Date.now() / 1000 / PERIOD_SECONDS)
  let submittedBuf = Buffer.from(trimmed, 'utf8')
  for (let offset of [-1, 0, 1]) {
    let candidate = totpCode(secretBytes, currentStep + offset)
    let candidateBuf = Buffer.from(candidate, 'utf8')
    if (candidateBuf.length === submittedBuf.length && timingSafeEqual(candidateBuf, submittedBuf)) {
      return true
    }
  }
  return false
}

export default createController(routes.mfa, {
  actions: {
    async challenge(context) {
      let auth = requireAuth(context)
      let returnTo = safeReturnTo(context.url.searchParams.get('returnTo'))
      let status = await totpStatus(auth.userId)
      // An external user with no credential yet cannot pass a challenge, so send
      // them to enrolment instead of showing a form they can never satisfy.
      if (!status.enrolled) return redirect(`${routes.mfa.enrol.href()}?returnTo=${encodeURIComponent(returnTo)}`)
      return render(
        context,
        <MfaPage csrf={getCsrfToken(context)} returnTo={returnTo} error={status.locked ? 'Too many incorrect codes. Try again in a few minutes.' : undefined} />,
      )
    },
    async submit(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let code = requireText(form, 'code')
      let returnTo = safeReturnTo(optionalText(form, 'returnTo'))
      let session = getSession(context)

      let ok = false
      try {
        ok = await totpVerify(auth.userId, code)
      } catch (err: any) {
        await logAuthEvent('auth.mfa.failure', 'failure', auth.userId, { error: 'mfa_verify_error' })
        return render(
          context,
          <MfaPage csrf={getCsrfToken(context)} returnTo={returnTo} error="Verification failed. Try again." />,
          { status: 422 },
        )
      }

      if (!ok) {
        await logAuthEvent('auth.mfa.failure', 'failure', auth.userId, { reason: 'incorrect_code' })
        return render(
          context,
          <MfaPage csrf={getCsrfToken(context)} returnTo={returnTo} error="Incorrect or already-used code." />,
          { status: 422 },
        )
      }

      let now = new Date().toISOString()
      // Rotating on a privilege change is the same rule the session spec applies to
      // login, link, role switch and step-up.
      session.regenerateId(true)
      session.set('auth', { ...auth, mfaVerifiedAt: now, stepUpAt: auth.stepUpAt ?? now })
      await logAuthEvent('auth.mfa.success', 'success', auth.userId, {})
      return redirect(returnTo)
    },
    async enrol(context) {
      let auth = requireAuth(context)
      let session = getSession(context)

      // Prevent MFA bypass / TOTP secret overwrite: an already-enrolled user must
      // complete MFA and fresh step-up before re-enrolling a new authenticator.
      let status = await totpStatus(auth.userId)
      if (status.enrolled) {
        if (!auth.mfaVerifiedAt) {
          return redirect(routes.mfa.challenge.href())
        }
        if (!isStepUpValid(auth, context)) {
          return redirect(`${routes.mfa.stepUp.href()}?returnTo=${encodeURIComponent(routes.mfa.enrol.href())}`)
        }
      }

      // Keep the pending secret in the session so a page refresh does not hand the
      // user a second, different key that their app never registered.
      let pending = session.get('totpEnrol') as { secret: string; userId: string } | undefined
      if (!pending || pending.userId !== auth.userId) {
        pending = { secret: base32Encode(generateTotpSecret()), userId: auth.userId }
        session.set('totpEnrol', pending)
      }

      return render(
        context,
        <MfaEnrolPage
          csrf={getCsrfToken(context)}
          otpauthUri={buildOtpauthUri({ secret: pending.secret, accountName: auth.email ?? auth.userId })}
          secretLabel={formatSecretForDisplay(pending.secret)}
        />,
      )
    },
    async enrolSubmit(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let code = requireText(form, 'code')
      let session = getSession(context)
      let pending = session.get('totpEnrol') as { secret: string; userId: string } | undefined

      let status = await totpStatus(auth.userId)
      if (status.enrolled) {
        if (!auth.mfaVerifiedAt) {
          return redirect(routes.mfa.challenge.href())
        }
        if (!isStepUpValid(auth, context)) {
          return redirect(`${routes.mfa.stepUp.href()}?returnTo=${encodeURIComponent(routes.mfa.enrol.href())}`)
        }
      }

      if (!pending || pending.userId !== auth.userId) {
        return redirect(routes.mfa.enrol.href())
      }

      // Verify the submitted code against the pending secret BEFORE persisting to
      // PostgreSQL so an incorrect code never overwrites an existing credential.
      if (!verifyPendingTotpCode(pending.secret, code)) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('invalid_mfa_code'), {
            status: 422,
            detail: 'That code did not match. Check the time on your device and try the next code.',
            extra: { error: 'invalid_mfa_code' },
          })
        }
        return render(
          context,
          <MfaEnrolPage
            csrf={getCsrfToken(context)}
            otpauthUri={buildOtpauthUri({ secret: pending.secret, accountName: auth.email ?? auth.userId })}
            secretLabel={formatSecretForDisplay(pending.secret)}
            error="That code did not match. Check the time on your device and try the next code."
          />,
          { status: 422 },
        )
      }

      let ok = false
      try {
        await totpEnrol(auth.userId, pending.secret)
        ok = await totpVerify(auth.userId, code)
      } catch (err: any) {
        let correlationId = getRequestId(context)
        console.error('mfa enrolment error:', {
          correlationId: correlationId ?? 'none',
          userId: auth.userId,
          error: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
        })

        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, err, {
            status: 500,
            detail: 'MFA enrolment failed. Please try again.',
            fallbackMessage: 'MFA enrolment failed. Please try again.',
            correlationId,
          })
        }

        return render(
          context,
          <MfaEnrolPage
            csrf={getCsrfToken(context)}
            otpauthUri={buildOtpauthUri({ secret: pending.secret, accountName: auth.email ?? auth.userId })}
            secretLabel={formatSecretForDisplay(pending.secret)}
            error="MFA enrolment failed. Please try again."
          />,
          { status: 500 },
        )
      }

      if (!ok) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('invalid_mfa_code'), {
            status: 422,
            detail: 'That code did not match. Check the time on your device and try the next code.',
            extra: { error: 'invalid_mfa_code' },
          })
        }
        return render(
          context,
          <MfaEnrolPage
            csrf={getCsrfToken(context)}
            otpauthUri={buildOtpauthUri({ secret: pending.secret, accountName: auth.email ?? auth.userId })}
            secretLabel={formatSecretForDisplay(pending.secret)}
            error="That code did not match. Check the time on your device and try the next code."
          />,
          { status: 422 },
        )
      }

      let now = new Date().toISOString()
      session.regenerateId(true)
      session.set('auth', { ...auth, mfaVerifiedAt: now, stepUpAt: auth.stepUpAt ?? now })
      session.set('totpEnrol', undefined)
      return redirect(routes.session.profile.href())
    },
    stepUp(context) {
      let auth = requireAuth(context)
      let returnTo = safeReturnTo(context.url.searchParams.get('returnTo'))
      return render(
        context,
        <StepUpPage
          csrf={getCsrfToken(context)}
          returnTo={returnTo}
          entraEnabled={entraConfigured()}
          googleEnabled={googleConfigured()}
        />,
      )
    },
    async stepUpSubmit(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let password = requireText(form, 'password')
      let returnTo = safeReturnTo(optionalText(form, 'returnTo'))
      let session = getSession(context)
      let ip = clientIp(context)

      // 1. Check dedicated step-up throttle before password verification
      if (await isStepUpThrottled(auth.userId, ip, session.id)) {
        let retryAfter = getStepUpRetryAfter(auth.userId, ip, session.id)
        console.warn('auth.step_up_throttled', {
          userId: auth.userId,
          ip,
          sessionId: session.id,
          retryAfter,
        })
        return render(
          context,
          <StepUpPage
            csrf={getCsrfToken(context)}
            returnTo={returnTo}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            error="Too many failed step-up attempts. Please try again later."
          />,
          {
            status: 429,
            headers: {
              'Retry-After': String(retryAfter),
            },
          },
        )
      }

      let email = auth.email
      let lookup = email ? await passwordLookup(email) : null
      let valid = Boolean(lookup && lookup.status === 'active' && lookup.hash && (await verifyPassword(password, lookup.hash)))

      if (!valid) {
        // 2. Record failure in dedicated step-up namespace (no effect on primary login lockout)
        await recordStepUpAttempt(auth.userId, ip, false, session.id)
        return render(
          context,
          <StepUpPage
            csrf={getCsrfToken(context)}
            returnTo={returnTo}
            entraEnabled={entraConfigured()}
            googleEnabled={googleConfigured()}
            error="Incorrect password."
          />,
          { status: 401 },
        )
      }

      // 3. Permitted success clears step-up throttle
      await recordStepUpAttempt(auth.userId, ip, true, session.id)

      let now = new Date().toISOString()
      session.regenerateId(true)
      session.set('auth', { ...auth, stepUpAt: now })
      return redirect(returnTo)
    },
    async stepUpOAuth(context) {
      let auth = requireAuth(context)
      if (auth.kind !== 'external') return forbiddenResponse(context, 'External authentication required')
      let resolved = resolveOAuthProvider(context, context.params.provider)
      if ('errorResponse' in resolved) {
        return resolved.errorResponse
      }
      let form = (await context.get(FormData)) as FormData
      let returnTo = safeReturnTo(optionalText(form, 'returnTo'))
      let session = getSession(context)
      setLinkIntent(session, {
        provider: resolved.provider,
        purpose: 'step_up',
        userId: auth.userId,
        returnTo,
      })
      return startExternalAuth(resolved.providerInstance, context)
    },
  },
})
