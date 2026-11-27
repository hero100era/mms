-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

REVOKE SELECT ON TABLE certificate_survey_pool FROM ext_user;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_auditor;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_compliance;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_coordinator;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_finance;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_hr;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_manager;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_surveyor;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_sysadmin;

REVOKE SELECT ON TABLE certificate_survey_pool FROM int_viewer;

REVOKE SELECT ON TABLE survey_pool FROM ext_user;

REVOKE SELECT ON TABLE survey_pool FROM int_auditor;

REVOKE SELECT ON TABLE survey_pool FROM int_compliance;

REVOKE SELECT ON TABLE survey_pool FROM int_coordinator;

REVOKE SELECT ON TABLE survey_pool FROM int_finance;

REVOKE SELECT ON TABLE survey_pool FROM int_hr;

REVOKE SELECT ON TABLE survey_pool FROM int_manager;

REVOKE SELECT ON TABLE survey_pool FROM int_surveyor;

REVOKE SELECT ON TABLE survey_pool FROM int_sysadmin;

REVOKE SELECT ON TABLE survey_pool FROM int_viewer;

DROP TRIGGER IF EXISTS survey_pool_audit_capture ON survey_pool;

DROP TABLE IF EXISTS survey_pool CASCADE;

DROP TABLE IF EXISTS certificate_survey_pool CASCADE;

CREATE TABLE IF NOT EXISTS certificate_type (
    code varchar(10),
    description varchar(100) NOT NULL,
    CONSTRAINT certificate_type_pkey PRIMARY KEY (code)
);

ALTER TABLE certificate_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY certificate_type_read ON certificate_type FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE TABLE IF NOT EXISTS survey_audit_catalog (
    id integer GENERATED ALWAYS AS IDENTITY,
    code varchar(20) NOT NULL,
    name varchar(120) NOT NULL,
    description text,
    item_kind text DEFAULT 'survey' NOT NULL,
    certificate_type_code varchar(10),
    survey_audit_type_code varchar(2),
    fee numeric(9,2),
    period interval,
    window_before interval,
    window_after interval,
    is_statutory boolean DEFAULT false NOT NULL,
    is_mandatory boolean DEFAULT false NOT NULL,
    is_periodical boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT survey_audit_catalog_pkey PRIMARY KEY (id),
    CONSTRAINT survey_audit_catalog_cert_type_kind_uk UNIQUE (certificate_type_code, survey_audit_type_code),
    CONSTRAINT survey_audit_catalog_code_key UNIQUE (code),
    CONSTRAINT survey_audit_catalog_certificate_type_code_fkey FOREIGN KEY (certificate_type_code) REFERENCES certificate_type (code) ON DELETE SET NULL,
    CONSTRAINT survey_audit_catalog_item_kind_check CHECK (item_kind IN ('survey'::text, 'audit'::text, 'doc'::text))
);

CREATE INDEX IF NOT EXISTS survey_audit_catalog_cert_type_ix ON survey_audit_catalog (certificate_type_code);

CREATE INDEX IF NOT EXISTS survey_audit_catalog_type_ix ON survey_audit_catalog (survey_audit_type_code);

ALTER TABLE survey_audit_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_audit_catalog_read ON survey_audit_catalog FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE survey_audit_catalog
ADD CONSTRAINT survey_audit_catalog_survey_audit_type_code_fkey FOREIGN KEY (survey_audit_type_code) REFERENCES survey_audit_type (code);

CREATE OR REPLACE TRIGGER survey_audit_catalog_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON survey_audit_catalog
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

ALTER TABLE core.certificate_template
ADD CONSTRAINT certificate_template_cert_code_fkey FOREIGN KEY (cert_code) REFERENCES core.certificate_type (code) NOT VALID;

ALTER TABLE core.certificate_template VALIDATE CONSTRAINT certificate_template_cert_code_fkey;

ALTER TABLE checklist_section DROP COLUMN survey_id;

ALTER TABLE checklist_section
ADD COLUMN survey_catalog_id integer CONSTRAINT checklist_section_survey_catalog_id_fkey REFERENCES survey_audit_catalog (id);

DROP INDEX IF EXISTS checklist_section_survey_id_ix;



ALTER TABLE core.flag_cert_authorization
ADD CONSTRAINT flag_cert_authorization_cert_code_fkey FOREIGN KEY (cert_code) REFERENCES core.certificate_type (code) ON DELETE CASCADE NOT VALID;

ALTER TABLE core.flag_cert_authorization VALIDATE CONSTRAINT flag_cert_authorization_cert_code_fkey;

ALTER TABLE flag_survey_authorization DROP COLUMN cert_code;

ALTER TABLE flag_survey_authorization DROP COLUMN survey_type;

ALTER TABLE flag_survey_authorization
ADD COLUMN survey_catalog_id integer NOT NULL CONSTRAINT flag_survey_authorization_survey_catalog_id_fkey REFERENCES survey_audit_catalog (id) ON DELETE CASCADE;

ALTER TABLE flag_survey_authorization
ADD CONSTRAINT flag_survey_authorization_flag_catalog_uk UNIQUE (flag_code, survey_catalog_id);

DROP INDEX IF EXISTS flag_survey_auth_cert_code_ix;



ALTER TABLE report_template DROP COLUMN survey_id;

