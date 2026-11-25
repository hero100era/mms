import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getAuth, getSession, render, requireAuth, forbiddenResponse } from '../context.ts'
import { alertBreakGlassActivated } from '../../jobs/break-glass-alerts.ts'
import { breakGlassActivate, breakGlassDeactivate, breakGlassState } from '../../auth/service.ts'
import { BreakGlassPage, NoAccessPage } from '../auth-pages.tsx'
import { actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import { optionalText } from '../validation.ts'

export default createController(routes.breakGlass, {
  actions: {
    async index(context) {
      let auth = requireAuth(context)
      let state = await breakGlassState(auth.userId)
      if (!state) {
        // Not a break-glass account: this page is not theirs to see, and the reason
        // form must not become a generic "become sysadmin" endpoint.
        if (isJsonOrProblemRequest(context.request)) {
          return forbiddenResponse(context, 'This account is not authorized for break-glass operations.')
        }
        return render(context, <NoAccessPage />, { status: 403 })
      }
      return render(
        context,
        <BreakGlassPage
          csrf={getCsrfToken(context)}
          label={state.label}
          dormant={state.dormant}
          validUntil={state.valid_until}
          reason={state.reason}
          drillOverdue={state.drill_overdue}
          error={state.enabled ? undefined : 'This account is disabled. The platform administrator must re-enable it.'}
        />,
      )
    },
    async activate(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let reason = optionalText(form, 'reason') ?? ''
      let session = getSession(context)
      if (reason.length < 10) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('reason_too_short'), {
            status: 422,
            detail: 'Write a reason of at least ten characters. It is part of the record.',
            extra: { error: 'reason_too_short' },
          })
        }
        return render(
          context,
          <BreakGlassPage
            csrf={getCsrfToken(context)}
            label={auth.email ?? auth.userId}
            dormant
            error="Write a reason of at least ten characters. It is part of the record."
          />,
          { status: 422 },
        )
      }
      try {
        await breakGlassActivate(auth.userId, reason)
      } catch (err: any) {
        let message = String(err?.message ?? '')
        let explanation = message.includes('break_glass_disabled')
          ? 'This account is disabled. The platform administrator must re-enable it.'
          : message.includes('already_holds_sysadmin')
            ? 'This account already holds int_sysadmin. Use that access instead of opening a window.'
            : 'Activation failed. Nothing was granted.'
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, err, {
            status: 403,
            detail: explanation,
            extra: { error: 'activation_failed' },
          })
        }
        return render(
          context,
          <BreakGlassPage csrf={getCsrfToken(context)} label={auth.email ?? auth.userId} dormant error={explanation} />,
          { status: 403 },
        )
      }
      // Rotate on the privilege change and re-sign the session with the sysadmin role
      // so the next request carries a token whose assignment actually exists.
      session.regenerateId(true)
      session.set('auth', { ...auth, activeRole: 'int_sysadmin', assignableRoles: ['int_sysadmin'] })
      // Card H-10: opening a break-glass window is the event operators must see. The
      // alert is raised here rather than on the page, so a scripted activation cannot
      // stay quiet while only the human-driven one is noticed.
      let activated = await breakGlassState(auth.userId)
      await alertBreakGlassActivated(auth.userId, activated?.valid_until ?? null, reason)
      return redirect(routes.breakGlass.index.href())
    },
    async deactivate(context) {
      let auth = requireAuth(context)
      let form = (await context.get(FormData)) as FormData
      let reason = optionalText(form, 'reason') ?? ''
      if (reason.length < 10) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('reason_too_short'), {
            status: 422,
            detail: 'Write a reason of at least ten characters.',
            extra: { error: 'reason_too_short' },
          })
        }
        return render(
          context,
          <BreakGlassPage
            csrf={getCsrfToken(context)}
            label={auth.email ?? auth.userId}
            dormant={false}
            error="Write a reason of at least ten characters."
          />,
          { status: 422 },
        )
      }
      await breakGlassDeactivate(auth.userId, reason)
      // Deactivation revokes every live session for the account, including this one.
      let closing = getSession(context)
      closing.destroy()
      return redirect(routes.session.login.href())
    },
  },
})
