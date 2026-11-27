CREATE INDEX CONCURRENTLY IF NOT EXISTS checklist_section_catalog_id_ix ON core.checklist_section (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS flag_survey_auth_catalog_id_ix ON core.flag_survey_authorization (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS report_template_catalog_id_ix ON core.report_template (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_doc_catalog_id_ix ON core.survey_documentation (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_prep_catalog_id_ix ON core.survey_preparation (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_prep_section_catalog_id_ix ON core.survey_preparation_section (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_audit_catalog_ix ON fleet.survey_audit (survey_catalog_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS survey_line_catalog_ix ON survey.survey_line (survey_catalog_id);
