-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION caller_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  -- Inside a definer function current_user is the definer (mms_owner), not the
  -- caller, so the caller is recovered from the role GUC:
  --   * PostgREST SET LOCAL ROLE 'int_* '    -> GUC = the capability role
  --   * the worker process (login role worker) -> GUC = 'none' / NULL
  --   * SET ROLE (session or local)            -> GUC = the target role
  -- Only when the GUC is unset does current_user carry information, and then it
  -- is the session login role (SET SESSION AUTHORIZATION).
  select case
    when coalesce(current_setting('role', true), '') in ('', 'none') then current_user::text
    else current_setting('role', true)
  end;
$$;
