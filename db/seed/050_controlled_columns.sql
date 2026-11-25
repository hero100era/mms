-- Seed controlled column catalog for Tier 2 event reconciliation (Card H-02).
insert into audit_trail.controlled_column
  (schema_name, table_name, column_name, regulated_event_type, description)
values
  ('survey', 'survey_request', 'status', 'survey.request.*', 'Survey request lifecycle status transition'),
  ('survey', 'survey_request', 'office_unit_id', 'survey.request.*', 'Survey request office station assignment'),
  ('iam', 'staff_position', 'job_title_code', 'iam.position.*', 'Staff position title assignment'),
  ('iam', 'staff_position', 'reason', 'iam.position.*', 'Staff position change justification'),
  ('iam', 'app_user', 'status', 'auth.user.*', 'User account status lifecycle'),
  ('core', 'org_unit', 'active', 'org.unit.*', 'Organisation unit active flag'),
  ('core', 'org_unit', 'unit_type', 'org.unit.*', 'Organisation unit structural type'),
  ('core', 'org_unit', 'parent_id', 'org.unit.*', 'Organisation unit hierarchy parent'),
  ('core', 'document_version', 'storage_path', 'core.document.*', 'Document version storage path and quarantine status'),
  ('fleet', 'ship', 'status', 'fleet.ship.*', 'Commercial vessel service status')
on conflict (schema_name, table_name, column_name) do update
  set regulated_event_type = excluded.regulated_event_type,
      description = excluded.description;
