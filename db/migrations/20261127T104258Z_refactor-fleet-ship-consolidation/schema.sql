-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

ALTER TABLE ship DROP COLUMN ship_type;

ALTER TABLE ship DROP COLUMN administration_types;

ALTER TABLE ship DROP COLUMN gross_tons;

ALTER TABLE ship
ADD COLUMN administration_type varchar(2) DEFAULT 'C' NOT NULL CONSTRAINT ship_administration_type_fkey REFERENCES core.administration_type (code);

ALTER TABLE ship ALTER COLUMN gross_tonnage TYPE numeric(9,2) USING gross_tonnage::numeric(9,2);

ALTER TABLE fleet.ship ADD CONSTRAINT ship_type_mms_not_null NOT NULL type_mms NOT VALID;

ALTER TABLE fleet.ship VALIDATE CONSTRAINT ship_type_mms_not_null;

ALTER TABLE ship ALTER COLUMN type_mms SET DEFAULT 'OC';

ALTER TABLE ship ALTER COLUMN status DROP DEFAULT;

ALTER TABLE ship ALTER COLUMN status TYPE varchar(20) USING status::varchar(20);

ALTER TABLE ship ALTER COLUMN status SET DEFAULT 'in_service';

ALTER TABLE fleet.ship
ADD CONSTRAINT ship_status_fk FOREIGN KEY (status) REFERENCES core.ship_status (code) NOT VALID;

ALTER TABLE fleet.ship VALIDATE CONSTRAINT ship_status_fk;

ALTER TABLE ship DROP CONSTRAINT ship_gross_tonnage_ck;

ALTER TABLE fleet.ship
ADD CONSTRAINT ship_gross_tonnage_ck CHECK (gross_tonnage IS NULL OR gross_tonnage > 0::numeric) NOT VALID;

ALTER TABLE fleet.ship VALIDATE CONSTRAINT ship_gross_tonnage_ck;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

CREATE OR REPLACE VIEW ships WITH (security_invoker=true) AS
 SELECT s.id,
    s.imo_number,
    s.name,
    s.type_iacs,
    s.type_mms,
    s.type_other,
    s.flag_code,
    s.gross_tonnage,
    s.build_year,
    s.status,
    s.responsible_mts_unit_id,
    s.created_at,
    s.updated_at,
    s.class_number,
    s.previous_names,
    s.build_date,
    s.commissioning_date,
    s.keel_laid_date,
    s.contract_date,
    s.class_entry_date,
    s.administration_type,
    s.classed_by,
    s.port_of_registry,
    s.date_of_registry,
    s.registry_number,
    s.call_sign,
    s.official_number,
    s.signal_letter,
    s.mmsi_number,
    s.class_status,
    s.main_class,
    s.dual_class,
    s.net_tons,
    s.national_tons,
    s.deadweight,
    s.light_ship,
    s.ballast_capacity,
    s.equipment_number,
    s.length,
    s.length_oa,
    s.length_bp,
    s.moulded_depth,
    s.moulded_breadth,
    s.moulded_draft,
    s.design_draft,
    s.breakdown_template_id,
    s.is_active,
    private.org_unit_name(s.responsible_mts_unit_id) AS responsible_mts_unit_name,
    f.fullname AS flag_name,
    vt.name AS type_iacs_name,
    vtm.name AS type_mms_name,
    cs.name AS class_status_name,
    ss.name AS ship_status_name
   FROM fleet.ship s
     LEFT JOIN core.flag f ON f.code::text = s.flag_code::text
     LEFT JOIN core.vessel_type_iacs vt ON vt.code::text = s.type_iacs::text
     LEFT JOIN core.vessel_type_mms vtm ON vtm.code::text = s.type_mms::text
     LEFT JOIN core.class_status cs ON cs.code::text = s.class_status::text
     LEFT JOIN core.ship_status ss ON ss.code::text = s.status::text;

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
