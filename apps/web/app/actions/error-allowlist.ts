export interface AllowlistedMessageEntry {
  publicMessage: string
  owner: string
  removalTarget: string
}

export const EXACT_MESSAGE_ALLOWLIST: Record<string, AllowlistedMessageEntry> = {
  creator_cannot_approve: {
    publicMessage: 'Action rejected: creator_cannot_approve (creator cannot approve their own survey request)',
    owner: 'workflow-team',
    removalTarget: 'Phase-P1',
  },
  cannot_confirm_own_proposal: {
    publicMessage: 'Action rejected: cannot_confirm_own_proposal (cannot confirm own position proposal)',
    owner: 'workflow-team',
    removalTarget: 'Phase-P1',
  },
  cannot_grant_self: {
    publicMessage: 'Action rejected: cannot_grant_self (cannot grant qualification to yourself)',
    owner: 'iam-team',
    removalTarget: 'Phase-P1',
  },
  cannot_revoke_self: {
    publicMessage: 'Action rejected: cannot_revoke_self (cannot revoke qualification from yourself)',
    owner: 'iam-team',
    removalTarget: 'Phase-P1',
  },
  break_glass_forbidden: {
    publicMessage: 'Action rejected: break_glass_forbidden (action not permitted under break-glass)',
    owner: 'security-team',
    removalTarget: 'Phase-P1',
  },
  sysadmin_cannot_approve: {
    publicMessage: 'Action rejected: sysadmin_cannot_approve (sysadmin cannot approve regulated actions)',
    owner: 'security-team',
    removalTarget: 'Phase-P1',
  },
  insufficient_privilege: {
    publicMessage: 'Insufficient privileges to perform this operation.',
    owner: 'security-team',
    removalTarget: 'Phase-P1',
  },
  insufficient_authority: {
    publicMessage: 'Insufficient authority to perform this operation.',
    owner: 'security-team',
    removalTarget: 'Phase-P1',
  },
  reason_required: {
    publicMessage: 'A valid reason is required for this action.',
    owner: 'workflow-team',
    removalTarget: 'Phase-P1',
  },
  not_found: {
    publicMessage: 'The requested resource was not found.',
    owner: 'core-team',
    removalTarget: 'Phase-P1',
  },
  survey_request_not_found: {
    publicMessage: 'The survey request was not found.',
    owner: 'survey-team',
    removalTarget: 'Phase-P1',
  },
  document_not_found: {
    publicMessage: 'The requested document was not found.',
    owner: 'upload-team',
    removalTarget: 'Phase-P1',
  },
  version_not_found: {
    publicMessage: 'The requested document version was not found.',
    owner: 'upload-team',
    removalTarget: 'Phase-P1',
  },
}
