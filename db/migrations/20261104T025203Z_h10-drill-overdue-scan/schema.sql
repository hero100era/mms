-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION break_glass_drill_overdue()
RETURNS TABLE(user_id uuid, label text, last_drill_at timestamptz, days_since_drill integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select b.user_id,
         b.label,
         b.last_drill_at,
         case
           when b.last_drill_at is null then null
           else floor(extract(epoch from (now() - b.last_drill_at)) / 86400)::int
         end
    from iam.break_glass_account b
   where b.enabled
     and (b.last_drill_at is null or b.last_drill_at <= now() - interval '100 days')
   order by b.last_drill_at nulls first;
$$;

REVOKE EXECUTE ON FUNCTION break_glass_drill_overdue() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION break_glass_drill_overdue() TO auth_gateway;
