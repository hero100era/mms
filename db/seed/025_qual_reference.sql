-- Qualification catalog reference data.
-- Cards H-14, H-15, H-16: qualifications required for regulated sign-off actions.

insert into qual.qualification (code, name, action_code, job_family, description) values
  ('survey.report.release', 'Survey Report Release Qualification', 'survey.report.release', 'survey', 'Qualification required to release survey reports'),
  ('survey.report.countersign', 'Survey Report Countersign Qualification', 'survey.report.countersign', 'survey', 'Qualification required to countersign survey reports'),
  ('audit_trail.report.release', 'Audit Report Release Qualification', 'audit_trail.report.release', 'audit', 'Qualification required to release audit reports'),
  ('mts.report.technical_review', 'MTS Technical Review Qualification', 'mts.report.technical_review', 'mts', 'Qualification required for MTS technical review'),
  ('mts.condition_of_class.approve', 'MTS Condition of Class Approval Qualification', 'mts.condition_of_class.approve', 'mts', 'Qualification required to approve conditions of class'),
  ('plan.drawing.approve', 'Plan Drawing Approval Qualification', 'plan.drawing.approve', 'plan', 'Qualification required to approve plan drawings')
on conflict (code) do update
  set name = excluded.name,
      action_code = excluded.action_code,
      job_family = excluded.job_family,
      description = excluded.description;

insert into qual.qualification_action (qualification_code, action_code) values
  ('survey.report.release', 'survey.report.release'),
  ('survey.report.countersign', 'survey.report.countersign'),
  ('audit_trail.report.release', 'audit_trail.report.release'),
  ('mts.report.technical_review', 'mts.report.technical_review'),
  ('mts.condition_of_class.approve', 'mts.condition_of_class.approve'),
  ('plan.drawing.approve', 'plan.drawing.approve')
on conflict (qualification_code, action_code) do nothing;
