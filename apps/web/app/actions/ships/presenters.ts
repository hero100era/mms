export const SHIP_STATUS_LABELS: Record<string, string> = {
  in_service: 'In Service',
  laid_up: 'Laid Up',
  under_construction: 'Under Construction',
  decommissioned: 'Decommissioned',
}

export const PARTY_ROLE_LABELS: Record<string, string> = {
  registered_owner: 'Registered Owner',
  bareboat_charterer: 'Bareboat Charterer',
  doc_company: 'DOC Company',
  ism_manager: 'ISM Manager',
  isps_operator: 'ISPS Operator',
  commercial_operator: 'Commercial Operator',
  builder: 'Builder',
  agent: 'Agent',
  mlc_owner: 'MLC Owner',
}

export function formatShipStatus(status: string | null | undefined): string {
  if (!status) return 'Unknown'
  return SHIP_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}

export function formatShipType(shipType: string | null | undefined): string {
  if (!shipType) return '—'
  return shipType.replace(/_/g, ' ')
}

export function formatPartyRole(role: string | null | undefined): string {
  if (!role) return '—'
  return PARTY_ROLE_LABELS[role] ?? role.replace(/_/g, ' ')
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  let d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toISOString().slice(0, 10)
}

export function formatNumber(value: number | string | null | undefined, unit?: string): string {
  if (value === null || value === undefined || value === '') return '—'
  let num = typeof value === 'number' ? value : Number(value)
  let formatted = Number.isNaN(num) ? String(value) : num.toLocaleString()
  return unit ? `${formatted} ${unit}` : formatted
}

export function formatText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}
