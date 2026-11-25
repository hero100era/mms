import { createController } from 'remix/router'
import type { PgrstClient } from '@mms/pgrst-client'
import { routes } from '../../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getPgrst, render, requireRole } from '../../context.ts'
import { PositionProposalsPage } from '../../admin-pages.tsx'
import { actionProblemResponse, isJsonOrProblemRequest, safeActionError } from '../../errors.ts'
import {
  requireBoundedReason,
  requireText,
  requireUuid,
} from '../../validation.ts'

/** Fetches the three reads the proposals page needs, in parallel. */
function loadProposalPageData(client: PgrstClient) {
  return Promise.all([
    client.select('position_proposals', { status: 'eq.pending', order: 'proposed_at' }),
    client.select('position_job_titles'),
    client.select('position_units'),
  ])
}

export default createController(routes.admin.proposals, {
  actions: {
    async index(context) {
      let auth = requireRole(context, ['int_hr', 'int_sysadmin'])
      let client = getPgrst(context)
      let [proposals, jobTitles, units] = await loadProposalPageData(client)
      return render(
        context,
        <PositionProposalsPage
          csrf={getCsrfToken(context)}
          proposals={proposals}
          jobTitles={jobTitles}
          units={units}
        />,
      )
    },
    async confirm(context) {
      let auth = requireRole(context, ['int_hr'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)
      try {
        let id = requireUuid(form, 'id')
        let jobTitleCode = requireText(form, 'job_title_code')
        let unitId = requireUuid(form, 'unit_id')
        let reason = requireBoundedReason(form, 'reason')

        await client.rpc('position_proposal_confirm', {
          p_id: id,
          p_job_title_code: jobTitleCode,
          p_unit_id: unitId,
          p_line_manager_id: null,
          p_reason: reason,
        })
        return redirect(routes.admin.proposals.index.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let [proposals, jobTitles, units] = await loadProposalPageData(client)
        return render(
          context,
          <PositionProposalsPage
            csrf={getCsrfToken(context)}
            proposals={proposals}
            jobTitles={jobTitles}
            units={units}
            error={safeActionError(error, 'Could not confirm the proposal')}
          />,
          { status: 422 },
        )
      }
    },
    async reject(context) {
      let auth = requireRole(context, ['int_hr'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)
      try {
        let id = requireUuid(form, 'id')
        let reason = requireBoundedReason(form, 'reason')

        await client.rpc('position_proposal_reject', {
          p_id: id,
          p_reason: reason,
        })
        return redirect(routes.admin.proposals.index.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let [proposals, jobTitles, units] = await loadProposalPageData(client)
        return render(
          context,
          <PositionProposalsPage
            csrf={getCsrfToken(context)}
            proposals={proposals}
            jobTitles={jobTitles}
            units={units}
            error={safeActionError(error, 'Could not reject the proposal')}
          />,
          { status: 422 },
        )
      }
    },
  },
})
