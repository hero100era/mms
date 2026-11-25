-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION pre_request()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c jsonb := private.claims();
  r text := c ->> 'role';
  k text;
  v_bg bigint := nullif(c ->> 'bg', '')::bigint;
begin
  select kind into k from iam.db_role where role_name = r;
  if k is null then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  if k = 'anon' then
    if c ? 'sub' then
      raise exception using errcode = 'PT401', message = 'anon_with_subject';
    end if;
    return;
  end if;
  -- Only the capability roles the plan exposes through PostgREST may pass this
  -- gate. The owner, migrator, sealer, worker and other login roles can hold a
  -- valid session too, but they must never reach the PostgREST execution path.
  if k not in ('internal', 'external') then
    raise exception using errcode = 'PT403', message = 'role_not_allowed';
  end if;
  -- H-10: a break-glass token must name the end of the activation window, and the
  -- window must still be open. The claim alone grants nothing: the session and
  -- assignment checks below still have to pass.
  if v_bg is not null and v_bg <= extract(epoch from now())::bigint then
    raise exception using errcode = 'PT401', message = 'break_glass_expired';
  end if;
  if not exists (
    select 1
      from iam.session s
      join iam.app_user u on u.id = s.user_id
     where s.id = (c ->> 'sid')::uuid
       and s.user_id = (c ->> 'sub')::uuid
       and s.active_role = r
       and s.revoked_at is null
       and now() < s.idle_expires_at
       and now() < s.expires_at
       and u.status = 'active'
       and ((k = 'external' and u.kind = 'external')
         or (k = 'internal' and u.kind = 'internal' and exists (
               select 1 from iam.role_assignment a
                where a.user_id = u.id
                  and a.db_role = r
                  and a.revoked_at is null
                  and a.valid @> now())))
  ) then
    raise exception using errcode = 'PT401', message = 'session_invalid';
  end if;
end;
$$;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE TABLE IF NOT EXISTS break_glass_account (
    user_id uuid,
    label text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    activated_at timestamptz,
    valid_until timestamptz,
    reason text,
    last_drill_at timestamptz,
    CONSTRAINT break_glass_account_pkey PRIMARY KEY (user_id),
    CONSTRAINT break_glass_account_cap_ck CHECK (valid_until IS NULL OR valid_until <= (activated_at + '04:00:00'::interval)),
    CONSTRAINT break_glass_account_label_ck CHECK (btrim(label) <> ''::text),
    CONSTRAINT break_glass_account_window_ck CHECK (activated_at IS NULL AND valid_until IS NULL AND reason IS NULL OR activated_at IS NOT NULL AND valid_until IS NOT NULL AND reason IS NOT NULL AND btrim(reason) <> ''::text),
    CONSTRAINT break_glass_account_window_order_ck CHECK (valid_until IS NULL OR valid_until > activated_at)
);

ALTER TABLE break_glass_account ENABLE ROW LEVEL SECURITY;

CREATE POLICY break_glass_account_compliance_read ON break_glass_account FOR SELECT TO int_compliance, int_sysadmin USING (true);

ALTER TABLE break_glass_account
ADD CONSTRAINT break_glass_account_user_fk FOREIGN KEY (user_id) REFERENCES app_user (id);

CREATE OR REPLACE TRIGGER break_glass_account_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON break_glass_account
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_granted_by_ck;

ALTER TABLE iam.role_assignment
ADD CONSTRAINT role_assignment_granted_by_ck CHECK (granted_by <> user_id OR source = 'break_glass'::text AND db_role = 'int_sysadmin'::text AND scope_type = 'global'::text) NOT VALID;

ALTER TABLE iam.role_assignment VALIDATE CONSTRAINT role_assignment_granted_by_ck;

ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_source_ck;

ALTER TABLE iam.role_assignment
ADD CONSTRAINT role_assignment_source_ck CHECK (source IN ('position'::text, 'manual'::text, 'break_glass'::text)) NOT VALID;

