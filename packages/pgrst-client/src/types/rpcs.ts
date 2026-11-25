import type {
  AssignableRoleRow,
  ExplainAuthorityResult,
  ExternalUserRow,
  StaffAssignmentRow,
  StaffDirectoryRow,
} from './views.ts'

export interface ApiRpcs {
  survey_request_create: {
    args: {
      p_ship_id: string
      p_org_id: string
      p_office_unit_id: string
      p_port_name: string
      p_port_country?: string
      p_port_code?: string | null
      p_estimated_arrival: string
      p_estimated_departure: string
      p_survey_types: string[]
      p_scope_description?: string | null
      p_agent_contact?: Record<string, unknown>
    }
    result: string
  }
  survey_request_submit: {
    args: {
      p_id: string
      p_reason: string
    }
    result: void
  }
  survey_request_accept: {
    args: {
      p_id: string
      p_reason: string
      p_triage_notes?: string
    }
    result: void
  }
  survey_request_request_clarification: {
    args: {
      p_id: string
      p_reason: string
      p_notes?: string
    }
    result: void
  }
  survey_request_reject: {
    args: {
      p_id: string
      p_reason: string
      p_notes?: string
    }
    result: void
  }
  survey_request_transfer: {
    args: {
      p_id: string
      p_new_office_unit_id: string
      p_reason: string
    }
    result: void
  }
  document_create_version: {
    args: {
      p_entity_type: string
      p_entity_id: string
      p_doc_type: string
      p_title: string
      p_file_name: string
      p_mime_type: string
      p_byte_size: number
      p_sha256: string
      p_storage_path: string
    }
    result: string
  }
  document_version_record_scan: {
    args: {
      p_version_id: string
      p_status: string
      p_scanner_engine: string
      p_threat_name?: string | null
      p_promoted_path?: string | null
      p_detail?: Record<string, unknown>
    }
    result: void
  }
  document_version_promote: {
    args: {
      p_version_id: string
      p_storage_path: string
    }
    result: void
  }
  staff_directory: {
    args?: Record<string, never> | Record<string, unknown>
    result: StaffDirectoryRow[]
  }
  staff_assignments: {
    args?: { p_user_id?: string } | Record<string, never>
    result: StaffAssignmentRow[]
  }
  assignable_roles: {
    args?: { p_user_id?: string } | Record<string, never>
    result: AssignableRoleRow[]
  }
  staff_position_set: {
    args: {
      p_user_id: string
      p_job_title_code: string
      p_unit_id: string
      p_family_override?: string | null
      p_line_manager_id?: string | null
      p_valid_from?: string | null
      p_reason: string
    }
    result: void
  }
  staff_position_close: {
    args: {
      p_user_id: string
      p_reason: string
    }
    result: void
  }
  role_assignment_grant: {
    args: {
      p_user_id: string
      p_db_role: string
      p_scope_type: string
      p_scope_unit_id?: string | null
      p_reason: string
    }
    result: void
  }
  role_assignment_revoke: {
    args: {
      p_id: string
      p_reason: string
    }
    result: void
  }
  external_users: {
    args?: Record<string, never> | Record<string, unknown>
    result: ExternalUserRow[]
  }
  create_external_user: {
    args: {
      p_email: string
      p_display_name: string
      p_reason: string
    }
    result: string
  }
  invite_external_user: {
    args: {
      p_user_id: string
      p_reason: string
    }
    result: string
  }
  position_proposal_confirm: {
    args: {
      p_id: string
      p_job_title_code?: string
      p_unit_id?: string
      p_line_manager_id?: string | null
      p_reason: string
    }
    result: void
  }
  position_proposal_reject: {
    args: {
      p_id: string
      p_reason: string
    }
    result: void
  }
  explain_authority: {
    args: {
      p_action_code: string
      p_amount?: number | null
      p_unit_id?: string | null
      p_record_id?: string | null
    }
    result: ExplainAuthorityResult[]
  }
}
