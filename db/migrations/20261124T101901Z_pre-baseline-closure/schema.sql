-- ===== schema: auth  (pgschema 1.14.1) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION resolve_entra(
    p_tid uuid,
    p_oid uuid,
    p_upn text,
    p_name text,
    p_app_roles text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_config auth.config;
  v_user iam.app_user;
  v_roles jsonb;
begin
  select * into v_config from auth.config where singleton;
  if v_config.entra_tenant_id is null then
    raise exception 'entra_tenant_not_configured' using errcode = '42501';
  end if;
  if p_tid is null or p_oid is null or p_tid <> v_config.entra_tenant_id then
    raise exception 'foreign_tenant' using errcode = '42501';
  end if;
  if not coalesce(p_app_roles, '{}') @> array[v_config.entra_app_role] then
    raise exception 'mms_user_role_required' using errcode = '42501';
  end if;
  if coalesce(p_app_roles, '{}') && array['Guest', 'MMS.Guest'] then
    raise exception 'guest_denied' using errcode = '42501';
  end if;

  insert into iam.app_user (kind, display_name, email, status, entra_tenant_id, entra_object_id)
  values (
    'internal',
    coalesce(nullif(trim(p_name), ''), coalesce(p_upn, p_oid::text)),
    case when p_upn like '%@%' then lower(p_upn) end,
    'active',
    p_tid,
    p_oid
  )
  on conflict (entra_tenant_id, entra_object_id) do update
    set display_name = excluded.display_name,
        email = coalesce(excluded.email, iam.app_user.email)
  returning * into v_user;

  select coalesce(jsonb_agg(distinct a.db_role order by a.db_role), '[]'::jsonb)
    into v_roles
    from iam.role_assignment a
   where a.user_id = v_user.id
     and a.revoked_at is null
     and a.valid @> now();

  return jsonb_build_object(
    'user_id', v_user.id,
    'status', v_user.status,
    'assignable_roles', v_roles,
    -- H-10: the BFF routes a break-glass identity to the reason form instead of the
    -- role chooser. Dormant means no assignable roles, which alone would look like
    -- "no access" and strand the account that exists to fix that.
    'break_glass', exists (
      select 1 from iam.break_glass_account b
       where b.user_id = v_user.id and b.enabled
    )
  );
end;
$$;

-- ===== schema: api  (pgschema 1.14.1) =====

set local search_path = api;

REVOKE SELECT ON TABLE position_job_titles FROM int_sysadmin;

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

  perform private.set_change_context(trim(p_reason));

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
