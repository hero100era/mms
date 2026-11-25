-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

DROP FUNCTION IF EXISTS entra_sync_list_staff();

CREATE OR REPLACE FUNCTION entra_sync_list_staff()
RETURNS TABLE(user_id uuid, entra_tenant_id uuid, entra_object_id uuid, display_name text, email text, status text, has_position boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not (private.is_worker() or private.active_role() = 'int_sysadmin') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entra_tenant_id, u.entra_object_id, u.display_name, u.email, u.status,
         exists (
           select 1 from iam.staff_position sp
            where sp.user_id = u.id and upper(sp.valid) is null
         ) as has_position
    from iam.app_user u
   where u.kind = 'internal'
     and u.status in ('active', 'suspended')
     and u.entra_tenant_id is not null
     and u.entra_object_id is not null
   order by u.id;
end;
$$;