ALTER TABLE iam.role_assignment VALIDATE CONSTRAINT role_assignment_source_ck;

GRANT SELECT ON TABLE break_glass_account TO int_compliance;

GRANT SELECT ON TABLE break_glass_account TO int_sysadmin;

-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION break_glass_activate(
    p_user_id uuid,
    p_reason text,
    p_valid_until timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_label text;
  v_enabled boolean;
  v_now timestamptz;
  v_until timestamptz;
  v_live int;
  v_assignment iam.role_assignment;
  v_existing jsonb;
begin
  if p_reason is null or btrim(p_reason) = '' then
    perform private.emit_event(
      'auth.breakglass.failure', 'failure', 'user', p_user_id, null, null,
      jsonb_build_object('reason', 'reason_required'));
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select label, enabled into v_label, v_enabled
    from iam.break_glass_account
   where user_id = p_user_id
     for update;
  if not found then
    raise exception 'not_break_glass_account' using errcode = '42501';
  end if;
  if not v_enabled then
    perform private.emit_event(
      'auth.breakglass.denied', 'denied', 'user', p_user_id, null, null,
      jsonb_build_object('reason', 'disabled'));
    raise exception 'break_glass_disabled' using errcode = '42501';
  end if;

  -- Already active: report the window instead of stacking a second assignment.
  if exists (
    select 1 from iam.role_assignment a
     where a.user_id = p_user_id
       and a.source = 'break_glass'
       and a.revoked_at is null
       and a.valid && tstzrange(now(), null, '[)')
  ) then
    select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) into v_existing
      from iam.role_assignment a
     where a.user_id = p_user_id
       and a.source = 'break_glass'
       and a.revoked_at is null
       and a.valid && tstzrange(now(), null, '[)');
    return jsonb_build_object(
      'activated', false,
      'reason', 'already_active',
      'assignments', v_existing
    );
  end if;

  -- The window is bounded by the card, whatever the caller asks for.
  v_now := clock_timestamp();
  v_until := least(coalesce(p_valid_until, v_now + interval '4 hours'), v_now + interval '4 hours');
  if v_until <= v_now then
    raise exception 'invalid_validity_window' using errcode = '22023';
  end if;

  -- Exactly one global int_sysadmin assignment while the window is open.
  select count(*) into v_live
    from iam.role_assignment a
   where a.user_id = p_user_id
     and a.db_role = 'int_sysadmin'
     and a.revoked_at is null
     and a.valid @> v_now;
  if v_live > 0 then
    raise exception 'already_holds_sysadmin' using errcode = '23514';
  end if;

  insert into iam.role_assignment (
    user_id, user_kind, db_role, scope_type, scope_unit_id,
    source, position_id, valid, granted_by, grant_reason
  ) values (
    p_user_id, 'internal', 'int_sysadmin', 'global', null,
    'break_glass', null, tstzrange(v_now, v_until, '[)'), p_user_id, btrim(p_reason)
  )
  returning * into v_assignment;

  update iam.break_glass_account
     set activated_at = v_now,
         valid_until = v_until,
         reason = btrim(p_reason)
   where user_id = p_user_id;

  perform private.emit_event(
    'auth.breakglass.activated', 'success', 'user', p_user_id, null, btrim(p_reason),
    jsonb_build_object(
      'label', v_label,
      'assignment_id', v_assignment.id,
      'valid_until', v_until,
      'window_hours', round(extract(epoch from (v_until - v_now)) / 3600, 2)
    )
  );

  -- Immediate alerts, through the existing outbox, so an activation cannot pass
  -- unnoticed even when nobody reads the audit trail.
  insert into core.outbox (kind, payload, status)
  select 'break_glass_alert',
         jsonb_build_object(
           'user_id', p_user_id,
           'label', v_label,
           'reason', btrim(p_reason),
           'valid_until', v_until,
           'audience', audience
         ),
         'pending'
    from unnest(array['it_security', 'ho_compliance']) as audience;

  return jsonb_build_object(
    'activated', true,
    'assignment_id', v_assignment.id,
    'valid_until', v_until
  );
