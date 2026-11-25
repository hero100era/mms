-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

ALTER TABLE core.org_unit_coverage
ADD CONSTRAINT org_unit_coverage_valid_bounds_ck CHECK (lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE core.org_unit_coverage VALIDATE CONSTRAINT org_unit_coverage_valid_bounds_ck;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

ALTER TABLE iam.org_membership
ADD CONSTRAINT org_membership_valid_bounds_ck CHECK (lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE iam.org_membership VALIDATE CONSTRAINT org_membership_valid_bounds_ck;

ALTER TABLE iam.role_assignment
ADD CONSTRAINT role_assignment_valid_bounds_ck CHECK (lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE iam.role_assignment VALIDATE CONSTRAINT role_assignment_valid_bounds_ck;

ALTER TABLE iam.staff_position
ADD CONSTRAINT staff_position_valid_bounds_ck CHECK (lower_inc(valid) AND NOT upper_inc(valid)) NOT VALID;

ALTER TABLE iam.staff_position VALIDATE CONSTRAINT staff_position_valid_bounds_ck;

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION invite_external_user(
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
  v_token text;
  v_expires timestamptz;
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
  if v_user.status = 'deactivated' then
    raise exception 'user_deactivated';
  end if;
  if v_user.status <> 'invited' then
    raise exception 'user_already_active_or_not_invited' using errcode = '42501';
  end if;

  v_token := encode(sha256(convert_to(
    gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'
  )), 'hex');
  v_expires := now() + interval '72 hours';

  update iam.one_time_token
     set expires_at = now()
   where user_id = p_user_id
     and purpose = 'invite'
     and used_at is null
     and expires_at > now();

  insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_by)
  values (p_user_id, 'invite', sha256(convert_to(v_token, 'UTF8')), v_expires, private.uid());

  insert into core.outbox (kind, payload, status, enqueued_by)
  values (
    'invite_email',
    jsonb_build_object(
      'user_id', p_user_id,
      'email', v_user.email,
      'display_name', v_user.display_name,
      'token', v_token
    ),
    'pending',
    private.uid()
  );

  perform private.emit_event(
    'auth.invite.created', 'success', 'app_user', p_user_id, null, p_reason,
    jsonb_build_object('expires_at', v_expires)
  );
end;
$$;

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

CREATE OR REPLACE FUNCTION org_coverage_end(
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
  v_covered uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  select covered_unit_id into v_covered
    from core.org_unit_coverage
   where id = p_id and upper_inf(valid)
   for update;

  if v_covered is null then
    raise exception 'coverage_not_found_or_already_ended';
  end if;

  update core.org_unit_coverage
     set valid = tstzrange(lower(valid), now())
   where id = p_id;

  perform private.emit_event(
    'org.coverage.ended', 'success', 'org_unit_coverage', p_id, v_covered,
    p_reason, '{}'::jsonb);
end;
$$;

CREATE OR REPLACE FUNCTION org_coverage_set(
    p_unit_id uuid,
    p_covered_unit_id uuid,
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
  v_actor uuid := nullif(private.claim('sub'), '')::uuid;
begin
  perform private.assert_sysadmin();
  perform private.set_change_context(p_reason);

  if v_actor is null then
    raise exception 'actor_required';
  end if;

  if p_unit_id = nullif(private.claim('org_unit_id'), '')::uuid then
    raise exception 'cannot_change_own_coverage' using errcode = '42501';
  end if;

  -- R2.5: serialise coverage changes for this subject unit before closing the
  -- open period and opening a new one.
  perform 1 from core.org_unit where id = p_unit_id for update;

  update core.org_unit_coverage
     set valid = tstzrange(lower(valid), now())
   where unit_id = p_unit_id
     and covered_unit_id = p_covered_unit_id
     and upper_inf(valid);

  insert into core.org_unit_coverage (unit_id, covered_unit_id, set_by, reason)
  values (p_unit_id, p_covered_unit_id, v_actor, p_reason)
  returning id into v_id;

  perform private.emit_event(
    'org.coverage.granted', 'success', 'org_unit_coverage', v_id, p_covered_unit_id,
    p_reason, jsonb_build_object('unit_id', p_unit_id, 'covered_unit_id', p_covered_unit_id));

  return v_id;
end;
$$;

CREATE OR REPLACE FUNCTION role_assignment_grant(
    p_user_id uuid,
    p_db_role text,
    p_scope_type text,
    p_scope_unit_id uuid,
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
begin
  perform private.assert_sysadmin();
  if p_user_id = private.uid() then
    raise exception 'cannot_grant_self' using errcode = '42501';
  end if;
  perform private.assert_role_eligible(p_user_id, p_db_role);
  perform private.set_change_context(p_reason);

  -- R2.5: lock the subject user before opening a new assignment period.
  perform 1 from iam.app_user where id = p_user_id for update;

  insert into iam.role_assignment
    (user_id, user_kind, db_role, scope_type, scope_unit_id, source, granted_by, grant_reason)
  values
    (p_user_id, 'internal', p_db_role, p_scope_type, p_scope_unit_id, 'manual', private.uid(), p_reason)
  returning id into v_id;

  perform private.emit_event(
    'iam.assignment.granted', 'success', 'app_user', p_user_id, p_scope_unit_id, p_reason,
    jsonb_build_object('db_role', p_db_role, 'scope_type', p_scope_type, 'assignment_id', v_id));
  return v_id;
end;
$$;

CREATE OR REPLACE FUNCTION staff_position_close(
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
  v_unit uuid;
begin
  perform private.assert_authority('hr.position.set');
  if p_user_id = private.uid() then
    raise exception 'cannot_close_own_position' using errcode = '42501';
  end if;
  perform private.set_change_context(p_reason);

  select unit_id into v_unit from iam.staff_position
   where user_id = p_user_id and valid @> now() for update;
  if not found then
    raise exception 'current_position_not_found';
  end if;

  -- R2.5: lock the subject before closing periods and suspending the user.
  perform 1 from iam.app_user where id = p_user_id for update;

  perform private.assert_in_scope(v_unit);

  update iam.staff_position
     set valid = tstzrange(lower(valid), now())
   where user_id = p_user_id and valid @> now();

  update iam.role_assignment
     set revoked_at = now(), revoked_by = private.uid(), revoke_reason = p_reason
   where user_id = p_user_id and source = 'position' and revoked_at is null;

  if not exists (
    select 1 from iam.role_assignment
     where user_id = p_user_id and revoked_at is null and valid @> now()
  ) then
    update iam.app_user set status = 'suspended' where id = p_user_id and status = 'active';
  end if;

  perform private.emit_event(
    'iam.position.closed', 'success', 'app_user', p_user_id, v_unit, p_reason, '{}'::jsonb);
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_accept(
    p_id uuid,
    p_reason text,
    p_triage_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: must be submitted' using errcode = '22023';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'accepted',
         triage_notes = coalesce(p_triage_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = rowcount;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.accepted', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'accepted', 'triage_notes', p_triage_notes)
  );
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_reject(
    p_id uuid,
    p_reason text,
    p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: must be submitted' using errcode = '22023';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'rejected',
         triage_notes = coalesce(p_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = rowcount;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.rejected', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'rejected', 'triage_notes', p_notes)
  );
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_request_clarification(
    p_id uuid,
    p_reason text,
    p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: must be submitted' using errcode = '22023';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'clarification_requested',
         triage_notes = coalesce(p_notes, triage_notes),
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = rowcount;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.clarification_requested', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'clarification_requested', 'triage_notes', p_notes)
  );
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_submit(
    p_id uuid,
    p_reason text DEFAULT 'Submitted for station triage'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_role text := private.active_role();
  v_changed int;
begin
  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_role = 'ext_user' then
    if not (v_req.org_id = any (private.my_org_ids())) then
      raise exception 'unauthorized_org' using errcode = '42501';
    end if;
  elsif v_role in ('int_coordinator', 'int_manager', 'int_sysadmin') then
    if v_role <> 'int_sysadmin' then
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
  else
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Idempotent submit
  if v_req.status = 'submitted' then
    return p_id;
  end if;

  if v_req.status not in ('draft', 'clarification_requested') then
    raise exception 'invalid_state_transition: cannot submit from %', v_req.status using errcode = '22023';
  end if;

  if v_req.survey_types is null or cardinality(v_req.survey_types) = 0 then
    raise exception 'survey_types_required' using errcode = '22023';
  end if;

  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set status = 'submitted',
         updated_by = private.uid()
   where id = p_id
     and status in ('draft', 'clarification_requested');
  -- R2.4: the state predicate and the row count make the transition atomic
  -- even if the row changed between the lock and the UPDATE. `id` is the PK,
  -- so anything other than exactly one row is a conflict, not a silent no-op.
  get diagnostics v_changed = rowcount;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.submitted', 'success', 'survey_request', p_id, v_req.office_unit_id, p_reason,
    jsonb_build_object('request_no', v_req.request_no, 'status', 'submitted')
  );

  return p_id;
end;
$$;

CREATE OR REPLACE FUNCTION survey_request_transfer(
    p_id uuid,
    p_new_office_unit_id uuid,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_req survey.survey_request;
  v_target_type text;
  v_previous_office uuid;
  v_changed int;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_req from survey.survey_request where id = p_id for update;
  if not found then
    raise exception 'survey_request_not_found' using errcode = '22023';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'invalid_state_transition: only submitted requests can be transferred' using errcode = '22023';
  end if;

  perform private.assert_in_scope(v_req.office_unit_id);
  perform private.assert_authority('survey.request.triage');

  select unit_type into v_target_type from core.org_unit where id = p_new_office_unit_id and active;
  if v_target_type is distinct from 'station' then
    raise exception 'target unit must be an active station' using errcode = '23514';
  end if;

  if p_new_office_unit_id = v_req.office_unit_id then
    return;
  end if;

  v_previous_office := v_req.office_unit_id;
  perform private.set_change_context(p_reason, v_req.org_id);

  update survey.survey_request
     set office_unit_id = p_new_office_unit_id,
         updated_by = private.uid()
   where id = p_id
     and status = 'submitted';
  get diagnostics v_changed = rowcount;
  if v_changed <> 1 then
    raise exception 'workflow_conflict' using errcode = '40001';
  end if;

  perform private.emit_event(
    'survey.request.transferred', 'success', 'survey_request', p_id, p_new_office_unit_id, p_reason,
    jsonb_build_object(
      'request_no', v_req.request_no,
      'previous_office_unit_id', v_previous_office,
      'new_office_unit_id', p_new_office_unit_id
    )
  );
end;
$$;
