-- Drop api.ship_survey_audits and columns referencing core.survey_status_enum before pgschema updates core
drop view if exists api.ship_survey_audits;

alter table if exists fleet.survey_audit
  drop column if exists survey_status;

alter table if exists survey.survey_line
  drop column if exists survey_status;
