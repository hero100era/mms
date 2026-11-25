-- IAM reference data. Capability roles are cluster-level (bootstrap); these
-- rows are the in-database mirror. Rules reference only roles created in F-02.

insert into iam.db_role (role_name, kind, description) values
  ('web_anon', 'anon', 'Public website'),
  ('ext_user', 'external', 'All external users'),
  ('int_viewer', 'internal', 'All staff baseline'),
  ('int_surveyor', 'internal', 'Station surveyors'),
  ('int_auditor', 'internal', 'Station auditors'),
  ('int_coordinator', 'internal', 'Office administration'),
  ('int_manager', 'internal', 'Line management'),
  ('int_compliance', 'internal', 'HO compliance'),
  ('int_hr', 'internal', 'Human resources'),
  ('int_finance', 'internal', 'Finance'),
  ('int_sysadmin', 'internal', 'IT system administration')
on conflict (role_name) do update
  set kind = excluded.kind, description = excluded.description;

insert into iam.job_family (code, label_en, label_zh) values
  ('survey', 'Survey', '检验'),
  ('audit', 'Audit', '审核'),
  ('plan', 'Plan approval', '图纸审批'),
  ('mts', 'MTS', '海事技术服务'),
  ('compliance', 'Compliance', '合规'),
  ('management', 'Management', '管理'),
  ('hr', 'Human resources', '人力资源'),
  ('finance', 'Finance', '财务'),
  ('office_admin', 'Office administration', '行政')
on conflict (code) do update
  set label_en = excluded.label_en, label_zh = excluded.label_zh;

insert into iam.job_grade (grade, label_en) values
  (0, 'Intern'), (1, 'Junior'), (2, 'Officer/Engineer'), (3, 'Senior'),
  (4, 'Principal/Manager'), (5, 'Senior manager'), (6, 'Director'),
  (7, 'Senior director'), (8, 'Managing director')
on conflict (grade) do update set label_en = excluded.label_en;

insert into iam.job_title (code, label_en, job_family, grade) values
  ('interns', 'Interns', null, 0),
  ('junior_surveyors', 'Junior surveyors', 'survey', 1),
  ('surveyors', 'Surveyors', 'survey', 2),
  ('senior_surveyors', 'Senior surveyors', 'survey', 3),
  ('principal_surveyors', 'Principal surveyors', 'survey', 4),
  ('auditors', 'Auditors', 'audit', 2),
  ('senior_auditors', 'Senior auditors', 'audit', 3),
  ('principal_auditors', 'Principal auditors', 'audit', 4),
  ('junior_engineers', 'Junior engineers', null, 1),
  ('engineers', 'Engineers', null, 2),
  ('senior_engineers', 'Senior engineers', null, 3),
  ('principal_engineers', 'Principal engineers', null, 4),
  ('compliance_officers', 'Compliance officers', 'compliance', 2),
  ('senior_compliance_officers', 'Senior compliance officers', 'compliance', 3),
  ('managers', 'Managers', 'management', 4),
  ('senior_managers', 'Senior managers', 'management', 5),
  ('directors', 'Directors', 'management', 6),
  ('senior_directors', 'Senior directors', 'management', 7),
  ('managing_directors', 'Managing directors', 'management', 8),
  ('hr', 'HR', 'hr', 2),
  ('senior_hr', 'Senior HR', 'hr', 3),
  ('hr_executives', 'HR executives', 'hr', 2),
  ('hr_managers', 'HR managers', 'hr', 4),
  ('hr_directors', 'HR directors', 'hr', 6),
  ('finance', 'Finance', 'finance', 2),
  ('senior_finance', 'Senior finance', 'finance', 3),
  ('finance_executives', 'Finance executives', 'finance', 2),
  ('finance_managers', 'Finance managers', 'finance', 4),
  ('finance_directors', 'Finance directors', 'finance', 6),
  ('admins', 'Administrators', 'office_admin', 2),
  ('senior_admins', 'Senior administrators', 'office_admin', 3),
  ('admin_managers', 'Administration managers', 'office_admin', 4),
  ('admin_directors', 'Administration directors', 'office_admin', 6)
on conflict (code) do update
  set label_en = excluded.label_en, job_family = excluded.job_family, grade = excluded.grade;

insert into iam.default_role_rule
  (unit_type, unit_function, job_family, min_grade, max_grade, db_role, scope_target)
select v.unit_type, v.unit_function, v.job_family, v.min_grade, v.max_grade, v.db_role, v.scope_target
  from (values
    (null::text, null::text, null::text, 0, 8, 'int_viewer', 'own_unit'),
    ('station', null, 'survey', 1, 3, 'int_surveyor', 'own_unit'),
    ('station', null, 'survey', 4, 4, 'int_surveyor', 'parent_unit'),
    ('station', null, 'audit', 2, 3, 'int_auditor', 'own_unit'),
    ('station', null, 'audit', 4, 4, 'int_auditor', 'parent_unit'),
    ('station', null, 'management', 4, 5, 'int_manager', 'own_unit'),
    ('station', null, 'office_admin', 2, 6, 'int_coordinator', 'own_unit'),
    ('regional_office', null, 'management', 4, 8, 'int_manager', 'own_unit'),
    ('regional_office', null, 'office_admin', 2, 6, 'int_coordinator', 'own_unit'),
    ('plan_approval_centre', null, 'management', 4, 6, 'int_manager', 'own_unit'),
    ('plan_approval_centre', null, 'office_admin', 2, 4, 'int_coordinator', 'own_unit'),
    ('mts_centre', null, 'management', 4, 6, 'int_manager', 'own_unit'),
    ('ho_department', null, 'compliance', 2, 8, 'int_compliance', 'global'),
    ('ho_department', null, 'management', 2, 8, 'int_compliance', 'global'),
    (null, null, 'hr', 2, 6, 'int_hr', 'own_unit'),
    (null, null, 'finance', 2, 6, 'int_finance', 'own_unit'),
    ('head_office', null, 'management', 6, 8, 'int_manager', 'global')
  ) as v(unit_type, unit_function, job_family, min_grade, max_grade, db_role, scope_target)
 where not exists (
   select 1 from iam.default_role_rule r
    where r.unit_type is not distinct from v.unit_type
      and r.unit_function is not distinct from v.unit_function
      and r.job_family is not distinct from v.job_family
      and r.min_grade = v.min_grade
      and r.max_grade = v.max_grade
      and r.db_role = v.db_role
      and r.scope_target = v.scope_target
 );