end;
$$;

CREATE OR REPLACE FUNCTION break_glass_claims(
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case
           when b.valid_until is null or b.valid_until <= now() then null
           else jsonb_build_object(
             'src', 'break_glass',
             'bg', floor(extract(epoch from b.valid_until))::bigint
           )
         end
    from iam.break_glass_account b
   where b.user_id = p_user_id
     and b.enabled;
$$;

CREATE OR REPLACE FUNCTION break_glass_deactivate(
    p_user_id uuid,
    p_reason text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_count int;
  v_label text;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select label into v_label from iam.break_glass_account where user_id = p_user_id;
  if not found then
    raise exception 'not_break_glass_account' using errcode = '42501';
  end if;

  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = p_user_id,
         revoke_reason = btrim(p_reason),
         valid = tstzrange(lower(valid), least(now(), upper(valid)), '[)')
   where user_id = p_user_id
     and source = 'break_glass'
     and revoked_at is null;
  get diagnostics v_count = row_count;

  -- Revoke every live session the account opened, so nothing outlives the window.
  update iam.session
     set revoked_at = now(), revoke_reason = 'break_glass_deactivated'
   where user_id = p_user_id
     and revoked_at is null;

  update iam.break_glass_account
     set activated_at = null,
         valid_until = null,
         reason = null
   where user_id = p_user_id;

  perform private.emit_event(
    'auth.breakglass.deactivated', 'success', 'user', p_user_id, null, btrim(p_reason),
    jsonb_build_object('label', v_label, 'assignments_revoked', v_count)
  );

  return v_count;
end;
$$;

CREATE OR REPLACE FUNCTION break_glass_failure(
    p_user_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  perform private.emit_event(
    'auth.breakglass.failure', 'failure', 'user', p_user_id, null, null,
    jsonb_build_object('reason', coalesce(p_reason, 'unknown')));
end;
$$;

REVOKE EXECUTE ON FUNCTION break_glass_claims(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION break_glass_deactivate(p_user_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION break_glass_failure(p_user_id uuid, p_reason text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION break_glass_claims(p_user_id uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION break_glass_deactivate(p_user_id uuid, p_reason text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION break_glass_failure(p_user_id uuid, p_reason text) TO auth_gateway;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION break_glass_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select coalesce(
           (select jsonb_build_object(
                     'label', b.label,
                     'enabled', b.enabled,
                     'dormant', not exists (
                         select 1 from iam.role_assignment a
                          where a.user_id = b.user_id
                            and a.source = 'break_glass'
                            and a.revoked_at is null
                            and a.valid && tstzrange(now(), null, '[)')),
                     'valid_until', b.valid_until,
                     'reason', b.reason,
                     'last_drill_at', b.last_drill_at,
                     'drill_overdue', b.last_drill_at is null or b.last_drill_at <= now() - interval '100 days'
                   )
              from iam.break_glass_account b
             where b.user_id = private.uid()),
           '{}'::jsonb);
$$;

CREATE OR REPLACE VIEW break_glass_accounts WITH (security_invoker=true) AS
 SELECT b.user_id,
    u.display_name,
    b.label,
    b.enabled,
    b.activated_at,
    b.valid_until,
    b.reason,
    b.last_drill_at
   FROM iam.break_glass_account b
     JOIN iam.app_user u ON u.id = b.user_id;

REVOKE EXECUTE ON FUNCTION break_glass_state() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_auditor;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_coordinator;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_finance;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_hr;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_manager;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_surveyor;

GRANT EXECUTE ON FUNCTION break_glass_state() TO int_viewer;

GRANT SELECT ON TABLE break_glass_accounts TO int_compliance;

GRANT SELECT ON TABLE break_glass_accounts TO int_sysadmin;
