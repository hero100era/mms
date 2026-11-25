-- Regulated function registry for completeness enforcement.
insert into audit_trail.regulated_function
  (function_schema, function_name, event_type, action_code, description)
values
  ('api', 'staff_position_set', 'iam.position.changed', 'hr.position.set', 'Set staff position and derive role assignments'),
  ('api', 'staff_position_close', 'iam.position.closed', 'hr.position.set', 'Close active staff position and revoke derived assignments'),
  ('api', 'role_assignment_grant', 'iam.assignment.granted', null, 'Manual grant of internal role assignment'),
  ('api', 'role_assignment_revoke', 'iam.assignment.revoked', null, 'Revocation of manual role assignment'),
  ('api', 'create_external_user', 'auth.user.created', 'iam.external_user.create', 'Provision and invite external user'),
  ('api', 'invite_external_user', 'auth.invite.created', 'iam.external_user.create', 'Re-issue external user invite'),
  ('api', 'user_suspend', 'auth.user.suspended', 'iam.external_user.create', 'Suspend external user account'),
  ('api', 'user_reactivate', 'auth.user.reactivated', 'iam.external_user.create', 'Reactivate suspended external user account'),
  ('api', 'membership_grant', 'auth.membership.granted', 'iam.external_user.create', 'Grant organization membership'),
  ('api', 'membership_revoke', 'auth.membership.revoked', 'iam.external_user.create', 'Revoke organization membership'),
  ('api', 'org_unit_create', 'org.unit.created', null, 'Create organizational unit'),
  ('api', 'org_unit_update', 'org.unit.changed', null, 'Update organizational unit details'),
  ('api', 'org_unit_close', 'org.unit.closed', null, 'Close organizational unit'),
  ('api', 'org_coverage_set', 'org.coverage.granted', null, 'Grant organizational coverage'),
  ('api', 'org_coverage_end', 'org.coverage.ended', null, 'End organizational coverage'),
  ('api', 'routing_rule_set', 'org.routing_rule.changed', null, 'Set routing rule for work type')
on conflict (function_schema, function_name) do update
  set event_type = excluded.event_type,
      action_code = excluded.action_code,
      description = excluded.description;
