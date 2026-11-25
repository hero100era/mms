-- ===== schema: private  (pgschema 1.14.1) =====

set local search_path = private;

GRANT EXECUTE ON FUNCTION audit_no_truncate() TO PUBLIC;

CREATE OR REPLACE FUNCTION org_unit_name(
    p_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select name
    from core.org_unit
   where id = p_id
     and (
       coalesce(private.active_role(), '') <> 'ext_user'
       or (unit_type = 'station' and active)
     );
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

  v_proposer := case
    when private.is_worker() then coalesce(p_proposed_by, nullif(private.uid(), '00000000-0000-0000-0000-000000000001'::uuid))
    else nullif(private.uid(), '00000000-0000-0000-0000-000000000001'::uuid)
  end;

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

-- ===== schema: iam  (pgschema 1.14.1) =====

set local search_path = iam;

REVOKE SELECT (active, code, job_family, label_en, label_zh) ON TABLE job_title FROM int_sysadmin;

GRANT SELECT ON TABLE job_title TO int_sysadmin;

-- ===== schema: auth  (pgschema 1.14.1) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION break_glass_drill_record(
    p_user_id uuid,
    p_operator text,
    p_outcome text,
    p_evidence jsonb DEFAULT '{}'
)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_at timestamptz := clock_timestamp();
  v_label text;
begin
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'operator_required' using errcode = '22023';
  end if;
  if p_outcome not in ('passed', 'failed') then
    raise exception 'invalid_drill_outcome' using errcode = '22023';
  end if;

  update iam.break_glass_account
     set last_drill_at = case when p_outcome = 'passed' then v_at else last_drill_at end
   where user_id = p_user_id
     and enabled
  returning label into v_label;

  if not found then
    raise exception 'break_glass_account_not_found' using errcode = '22023';
  end if;

  perform private.emit_event(
    'auth.breakglass.drill_recorded', 'success', 'break_glass_account', p_user_id, null, null,
    jsonb_build_object(
      'operator', btrim(p_operator),
      'outcome', p_outcome,
      'label', v_label,
      'performed_at', v_at,
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    )
  );

  return v_at;
end;
$$;

CREATE OR REPLACE FUNCTION session_touch(
    p_sid uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_kind text;
  v_user_id uuid;
  v_is_break_glass boolean := false;
  v_idle interval;
begin
  select user_kind, user_id into v_kind, v_user_id
    from iam.session
   where id = p_sid and revoked_at is null
     and idle_expires_at > now() and expires_at > now();
  if v_kind is null then
    return null;
  end if;
  select exists (
    select 1 from iam.break_glass_account where user_id = v_user_id and enabled
  ) into v_is_break_glass;
  v_idle := case
    when v_kind = 'external' or v_is_break_glass then interval '30 minutes'
    else interval '60 minutes'
  end;
  update iam.session
     set last_seen_at = now(), idle_expires_at = now() + v_idle
   where id = p_sid;
  return auth.session_read(p_sid);
end;
$$;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

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

  perform private.set_change_context(trim(p_reason));

  update qual.staff_qualification
     set revoked_at = now(),
         revoked_by = private.uid(),
         revoke_reason = trim(p_reason),
         valid = case
           when lower(valid) > now() then 'empty'::tstzrange
           else tstzrange(lower(valid), now(), '[)')
         end
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
