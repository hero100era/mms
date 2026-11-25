-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE POLICY app_user_admin_read ON app_user FOR SELECT TO int_hr, int_sysadmin USING (true);

CREATE POLICY staff_position_admin_read ON staff_position FOR SELECT TO int_hr, int_sysadmin USING (true);
