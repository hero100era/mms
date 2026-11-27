-- Drop dependent API views, functions, RLS policies, and cross-schema FKs before Step 4 updates core, fleet, survey, and qual
drop view if exists api.ship_certificates;
drop view if exists api.ship_survey_audits;
drop view if exists api.ship_finding_comments;
drop view if exists api.qualifications;
drop function if exists api.my_qualifications();

drop policy if exists certificate_ext_read on fleet.certificate;
drop policy if exists survey_audit_ext_read on fleet.survey_audit;
drop policy if exists finding_comment_ext_read on fleet.finding_comment;

alter table if exists fleet.finding_comment
  drop constraint if exists finding_comment_type_fk,
  drop constraint if exists finding_comment_status_fk;

drop table if exists survey.comment_line;
