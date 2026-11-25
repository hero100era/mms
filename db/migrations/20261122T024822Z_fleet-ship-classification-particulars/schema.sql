-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

CREATE SEQUENCE IF NOT EXISTS class_number_seq AS integer START WITH 1000;

CREATE TABLE IF NOT EXISTS ship_breakdown (
    id SERIAL,
    ship_id uuid NOT NULL,
    template_id integer,
    name varchar(200) NOT NULL,
    description text,
    revision integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    applied_at timestamptz,
    applied_by varchar(100),
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ship_breakdown_pkey PRIMARY KEY (id),
    CONSTRAINT ship_breakdown_ship_id_fkey FOREIGN KEY (ship_id) REFERENCES ship (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ship_breakdown_active_uk ON ship_breakdown (ship_id) WHERE (is_active IS TRUE);

CREATE INDEX IF NOT EXISTS ship_breakdown_ship_ix ON ship_breakdown (ship_id);

CREATE INDEX IF NOT EXISTS ship_breakdown_template_fk_ix ON ship_breakdown (template_id);

ALTER TABLE ship_breakdown ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_breakdown_ext_read ON ship_breakdown FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM ship_party sp WHERE ((sp.ship_id = ship_breakdown.ship_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))));

CREATE POLICY ship_breakdown_staff_read ON ship_breakdown FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE ship_breakdown
ADD CONSTRAINT ship_breakdown_template_id_fkey1 FOREIGN KEY (template_id) REFERENCES core.breakdown_template (id) ON DELETE SET NULL;

ALTER TABLE ship DROP COLUMN flag_state;

ALTER TABLE ship ADD COLUMN class_number integer DEFAULT nextval('class_number_seq'::regclass) NOT NULL;

ALTER TABLE ship ADD COLUMN previous_names varchar(500);

ALTER TABLE ship ADD COLUMN build_date date;

ALTER TABLE ship ADD COLUMN commissioning_date date;

ALTER TABLE ship ADD COLUMN keel_laid_date date;

ALTER TABLE ship ADD COLUMN contract_date date;

ALTER TABLE ship ADD COLUMN class_entry_date date;

ALTER TABLE ship
ADD COLUMN administration_types varchar(2) DEFAULT 'C' NOT NULL CONSTRAINT ship_administration_types_fkey REFERENCES core.administration_type (code);

ALTER TABLE ship
ADD COLUMN classed_by varchar(20) CONSTRAINT ship_classed_by_fkey REFERENCES core.classification_society (code);

ALTER TABLE ship ADD COLUMN port_of_registry varchar(50);

ALTER TABLE ship ADD COLUMN date_of_registry date;

ALTER TABLE ship ADD COLUMN registry_number varchar(20);

ALTER TABLE ship ADD COLUMN call_sign varchar(10);

ALTER TABLE ship ADD COLUMN official_number varchar(10);

ALTER TABLE ship
ADD COLUMN type_iacs varchar(2) DEFAULT 'BC' NOT NULL CONSTRAINT ship_type_iacs_fkey REFERENCES core.vessel_type_iacs (code);

ALTER TABLE ship ADD COLUMN type_other varchar(50);

ALTER TABLE ship
ADD COLUMN type_mms varchar(2) CONSTRAINT ship_type_mms_fkey REFERENCES core.vessel_type_mms (code);

ALTER TABLE ship
ADD COLUMN class_status varchar(2) CONSTRAINT ship_class_status_fkey REFERENCES core.class_status (code);

ALTER TABLE ship
ADD COLUMN ship_status varchar(2) CONSTRAINT ship_ship_status_fkey REFERENCES core.ship_status (code);

ALTER TABLE ship ADD COLUMN gross_tons numeric(9,2);

ALTER TABLE ship ADD COLUMN national_tons numeric(9,2);

ALTER TABLE ship ADD COLUMN deadweight integer;

ALTER TABLE ship
ADD COLUMN flag_code varchar(3) DEFAULT 'PA' NOT NULL CONSTRAINT ship_flag_code_fkey REFERENCES core.flag (code);

ALTER TABLE ship ADD COLUMN mmsi_number varchar(10);

ALTER TABLE ship ADD COLUMN main_class varchar(30);

