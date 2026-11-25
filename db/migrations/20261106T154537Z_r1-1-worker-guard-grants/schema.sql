-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION is_worker_or_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if private.is_worker() then
    return true;
  end if;
  return coalesce(private.active_role(), '') = 'int_sysadmin';
exception
  when insufficient_privilege then
    return false;
end;
$$;

GRANT EXECUTE ON FUNCTION active_role() TO worker;
