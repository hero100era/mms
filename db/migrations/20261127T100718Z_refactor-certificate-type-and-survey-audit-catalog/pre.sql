-- Drop dependent cross-schema & intra-core constraints/views before pgschema updates core
drop view if exists api.ship_survey_audits;

alter table if exists core.certificate_template
  drop constraint if exists certificate_template_cert_code_fkey;

alter table if exists core.flag_cert_authorization
  drop constraint if exists flag_cert_authorization_cert_code_fkey;

alter table if exists fleet.certificate
  drop constraint if exists certificate_cert_code_fk;

alter table if exists fleet.survey_audit
  drop constraint if exists survey_audit_cert_code_fk,
  drop constraint if exists survey_audit_pool_fk;

alter table if exists survey.survey_request_item
  drop constraint if exists survey_request_item_occ_fk;

alter table if exists survey.certificate_line
  drop constraint if exists certificate_line_cert_code_fk;

alter table if exists survey.survey_line
  drop constraint if exists survey_line_pool_fk;
