-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION emergency_reenable_break_glass(
    p_user_id uuid,
    p_operator text,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed int;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'operator_required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.break_glass_account
     set enabled = true,
         activated_at = null,
         valid_until = null,
         reason = null
   where user_id = p_user_id
     and not enabled;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_revoke_assignment(
    p_assignment_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user uuid;
  v_changed boolean;
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

CREATE OR REPLACE FUNCTION emergency_revoke_sessions(
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
  v_changed int;
begin
  if not private.is_emergency() then
    raise exception 'emergency_role_required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform set_config('mms.reason', btrim(p_reason), true);
  update iam.session
     set revoked_at = now(), revoke_reason = 'break_glass: ' || btrim(p_reason)
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

CREATE OR REPLACE FUNCTION emergency_suspend_user(
    p_user_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_changed boolean;
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
  return v_changed;
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
  get diagnostics v_changed = row_count;
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
  get diagnostics v_changed = row_count;
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
  get diagnostics v_changed = row_count;
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
  get diagnostics v_changed = row_count;
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
  get diagnostics v_changed = row_count;
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