insert into iam.authority_rule
  (action_code, db_role, job_family, unit_type, min_grade, max_amount, currency, requires_qualification)
select v.action_code, v.db_role, v.job_family, v.unit_type, v.min_grade, v.max_amount, v.currency, v.requires_qualification
  from (values
    ('survey.request.triage', 'int_coordinator', 'office_admin', 'station', 2, null::numeric, null::char(3), false),
    ('survey.job.assign', 'int_manager', null, 'station', 4, null, null, false),
    ('survey.job.assign', 'int_manager', null, 'regional_office', 4, null, null, false),
    ('survey.report.release', 'int_surveyor', 'survey', 'station', 2, null, null, true),
    ('survey.report.countersign', 'int_surveyor', 'survey', 'station', 3, null, null, true),
    ('audit_trail.report.release', 'int_auditor', 'audit', 'station', 2, null, null, true),
    ('compliance.finding.raise', 'int_compliance', 'compliance', 'ho_department', 2, null, null, false),
    ('compliance.record.hold', 'int_compliance', 'compliance', 'ho_department', 3, null, null, false),
    ('billing.credit_note.approve', 'int_finance', 'finance', null, 4, 10000.00, 'USD', false),
    ('billing.credit_note.approve', 'int_finance', 'finance', null, 6, null, null, false),
    ('hr.position.set', 'int_hr', 'hr', null, 3, null, null, false),
    ('iam.external_user.create', 'int_coordinator', 'office_admin', null, 2, null, null, false),
    ('audit_trail.trail.read', 'int_compliance', null, null, 2, null, null, false),
    ('audit_trail.trail.read', 'int_manager', null, null, 4, null, null, false),
    ('plan.submission.reroute', 'int_manager', null, 'plan_approval_centre', 4, null, null, false),
    -- Delegated organisation administration (ADR-0018, Q4). A regional
    -- administrator may create children under a unit they already administer and
    -- close descendants; re-parenting and coverage stay sysadmin-only.
    ('org.unit.create', 'int_coordinator', null, 'regional_office', 3, null, null, false),
    ('org.unit.create', 'int_manager', null, 'regional_office', 3, null, null, false),
    ('org.unit.close', 'int_manager', null, 'regional_office', 4, null, null, false)
  ) as v(action_code, db_role, job_family, unit_type, min_grade, max_amount, currency, requires_qualification)
 where not exists (
   select 1 from iam.authority_rule r
    where r.action_code = v.action_code
      and r.db_role = v.db_role
      and r.job_family is not distinct from v.job_family
      and r.unit_type is not distinct from v.unit_type
      and r.min_grade = v.min_grade
      and r.max_amount is not distinct from v.max_amount
      and r.currency is not distinct from v.currency
      and r.requires_qualification = v.requires_qualification
 );

-- R1.6 / ADR-0022: operations a break-glass session must never perform.
-- Regulated approvals and signing are named explicitly even though their RPCs
-- belong to R9, so a future implementation cannot route around the matrix.
insert into iam.break_glass_forbidden_action (action_code, description)
select v.action_code, v.description
  from (values
    ('hr.position.set', 'HR decision: set or change a staff position'),
    ('survey.request.triage', 'Operational decision: triage or accept survey request'),
    ('survey.job.assign', 'Operational decision: assign a survey job'),
    ('survey.report.release', 'Regulated approval: release a survey report'),
    ('survey.report.countersign', 'Regulated approval: countersign a survey report'),
    ('audit_trail.report.release', 'Regulated approval: release an audit report'),
    ('billing.credit_note.approve', 'Financial approval'),
    ('compliance.record.hold', 'Compliance decision: place a record on hold'),
    ('plan.submission.reroute', 'Operational decision: reroute a plan submission'),
    ('qual.grant', 'Qualification decision: grant staff qualification'),
    ('qual.revoke', 'Qualification decision: revoke staff qualification'),
    ('certificate.issue', 'Certificate issuance (R9 reserved code)'),
    ('certificate.sign', 'Certificate signing (R9 reserved code)'),
    ('cert.issue', 'Certificate issuance'),
    ('cert.cancel', 'Certificate cancellation'),
    ('cert.revoke', 'Certificate revocation'),
    ('report.sign', 'Report signing (R9 reserved code)'),
    ('survey.conclude', 'Survey conclusion (R9 reserved code)'),
    ('audit_trail.conclude', 'Audit conclusion (R9 reserved code)'),
    ('qualification.approve', 'Qualification approval (R9 reserved code)'),
    ('financial.approval', 'Financial approval (R9 reserved code)')
  ) as v(action_code, description)
 where not exists (
   select 1 from iam.break_glass_forbidden_action f where f.action_code = v.action_code
 );

insert into iam.app_user (id, kind, display_name, service_name, status)
values ('00000000-0000-0000-0000-000000000001', 'service', 'Outbox Worker', 'worker', 'active')
on conflict (service_name) do update
  set display_name = excluded.display_name, status = excluded.status;
