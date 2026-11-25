import { createController } from 'remix/router'
import type { PgrstClient } from '@mms/pgrst-client'
import { routes } from '../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getPgrst, render, requireAuth, requireRole, forbiddenResponse } from '../context.ts'
import { TriageDetailPage, TriageQueuePage } from '../survey-pages.tsx'
import { actionProblemResponse, classifyActionError, isJsonOrProblemRequest, safeActionError, toDomainErrorCode } from '../errors.ts'
import {
  optionalText,
  requireBoundedReason,
  requireUuid,
  requireUuidFromParams,
} from '../validation.ts'
import { loadSurveyDetail } from '../survey/loaders.ts'

async function runTriageMutation(
  context: any,
  fn: (id: string, form: FormData, client: PgrstClient) => Promise<void>,
): Promise<Response> {
  requireRole(context, ['int_coordinator', 'int_manager'])
  let id = requireUuidFromParams(context.params, 'id')
  let client = getPgrst(context)
  let form = (await context.get(FormData)) as FormData

  try {
    await fn(id, form, client)
    return redirect(routes.triage.detail.href({ id }))
  } catch (error: any) {
    if (isJsonOrProblemRequest(context.request)) {
      return actionProblemResponse(context, error)
    }
    let kind = classifyActionError(error)
    if (kind === 'privilege') {
      return forbiddenResponse(context, 'Insufficient triage authority')
    }
    if (kind === 'not_found') {
      return new Response('Not Found', { status: 404 })
    }
    return new Response(safeActionError(error, 'Triage action failed'), { status: 422 })
  }
}

export default createController(routes.triage, {
  actions: {
    async queue(context) {
      let auth = requireAuth(context)
      if (auth.kind === 'external' || auth.activeRole === 'ext_user') {
        return forbiddenResponse(context, 'Triage queue is restricted to internal staff')
      }

      let client = getPgrst(context)
      let url = new URL(context.request.url)
      let statusFilter = url.searchParams.get('status') || 'all'
      let allowedFilters = ['all', 'submitted', 'clarification_requested', 'accepted', 'rejected']
      if (!allowedFilters.includes(statusFilter)) {
        statusFilter = 'all'
      }

      let queryOpts: Record<string, string> = { order: 'created_at.desc' }
      if (statusFilter !== 'all') {
        queryOpts.status = `eq.${statusFilter}`
      }

      let requests = await client.select('survey_requests', queryOpts)

      return render(
        context,
        <TriageQueuePage
          csrf={getCsrfToken(context)}
          role={auth.activeRole}
          requests={requests || []}
          currentFilter={statusFilter}
        />,
      )
    },
    async detail(context) {
      let auth = requireAuth(context)
      if (auth.kind === 'external' || auth.activeRole === 'ext_user') {
        return forbiddenResponse(context, 'Triage is restricted to internal staff')
      }

      let id = requireUuidFromParams(context.params, 'id')
      let client = getPgrst(context)

      let detail = await loadSurveyDetail(client, id, { includeStations: true, includeAudit: true })
      if (!detail) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('Survey request not found'), {
            status: 404,
            title: 'Not Found',
            code: 'NOT_FOUND',
            detail: 'Survey request not found',
          })
        }
        return new Response('Not Found', { status: 404 })
      }

      return render(
        context,
        <TriageDetailPage
          csrf={getCsrfToken(context)}
          role={auth.activeRole}
          request={detail.request}
          documents={detail.documents}
          versions={detail.versions}
          stations={detail.stations}
          auditEvents={detail.auditEvents}
        />,
      )
    },
    async accept(context) {
      return runTriageMutation(context, async (id, form, client) => {
        let reason = requireBoundedReason(form, 'reason', 5)
        let notes = optionalText(form, 'triage_notes')
        await client.rpc('survey_request_accept', {
          p_id: id,
          p_reason: reason,
          p_triage_notes: notes || undefined,
        })
      })
    },
    async clarify(context) {
      return runTriageMutation(context, async (id, form, client) => {
        let reason = requireBoundedReason(form, 'reason', 5)
        let notes = optionalText(form, 'notes') || optionalText(form, 'triage_notes')
        await client.rpc('survey_request_request_clarification', {
          p_id: id,
          p_reason: reason,
          p_notes: notes || undefined,
        })
      })
    },
    async reject(context) {
      return runTriageMutation(context, async (id, form, client) => {
        let reason = requireBoundedReason(form, 'reason', 5)
        let notes = optionalText(form, 'notes') || optionalText(form, 'triage_notes')
        await client.rpc('survey_request_reject', {
          p_id: id,
          p_reason: reason,
          p_notes: notes || undefined,
        })
      })
    },
    async transfer(context) {
      return runTriageMutation(context, async (id, form, client) => {
        let newOfficeUnitId = requireUuid(form, 'new_office_unit_id')
        let reason = requireBoundedReason(form, 'reason', 5)
        await client.rpc('survey_request_transfer', {
          p_id: id,
          p_new_office_unit_id: newOfficeUnitId,
          p_reason: reason,
        })
      })
    },
  },
})
