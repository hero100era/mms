-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION assignable_roles(
    p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(role_name text, description text, eligible boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  perform private.assert_sysadmin();
  return query
  select r.role_name,
         r.description,
         case
           when p_user_id is null then true
           when r.role_name = 'int_sysadmin' then true
           when exists (
             select 1
               from iam.staff_position p
               join iam.job_title t on t.code = p.job_title_code
               join core.org_unit u on u.id = p.unit_id
               join iam.default_role_rule dr on dr.db_role = r.role_name
              where p.user_id = p_user_id
                and p.valid @> now()
                and (dr.unit_type is null or dr.unit_type = u.unit_type)
                and (dr.unit_function is null or dr.unit_function = u.function_code)
                and (dr.job_family is null or dr.job_family = p.job_family)
                and t.grade between dr.min_grade and dr.max_grade
           ) then true
           else false
         end as eligible
    from iam.db_role r
   where r.kind = 'internal'
   order by r.role_name;
end;
$$;

REVOKE EXECUTE ON FUNCTION assignable_roles(p_user_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION assignable_roles(p_user_id uuid) TO int_sysadmin;
