-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION user_directory_grade(
    p_user_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case
    when private.active_role() = 'int_hr' then t.grade
    when p_user_id = private.uid() then t.grade
    when p_user_id in (select private.my_reports()) then t.grade
    else null
  end
  from iam.staff_position p
  join iam.job_title t on t.code = p.job_title_code
  where p.user_id = p_user_id
    and p.valid @> now()
  order by upper(p.valid) nulls last
  limit 1;
$$;

CREATE OR REPLACE FUNCTION user_directory_line_manager(
    p_user_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case
    when private.active_role() = 'int_hr' then p.line_manager_id
    when p_user_id = private.uid() then p.line_manager_id
    when p_user_id in (select private.my_reports()) then p.line_manager_id
    else null
  end
  from iam.staff_position p
  where p.user_id = p_user_id
    and p.valid @> now()
  order by upper(p.valid) nulls last
  limit 1;
$$;

REVOKE EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION user_directory_grade(p_user_id uuid) TO int_viewer;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION user_directory_line_manager(p_user_id uuid) TO int_viewer;

-- ===== schema: party  (pgschema 1.13.4) =====

set local search_path = party;

ALTER TABLE organization ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_ext_read ON organization FOR SELECT TO ext_user USING (id = ANY (private.my_org_ids()));

CREATE POLICY organization_staff_read ON organization FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

GRANT SELECT ON TABLE organization TO ext_user;

GRANT SELECT ON TABLE organization TO int_auditor;

GRANT SELECT ON TABLE organization TO int_compliance;

GRANT SELECT ON TABLE organization TO int_coordinator;

GRANT SELECT ON TABLE organization TO int_finance;

GRANT SELECT ON TABLE organization TO int_hr;

GRANT SELECT ON TABLE organization TO int_manager;

GRANT SELECT ON TABLE organization TO int_surveyor;

GRANT SELECT ON TABLE organization TO int_sysadmin;

GRANT SELECT ON TABLE organization TO int_viewer;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

REVOKE SELECT ON TABLE staff_position FROM int_sysadmin;

CREATE POLICY app_user_internal_read ON app_user FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_manager, int_surveyor, int_viewer USING ((kind = 'internal') AND (status = ANY (ARRAY['active', 'invited'])));

CREATE POLICY job_title_read ON job_title FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (true);

CREATE POLICY org_membership_ext_read ON org_membership FOR SELECT TO ext_user USING ((user_id = private.uid()) AND (revoked_at IS NULL) AND (valid @> now()));

CREATE POLICY org_membership_staff_read ON org_membership FOR SELECT TO int_compliance, int_coordinator, int_manager, int_sysadmin USING (true);

CREATE POLICY staff_position_staff_read ON staff_position FOR SELECT TO int_auditor, int_compliance, int_coordinator, int_finance, int_manager, int_surveyor, int_sysadmin, int_viewer USING (valid @> now());

ALTER POLICY staff_position_admin_read ON staff_position TO int_hr;

GRANT SELECT ON TABLE job_title TO int_hr;

GRANT SELECT ON TABLE org_membership TO ext_user;

GRANT SELECT ON TABLE org_membership TO int_compliance;

GRANT SELECT ON TABLE org_membership TO int_coordinator;

GRANT SELECT ON TABLE org_membership TO int_manager;

GRANT SELECT ON TABLE org_membership TO int_sysadmin;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_auditor;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_compliance;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_coordinator;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_finance;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_manager;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_surveyor;

GRANT SELECT (display_name, email, id, kind, status) ON TABLE app_user TO int_viewer;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_auditor;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_compliance;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_coordinator;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_finance;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_manager;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_surveyor;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_sysadmin;

GRANT SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title TO int_viewer;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_auditor;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_compliance;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_coordinator;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_finance;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_manager;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_surveyor;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_sysadmin;

GRANT SELECT (id, job_family, job_title_code, reason, set_by, unit_id, user_id, user_kind, valid) ON TABLE staff_position TO int_viewer;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

REVOKE SELECT ON TABLE staff_positions FROM int_sysadmin;

CREATE OR REPLACE VIEW organizations WITH (security_invoker=true) AS
 SELECT id,
    name,
    org_type,
    status
   FROM party.organization;

CREATE OR REPLACE VIEW user_directory WITH (security_invoker=true) AS
 SELECT u.id,
    u.display_name,
    u.email,
    p.job_title_code AS title,
    p.unit_id,
    private.user_directory_grade(u.id) AS grade,
    private.user_directory_line_manager(u.id) AS line_manager_id
   FROM iam.app_user u
     LEFT JOIN iam.staff_position p ON p.user_id = u.id AND p.valid @> now()
  WHERE u.kind = 'internal'::text AND (u.status = ANY (ARRAY['active'::text, 'invited'::text]));

GRANT SELECT ON TABLE organizations TO ext_user;

GRANT SELECT ON TABLE organizations TO int_auditor;

GRANT SELECT ON TABLE organizations TO int_compliance;

GRANT SELECT ON TABLE organizations TO int_coordinator;

GRANT SELECT ON TABLE organizations TO int_finance;

GRANT SELECT ON TABLE organizations TO int_hr;

GRANT SELECT ON TABLE organizations TO int_manager;

GRANT SELECT ON TABLE organizations TO int_surveyor;

GRANT SELECT ON TABLE organizations TO int_sysadmin;

GRANT SELECT ON TABLE organizations TO int_viewer;

GRANT SELECT ON TABLE user_directory TO int_auditor;

GRANT SELECT ON TABLE user_directory TO int_compliance;

GRANT SELECT ON TABLE user_directory TO int_coordinator;

GRANT SELECT ON TABLE user_directory TO int_finance;

GRANT SELECT ON TABLE user_directory TO int_hr;

GRANT SELECT ON TABLE user_directory TO int_manager;

GRANT SELECT ON TABLE user_directory TO int_surveyor;

GRANT SELECT ON TABLE user_directory TO int_sysadmin;

GRANT SELECT ON TABLE user_directory TO int_viewer;
