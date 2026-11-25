-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION caller_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
declare
  v_role text := nullif(current_setting('role', true), '');
  v_current text := current_user::text;
begin
  -- Inside a SECURITY DEFINER function PostgreSQL switches the execution
  -- context to the definer, so `current_user` alone only ever names mms_owner.
  -- The caller survives in two other places, and each covers a different path:
  --   * the `role` GUC is set by SET ROLE / SET LOCAL ROLE, which is how
  --     PostgREST switches from authenticator to a capability role;
  --   * `session_user` still names the original login role when the connection
  --     itself was opened with SET SESSION AUTHORIZATION (the outbox worker),
  --     because the definer switch only replaces the current user.
  -- Order matters: the GUC wins because an in-function role switch is the more
  -- specific statement of intent. `current_user` is the last resort for the owner.
  if v_role is not null and v_role <> 'none' then
    return v_role;
  end if;
  if session_user::text <> v_current then
    return session_user::text;
  end if;
  return v_current;
end;
$$;
