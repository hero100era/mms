-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION assert_authority(
    p_action_code text,
    p_amount numeric DEFAULT NULL
)
RETURNS TABLE(rule_id uuid, title text, grade integer, unit_id uuid, unit_type text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_position record;
  v_rule record;
begin
  select * into v_position from private.my_position();
  if not found then
    perform private.emit_event(
      'authz.denied.insufficient_authority', 'denied', 'authority_rule', null, null, null,
      jsonb_build_object('action', p_action_code, 'role', private.active_role(), 'reason', 'no_position'));
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  select r.id, r.min_grade, r.max_amount
    into v_rule
    from iam.authority_rule r
   where r.action_code = p_action_code
     and r.db_role = private.active_role()
     and (r.job_family is null or r.job_family = v_position.job_family)
     and (r.unit_type is null or r.unit_type = v_position.unit_type)
     and v_position.grade >= r.min_grade
     and r.valid @> now()
     and (r.max_amount is null or (p_amount is not null and p_amount <= r.max_amount))
   order by r.min_grade desc, r.max_amount nulls first
   limit 1;

  if not found then
    perform private.emit_event(
      'authz.denied.insufficient_authority', 'denied', 'authority_rule', null,
      v_position.unit_id, null,
      jsonb_build_object(
        'action', p_action_code,
        'role', private.active_role(),
        'title', v_position.job_title_code,
        'grade', v_position.grade,
        'unit_type', v_position.unit_type,
        'amount', p_amount));
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  perform set_config('mms.authority_rule_id', v_rule.id::text, true);
  perform set_config('mms.authority_title', v_position.job_title_code, true);
  perform set_config('mms.authority_grade', v_position.grade::text, true);
  perform set_config('mms.authority_unit_id', v_position.unit_id::text, true);

  return query select v_rule.id, v_position.job_title_code, v_position.grade,
                      v_position.unit_id, v_position.unit_type;
end;
$$;

CREATE OR REPLACE FUNCTION emit_event(
    p_event_type text,
    p_outcome text,
    p_subject_type text,
    p_subject_id uuid,
    p_scope_unit_id uuid,
    p_reason text,
    p_detail jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c jsonb := private.claims();
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  v_reason_required boolean;
  v_reason text := coalesce(p_reason, nullif(current_setting('mms.reason', true), ''));
  v_on_behalf_of uuid := nullif(current_setting('mms.on_behalf_of', true), '')::uuid;
  v_authority_rule_id uuid := coalesce((p_detail ->> 'authority_rule_id')::uuid, nullif(current_setting('mms.authority_rule_id', true), '')::uuid);
  v_actor_title text := coalesce(nullif(current_setting('mms.authority_title', true), ''), c ->> 'title');
  v_actor_grade int := coalesce(nullif(current_setting('mms.authority_grade', true), '')::int, nullif(c ->> 'grade', '')::int);
  v_actor_unit_id uuid := coalesce(nullif(current_setting('mms.authority_unit_id', true), '')::uuid, nullif(c ->> 'org_unit_id', '')::uuid);
  v_pos record;
begin
  select reason_required into v_reason_required
    from audit_trail.event_type
   where code = p_event_type;
  if not found then
    raise exception 'invalid_event_type: %', p_event_type using errcode = '22023';
  end if;

  if v_reason_required and (v_reason is null or btrim(v_reason) = '') then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if v_on_behalf_of is not null and not exists (
    select 1 from party.organization where id = v_on_behalf_of
  ) then
    raise exception 'invalid_on_behalf_of' using errcode = '22023';
  end if;

  if v_actor_title is null or v_actor_grade is null or v_actor_unit_id is null then
    select p.job_title_code, t.grade, p.unit_id
      into v_pos
      from iam.staff_position p
      join iam.job_title t on t.code = p.job_title_code
     where p.user_id = nullif(c ->> 'sub', '')::uuid
       and p.valid @> now()
     limit 1;
    if found then
      v_actor_title := coalesce(v_actor_title, v_pos.job_title_code);
      v_actor_grade := coalesce(v_actor_grade, v_pos.grade);
      v_actor_unit_id := coalesce(v_actor_unit_id, v_pos.unit_id);
    end if;
  end if;

  insert into audit_trail.event (
    event_type, outcome, actor_id, session_id, db_role, auth_method,
    on_behalf_of, initiated_by, actor_title, actor_grade, actor_unit_id,
    authority_rule_id, subject_type, subject_id, scope_unit_id,
    request_id, trace_id, source, client_ip, reason, detail
  ) values (
    p_event_type,
    p_outcome,
    nullif(c ->> 'sub', '')::uuid,
    nullif(c ->> 'sid', '')::uuid,
    coalesce(nullif(c ->> 'role', ''), session_user),
    c -> 'amr' ->> 0,
    v_on_behalf_of,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    v_actor_title,
    v_actor_grade,
    v_actor_unit_id,
    v_authority_rule_id,
    p_subject_type,
    p_subject_id,
    p_scope_unit_id,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    coalesce(c ->> 'src', 'web'),
    nullif(h ->> 'x-client-ip', '')::inet,
    v_reason,
    p_detail
  );
end;
$$;

CREATE OR REPLACE FUNCTION set_change_context(
    p_reason text,
    p_on_behalf_of uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required';
  end if;
  if p_on_behalf_of is not null and not exists (
    select 1 from party.organization where id = p_on_behalf_of
  ) then
    raise exception 'invalid_on_behalf_of' using errcode = '22023';
  end if;
  perform set_config('mms.reason', p_reason, true);
  perform set_config('mms.on_behalf_of', coalesce(p_on_behalf_of::text, ''), true);
end;
$$;

GRANT EXECUTE ON FUNCTION emit_event(p_event_type text, p_outcome text, p_subject_type text, p_subject_id uuid, p_scope_unit_id uuid, p_reason text, p_detail jsonb) TO int_compliance;

GRANT EXECUTE ON FUNCTION emit_event(p_event_type text, p_outcome text, p_subject_type text, p_subject_id uuid, p_scope_unit_id uuid, p_reason text, p_detail jsonb) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_viewer;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE TABLE IF NOT EXISTS regulated_function (
    function_schema text,
    function_name text,
    event_type text NOT NULL,
    action_code text,
    description text NOT NULL,
    CONSTRAINT regulated_function_pk PRIMARY KEY (function_schema, function_name)
);

ALTER TABLE regulated_function ENABLE ROW LEVEL SECURITY;

CREATE POLICY regulated_function_read ON regulated_function FOR SELECT TO int_compliance, int_coordinator, int_hr, int_manager, int_sysadmin USING (true);

ALTER TABLE regulated_function
ADD CONSTRAINT regulated_function_event_type_fk FOREIGN KEY (event_type) REFERENCES event_type (code);

CREATE POLICY event_own_read ON event FOR SELECT TO ext_user, int_auditor, int_compliance, int_coordinator, int_finance, int_hr, int_manager, int_surveyor, int_sysadmin, int_viewer USING (actor_id = private.uid());

ALTER POLICY event_manager_read ON event USING ((scope_unit_id = ANY (private.my_offices())) OR (scope_unit_id = ANY (private.my_units())));

GRANT SELECT ON TABLE event TO ext_user;

GRANT SELECT ON TABLE event TO int_auditor;

GRANT SELECT ON TABLE event TO int_coordinator;

GRANT SELECT ON TABLE event TO int_finance;

GRANT SELECT ON TABLE event TO int_hr;

GRANT SELECT ON TABLE event TO int_surveyor;

GRANT SELECT ON TABLE event TO int_viewer;

GRANT SELECT ON TABLE event_type TO ext_user;

GRANT SELECT ON TABLE event_type TO int_auditor;

GRANT SELECT ON TABLE event_type TO int_coordinator;

GRANT SELECT ON TABLE event_type TO int_finance;

GRANT SELECT ON TABLE event_type TO int_hr;

GRANT SELECT ON TABLE event_type TO int_surveyor;

GRANT SELECT ON TABLE event_type TO int_viewer;

GRANT SELECT ON TABLE regulated_function TO int_compliance;

GRANT SELECT ON TABLE regulated_function TO int_coordinator;

GRANT SELECT ON TABLE regulated_function TO int_hr;

GRANT SELECT ON TABLE regulated_function TO int_manager;

GRANT SELECT ON TABLE regulated_function TO int_sysadmin;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION membership_grant(
    p_user_id uuid,
    p_org_id uuid,
    p_member_role text,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_id uuid;
  v_user iam.app_user;
  v_org party.organization;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  select * into v_user from iam.app_user where id = p_user_id and kind = 'external';
  if not found then
    raise exception 'external_user_not_found';
  end if;

  select * into v_org from party.organization where id = p_org_id and status = 'active';
  if not found then
    raise exception 'organization_not_found';
  end if;

  if p_member_role not in ('org_admin', 'requester', 'viewer') then
    raise exception 'invalid_member_role' using errcode = '22023';
  end if;

  insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by)
  values (p_user_id, 'external', p_org_id, p_member_role, private.uid())
  returning id into v_id;

  perform private.emit_event(
    'auth.membership.granted', 'success', 'org_membership', v_id, null, p_reason,
    jsonb_build_object('user_id', p_user_id, 'org_id', p_org_id, 'member_role', p_member_role)
  );

  return v_id;
end;
$$;

CREATE OR REPLACE FUNCTION membership_revoke(
    p_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_mem iam.org_membership;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  select * into v_mem from iam.org_membership where id = p_id and revoked_at is null for update;
  if not found then
    raise exception 'membership_not_found_or_revoked';
  end if;

  update iam.org_membership
     set revoked_at = now(),
         revoked_by = private.uid()
   where id = p_id;

  perform private.emit_event(
    'auth.membership.revoked', 'success', 'org_membership', p_id, null, p_reason,
    jsonb_build_object('user_id', v_mem.user_id, 'org_id', v_mem.org_id, 'member_role', v_mem.member_role)
  );
end;
$$;

CREATE OR REPLACE FUNCTION user_reactivate(
    p_user_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  select * into v_user from iam.app_user where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found';
  end if;
  if v_user.status = 'active' then
    raise exception 'user_already_active';
  end if;
  if v_user.status = 'deactivated' then
    raise exception 'user_deactivated';
  end if;

  update iam.app_user
     set status = 'active'
   where id = p_user_id;

  perform private.emit_event(
    'auth.user.reactivated', 'success', 'app_user', p_user_id, null, p_reason,
    jsonb_build_object('user_id', p_user_id, 'email', v_user.email, 'kind', v_user.kind)
  );
end;
$$;

CREATE OR REPLACE FUNCTION user_suspend(
    p_user_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
begin
  if coalesce(private.claim('role'), '') = 'int_sysadmin' then
    null;
  else
    perform private.assert_authority('iam.external_user.create');
  end if;

  perform private.set_change_context(p_reason);

  select * into v_user from iam.app_user where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found';
  end if;
  if v_user.status = 'suspended' then
    raise exception 'user_already_suspended';
  end if;
  if v_user.status = 'deactivated' then
    raise exception 'user_deactivated';
  end if;

  update iam.app_user
     set status = 'suspended'
   where id = p_user_id;

  perform private.emit_event(
    'auth.user.suspended', 'success', 'app_user', p_user_id, null, p_reason,
    jsonb_build_object('user_id', p_user_id, 'email', v_user.email, 'kind', v_user.kind)
  );
end;
$$;

CREATE OR REPLACE VIEW audit_changes WITH (security_invoker=true) AS
 SELECT id,
    occurred_at,
    tx_id,
    schema_name,
    table_name,
    op,
    row_id,
    old_row,
    new_row,
    changed_cols,
    actor_id,
    actor_label,
    db_role,
    session_id,
    auth_method,
    on_behalf_of,
    initiated_by,
    request_id,
    trace_id,
    source,
    client_ip,
    reason
   FROM audit_trail.change_log;

CREATE OR REPLACE VIEW audit_events WITH (security_invoker=true) AS
 SELECT id,
    occurred_at,
    tx_id,
    event_type,
    outcome,
    actor_id,
    session_id,
    db_role,
    auth_method,
    on_behalf_of,
    initiated_by,
    actor_title,
    actor_grade,
    actor_unit_id,
    authority_rule_id,
    subject_type,
    subject_id,
    subject_revision,
    scope_unit_id,
    request_id,
    trace_id,
    source,
    client_ip,
    user_agent,
    reason,
    detail
   FROM audit_trail.event;

CREATE OR REPLACE VIEW my_activity WITH (security_invoker=true) AS
 SELECT id,
    occurred_at,
    event_type,
    outcome,
    subject_type,
    subject_id,
    reason,
    detail
   FROM audit_trail.event
  WHERE actor_id = private.uid();

REVOKE EXECUTE ON FUNCTION membership_grant(p_user_id uuid, p_org_id uuid, p_member_role text, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION membership_revoke(p_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION user_reactivate(p_user_id uuid, p_reason text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION user_suspend(p_user_id uuid, p_reason text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION role_assignment_revoke(
    p_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_role text;
  v_scope_unit uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where id = p_id and revoked_at is null
  returning user_id, db_role, scope_unit_id into v_user, v_role, v_scope_unit;

  if not found then
    raise exception 'assignment_not_found_or_revoked';
  end if;

  perform private.emit_event(
    'iam.assignment.revoked', 'success', 'app_user', v_user, v_scope_unit, p_reason,
    jsonb_build_object('db_role', v_role, 'assignment_id', p_id));
end;
$$;

GRANT EXECUTE ON FUNCTION membership_grant(p_user_id uuid, p_org_id uuid, p_member_role text, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION membership_grant(p_user_id uuid, p_org_id uuid, p_member_role text, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION membership_revoke(p_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION membership_revoke(p_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION user_reactivate(p_user_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION user_reactivate(p_user_id uuid, p_reason text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION user_suspend(p_user_id uuid, p_reason text) TO int_coordinator;

GRANT EXECUTE ON FUNCTION user_suspend(p_user_id uuid, p_reason text) TO int_sysadmin;

GRANT SELECT ON TABLE audit_changes TO int_compliance;

GRANT SELECT ON TABLE audit_changes TO int_sysadmin;

GRANT SELECT ON TABLE audit_events TO int_compliance;

GRANT SELECT ON TABLE audit_events TO int_manager;

GRANT SELECT ON TABLE audit_events TO int_sysadmin;

GRANT SELECT ON TABLE my_activity TO ext_user;

GRANT SELECT ON TABLE my_activity TO int_auditor;

GRANT SELECT ON TABLE my_activity TO int_compliance;

GRANT SELECT ON TABLE my_activity TO int_coordinator;

GRANT SELECT ON TABLE my_activity TO int_finance;

GRANT SELECT ON TABLE my_activity TO int_hr;

GRANT SELECT ON TABLE my_activity TO int_manager;

GRANT SELECT ON TABLE my_activity TO int_surveyor;

GRANT SELECT ON TABLE my_activity TO int_sysadmin;

GRANT SELECT ON TABLE my_activity TO int_viewer;