ALTER TABLE report_template
ADD COLUMN survey_catalog_id integer NOT NULL CONSTRAINT report_template_survey_catalog_id_fkey REFERENCES survey_audit_catalog (id) ON DELETE CASCADE;

DROP INDEX IF EXISTS report_template_survey_id_ix;



ALTER TABLE survey_documentation DROP COLUMN survey_id;

ALTER TABLE survey_documentation
ADD COLUMN survey_catalog_id integer NOT NULL CONSTRAINT survey_documentation_survey_catalog_id_fkey REFERENCES survey_audit_catalog (id) ON DELETE CASCADE;

DROP INDEX IF EXISTS survey_doc_survey_id_ix;



ALTER TABLE survey_preparation DROP COLUMN survey_id;

ALTER TABLE survey_preparation
ADD COLUMN survey_catalog_id integer NOT NULL CONSTRAINT survey_preparation_survey_catalog_id_fkey REFERENCES survey_audit_catalog (id) ON DELETE CASCADE;

DROP INDEX IF EXISTS survey_prep_survey_id_ix;



ALTER TABLE survey_preparation_section DROP COLUMN survey_id;

ALTER TABLE survey_preparation_section
ADD COLUMN survey_catalog_id integer NOT NULL CONSTRAINT survey_preparation_section_survey_catalog_id_fkey REFERENCES survey_audit_catalog (id) ON DELETE CASCADE;

DROP INDEX IF EXISTS survey_prep_section_survey_id_ix;



GRANT SELECT ON TABLE certificate_type TO ext_user;

GRANT SELECT ON TABLE certificate_type TO int_auditor;

GRANT SELECT ON TABLE certificate_type TO int_compliance;

GRANT SELECT ON TABLE certificate_type TO int_coordinator;

GRANT SELECT ON TABLE certificate_type TO int_finance;

GRANT SELECT ON TABLE certificate_type TO int_hr;

GRANT SELECT ON TABLE certificate_type TO int_manager;

GRANT SELECT ON TABLE certificate_type TO int_surveyor;

GRANT SELECT ON TABLE certificate_type TO int_sysadmin;

GRANT SELECT ON TABLE certificate_type TO int_viewer;

GRANT SELECT ON TABLE survey_audit_catalog TO ext_user;

GRANT SELECT ON TABLE survey_audit_catalog TO int_auditor;

GRANT SELECT ON TABLE survey_audit_catalog TO int_compliance;

GRANT SELECT ON TABLE survey_audit_catalog TO int_coordinator;

GRANT SELECT ON TABLE survey_audit_catalog TO int_finance;

GRANT SELECT ON TABLE survey_audit_catalog TO int_hr;

GRANT SELECT ON TABLE survey_audit_catalog TO int_manager;

GRANT SELECT ON TABLE survey_audit_catalog TO int_surveyor;

GRANT SELECT ON TABLE survey_audit_catalog TO int_sysadmin;

GRANT SELECT ON TABLE survey_audit_catalog TO int_viewer;

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER TABLE fleet.certificate
ADD CONSTRAINT certificate_cert_code_fk FOREIGN KEY (cert_code) REFERENCES core.certificate_type (code) NOT VALID;

ALTER TABLE fleet.certificate VALIDATE CONSTRAINT certificate_cert_code_fk;

ALTER TABLE survey_audit DROP COLUMN cert_code;

ALTER TABLE survey_audit DROP COLUMN pool_id;

ALTER TABLE survey_audit
ADD COLUMN certificate_type_code varchar(10) CONSTRAINT survey_audit_certificate_type_fk REFERENCES core.certificate_type (code) ON DELETE SET NULL;

ALTER TABLE survey_audit
ADD COLUMN survey_catalog_id integer CONSTRAINT survey_audit_catalog_fk REFERENCES core.survey_audit_catalog (id) ON DELETE SET NULL;

DROP INDEX IF EXISTS survey_audit_pool_ix;

-- ===== schema: survey  (pgschema 1.14.1) =====

set local search_path = survey;

ALTER TABLE survey.certificate_line
ADD CONSTRAINT certificate_line_cert_code_fk FOREIGN KEY (cert_code) REFERENCES core.certificate_type (code) NOT VALID;

ALTER TABLE survey.certificate_line VALIDATE CONSTRAINT certificate_line_cert_code_fk;

ALTER TABLE survey_line DROP COLUMN pool_id;

ALTER TABLE survey_line
ADD COLUMN survey_catalog_id integer CONSTRAINT survey_line_catalog_fk REFERENCES core.survey_audit_catalog (id) ON DELETE SET NULL;

DROP INDEX IF EXISTS survey_line_pool_ix;



ALTER TABLE survey.survey_request_item
ADD CONSTRAINT survey_request_item_occ_fk FOREIGN KEY (occ_survey_code) REFERENCES core.survey_audit_catalog (code) ON DELETE SET NULL NOT VALID;

ALTER TABLE survey.survey_request_item VALIDATE CONSTRAINT survey_request_item_occ_fk;

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
    sa.survey_status,
    sa.range_from_date,
    sa.range_to_date,
    sa.fee,
    sa.is_ordered,
    sa.is_active,
    sa.created_at,
    sa.updated_at
   FROM fleet.survey_audit sa
     LEFT JOIN core.survey_audit_catalog sac ON sac.id = sa.survey_catalog_id;

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
