-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_role_eligible(
    p_user_id uuid,
    p_db_role text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_db_role = 'int_sysadmin' then
    return;
  end if;
  if exists (
    select 1
      from iam.staff_position p
      join iam.job_title t on t.code = p.job_title_code
      join core.org_unit u on u.id = p.unit_id
      join iam.default_role_rule r on r.db_role = p_db_role
     where p.user_id = p_user_id
       and p.valid @> now()
       and (r.unit_type is null or r.unit_type = u.unit_type)
       and (r.unit_function is null or r.unit_function = u.function_code)
       and (r.job_family is null or r.job_family = p.job_family)
       and t.grade between r.min_grade and r.max_grade
  ) then
    return;
  end if;
  perform private.emit_event(
    'authz.denied.insufficient_authority', 'denied', 'app_user', p_user_id, null, null,
    jsonb_build_object('role', p_db_role, 'reason', 'role_not_eligible'));
  raise exception 'role_not_eligible' using errcode = '42501';
end;
$$;
