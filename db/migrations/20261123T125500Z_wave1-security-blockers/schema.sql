-- Migration: 20261123T125500Z_wave1-security-blockers
-- Addresses Wave 1 database blockers:
--   C-03: Revoke unauthenticated web_anon / read-only grants on private.upload_prepare & upload_mark_uploaded
--   C-04: Exclude core.outbox.payload from audit_trail.change_log and fix stale 'audit' schema exclusions
--   C-05: Restrict api.user_suspend / api.user_reactivate for non-sysadmin callers to external users only
--   C-06: Make private.is_approved_scanner() fail-closed (remove session-writable mms.runtime GUC bypass)
--   H-07: Add p_created_by to private.upload_prepare and add private.upload_get_for_finalize()
--   H-09: Return email from auth.set_password() so invite acceptance populates session email
--   H-15: Fix boolean > integer runtime crash in api.emergency_revoke_assignment & emergency_suspend_user
--   H-16: Enforce temporal validity (valid @> now()) in auth.user_roles()

-- C-06: Fail-closed scanner engine check
create or replace function private.is_approved_scanner(p_engine text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from private.approved_scanner_engine e
     where e.engine = p_engine
       and e.production = true
  );
$$;

-- C-03 & H-07: Replace 7-arg private.upload_prepare with authenticated 8-arg signature
drop function if exists private.upload_prepare(uuid, text, uuid, text, text, text, timestamptz);

