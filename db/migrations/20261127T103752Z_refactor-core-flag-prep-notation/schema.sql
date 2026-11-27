-- ===== schema: core  (pgschema 1.14.1) =====

set local search_path = core;

REVOKE SELECT (code, fullname, is_active, is_hssc, name) ON TABLE flag FROM ext_user;

CREATE TABLE IF NOT EXISTS flag_ro_agreement (
    id integer GENERATED ALWAYS AS IDENTITY,
    flag_code varchar(3) NOT NULL,
    email varchar(50),
    tel varchar(30),
    fax varchar(30),
    contact varchar(100),
    contract_file varchar(128),
    contract_start date,
    contract_end date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT flag_ro_agreement_pkey PRIMARY KEY (id),
    CONSTRAINT flag_ro_agreement_flag_code_fkey FOREIGN KEY (flag_code) REFERENCES flag (code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS flag_ro_agreement_flag_code_ix ON flag_ro_agreement (flag_code);

ALTER TABLE flag_ro_agreement ENABLE ROW LEVEL SECURITY;

CREATE POLICY flag_ro_agreement_read ON flag_ro_agreement FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE OR REPLACE TRIGGER flag_ro_agreement_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON flag_ro_agreement
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

ALTER TABLE breakdown_template ALTER COLUMN created_by TYPE uuid USING created_by::uuid;

ALTER TABLE breakdown_template ALTER COLUMN updated_by TYPE uuid USING updated_by::uuid;

ALTER TABLE class_notation DROP COLUMN incompatible_notations;

ALTER TABLE flag DROP COLUMN email;

ALTER TABLE flag DROP COLUMN tel;

ALTER TABLE flag DROP COLUMN fax;

ALTER TABLE flag DROP COLUMN contact;

ALTER TABLE flag DROP COLUMN contract_file;

ALTER TABLE flag DROP COLUMN contract_start;

ALTER TABLE flag DROP COLUMN contract_end;

ALTER TABLE survey_preparation DROP COLUMN survey_catalog_id;

ALTER TABLE survey_preparation
ADD COLUMN section_id integer NOT NULL CONSTRAINT survey_preparation_section_id_fkey REFERENCES survey_preparation_section (id) ON DELETE CASCADE;

DROP INDEX IF EXISTS survey_prep_catalog_id_ix;



GRANT SELECT ON TABLE flag TO ext_user;

GRANT SELECT ON TABLE flag_ro_agreement TO int_auditor;

GRANT SELECT ON TABLE flag_ro_agreement TO int_compliance;

GRANT SELECT ON TABLE flag_ro_agreement TO int_coordinator;

GRANT SELECT ON TABLE flag_ro_agreement TO int_finance;

GRANT SELECT ON TABLE flag_ro_agreement TO int_hr;

GRANT SELECT ON TABLE flag_ro_agreement TO int_manager;

GRANT SELECT ON TABLE flag_ro_agreement TO int_surveyor;

GRANT SELECT ON TABLE flag_ro_agreement TO int_sysadmin;

GRANT SELECT ON TABLE flag_ro_agreement TO int_viewer;

-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER TABLE ship_breakdown ALTER COLUMN applied_by TYPE uuid USING applied_by::uuid;

ALTER TABLE fleet.ship_breakdown
ADD CONSTRAINT ship_breakdown_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES iam.app_user (id) NOT VALID;

ALTER TABLE fleet.ship_breakdown VALIDATE CONSTRAINT ship_breakdown_applied_by_fkey;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE VIEW ship_breakdowns WITH (security_invoker=true) AS
 SELECT id,
    ship_id,
    template_id,
    name,
    description,
    revision,
    is_active,
    applied_at,
    applied_by,
    created_at,
    updated_at
   FROM fleet.ship_breakdown sb;

GRANT SELECT ON TABLE ship_breakdowns TO ext_user;

GRANT SELECT ON TABLE ship_breakdowns TO int_auditor;

GRANT SELECT ON TABLE ship_breakdowns TO int_compliance;

GRANT SELECT ON TABLE ship_breakdowns TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdowns TO int_finance;

GRANT SELECT ON TABLE ship_breakdowns TO int_hr;

GRANT SELECT ON TABLE ship_breakdowns TO int_manager;

GRANT SELECT ON TABLE ship_breakdowns TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdowns TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdowns TO int_viewer;
