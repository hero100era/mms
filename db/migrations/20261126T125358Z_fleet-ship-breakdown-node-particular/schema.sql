-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

CREATE TABLE IF NOT EXISTS ship_breakdown_node_particular (
    id integer GENERATED ALWAYS AS IDENTITY,
    ship_breakdown_node_id integer NOT NULL,
    template_particular_id integer,
    attr_key varchar(100) NOT NULL,
    attr_title varchar(200) NOT NULL,
    attr_value text,
    selection_options jsonb,
    data_type core.data_type_enum DEFAULT 'text'::core.data_type_enum,
    unit varchar(20),
    is_modified boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ship_breakdown_node_particular_pkey PRIMARY KEY (id),
    CONSTRAINT uq_snode_attr UNIQUE (ship_breakdown_node_id, attr_key)
);

CREATE INDEX IF NOT EXISTS ship_breakdown_node_part_node_ix ON ship_breakdown_node_particular (ship_breakdown_node_id);

CREATE INDEX IF NOT EXISTS ship_breakdown_node_part_tmpl_ix ON ship_breakdown_node_particular (template_particular_id);

ALTER TABLE ship_breakdown_node_particular ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_breakdown_node_particular_ext_read ON ship_breakdown_node_particular FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM ((ship_breakdown_node sbn JOIN ship_breakdown sb ON ((sb.id = sbn.ship_breakdown_id))) JOIN ship_party sp ON ((sp.ship_id = sb.ship_id))) WHERE ((sbn.id = ship_breakdown_node_particular.ship_breakdown_node_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))));

CREATE POLICY ship_breakdown_node_particular_staff_read ON ship_breakdown_node_particular FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE ship_breakdown_node_particular
ADD CONSTRAINT ship_breakdown_node_particular_ship_breakdown_node_id_fkey FOREIGN KEY (ship_breakdown_node_id) REFERENCES ship_breakdown_node (id) ON DELETE CASCADE;

ALTER TABLE ship_breakdown_node_particular
ADD CONSTRAINT ship_breakdown_node_particular_template_particular_id_fkey FOREIGN KEY (template_particular_id) REFERENCES core.breakdown_template_node_particular (id) ON DELETE SET NULL;

CREATE OR REPLACE TRIGGER ship_breakdown_node_particular_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON ship_breakdown_node_particular
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

GRANT SELECT ON TABLE ship_breakdown_node_particular TO ext_user;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_auditor;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_compliance;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_finance;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_hr;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_manager;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdown_node_particular TO int_viewer;