create or replace function private.upload_prepare(
  p_upload_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_doc_type text,
  p_file_name text,
  p_quarantine_path text,
  p_expires_at timestamptz,
  p_created_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if not private.is_worker() then
    v_actor := private.uid();
    if v_actor is null then
      raise exception 'authentication_required' using errcode = '42501';
    end if;
  else
    v_actor := coalesce(p_created_by, private.uid());
  end if;

  insert into core.upload (
    id, entity_type, entity_id, doc_type, file_name, quarantine_path,
    upload_state, expires_at, created_by
  ) values (
    p_upload_id, p_entity_type, p_entity_id, p_doc_type, p_file_name, p_quarantine_path,
    'prepared', p_expires_at, v_actor
  );
end;
$$;

create or replace function private.upload_get_for_finalize(p_upload_id uuid)
returns table (
  id uuid,
  entity_type text,
  entity_id uuid,
  doc_type text,
  file_name text,
  quarantine_path text,
  upload_state text,
  created_by uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_worker_or_admin() then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  return query
  select u.id, u.entity_type, u.entity_id, u.doc_type, u.file_name,
         u.quarantine_path, u.upload_state, u.created_by
    from core.upload u
   where u.id = p_upload_id;
end;
$$;

create or replace function private.upload_mark_uploaded(
  p_upload_id uuid,
  p_sha256 bytea,
  p_byte_size bigint,
  p_mime_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if not private.is_worker() and private.uid() is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  update core.upload
     set upload_state = 'uploaded',
         sha256 = p_sha256,
         byte_size = p_byte_size,
         mime_type = p_mime_type,
         updated_at = clock_timestamp(),
         updated_by = coalesce(private.uid(), updated_by)
   where id = p_upload_id
     and upload_state = 'prepared'
     and (private.is_worker() or created_by = private.uid());

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'upload_not_found_or_invalid_state' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.upload_prepare(uuid, text, uuid, text, text, text, timestamptz, uuid) from public;
revoke all on function private.upload_get_for_finalize(uuid) from public;
revoke all on function private.upload_mark_uploaded(uuid, bytea, bigint, text) from public;

revoke execute on function private.upload_mark_uploaded(uuid, bytea, bigint, text)
  from web_anon, int_viewer, int_compliance, int_hr, int_finance;

grant execute on function private.upload_prepare(uuid, text, uuid, text, text, text, timestamptz, uuid)
  to ext_user, int_surveyor, int_auditor, int_coordinator, int_manager, int_sysadmin, worker;
grant execute on function private.upload_get_for_finalize(uuid)
  to worker, int_sysadmin;
grant execute on function private.upload_mark_uploaded(uuid, bytea, bigint, text)
  to ext_user, int_surveyor, int_auditor, int_coordinator, int_manager, int_sysadmin, worker;

-- C-04: Exclude core.outbox.payload and clean up stale 'audit' schema exclusions
delete from audit_trail.excluded_column where schema_name = 'audit';

insert into audit_trail.excluded_column (schema_name, table_name, column_name, mode, reason) values
  ('core', 'outbox', 'payload', 'omit', 'outbox payload may contain single-use reset/invite tokens or PII'),
  ('audit_trail', 'seal', 'batch_hash', 'omit', 'seal batch hash metadata'),
  ('audit_trail', 'seal', 'prev_seal_hash', 'omit', 'seal chain previous hash metadata'),
  ('audit_trail', 'seal', 'seal_hash', 'omit', 'seal hash digest metadata'),
  ('audit_trail', 'forwarder_watermark', 'last_batch_hash', 'omit', 'forwarder watermark batch hash metadata'),
  ('audit_trail', 'crypto_shred_key', 'encrypted_key', 'omit', 'encrypted data encryption key material'),
  ('audit_trail', 'crypto_shred_key', 'key_fingerprint', 'omit', 'crypto shred key fingerprint'),
  ('audit_trail', 'crypto_shred_key', 'key_status', 'omit', 'crypto shred key lifecycle status')
on conflict (schema_name, table_name, column_name) do update
  set mode = excluded.mode, reason = excluded.reason;

-- C-05: Restrict user_suspend and user_reactivate for non-sysadmin callers
create or replace function api.user_suspend(p_user_id uuid, p_reason text)
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

create or replace function api.user_reactivate(p_user_id uuid, p_reason text)
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

-- H-09: Return email from auth.set_password()
create or replace function auth.set_password(p_credential text, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_session_user uuid;
  v_consumed jsonb;
  v_status text;
  v_email text;
  v_is_reset boolean := false;
begin
  if p_hash is null or length(p_hash) < 20 then
    raise exception 'invalid_password_hash' using errcode = '22023';
  end if;
  if p_credential ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select user_id into v_session_user
      from iam.session
     where id = p_credential::uuid
       and revoked_at is null
       and idle_expires_at > now()
       and expires_at > now();
    if v_session_user is null then
      raise exception 'session_not_found' using errcode = '42501';
    end if;
    v_user := v_session_user;
  else
    v_consumed := auth.token_consume('password_reset', p_credential);
    if v_consumed is not null then
      v_is_reset := true;
    else
      v_consumed := auth.token_consume('invite', p_credential);
    end if;
    if v_consumed is null then
      raise exception 'invalid_token' using errcode = '42501';
    end if;
    v_user := (v_consumed ->> 'user_id')::uuid;
  end if;
  select status, email into v_status, v_email from iam.app_user where id = v_user and kind = 'external';
  if not found then
    raise exception 'external_user_required' using errcode = '42501';
  end if;
  if v_status not in ('invited', 'active') then
    raise exception 'user_inactive' using errcode = '42501';
  end if;
  insert into iam.password_credential (user_id, hash)
  values (v_user, p_hash)
  on conflict (user_id) do update set hash = excluded.hash, set_at = now();
  if v_status = 'invited' then
    update iam.app_user
       set status = 'active',
           email_verified_at = coalesce(email_verified_at, now())
     where id = v_user;
    perform auth.log_event('auth.invite.accepted', 'success', v_user, '{}'::jsonb);
  end if;
  perform auth.log_event('auth.password.set', 'success', v_user, jsonb_build_object('method', 'password'));
  if v_is_reset then
    perform auth.log_event('auth.password.reset_completed', 'success', v_user, '{}'::jsonb);
  end if;
  update iam.session
     set revoked_at = now(), revoke_reason = case when v_is_reset then 'password_reset' else 'password_changed' end
   where user_id = v_user and revoked_at is null;
  return jsonb_build_object('user_id', v_user, 'email', v_email);
end;
$$;

-- H-15: Fix boolean > integer runtime crash in emergency break-glass functions
create or replace function api.emergency_suspend_user(p_user_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.app_user
     set status = 'suspended'
   where id = p_user_id
     and status <> 'suspended';
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function api.emergency_revoke_assignment(p_assignment_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_changed integer;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select user_id into v_user from iam.role_assignment where id = p_assignment_id;
  if not found then
    raise exception 'assignment_not_found' using errcode = '42501';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.role_assignment
     set revoked_at = now(),
         revoked_by = v_user,
         revoke_reason = 'break_glass: ' || btrim(p_reason),
         valid = tstzrange(lower(valid), least(now(), upper(valid)), '[)')
   where id = p_assignment_id
     and revoked_at is null;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

-- H-16: Enforce temporal validity in auth.user_roles()
create or replace function auth.user_roles(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct ra.db_role order by ra.db_role), '{}'::text[])
  from iam.role_assignment ra
  where ra.user_id = p_user_id
    and ra.revoked_at is null
    and ra.valid @> now();
$$;
