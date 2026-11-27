import type {
  PgrstClient,
  ShipBreakdownNodeParticularRow,
  ShipBreakdownNodeRow,
  ShipBreakdownRow,
  ShipCertificateRow,
  ShipClassNotationRow,
  ShipFindingCommentRow,
  ShipPartyRow,
  ShipRow,
  ShipSurveyAuditRow,
  SurveyRequestRow,
} from '@mms/pgrst-client'

import type { ShipsFilterState } from './types.ts'

export interface ShipDetailData {
  ship: ShipRow
  parties: ShipPartyRow[]
  notations: ShipClassNotationRow[]
  certificates: ShipCertificateRow[]
  surveyAudits: ShipSurveyAuditRow[]
  findings: ShipFindingCommentRow[]
  breakdowns: ShipBreakdownRow[]
  breakdownNodes: ShipBreakdownNodeRow[]
  breakdownParticulars: ShipBreakdownNodeParticularRow[]
  surveyRequests: SurveyRequestRow[]
}

export async function loadShipsList(
  client: PgrstClient,
  filters: ShipsFilterState,
): Promise<{ ships: ShipRow[]; availableTypes: string[] }> {
  let allShips = (await client.select('ships', { order: 'name.asc' })) ?? []

  let typeSet = new Set<string>()
  for (let ship of allShips) {
    if (ship.ship_type) typeSet.add(ship.ship_type)
  }
  let availableTypes = Array.from(typeSet).sort()

  let query = filters.q.trim().toLowerCase()
  let ships = allShips.filter((ship) => {
    if (filters.status !== 'all' && ship.status !== filters.status) {
      return false
    }
    if (filters.shipType !== 'all' && ship.ship_type !== filters.shipType) {
      return false
    }
    if (query.length > 0) {
      let haystack = [
        ship.name,
        ship.imo_number,
        ship.class_number != null ? String(ship.class_number) : '',
        ship.call_sign ?? '',
        ship.mmsi_number ?? '',
        ship.port_of_registry ?? '',
        ship.flag_code ?? '',
        ship.flag_name ?? '',
      ]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(query)) {
        return false
      }
    }
    return true
  })

  return { ships, availableTypes }
}

export async function loadShipDetail(
  client: PgrstClient,
  id: string,
): Promise<ShipDetailData | null> {
  let ships: ShipRow[] = []
  try {
    ships = await client.select('ships', { id: `eq.${id}` })
  } catch {
    return null
  }

  if (!ships || ships.length === 0) {
    return null
  }

  let ship = ships[0]!
  let [
    parties,
    notations,
    certificates,
    surveyAudits,
    findings,
    breakdowns,
    breakdownNodes,
    breakdownParticulars,
    surveyRequests,
  ] = await Promise.all([
    client.select('ship_parties', { ship_id: `eq.${id}`, order: 'party_role.asc' }).catch(() => []),
    client
      .select('ship_class_notations', { ship_id: `eq.${id}`, order: 'display_order.asc' })
      .catch(() => []),
    client
      .select('ship_certificates', { ship_id: `eq.${id}`, order: 'expiry_date.asc' })
      .catch(() => []),
    client
      .select('ship_survey_audits', { ship_id: `eq.${id}`, order: 'next_due_date.asc' })
      .catch(() => []),
    client
      .select('ship_finding_comments', { ship_id: `eq.${id}`, order: 'date_issued.desc' })
      .catch(() => []),
    client
      .select('ship_breakdowns', { ship_id: `eq.${id}`, order: 'revision.desc' })
      .catch(() => []),
    client
      .select('ship_breakdown_nodes', { ship_id: `eq.${id}`, order: 'level.asc,sort_order.asc' })
      .catch(() => []),
    client
      .select('ship_breakdown_node_particulars', { ship_id: `eq.${id}`, order: 'sort_order.asc' })
      .catch(() => []),
    client
      .select('survey_requests', { ship_id: `eq.${id}`, order: 'created_at.desc' })
      .catch(() => []),
  ])

  return {
    ship,
    parties: parties ?? [],
    notations: notations ?? [],
    certificates: certificates ?? [],
    surveyAudits: surveyAudits ?? [],
    findings: findings ?? [],
    breakdowns: breakdowns ?? [],
    breakdownNodes: breakdownNodes ?? [],
    breakdownParticulars: breakdownParticulars ?? [],
    surveyRequests: surveyRequests ?? [],
  }
}
