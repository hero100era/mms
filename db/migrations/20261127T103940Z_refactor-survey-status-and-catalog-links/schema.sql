-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

DROP TYPE IF EXISTS survey_status_enum RESTRICT;

CREATE TYPE survey_execution_status_enum AS ENUM (
    'partial',
    'scheduled',
    'executing',
    'completed',
    'postponed'
);

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER TABLE survey_audit
ADD COLUMN schedule_status varchar(2) CONSTRAINT survey_audit_schedule_status_fkey REFERENCES core.survey_audit_status (code);

-- ===== schema: survey  (pgschema 1.14.1) =====

set local search_path = survey;

ALTER TABLE job DROP CONSTRAINT job_type_ck;

ALTER TABLE survey.job
ADD CONSTRAINT job_type_ck CHECK (job_type IN ('survey'::text, 'audit'::text, 'doc'::text)) NOT VALID;

ALTER TABLE survey.job VALIDATE CONSTRAINT job_type_ck;

ALTER TABLE survey_line ADD COLUMN execution_status core.survey_execution_status_enum;

ALTER TABLE survey_request_item DROP COLUMN occ_survey_code;

ALTER TABLE survey_request_item
ADD COLUMN survey_catalog_id integer CONSTRAINT survey_request_item_catalog_fk REFERENCES core.survey_audit_catalog (id) ON DELETE SET NULL;

ALTER TABLE survey.survey_request_item
ADD CONSTRAINT survey_request_item_target_ck CHECK (num_nonnulls(survey_audit_id, finding_comment_id, survey_catalog_id) = 1) NOT VALID;

ALTER TABLE survey.survey_request_item VALIDATE CONSTRAINT survey_request_item_target_ck;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE VIEW ship_survey_audits WITH (security_invoker=true) AS
 SELECT sa.id,
    sa.ship_id,
    sa.company_id,
    sa.certificate_type_code,
    sa.certificate_id,
    sa.survey_catalog_id,
    sac.code AS survey_catalog_code,
    sac.name AS survey_catalog_name,
    sac.item_kind,
    sa.description,
    sa.last_held_date,
    sa.place_held,
    sa.next_due_date,
    sa.postponement_date,
    sa.schedule_status,
    sas.name AS schedule_status_name,
    sa.range_from_date,
    sa.range_to_date,
    sa.fee,
    sa.is_ordered,
    sa.is_active,
    sa.created_at,
    sa.updated_at
   FROM fleet.survey_audit sa
     LEFT JOIN core.survey_audit_catalog sac ON sac.id = sa.survey_catalog_id
     LEFT JOIN core.survey_audit_status sas ON sas.code::text = sa.schedule_status::text;

GRANT SELECT ON TABLE ship_survey_audits TO ext_user;

GRANT SELECT ON TABLE ship_survey_audits TO int_auditor;

GRANT SELECT ON TABLE ship_survey_audits TO int_compliance;

GRANT SELECT ON TABLE ship_survey_audits TO int_coordinator;

GRANT SELECT ON TABLE ship_survey_audits TO int_finance;

GRANT SELECT ON TABLE ship_survey_audits TO int_hr;

GRANT SELECT ON TABLE ship_survey_audits TO int_manager;

GRANT SELECT ON TABLE ship_survey_audits TO int_surveyor;

GRANT SELECT ON TABLE ship_survey_audits TO int_sysadmin;

GRANT SELECT ON TABLE ship_survey_audits TO int_viewer;
