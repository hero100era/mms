import type {
  AuditEventRow,
  DocumentVersionRow,
  OrganizationRow,
  OrgUnitRow,
  ShipRow,
  SurveyRequestRow,
} from '@mms/pgrst-client'

export type SurveyRequestItem = SurveyRequestRow
export type ShipItem = ShipRow
export type StationItem = OrgUnitRow
export type OrgItem = OrganizationRow
export type DocumentVersionItem = DocumentVersionRow
export type AuditEventItem = AuditEventRow

export type SurveyListProps = {
  csrf: string
  role: string
  requests: SurveyRequestItem[]
  ships: ShipItem[]
  message?: string
  error?: string
}

export type NewSurveyProps = {
  csrf: string
  ships: ShipItem[]
  stations: StationItem[]
  orgs: OrgItem[]
  error?: string
  values?: {
    ship_id?: string
    org_id?: string
    office_unit_id?: string
    port_name?: string
    port_country?: string
    port_code?: string
    estimated_arrival?: string
    estimated_departure?: string
    scope_description?: string
    survey_types?: string[]
    agent_name?: string
    agent_company?: string
    agent_email?: string
    agent_phone?: string
  }
}

export type SurveyDetailProps = {
  csrf: string
  role: string
  request: SurveyRequestItem
  documents?: any[]
  versions?: DocumentVersionItem[]
  auditEvents?: AuditEventItem[]
  message?: string
  error?: string
}

export type TriageQueueProps = {
  csrf: string
  role: string
  requests: SurveyRequestItem[]
  currentFilter: string
  message?: string
  error?: string
}

export type TriageDetailProps = {
  csrf: string
  role: string
  request: SurveyRequestItem
  documents?: any[]
  versions?: DocumentVersionItem[]
  stations: StationItem[]
  auditEvents?: AuditEventItem[]
  message?: string
  error?: string
}
