import { createController } from 'remix/router'
import { routes } from '../../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getPgrst, render, requireRole } from '../../context.ts'
import { ExternalUsersPage } from '../../external-pages.tsx'
import { actionProblemResponse, isJsonOrProblemRequest, safeActionError } from '../../errors.ts'
import {
  requireBoundedReason,
  requireEmail,
  requireText,
  requireUuid,
  safeFormText,
} from '../../validation.ts'

export default createController(routes.admin.externalUsers, {
  actions: {
    async index(context) {
      let auth = requireRole(context, ['int_coordinator', 'int_sysadmin'])
      let client = getPgrst(context)
      let users = await client.rpc('external_users', {})
      return render(
        context,
        <ExternalUsersPage csrf={getCsrfToken(context)} users={users} />,
      )
    },
    async create(context) {
      let auth = requireRole(context, ['int_coordinator', 'int_sysadmin'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)
      try {
        let email = requireEmail(form, 'email')
        let displayName = requireText(form, 'display_name', { minLength: 1, maxLength: 100 })
        let reason = requireBoundedReason(form, 'reason')

        await client.rpc('create_external_user', {
          p_email: email,
          p_display_name: displayName,
          p_reason: reason,
        })
        return redirect(routes.admin.externalUsers.index.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let users = await client.rpc('external_users', {})
        return render(
          context,
          <ExternalUsersPage
            csrf={getCsrfToken(context)}
            users={users}
            values={{
              email: safeFormText(form, 'email'),
              display_name: safeFormText(form, 'display_name'),
              reason: safeFormText(form, 'reason'),
            }}
            error={safeActionError(error, 'Could not create external user')}
          />,
          { status: 422 },
        )
      }
    },
    async invite(context) {
      let auth = requireRole(context, ['int_coordinator', 'int_sysadmin'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)
      try {
        let userId = requireUuid(form, 'user_id')
        let reason = requireBoundedReason(form, 'reason')

        await client.rpc('invite_external_user', {
          p_user_id: userId,
          p_reason: reason,
        })
        return redirect(routes.admin.externalUsers.index.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let users = await client.rpc('external_users', {})
        return render(
          context,
          <ExternalUsersPage
            csrf={getCsrfToken(context)}
            users={users}
            error={safeActionError(error, 'Could not re-invite external user')}
          />,
          { status: 422 },
        )
      }
    },
  },
})