ALTER TABLE ship ADD COLUMN net_tons numeric(9,2);

ALTER TABLE ship ADD COLUMN light_ship numeric(9,2);

ALTER TABLE ship ADD COLUMN ballast_capacity numeric(9,2);

ALTER TABLE ship ADD COLUMN equipment_number integer;

ALTER TABLE ship ADD COLUMN length numeric(9,2);

ALTER TABLE ship ADD COLUMN length_oa numeric(9,2);

ALTER TABLE ship ADD COLUMN length_bp numeric(9,2);

ALTER TABLE ship ADD COLUMN moulded_depth numeric(9,2);

ALTER TABLE ship ADD COLUMN moulded_breadth numeric(9,2);

ALTER TABLE ship ADD COLUMN moulded_draft numeric(9,2);

ALTER TABLE ship ADD COLUMN design_draft numeric(9,2);

ALTER TABLE ship
ADD COLUMN dual_class varchar(20) CONSTRAINT ship_dual_class_fkey REFERENCES core.classification_society (code);

ALTER TABLE ship ADD COLUMN signal_letter varchar(10);

ALTER TABLE ship
ADD COLUMN breakdown_template_id integer CONSTRAINT ship_breakdown_template_id_fkey REFERENCES core.breakdown_template (id) ON DELETE SET NULL;

ALTER TABLE ship ADD COLUMN is_active boolean DEFAULT true NOT NULL;



ALTER TABLE ship_party DROP CONSTRAINT ship_party_role_ck;

ALTER TABLE fleet.ship_party
ADD CONSTRAINT ship_party_role_ck CHECK (party_role IN ('registered_owner'::text, 'bareboat_charterer'::text, 'doc_company'::text, 'ism_manager'::text, 'isps_operator'::text, 'commercial_operator'::text, 'builder'::text, 'agent'::text, 'mlc_owner'::text)) NOT VALID;

ALTER TABLE fleet.ship_party VALIDATE CONSTRAINT ship_party_role_ck;

GRANT USAGE ON SEQUENCE class_number_seq TO ext_user;

GRANT USAGE ON SEQUENCE class_number_seq TO int_auditor;

GRANT USAGE ON SEQUENCE class_number_seq TO int_compliance;

GRANT USAGE ON SEQUENCE class_number_seq TO int_coordinator;

GRANT USAGE ON SEQUENCE class_number_seq TO int_finance;

GRANT USAGE ON SEQUENCE class_number_seq TO int_hr;

GRANT USAGE ON SEQUENCE class_number_seq TO int_manager;

GRANT USAGE ON SEQUENCE class_number_seq TO int_surveyor;

GRANT USAGE ON SEQUENCE class_number_seq TO int_sysadmin;

GRANT USAGE ON SEQUENCE class_number_seq TO int_viewer;

GRANT SELECT ON TABLE ship_breakdown TO ext_user;

GRANT SELECT ON TABLE ship_breakdown TO int_auditor;

GRANT SELECT ON TABLE ship_breakdown TO int_compliance;

GRANT SELECT ON TABLE ship_breakdown TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdown TO int_finance;

GRANT SELECT ON TABLE ship_breakdown TO int_hr;

GRANT SELECT ON TABLE ship_breakdown TO int_manager;

GRANT SELECT ON TABLE ship_breakdown TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdown TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdown TO int_viewer;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE VIEW ships WITH (security_invoker=true) AS
 SELECT id,
    imo_number,
    name,
    ship_type,
    flag_code,
    gross_tonnage,
    build_year,
    status,
    responsible_mts_unit_id,
    created_at,
    updated_at
   FROM fleet.ship s;

GRANT SELECT ON TABLE ships TO ext_user;

GRANT SELECT ON TABLE ships TO int_auditor;

GRANT SELECT ON TABLE ships TO int_compliance;

GRANT SELECT ON TABLE ships TO int_coordinator;

GRANT SELECT ON TABLE ships TO int_finance;

GRANT SELECT ON TABLE ships TO int_hr;

GRANT SELECT ON TABLE ships TO int_manager;

GRANT SELECT ON TABLE ships TO int_surveyor;

GRANT SELECT ON TABLE ships TO int_sysadmin;

GRANT SELECT ON TABLE ships TO int_viewer;
