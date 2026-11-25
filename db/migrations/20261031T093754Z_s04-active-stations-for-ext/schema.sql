-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE POLICY org_unit_ext_read ON org_unit FOR SELECT TO ext_user USING ((unit_type = 'station') AND active);

GRANT SELECT ON TABLE org_unit TO ext_user;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

GRANT SELECT ON TABLE org_units TO ext_user;
