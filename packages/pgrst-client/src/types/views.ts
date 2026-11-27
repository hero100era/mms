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
  type_iacs: string
  type_mms: string
  type_other?: string | null
  flag_code: string
  gross_tonnage: number | null
  build_year: number | null
  status: string
  responsible_mts_unit_id?: string | null
  created_at?: string
  updated_at?: string
  class_number?: number
  previous_names?: string | null
  build_date?: string | null
  commissioning_date?: string | null
  keel_laid_date?: string | null
  contract_date?: string | null
  class_entry_date?: string | null
  administration_type?: string
  classed_by?: string | null
  port_of_registry?: string | null
  date_of_registry?: string | null
  registry_number?: string | null
  call_sign?: string | null
  official_number?: string | null
  signal_letter?: string | null
  mmsi_number?: string | null
  class_status?: string | null
  main_class?: string | null
  dual_class?: string | null
  net_tons?: number | null
  national_tons?: number | null
  deadweight?: number | null
  light_ship?: number | null
  ballast_capacity?: number | null
  equipment_number?: number | null
  length?: number | null
  length_oa?: number | null
  length_bp?: number | null
  moulded_depth?: number | null
  moulded_breadth?: number | null
  moulded_draft?: number | null
  design_draft?: number | null
  breakdown_template_id?: number | null
  is_active?: boolean
  responsible_mts_unit_name?: string | null
  flag_name?: string | null
  type_iacs_name?: string | null
  type_mms_name?: string | null
  class_status_name?: string | null
  ship_status_name?: string | null
}

export interface ShipPartyRow {
  id: string
  ship_id: string
  org_id: string
  org_name: string
  org_type: string
  party_role: string
  valid: string
  is_current: boolean
  created_at: string
  updated_at: string
}

export interface ShipClassNotationRow {
  id: string
  ship_id: string
  notation_id: number
  notation_code: string
  notation_symbol: string | null
  notation_name: string
  society_code: string
  group_id: number
  group_code: string
  group_name: string
  status: string
  display_order: number
  assigned_date: string
  effective_date: string | null
  expiry_date: string | null
  resolved_notation: string | null
  last_survey_date: string | null
  next_survey_due: string | null
  survey_cycle_months: number | null
  remarks: string | null
  is_current: boolean
  created_at: string
  updated_at: string
}

export interface ShipCertificateRow {
  id: string
  certificate_no: number
  version: number
  ship_id: string | null
  org_id: string | null
  certificate_template_code: string | null
  status: string
  status_name: string | null
  remarks: string | null
  issuing_society_code: string
  cert_code: string
  validity_type: string
  category: string
  internal_category: string
  description: string | null
  issue_date: string
  expiry_date: string | null
  extended_date: string | null
  doc_administration: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ShipSurveyAuditRow {
  id: string
  ship_id: string | null
  org_id: string | null
  certificate_type_code: string | null
  certificate_id: string | null
  survey_catalog_id: number | null
  survey_catalog_code: string | null
  survey_catalog_name: string | null
  item_kind: 'survey' | 'audit' | 'doc' | null
  description: string
  last_held_date: string
  place_held: string
  next_due_date: string | null
  postponement_date: string | null
  schedule_status: string | null
  schedule_status_name: string | null
  range_from_date: string | null
  range_to_date: string | null
  fee: number | null
  is_ordered: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ShipFindingCommentRow {
  id: string
  ship_id: string | null
  org_id: string | null
  finding_type: string
  finding_type_name: string | null
  is_private: boolean
  date_issued: string
  place_issued: string | null
  due_date: string | null
  status: string
  status_name: string | null
  postponed_due_date: string | null
  mms_reference: string | null
  subject: string
  body: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ShipBreakdownRow {
  id: number
  ship_id: string
  template_id: number | null
  name: string
  description: string | null
  revision: number
  is_active: boolean
  applied_at: string | null
  applied_by: string | null
  created_at: string
  updated_at: string
}

export interface ShipBreakdownNodeRow {
  id: number
  ship_breakdown_id: number
  ship_id: string
  parent_node_id: number | null
  template_node_id: number | null
  code: string
  name: string
  description: string | null
  category: string | null
  node_type: string | null
  level: number
  sort_order: number
  is_from_template: boolean
  is_modified: boolean
  is_active: boolean
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface ShipBreakdownNodeParticularRow {
  id: number
  ship_breakdown_node_id: number
  ship_breakdown_id: number
  ship_id: string
  template_particular_id: number | null
  attr_key: string
  attr_title: string
  attr_value: string | null
  selection_options: unknown
  data_type: string
  unit: string | null
  is_modified: boolean
  sort_order: number
  created_at: string
  updated_at: string
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
  action_codes: string[]
  valid_from?: string
  valid_until?: string | null
}

export interface ApiViews {
  survey_requests: SurveyRequestRow
  ships: ShipRow
  ship_parties: ShipPartyRow
  ship_class_notations: ShipClassNotationRow
  ship_certificates: ShipCertificateRow
  ship_survey_audits: ShipSurveyAuditRow
  ship_finding_comments: ShipFindingCommentRow
  ship_breakdowns: ShipBreakdownRow
  ship_breakdown_nodes: ShipBreakdownNodeRow
  ship_breakdown_node_particulars: ShipBreakdownNodeParticularRow
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
