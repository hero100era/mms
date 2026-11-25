export interface SurveyRequestRow {
  id: string
  request_no: string
  ship_id: string
  ship_name: string
  ship_imo_number: string
  org_id: string
  org_name: string
  office_unit_id: string
  station_name: string
  status: 'draft' | 'submitted' | 'accepted' | 'clarification_requested' | 'rejected'
  survey_types: string[]
  port_name: string
  port_country: string
  port_code: string | null
  estimated_arrival: string
  estimated_departure: string
  agent_contact: {
    name?: string
    email?: string
    phone?: string
    company?: string
  }
  scope_description: string | null
  triage_notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  office_unit_code?: string
}

export interface ShipRow {
  id: string
  imo_number: string
  name: string
  ship_type: string
  flag_code: string
  gross_tonnage: number
  build_year: number
  status: string
}

export interface OrgUnitRow {
  id: string
  code: string
  name: string
  unit_type: string
  parent_id?: string | null
  region_code: string | null
  function_code?: string | null
  active: boolean
  valid?: string
}

export interface OrganizationRow {
  id: string
  name: string
  org_type: string
  status?: string
}

export interface DocumentRow {
  id: string
  entity_type: string
  entity_id: string
  doc_type: string
  title: string
  status?: string
  created_at: string
  updated_at?: string
  created_by?: string | null
}

export interface DocumentVersionRow {
  id: string
  document_id: string
  revision_no: number
  version_no?: number
  file_name: string
  mime_type: string
  byte_size: number
  sha256: string
  sha256_hex?: string
  storage_path: string
  scan_status?: string
  scanned_at?: string | null
  threat_name?: string | null
  is_quarantined?: boolean
  created_at: string
  created_by: string | null
}

export interface StaffPositionRow {
  id: string
  user_id: string
  display_name: string
  kind?: string
  job_title_code: string
  job_family: string
  grade?: string | number
  unit_id: string
  unit_code?: string
  unit_name?: string
  unit_type?: string
  line_manager_id?: string | null
  valid: string
  set_by?: string
  reason?: string
}

export interface PositionProposalRow {
  id: string
  user_id: string
  display_name: string
  email: string
  status: string
  job_title_code: string | null
  proposed_job_title_code?: string
  job_title_label: string | null
  unit_id: string | null
  proposed_unit_id?: string
  unit_code: string | null
  unit_name: string | null
  entra_job_title: string | null
  entra_department: string | null
  entra_office: string | null
  proposed_line_manager_id?: string | null
  source: string
  proposed_at: string
  decided_at?: string | null
  decided_by?: string | null
  decision_reason?: string | null
  staff_position_id?: string | null
  notes?: string | null
}

export interface PositionJobTitleRow {
  code: string
  label_en: string
  name?: string
  label_zh?: string | null
  job_family?: string | null
  grade?: number | string
}

export interface PositionUnitRow {
  id: string
  code: string
  name: string
  unit_type?: string
  region_code?: string | null
}

export interface BreakGlassAccountRow {
  user_id: string
  label: string
  last_drill_at?: string | null
  created_at: string
}

export interface UserDirectoryRow {
  id: string
  display_name: string
  kind: string
  status: string
}

export interface ExternalUserRow {
  id: string
  email: string
  display_name: string
  status: string
  created_at: string
  email_verified_at?: string | null
}

export interface StaffDirectoryRow {
  id: string
  display_name: string
  kind: string
  status: string
}

export interface StaffAssignmentRow {
  id: string
  user_id: string
  display_name: string
  db_role: string
  scope_type: string
  scope_unit_id: string | null
  source: string
  valid: string
  revoked_at: string | null
}

export interface AssignableRoleRow {
  role_name: string
  description: string
  eligible: boolean
}

export interface ExplainAuthorityResult {
  allowed: boolean
  reason_code: string
  action_code: string
  rule_id: string | null
  details: Record<string, unknown>
}

export interface AuditEventRow {
  id: string
  occurred_at: string
  tx_id: string
  event_type: string
  outcome: string
  actor_id: string | null
  session_id?: string | null
  db_role: string
  actor_title: string | null
  actor_grade: number | null
  actor_unit_id: string | null
  authority_rule_id: string | null
  subject_type: string | null
  subject_id: string | null
  subject_revision?: number | null
  scope_unit_id: string | null
  request_id?: string | null
  trace_id?: string | null
  source?: string | null
  client_ip?: string | null
  user_agent?: string | null
  reason: string | null
  detail: Record<string, any>
  action?: string
}

export interface AuditChangeRow {
  id: string
  occurred_at: string
  tx_id: string
  schema_name: string
  table_name: string
  op: 'I' | 'U' | 'D'
  row_id?: string | null
}

export interface QualificationRow {
  qualification_code: string
  name: string
  action_code: string
  valid_from?: string
  valid_until?: string | null
}

export interface ApiViews {
  survey_requests: SurveyRequestRow
  ships: ShipRow
  org_units: OrgUnitRow
  organizations: OrganizationRow
  documents: DocumentRow
  document_versions: DocumentVersionRow
  staff_positions: StaffPositionRow
  position_proposals: PositionProposalRow
  position_job_titles: PositionJobTitleRow
  position_units: PositionUnitRow
  break_glass_accounts: BreakGlassAccountRow
  user_directory: UserDirectoryRow
  external_users: ExternalUserRow
  staff_directory: StaffDirectoryRow
  audit_events: AuditEventRow
  audit_changes: AuditChangeRow
  qualifications: QualificationRow
}
