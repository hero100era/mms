-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION break_glass_state(
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select jsonb_build_object(
    'label', b.label,
    'enabled', b.enabled,
    'dormant', b.valid_until is null or b.valid_until <= now(),
    'valid_until', b.valid_until,
    'reason', b.reason,
    'last_drill_at', b.last_drill_at,
    -- The drill is the control that keeps the account usable on the day it is needed.
    -- Overdue is computed on read, so no scheduler is required to notice it.
    'drill_overdue', b.last_drill_at is null
      or b.last_drill_at <= now() - interval '100 days'
  )
  from iam.break_glass_account b
  where b.user_id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION break_glass_state(p_user_id uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION break_glass_state(p_user_id uuid) TO auth_gateway;
