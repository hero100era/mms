import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getPgrst, render, requireAuth, forbiddenResponse } from '../context.ts'
import { NewSurveyRequestPage, SurveyDetailPage, SurveyListPage } from '../survey-pages.tsx'
import { parseUuidOrNull } from '../utils.ts'
import { actionProblemResponse, classifyActionError, isJsonOrProblemRequest, safeActionError } from '../errors.ts'
import { ensureText, optionalText, validateOptionalString, validateReason, validateUuid } from '../validation.ts'
import { loadSurveyDetail, loadSurveyFormLookups } from './loaders.ts'

export default createController(routes.survey, {
  actions: {
    async index(context) {
      let auth = requireAuth(context)

      let client = getPgrst(context)
      let [requests, ships] = await Promise.all([
        client.select('survey_requests', { order: 'created_at.desc' }),
        client.select('ships', { order: 'name.asc' }),
      ])

      return render(
        context,
        <SurveyListPage
          csrf={getCsrfToken(context)}
          role={auth.activeRole}
          requests={requests || []}
          ships={ships || []}
        />,
      )
    },
    async new(context) {
      let auth = requireAuth(context)

      let client = getPgrst(context)
      let [ships, stations, orgs] = await loadSurveyFormLookups(client)

      return render(
        context,
        <NewSurveyRequestPage
          csrf={getCsrfToken(context)}
          ships={ships || []}
          stations={stations || []}
          orgs={orgs || []}
        />,
      )
    },
    async create(context) {
      let auth = requireAuth(context)

      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)

      let rawShipId = optionalText(form, 'ship_id')
      let rawOfficeUnitId = optionalText(form, 'office_unit_id')
      let rawPortName = optionalText(form, 'port_name')
      let rawPortCountry = optionalText(form, 'port_country') || 'CN'
      let rawPortCode = optionalText(form, 'port_code')
      let rawEstimatedArrival = optionalText(form, 'estimated_arrival')
      let rawEstimatedDeparture = optionalText(form, 'estimated_departure')
      let rawScopeDescription = optionalText(form, 'scope_description')
      let rawSubmitAction = optionalText(form, 'submit_action')
      let rawSurveyTypes = form.getAll('survey_types').filter(Boolean).map(String)
      if (rawSurveyTypes.length === 0) {
        let single = optionalText(form, 'survey_types')
        if (single) rawSurveyTypes = [single]
      }
      let rawAgentName = optionalText(form, 'agent_name')
      let rawAgentEmail = optionalText(form, 'agent_email')
      let rawAgentPhone = optionalText(form, 'agent_phone')
      let rawOrgId = optionalText(form, 'org_id')

      try {
        let shipId = validateUuid(rawShipId, 'ship_id')
        let officeUnitId = validateUuid(rawOfficeUnitId, 'office_unit_id')
        let portName = ensureText(rawPortName, 'port_name')
        let portCountry = validateOptionalString(rawPortCountry, 'port_country') || 'CN'
        let portCode = validateOptionalString(rawPortCode, 'port_code')
        let estimatedArrival = rawEstimatedArrival
        let estimatedDeparture = rawEstimatedDeparture
        let scopeDescription = validateOptionalString(rawScopeDescription, 'scope_description')
        let submitAction = validateOptionalString(rawSubmitAction, 'submit_action')
        let surveyTypes = rawSurveyTypes

        let agentContact = {
          name: validateOptionalString(rawAgentName, 'agent_name') || undefined,
          email: validateOptionalString(rawAgentEmail, 'agent_email') || undefined,
          phone: validateOptionalString(rawAgentPhone, 'agent_phone') || undefined,
        }

        let orgId = parseUuidOrNull(rawOrgId)
        if (!orgId) {
          let orgs = await client.select('organizations', { limit: '1' })
          if (orgs && orgs.length > 0) {
            orgId = orgs[0].id
          }
        }

        let newId = await client.rpc('survey_request_create', {
          p_ship_id: shipId,
          p_org_id: orgId!,
          p_office_unit_id: officeUnitId,
          p_port_name: portName,
          p_port_country: portCountry,
          p_port_code: portCode,
          p_estimated_arrival: estimatedArrival
            ? new Date(estimatedArrival).toISOString()
            : new Date(Date.now() + 7 * 86400000).toISOString(),
          p_estimated_departure: estimatedDeparture
            ? new Date(estimatedDeparture).toISOString()
            : new Date(Date.now() + 10 * 86400000).toISOString(),
          p_survey_types: surveyTypes,
          p_scope_description: scopeDescription,
          p_agent_contact: agentContact,
        })

        if (submitAction === 'submit') {
          await client.rpc('survey_request_submit', {
            p_id: newId,
            p_reason: 'Initial submission for station triage',
          })
        }

        return redirect(routes.survey.detail.href({ id: newId }))
      } catch (error: any) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }

        if (classifyActionError(error) === 'privilege') {
          return forbiddenResponse(context, 'Forbidden')
        }

        let [ships, stations, orgs] = await loadSurveyFormLookups(client)

        return render(
          context,
          <NewSurveyRequestPage
            csrf={getCsrfToken(context)}
            ships={ships || []}
            stations={stations || []}
            orgs={orgs || []}
            values={{
              ship_id: String(rawShipId ?? ''),
              org_id: String(rawOrgId ?? ''),
              office_unit_id: String(rawOfficeUnitId ?? ''),
              port_name: String(rawPortName ?? ''),
              port_country: rawPortCountry,
              port_code: rawPortCode ?? undefined,
              estimated_arrival: rawEstimatedArrival ?? '',
              estimated_departure: rawEstimatedDeparture ?? '',
              survey_types: rawSurveyTypes,
              scope_description: rawScopeDescription ?? undefined,
              agent_name: rawAgentName ?? undefined,
              agent_email: rawAgentEmail ?? undefined,
              agent_phone: rawAgentPhone ?? undefined,
            }}
            error={safeActionError(error, 'Failed to create survey request')}
          />,
          { status: 422 },
        )
      }
    },
    async detail(context) {
      let auth = requireAuth(context)

      let id = parseUuidOrNull(context.params.id)
      if (!id) {
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

      let client = getPgrst(context)
      let detail = await loadSurveyDetail(client, id, { includeAudit: true })
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
        <SurveyDetailPage
          csrf={getCsrfToken(context)}
          role={auth.activeRole}
          request={detail.request}
          documents={detail.documents}
          versions={detail.versions}
          auditEvents={detail.auditEvents}
        />,
      )
    },
    async submit(context) {
      let auth = requireAuth(context)

      let id = parseUuidOrNull(context.params.id)
      if (!id) {
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

      let form = (await context.get(FormData)) as FormData
      let reason = validateReason(optionalText(form, 'reason') || 'Submitted survey request')
      let client = getPgrst(context)

      try {
        await client.rpc('survey_request_submit', {
          p_id: id,
          p_reason: reason,
        })
        return redirect(routes.survey.detail.href({ id }))
      } catch (error: any) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }

        let kind = classifyActionError(error)
        if (kind === 'privilege') {
          return forbiddenResponse(context, 'Forbidden')
        }
        if (kind === 'not_found') {
          return new Response('Not Found', { status: 404 })
        }

        let detail = await loadSurveyDetail(client, id, { includeAudit: false })
        if (!detail) {
          return new Response('Not Found', { status: 404 })
        }

        return render(
          context,
          <SurveyDetailPage
            csrf={getCsrfToken(context)}
            role={auth.activeRole}
            request={detail.request}
            documents={detail.documents}
            versions={detail.versions}
            error={safeActionError(error, 'Could not submit survey request')}
          />,
          { status: 422 },
        )
      }
    },
  },
})
