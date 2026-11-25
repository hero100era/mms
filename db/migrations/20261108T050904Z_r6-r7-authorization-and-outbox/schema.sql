-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

GRANT EXECUTE ON FUNCTION job_begin(p_job_id uuid) TO PUBLIC;

GRANT EXECUTE ON FUNCTION job_complete(p_job_id uuid, p_status text, p_error text) TO PUBLIC;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) TO PUBLIC;

REVOKE EXECUTE ON FUNCTION job_begin(p_job_id uuid) FROM worker;

REVOKE EXECUTE ON FUNCTION job_complete(p_job_id uuid, p_status text, p_error text) FROM worker;

REVOKE EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) FROM int_hr;

REVOKE EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) FROM int_sysadmin;

REVOKE EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb) FROM worker;

DROP FUNCTION IF EXISTS position_proposal_record(uuid, text, text, text, jsonb);

DROP FUNCTION IF EXISTS job_complete(uuid, text, text);

DROP FUNCTION IF EXISTS job_begin(uuid);

CREATE OR REPLACE FUNCTION explain_authority(
    p_action_code text,
    p_amount numeric DEFAULT NULL,
    p_unit_id uuid DEFAULT NULL,
    p_record_id uuid DEFAULT NULL
)
RETURNS TABLE(allowed boolean, reason_code text, action_code text, rule_id uuid, details jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_position record;
  v_rule record;
  v_role text := private.active_role();
  v_src text := private.audit_source();
  v_uid uuid := private.uid();
  v_req_creator uuid;
  v_proposal record;
  v_qual_user uuid;
begin
  -- 1. Break-glass prohibition check
  if v_src = 'break_glass' and exists (
    select 1 from iam.break_glass_forbidden_action bg where bg.action_code = p_action_code
  ) then
    return query select false, 'break_glass_forbidden'::text, p_action_code, null::uuid,
      jsonb_build_object('source', 'break_glass');
    return;
  end if;

  -- 2. Sysadmin cannot approve regulated business records
  if v_role = 'int_sysadmin' and p_action_code in (
    'survey.request.triage', 'survey.job.assign', 'survey.report.release',
    'survey.report.countersign', 'audit_trail.report.release', 'billing.credit_note.approve',
    'hr.position.set', 'qual.grant', 'qual.revoke', 'cert.issue', 'cert.cancel',
    'cert.revoke', 'compliance.record.hold'
  ) then
    return query select false, 'sysadmin_cannot_approve'::text, p_action_code, null::uuid,
      jsonb_build_object('role', v_role);
    return;
  end if;

  -- 3. Position check
  select * into v_position from private.my_position();
  if not found then
    return query select false, 'no_position'::text, p_action_code, null::uuid,
      jsonb_build_object('role', v_role);
    return;
  end if;

  -- 4. Scope check (if p_unit_id supplied)
  if p_unit_id is not null then
    if not (p_unit_id = any (private.my_units()) or p_unit_id = any (private.my_offices())) then
      return query select false, 'out_of_scope'::text, p_action_code, null::uuid,
        jsonb_build_object('unit_id', p_unit_id);
      return;
    end if;
  end if;

  -- 5. Segregation of duties checks (if p_record_id supplied)
  if p_record_id is not null then
    if p_action_code = 'survey.request.triage' then
      select created_by into v_req_creator from survey.survey_request where id = p_record_id;
      if found and v_req_creator is not null and v_req_creator = v_uid then
        return query select false, 'creator_cannot_approve'::text, p_action_code, null::uuid,
          jsonb_build_object('record_id', p_record_id);
        return;
      end if;
    elsif p_action_code = 'hr.position.set' then
      if p_record_id = v_uid then
        return query select false, 'cannot_approve_own'::text, p_action_code, null::uuid,
          jsonb_build_object('user_id', p_record_id);
        return;
      end if;
      select proposed_by, user_id into v_proposal from iam.position_proposal where id = p_record_id;
      if found and (v_proposal.proposed_by = v_uid or v_proposal.user_id = v_uid) then
        return query select false, 'cannot_confirm_own_proposal'::text, p_action_code, null::uuid,
          jsonb_build_object('proposal_id', p_record_id);
        return;
      end if;
    elsif p_action_code = 'qual.grant' then
      if p_record_id = v_uid then
        return query select false, 'cannot_grant_self'::text, p_action_code, null::uuid,
          jsonb_build_object('user_id', p_record_id);
        return;
      end if;
    elsif p_action_code = 'qual.revoke' then
      if p_record_id = v_uid then
        return query select false, 'cannot_revoke_self'::text, p_action_code, null::uuid,
          jsonb_build_object('user_id', p_record_id);
        return;
      end if;
      select user_id into v_qual_user from qual.staff_qualification where id = p_record_id;
      if found and v_qual_user = v_uid then
        return query select false, 'cannot_revoke_self'::text, p_action_code, null::uuid,
          jsonb_build_object('qualification_id', p_record_id, 'user_id', v_qual_user);
        return;
      end if;
    end if;
  end if;

  -- 6. Authority rule matching
  select r.id, r.min_grade, r.max_amount, r.requires_qualification
    into v_rule
    from iam.authority_rule r
   where r.action_code = p_action_code
     and r.db_role = v_role
     and (r.job_family is null or r.job_family = v_position.job_family)
     and (r.unit_type is null or r.unit_type = v_position.unit_type)
     and v_position.grade >= r.min_grade
     and r.valid @> now()
     and (r.max_amount is null or (p_amount is not null and p_amount <= r.max_amount))
   order by r.min_grade desc, r.max_amount nulls first
   limit 1;

  if not found then
    if not exists (select 1 from iam.authority_rule ar where ar.action_code = p_action_code and ar.db_role = v_role and ar.valid @> now()) then
      return query select false, 'rule_not_found'::text, p_action_code, null::uuid,
        jsonb_build_object('action', p_action_code, 'role', v_role);
    elsif p_amount is not null and exists (
      select 1 from iam.authority_rule ar
       where ar.action_code = p_action_code and ar.db_role = v_role and ar.valid @> now()
         and (ar.job_family is null or ar.job_family = v_position.job_family)
         and (ar.unit_type is null or ar.unit_type = v_position.unit_type)
         and v_position.grade >= ar.min_grade
         and ar.max_amount is not null and p_amount > ar.max_amount
    ) then
      return query select false, 'amount_exceeded'::text, p_action_code, null::uuid,
        jsonb_build_object('amount', p_amount);
    elsif not exists (
      select 1 from iam.authority_rule ar
       where ar.action_code = p_action_code and ar.db_role = v_role and ar.valid @> now()
         and (ar.job_family is null or ar.job_family = v_position.job_family)
         and (ar.unit_type is null or ar.unit_type = v_position.unit_type)
         and v_position.grade >= ar.min_grade
    ) then
      return query select false, 'min_grade_insufficient'::text, p_action_code, null::uuid,
        jsonb_build_object('grade', v_position.grade);
    else
      return query select false, 'position_ineligible'::text, p_action_code, null::uuid,
        jsonb_build_object('job_family', v_position.job_family, 'unit_type', v_position.unit_type);
    end if;
    return;
  end if;

  -- 7. Qualification check
  if v_rule.requires_qualification then
    if not exists (
      select 1
        from qual.staff_qualification sq
        join qual.qualification q on q.code = sq.qualification_code
        left join qual.qualification_action qa on qa.qualification_code = q.code
       where sq.user_id = v_uid
         and sq.valid @> now()
         and sq.revoked_at is null
         and (
           sq.qualification_code = p_action_code
           or q.action_code = p_action_code
           or qa.action_code = p_action_code
         )
    ) then
      return query select false, 'qualification_required'::text, p_action_code, v_rule.id,
        jsonb_build_object('action', p_action_code);
      return;
    end if;
  end if;

  -- 8. Allowed
  return query select true, 'ok'::text, p_action_code, v_rule.id,
    jsonb_build_object('title', v_position.job_title_code, 'grade', v_position.grade);
end;
$$;

CREATE OR REPLACE FUNCTION job_begin(
    p_job_id uuid,
    p_lease_seconds integer DEFAULT 60,
    p_worker_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_job core.outbox;
  v_worker_id uuid;
  v_worker_name text;
  v_worker_tag text;
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  select id, display_name into v_worker_id, v_worker_name
    from iam.app_user
   where kind = 'service' and service_name = 'worker' and status = 'active';

  if v_worker_id is null then
    insert into iam.app_user (id, kind, display_name, service_name, status)
    values ('00000000-0000-0000-0000-000000000001', 'service', 'Outbox Worker', 'worker', 'active')
    on conflict (service_name) do update set status = 'active'
    returning id, display_name into v_worker_id, v_worker_name;
  end if;

  select * into v_job
    from core.outbox
   where id = p_job_id
     for update;

  if not found then
    raise exception 'job_not_found';
  end if;

  if v_job.status <> 'pending' and not (v_job.status = 'processing' and v_job.lease_expires_at < now()) then
    raise exception 'job_not_pending' using errcode = '55P03';
  end if;

  v_worker_tag := coalesce(p_worker_id, v_worker_id::text);

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub', v_worker_id::text,
      'name', coalesce(v_worker_name, 'worker'),
      'role', 'worker',
      'src', 'job'
    )::text, true);

  if v_job.enqueued_by is not null then
    perform set_config('mms.initiated_by', v_job.enqueued_by::text, true);
  else
    perform set_config('mms.initiated_by', '', true);
  end if;

  update core.outbox
     set status = 'processing',
         attempts = attempts + 1,
         lease_expires_at = now() + (greatest(coalesce(p_lease_seconds, 60), 1) || ' seconds')::interval,
         leased_by = v_worker_tag
   where id = p_job_id
  returning * into v_job;

  return jsonb_build_object(
    'id', v_job.id,
    'kind', v_job.kind,
    'payload', v_job.payload,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'max_attempts', v_job.max_attempts,
    'lease_expires_at', v_job.lease_expires_at,
    'leased_by', v_job.leased_by,
    'enqueued_by', v_job.enqueued_by,
    'created_at', v_job.created_at
  );
