
create view api.audit_events
with (security_invoker = true)
as
select id, occurred_at, tx_id, event_type, outcome, actor_id, session_id, db_role,
       auth_method, on_behalf_of, initiated_by, actor_title, actor_grade, actor_unit_id,
       authority_rule_id, subject_type, subject_id, subject_revision, scope_unit_id,
       request_id, trace_id, source, client_ip, user_agent, reason, detail
  from audit_trail.event;

create view api.audit_changes
with (security_invoker = true)
as
select id, occurred_at, tx_id, schema_name, table_name, op, row_id,
       old_row, new_row, changed_cols, actor_id, actor_label, db_role,
       session_id, auth_method, on_behalf_of, initiated_by,
       request_id, trace_id, source, client_ip, reason
  from audit_trail.change_log;

create view api.my_activity
with (security_invoker = true)
as
select id, occurred_at, event_type, outcome, subject_type, subject_id,
       reason, detail
  from audit_trail.event
 where actor_id = private.uid();

grant select on api.audit_events to int_compliance, int_sysadmin, int_manager;
grant select on api.audit_changes to int_compliance, int_sysadmin;
grant select on api.my_activity to
  ext_user, int_viewer, int_surveyor, int_auditor, int_coordinator, int_manager,
  int_compliance, int_hr, int_finance, int_sysadmin;

create function api.user_suspend(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
  if v_user.kind = 'service' or p_user_id = private.uid() then
    raise exception 'cannot_suspend_self_or_service' using errcode = '42501';
  end if;
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' and v_user.kind <> 'external' then
    raise exception 'external_user_required' using errcode = '42501';
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

create function api.user_reactivate(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
  if v_user.kind = 'service' then
    raise exception 'cannot_reactivate_service' using errcode = '42501';
  end if;
  if coalesce(private.claim('role'), '') <> 'int_sysadmin' and v_user.kind <> 'external' then
    raise exception 'external_user_required' using errcode = '42501';
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

create function api.membership_grant(
  p_user_id uuid,
  p_org_id uuid,
  p_member_role text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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

  -- R2.5: lock the subject user before changing membership/identity state.
  select * into v_user from iam.app_user where id = p_user_id and kind = 'external' for update;
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

create function api.membership_revoke(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

revoke all on function api.user_suspend(uuid, text) from public;
revoke all on function api.user_reactivate(uuid, text) from public;
revoke all on function api.membership_grant(uuid, uuid, text, text) from public;
revoke all on function api.membership_revoke(uuid, text) from public;

grant execute on function api.user_suspend(uuid, text) to int_coordinator, int_sysadmin;
grant execute on function api.user_reactivate(uuid, text) to int_coordinator, int_sysadmin;
grant execute on function api.membership_grant(uuid, uuid, text, text) to int_coordinator, int_sysadmin;
grant execute on function api.membership_revoke(uuid, text) to int_coordinator, int_sysadmin;
