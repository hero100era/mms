-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

GRANT SELECT ON TABLE app_user TO int_hr;

GRANT SELECT ON TABLE app_user TO int_sysadmin;

GRANT SELECT ON TABLE staff_position TO int_hr;

GRANT SELECT ON TABLE staff_position TO int_sysadmin;
