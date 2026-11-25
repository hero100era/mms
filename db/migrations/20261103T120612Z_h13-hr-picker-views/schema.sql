-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

GRANT EXECUTE ON FUNCTION entra_sync_list_staff() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION entra_sync_list_staff() TO worker;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE VIEW position_job_titles WITH (security_invoker=true) AS
 SELECT code,
    label_en,
    label_zh,
    job_family,
    grade
   FROM iam.job_title t
  WHERE active
  ORDER BY grade DESC, code;

CREATE OR REPLACE VIEW position_units WITH (security_invoker=true) AS
 SELECT id,
    code,
    name,
    unit_type
   FROM core.org_unit u
  WHERE active AND upper(valid) IS NULL
  ORDER BY code;

GRANT SELECT ON TABLE position_job_titles TO int_hr;

GRANT SELECT ON TABLE position_job_titles TO int_sysadmin;

GRANT SELECT ON TABLE position_units TO int_hr;

GRANT SELECT ON TABLE position_units TO int_sysadmin;
