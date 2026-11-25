-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

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
  if v_role not in ('int_hr', 'int_sysadmin', 'int_compliance') then
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
  if v_role not in ('int_hr', 'int_sysadmin', 'int_compliance') then
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
