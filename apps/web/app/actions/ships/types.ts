import type {
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

export type ShipsFilterState = {
  q: string
  status: string
  shipType: string
}

export type ShipsListProps = {
  role: string
  ships: ShipRow[]
  filters: ShipsFilterState
  availableTypes: string[]
  error?: string
}

export type ShipDetailProps = {
  role: string
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