end;
$$;

CREATE OR REPLACE FUNCTION job_complete(
    p_job_id uuid,
    p_status text DEFAULT 'done',
    p_error text DEFAULT NULL,
    p_error_class text DEFAULT NULL,
    p_retry_delay_seconds integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_job core.outbox;
  v_worker_id uuid;
  v_worker_name text;
  v_retry_delay int;
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  if p_status not in ('done', 'failed', 'dead_letter', 'retry') then
    raise exception 'invalid_job_status' using errcode = '22023';
  end if;

  select * into v_job
    from core.outbox
   where id = p_job_id and status = 'processing'
     for update;

  if not found then
    raise exception 'job_not_processing';
  end if;

  select id, display_name into v_worker_id, v_worker_name
    from iam.app_user
   where kind = 'service' and service_name = 'worker' and status = 'active';

  if v_worker_id is not null then
    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', v_worker_id::text,
        'name', coalesce(v_worker_name, 'worker'),
        'role', 'worker',
        'src', 'job'
      )::text, true);
  end if;

  if v_job.enqueued_by is not null then
    perform set_config('mms.initiated_by', v_job.enqueued_by::text, true);
  end if;

  if p_status = 'done' then
    update core.outbox
       set status = 'done',
           lease_expires_at = null,
           leased_by = null
     where id = p_job_id;
  elsif p_status = 'dead_letter' then
    update core.outbox
       set status = 'dead_letter',
           lease_expires_at = null,
           leased_by = null,
           last_error_class = coalesce(p_error_class, 'terminal'),
           payload = case
             when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
             else payload
           end
     where id = p_job_id;
  elsif p_status = 'retry' then
    if v_job.attempts >= v_job.max_attempts or coalesce(p_error_class, '') = 'fatal' then
      update core.outbox
         set status = 'dead_letter',
             lease_expires_at = null,
             leased_by = null,
             last_error_class = coalesce(p_error_class, 'max_attempts_exceeded'),
             payload = case
               when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
               else payload
             end
       where id = p_job_id;
    else
      v_retry_delay := coalesce(p_retry_delay_seconds, least(300, (5 * power(2, greatest(v_job.attempts - 1, 0)))::int));
      update core.outbox
         set status = 'pending',
             next_at = now() + (v_retry_delay || ' seconds')::interval,
             lease_expires_at = null,
             leased_by = null,
             last_error_class = coalesce(p_error_class, 'transient'),
             payload = case
               when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
               else payload
             end
       where id = p_job_id;
    end if;
  elsif p_status = 'failed' then
    update core.outbox
       set status = 'failed',
           lease_expires_at = null,
           leased_by = null,
           last_error_class = coalesce(p_error_class, 'unhandled'),
           payload = case
             when p_error is not null then jsonb_set(payload, '{error}', to_jsonb(p_error))
             else payload
           end
     where id = p_job_id;
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION job_heartbeat(
    p_job_id uuid,
    p_extend_seconds integer DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if not private.is_worker() then
    raise exception 'worker_role_required' using errcode = '42501';
  end if;

  update core.outbox
     set lease_expires_at = now() + (greatest(coalesce(p_extend_seconds, 60), 1) || ' seconds')::interval
   where id = p_job_id
     and status = 'processing';

  if not found then
    raise exception 'job_not_processing';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION position_proposal_record(
    p_user_id uuid,
    p_entra_job_title text,
    p_entra_department text,
    p_entra_office text,
    p_payload jsonb DEFAULT '{}',
    p_proposed_by uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_user iam.app_user;
  v_title text;
  v_unit uuid;
  v_id uuid;
  v_proposer uuid;
begin
  if not (private.is_worker_or_admin() or coalesce(private.active_role(), '') = 'int_hr') then
    raise exception 'worker_or_admin_role_required' using errcode = '42501';
  end if;

  select * into v_user from iam.app_user
   where id = p_user_id and kind = 'internal' and status = 'active';
  if not found then
    raise exception 'internal_user_not_found';
  end if;

  select t.code into v_title from iam.job_title t
   where t.active and lower(t.code) = lower(btrim(coalesce(p_entra_job_title, '')));
  select u.id into v_unit from core.org_unit u
   where u.active and lower(u.code) = lower(btrim(coalesce(p_entra_office, ''))) limit 1;

  v_proposer := coalesce(p_proposed_by, nullif(private.uid(), '00000000-0000-0000-0000-000000000001'::uuid));

  insert into iam.position_proposal (
    user_id, job_title_code, unit_id, entra_job_title, entra_department, entra_office,
    source, source_payload, proposed_by
  )
  values (
    v_user.id, v_title, v_unit,
    nullif(btrim(p_entra_job_title), ''),
    nullif(btrim(p_entra_department), ''),
    nullif(btrim(p_entra_office), ''),
    case when private.is_worker() then 'entra' else 'hr' end,
    coalesce(p_payload, '{}'::jsonb),
    v_proposer
  )
  on conflict (user_id) where status = 'pending'
  do update set job_title_code = excluded.job_title_code,
                unit_id = excluded.unit_id,
                entra_job_title = excluded.entra_job_title,
                entra_department = excluded.entra_department,
                entra_office = excluded.entra_office,
                source_payload = excluded.source_payload,
                proposed_by = coalesce(excluded.proposed_by, iam.position_proposal.proposed_by),
                proposed_at = now()
  returning id into v_id;

  perform private.emit_event(
    'iam.position.proposed', 'success', 'staff_user', v_user.id, v_unit,
    'position proposed from directory attributes',
    jsonb_build_object('proposal_id', v_id, 'job_title_guess', v_title, 'unit_guess', v_unit)
  );
  return v_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION job_begin(p_job_id uuid, p_lease_seconds integer, p_worker_id text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION job_complete(p_job_id uuid, p_status text, p_error text, p_error_class text, p_retry_delay_seconds integer) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION job_heartbeat(p_job_id uuid, p_extend_seconds integer) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb, p_proposed_by uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION job_poll(
    p_limit integer DEFAULT 10
)
RETURNS TABLE(id uuid, kind text, payload jsonb, attempts integer, enqueued_by uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  -- A job that another instance has already claimed (`processing`) or finished
  -- (`done`) must never be handed out twice: `job_begin` has already bumped
  -- `attempts` and set the worker context, so re-processing would re-send the
  -- invite mail and double the audit attribution. Only terminal states are
  -- retried, and `failed` is terminal here (a human re-queues it).
  --
  -- R7.2: durable outbox leasing with `FOR UPDATE SKIP LOCKED`.
  -- Reclaims orphaned jobs whose lease has expired.
  return query
  select o.id, o.kind, o.payload, o.attempts, o.enqueued_by
    from core.outbox o
   where ((o.status = 'pending' and o.next_at <= now())
          or (o.status = 'processing' and o.lease_expires_at is not null and o.lease_expires_at < now()))
   order by o.next_at, o.created_at
   limit coalesce(p_limit, 10)
     for update skip locked;
end;
$$;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_viewer;

GRANT EXECUTE ON FUNCTION job_begin(p_job_id uuid, p_lease_seconds integer, p_worker_id text) TO worker;

GRANT EXECUTE ON FUNCTION job_complete(p_job_id uuid, p_status text, p_error text, p_error_class text, p_retry_delay_seconds integer) TO worker;

GRANT EXECUTE ON FUNCTION job_heartbeat(p_job_id uuid, p_extend_seconds integer) TO worker;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb, p_proposed_by uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb, p_proposed_by uuid) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION position_proposal_record(p_user_id uuid, p_entra_job_title text, p_entra_department text, p_entra_office text, p_payload jsonb, p_proposed_by uuid) TO worker;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

ALTER TABLE outbox
ADD COLUMN max_attempts integer DEFAULT 5 NOT NULL CONSTRAINT outbox_max_attempts_ck CHECK (max_attempts >= 1);

ALTER TABLE outbox ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE outbox ADD COLUMN leased_by text;

ALTER TABLE outbox ADD COLUMN last_error_class text;

ALTER TABLE outbox DROP CONSTRAINT outbox_status_ck;

ALTER TABLE core.outbox
ADD CONSTRAINT outbox_status_ck CHECK (status IN ('pending'::text, 'processing'::text, 'done'::text, 'failed'::text, 'dead_letter'::text)) NOT VALID;

ALTER TABLE core.outbox VALIDATE CONSTRAINT outbox_status_ck;

-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

ALTER TABLE iam.authority_rule
ADD CONSTRAINT authority_rule_sysadmin_ck CHECK (NOT (db_role = 'int_sysadmin'::text AND (action_code IN ('survey.request.triage'::text, 'survey.job.assign'::text, 'survey.report.release'::text, 'survey.report.countersign'::text, 'audit_trail.report.release'::text, 'billing.credit_note.approve'::text, 'hr.position.set'::text, 'qual.grant'::text, 'qual.revoke'::text)))) NOT VALID;

ALTER TABLE iam.authority_rule VALIDATE CONSTRAINT authority_rule_sysadmin_ck;

ALTER TABLE position_proposal
ADD COLUMN proposed_by uuid CONSTRAINT position_proposal_proposed_by_fk REFERENCES app_user (id);

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

REVOKE EXECUTE ON FUNCTION position_proposal_confirm(p_id uuid, p_job_title_code text, p_unit_id uuid, p_line_manager_id uuid, p_reason text) FROM int_sysadmin;

REVOKE EXECUTE ON FUNCTION position_proposal_reject(p_id uuid, p_reason text) FROM int_sysadmin;

REVOKE EXECUTE ON FUNCTION staff_qualification_grant(p_user_id uuid, p_qualification_code text, p_valid_from timestamp with time zone, p_valid_until timestamp with time zone, p_reason text) FROM int_sysadmin;

REVOKE EXECUTE ON FUNCTION staff_qualification_revoke(p_id uuid, p_reason text) FROM int_sysadmin;

CREATE OR REPLACE FUNCTION explain_authority(
    p_action_code text,
    p_amount numeric DEFAULT NULL,
    p_unit_id uuid DEFAULT NULL,
    p_record_id uuid DEFAULT NULL
)
RETURNS TABLE(allowed boolean, reason_code text, action_code text, rule_id uuid, details jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_role text := private.active_role();
begin
  if v_role not in (
    'int_compliance', 'int_manager', 'int_sysadmin', 'int_hr',
    'int_coordinator', 'int_surveyor', 'int_auditor', 'int_finance'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query select * from private.explain_authority(p_action_code, p_amount, p_unit_id, p_record_id);
end;
$$;

REVOKE EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION position_proposal_confirm(
    p_id uuid,
    p_job_title_code text,
    p_unit_id uuid,
    p_line_manager_id uuid,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_proposal iam.position_proposal;
  v_title text;
  v_unit uuid;
  v_position_id uuid;
begin
  if coalesce(private.active_role(), '') <> 'int_hr' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  perform private.assert_not_break_glass('hr.position.set');

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_proposal from iam.position_proposal where id = p_id for update;
  if not found then
    raise exception 'position_proposal_not_found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'position_proposal_already_decided' using errcode = '22023';
  end if;

  -- R6.3: Segregation of Duties - Creator/proposer cannot confirm own proposal, nor can user confirm their own position
  if (v_proposal.proposed_by is not null and v_proposal.proposed_by = private.uid())
     or v_proposal.user_id = private.uid() then
    raise exception 'cannot_confirm_own_proposal' using errcode = '42501';
  end if;

  v_title := coalesce(nullif(btrim(p_job_title_code), ''), v_proposal.job_title_code);
  v_unit := coalesce(p_unit_id, v_proposal.unit_id);
  if v_title is null or v_unit is null then
    raise exception 'position_proposal_incomplete' using errcode = '22023';
  end if;

  perform private.set_change_context(p_reason);
  v_position_id := api.staff_position_set(
    v_proposal.user_id, v_title, v_unit, null, p_line_manager_id, now(), p_reason
  );

  update iam.position_proposal
     set status = 'confirmed',
         decided_at = now(),
         decided_by = private.uid(),
         decision_reason = p_reason,
         staff_position_id = v_position_id,
         job_title_code = v_title,
         unit_id = v_unit
   where id = p_id;

  perform private.emit_event(
    'iam.position.proposal_confirmed', 'success', 'staff_user', v_proposal.user_id, v_unit,
    p_reason, jsonb_build_object('proposal_id', p_id, 'position_id', v_position_id)
  );
  return v_position_id;
end;
$$;

CREATE OR REPLACE FUNCTION position_proposal_reject(
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
  v_proposal iam.position_proposal;
begin
  if coalesce(private.active_role(), '') <> 'int_hr' then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;
  perform private.assert_not_break_glass('hr.position.set');

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_proposal from iam.position_proposal where id = p_id for update;
  if not found then
    raise exception 'position_proposal_not_found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'position_proposal_already_decided' using errcode = '22023';
  end if;

  perform private.set_change_context(p_reason);
  update iam.position_proposal
     set status = 'rejected',
         decided_at = now(),
         decided_by = private.uid(),
         decision_reason = p_reason
   where id = p_id;

  perform private.emit_event(
    'iam.position.proposal_rejected', 'success', 'staff_user', v_proposal.user_id, v_proposal.unit_id,
    p_reason, jsonb_build_object('proposal_id', p_id)
  );
end;
$$;

CREATE OR REPLACE FUNCTION staff_qualification_grant(
    p_user_id uuid,
    p_qualification_code text,
    p_valid_from timestamptz DEFAULT now(),
    p_valid_until timestamptz DEFAULT NULL,
    p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_id uuid;
  v_valid_from timestamptz := coalesce(p_valid_from, now());
  v_valid tstzrange;
  v_role text := private.active_role();
begin
  perform private.assert_not_break_glass('qual.grant');

  if v_role not in ('int_hr', 'int_compliance') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  if p_user_id = private.uid() then
    raise exception 'cannot_grant_self' using errcode = '42501';
  end if;

  if not exists (select 1 from iam.app_user where id = p_user_id and status <> 'deactivated') then
    raise exception 'user_not_found' using errcode = '22023';
  end if;

  if not exists (select 1 from qual.qualification where code = p_qualification_code) then
    raise exception 'qualification_not_found' using errcode = '22023';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if p_valid_until is not null and p_valid_until <= v_valid_from then
    raise exception 'invalid_valid_range' using errcode = '22023';
  end if;

  v_valid := tstzrange(v_valid_from, p_valid_until);

  insert into qual.staff_qualification (
    user_id, qualification_code, valid, granted_by, grant_reason
  ) values (
    p_user_id, p_qualification_code, v_valid, private.uid(), trim(p_reason)
  ) returning id into v_id;

  perform private.emit_event(
    'qual.qualification.granted', 'success', 'staff_qualification', v_id, null, trim(p_reason),
    jsonb_build_object(
      'user_id', p_user_id,
      'qualification_code', p_qualification_code,
      'valid_from', v_valid_from,
      'valid_until', p_valid_until
    )
  );

  return v_id;
end;
$$;

CREATE OR REPLACE FUNCTION staff_qualification_revoke(
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
  v_sq record;
  v_role text := private.active_role();
begin
  perform private.assert_not_break_glass('qual.revoke');

  if v_role not in ('int_hr', 'int_compliance') then
    raise exception 'insufficient_authority' using errcode = '42501';
  end if;

  select * into v_sq
    from qual.staff_qualification
   where id = p_id
     for update;

  if not found then
    raise exception 'qualification_not_found' using errcode = '22023';
  end if;

  if v_sq.revoked_at is not null then
    raise exception 'already_revoked' using errcode = '22023';
  end if;

  if v_sq.user_id = private.uid() then
    raise exception 'cannot_revoke_self' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  update qual.staff_qualification
     set revoked_at = now(),
         revoked_by = private.uid(),
         revoke_reason = trim(p_reason),
         valid = tstzrange(lower(valid), now())
   where id = p_id;

  perform private.emit_event(
    'qual.qualification.revoked', 'success', 'staff_qualification', p_id, null, trim(p_reason),
    jsonb_build_object(
      'user_id', v_sq.user_id,
      'qualification_code', v_sq.qualification_code,
      'revoked_at', now()
    )
  );
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

  -- R6.3: Segregation of Duties (Four-Eyes Review): Creator cannot accept their own survey request
  if v_req.created_by is not null and v_req.created_by = private.uid() then
    raise exception 'creator_cannot_approve' using errcode = '42501';
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

  -- R6.3: Segregation of Duties (Four-Eyes Review): Creator cannot accept their own survey request
  if v_req.created_by is not null and v_req.created_by = private.uid() then
    raise exception 'creator_cannot_approve' using errcode = '42501';
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

  -- R6.3: Segregation of Duties (Four-Eyes Review): Creator cannot accept their own survey request
  if v_req.created_by is not null and v_req.created_by = private.uid() then
    raise exception 'creator_cannot_approve' using errcode = '42501';
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

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_auditor;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_coordinator;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_finance;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_hr;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_surveyor;

GRANT EXECUTE ON FUNCTION explain_authority(p_action_code text, p_amount numeric, p_unit_id uuid, p_record_id uuid) TO int_sysadmin;
