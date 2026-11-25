-- auth: the gateway surface. These functions are the only way the BFF reads or
-- writes credentials, identities, sessions and one-time tokens. They are
-- SECURITY DEFINER and executable only by auth_gateway.

create table auth.config (
  singleton boolean primary key default true,
  entra_tenant_id uuid,
  entra_app_role text not null default 'MMS.User',
  updated_at timestamptz not null default now(),
  constraint auth_config_singleton_ck check (singleton)
);
alter table auth.config enable row level security;

create function auth.resolve_entra(
  p_tid uuid,
  p_oid uuid,
  p_upn text,
  p_name text,
  p_app_roles text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

create function auth.resolve_external(
  p_provider text,
  p_issuer text,
  p_subject text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_provider not in ('microsoft', 'google') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;
  select i.user_id into v_user_id
    from iam.user_identity i
    join iam.app_user u on u.id = i.user_id and u.kind = 'external'
   where i.provider = p_provider
     and i.issuer = p_issuer
     and i.subject = p_subject
     and i.unlinked_at is null
     and u.status = 'active';
  if v_user_id is null then
    return jsonb_build_object('status', 'not_linked');
  end if;
  return jsonb_build_object('status', 'linked', 'user_id', v_user_id);
end;
$$;

