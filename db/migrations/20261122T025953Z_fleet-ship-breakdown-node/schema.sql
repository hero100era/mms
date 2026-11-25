-- ===== schema: fleet  (pgschema 1.14.1) =====

set local search_path = fleet;

CREATE TABLE IF NOT EXISTS ship_breakdown_node (
    id SERIAL,
    ship_breakdown_id integer NOT NULL,
    parent_node_id integer,
    template_node_id integer,
    code varchar(50) NOT NULL,
    name varchar(200) NOT NULL,
    description text,
    category varchar(50),
    node_type varchar(50),
    level integer DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_from_template boolean DEFAULT true NOT NULL,
    is_modified boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ship_breakdown_node_pkey PRIMARY KEY (id),
    CONSTRAINT uq_ship_node_code UNIQUE (ship_breakdown_id, code),
    CONSTRAINT ship_breakdown_node_parent_node_id_fkey FOREIGN KEY (parent_node_id) REFERENCES ship_breakdown_node (id) ON DELETE CASCADE,
    CONSTRAINT chk_no_self_parent_ship CHECK (id <> parent_node_id)
);

CREATE INDEX IF NOT EXISTS ship_breakdown_node_breakdown_ix ON ship_breakdown_node (ship_breakdown_id);

CREATE INDEX IF NOT EXISTS ship_breakdown_node_parent_ix ON ship_breakdown_node (parent_node_id);

CREATE INDEX IF NOT EXISTS ship_breakdown_node_template_ix ON ship_breakdown_node (template_node_id);

ALTER TABLE ship_breakdown_node ENABLE ROW LEVEL SECURITY;

CREATE POLICY ship_breakdown_node_ext_read ON ship_breakdown_node FOR SELECT TO ext_user USING (EXISTS ( SELECT 1 FROM (ship_breakdown sb JOIN ship_party sp ON ((sp.ship_id = sb.ship_id))) WHERE ((sb.id = ship_breakdown_node.ship_breakdown_id) AND (sp.org_id = ANY (private.my_org_ids())) AND (sp.valid @> now()))));

CREATE POLICY ship_breakdown_node_staff_read ON ship_breakdown_node FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

ALTER TABLE ship_breakdown_node
ADD CONSTRAINT ship_breakdown_node_ship_breakdown_id_fkey FOREIGN KEY (ship_breakdown_id) REFERENCES ship_breakdown (id) ON DELETE CASCADE;

ALTER TABLE ship_breakdown_node
ADD CONSTRAINT ship_breakdown_node_template_node_id_fkey FOREIGN KEY (template_node_id) REFERENCES core.breakdown_template_node (id) ON DELETE SET NULL;

GRANT SELECT ON TABLE ship_breakdown_node TO ext_user;

GRANT SELECT ON TABLE ship_breakdown_node TO int_auditor;

GRANT SELECT ON TABLE ship_breakdown_node TO int_compliance;

GRANT SELECT ON TABLE ship_breakdown_node TO int_coordinator;

GRANT SELECT ON TABLE ship_breakdown_node TO int_finance;

GRANT SELECT ON TABLE ship_breakdown_node TO int_hr;

GRANT SELECT ON TABLE ship_breakdown_node TO int_manager;

GRANT SELECT ON TABLE ship_breakdown_node TO int_surveyor;

GRANT SELECT ON TABLE ship_breakdown_node TO int_sysadmin;

GRANT SELECT ON TABLE ship_breakdown_node TO int_viewer;
