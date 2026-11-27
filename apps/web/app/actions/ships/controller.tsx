import { createController } from 'remix/router'

import { routes } from '../../routes.ts'
import { getPgrst, render, requireAuth } from '../context.ts'
import { actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import { parseUuidOrNull } from '../utils.ts'
import { loadShipDetail, loadShipsList } from './loaders.ts'
import { ShipDetailPage } from './pages/detail.tsx'
import { ShipsListPage } from './pages/list.tsx'

const ALLOWED_STATUS_FILTERS = new Set([
  'all',
  'in_service',
  'laid_up',
  'under_construction',
  'decommissioned',
])

function wantsJsonPayload(request?: Request | null): boolean {
  if (!request) return false
  let accept = request.headers.get('accept') ?? ''
  return accept.includes('application/json') && !accept.includes('text/html')
}

export default createController(routes.ships, {
  actions: {
    async index(context) {
      let auth = requireAuth(context)
      let client = getPgrst(context)

      let url = context.url ?? new URL(context.request.url)
      let q = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
      let rawStatus = url.searchParams.get('status') ?? 'all'
      let status = ALLOWED_STATUS_FILTERS.has(rawStatus) ? rawStatus : 'all'
      let rawType = (url.searchParams.get('type_iacs') ?? 'all').trim()
      let typeIacs = /^[a-z0-9_]{1,20}$/i.test(rawType) ? rawType : 'all'

      let filters = { q, status, typeIacs }
      let { ships, availableTypes } = await loadShipsList(client, filters)

      if (wantsJsonPayload(context.request)) {
        return Response.json(
          { ships, filters, availableTypes },
          { headers: { 'Cache-Control': 'no-store' } },
        )
      }

      return render(
        context,
        <ShipsListPage
          role={auth.activeRole}
          ships={ships}
          filters={filters}
          availableTypes={availableTypes}
        />,
      )
    },

    async detail(context) {
      let auth = requireAuth(context)

      let id = parseUuidOrNull(context.params.id)
      if (!id) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('Vessel not found'), {
            status: 404,
            title: 'Not Found',
            code: 'NOT_FOUND',
            detail: 'Vessel not found',
          })
        }
        return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
      }

      let client = getPgrst(context)
      let detail = await loadShipDetail(client, id)
      if (!detail) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, new Error('Vessel not found'), {
            status: 404,
            title: 'Not Found',
            code: 'NOT_FOUND',
            detail: 'Vessel not found',
          })
        }
        return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
      }

      if (wantsJsonPayload(context.request)) {
        return Response.json(detail, { headers: { 'Cache-Control': 'no-store' } })
      }

      return render(
        context,
        <ShipDetailPage
          role={auth.activeRole}
          ship={detail.ship}
          parties={detail.parties}
          notations={detail.notations}
          certificates={detail.certificates}
          surveyAudits={detail.surveyAudits}
          findings={detail.findings}
          breakdowns={detail.breakdowns}
          breakdownNodes={detail.breakdownNodes}
          breakdownParticulars={detail.breakdownParticulars}
          surveyRequests={detail.surveyRequests}
        />,
      )
    },
  },
})
