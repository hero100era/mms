-- Roles a user may choose from (active assignments only). Used by the BFF
-- role chooser; it deliberately does not create a session.
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

revoke all on function auth.user_roles(uuid) from public;
grant execute on function auth.user_roles(uuid) to auth_gateway;

-- ---------------------------------------------------------------------------
-- H-09: TOTP second factor for external password users.
--
-- TOTP (RFC 6238) is HMAC over the 30 s time step, and HMAC is the one primitive
-- PostgreSQL cannot do unaided, so this is the only place pgcrypto is used. The
-- shared secret never leaves the database: the BFF submits the six digits and
-- receives a boolean, so a compromised web tier cannot disable its own second
-- factor by reading the secret out of `iam.totp_credential`.
--
-- A correct code is single-use: `last_step` records the counter that was accepted,
-- and any code whose counter is not greater is refused. That defeats replay of a
-- captured code within its window, which is the attack TOTP is weakest against.
-- ---------------------------------------------------------------------------

-- The secret column holds the RFC 4226 key bytes, not the base32 text the user typed
-- into their app. This turns that text back into bytes.
create function auth.base32_decode(p_text text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_clean text;
  v_bits integer := 0;
  v_value integer := 0;
  v_out bytea := ''::bytea;
  v_index integer;
  v_byte integer;
begin
  v_clean := upper(regexp_replace(coalesce(p_text, ''), '[^A-Za-z2-7]', '', 'g'));
  if v_clean = '' then
    raise exception 'invalid_base32' using errcode = '22023';
  end if;
  for v_index in 1..length(v_clean) loop
    v_byte := position(substr(v_clean, v_index, 1) in v_alphabet) - 1;
    if v_byte < 0 then
      raise exception 'invalid_base32' using errcode = '22023';
    end if;
    v_value := (v_value << 5) | v_byte;
    v_bits := v_bits + 5;
    if v_bits >= 8 then
      v_bits := v_bits - 8;
      v_out := v_out || set_byte('\x00'::bytea, 0, (v_value >> v_bits) & 255);
    end if;
  end loop;
  return v_out;
end;
$$;

revoke all on function auth.base32_decode(text) from public;
grant execute on function auth.base32_decode(text) to auth_gateway;

create function auth.totp_verify(p_user_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cred record;
  v_step bigint;
  v_expected text;
  v_ok boolean := false;
  v_offset int;
  v_matched bigint;
begin
  if p_code is null or p_code !~ '^[0-9]{6,8}$' then
    return false;
  end if;

  select c.secret, c.digits, c.period, c.algorithm, c.last_step, c.confirmed_at,
         c.failed_attempts, c.locked_until
    into v_cred
    from iam.totp_credential c
   where c.user_id = p_user_id
   for update;

  if not found then
    return false;
  end if;

  -- Locked out by repeated wrong codes: refuse without spending a comparison.
  if v_cred.locked_until is not null and v_cred.locked_until > now() then
    return false;
  end if;

  v_step := floor(extract(epoch from now()) / v_cred.period)::bigint;

  -- One step of drift either way: a phone whose clock lags 20 s would otherwise
  -- fail every code in the last seconds of each window.
  -- NOTE: a plpgsql FOR loop resets its control variable to NULL on exit, so the
  -- matched step is captured in v_matched inside the loop rather than read from
  -- v_offset afterwards. Reading v_offset after the loop silently wrote NULL and
  -- disabled replay protection entirely.
  for v_offset in -1..1 loop
    exit when v_ok;
    if v_cred.last_step is not null and v_step + v_offset <= v_cred.last_step then
      continue;
    end if;
    v_expected := extensions.totp_code(v_cred.secret, v_cred.period, v_step + v_offset,
                                       v_cred.digits, v_cred.algorithm);
    if v_expected = p_code then
      v_ok := true;
      v_matched := v_step + v_offset;
    end if;
  end loop;

  if v_ok then
    update iam.totp_credential
       set last_step = v_matched,
           failed_attempts = 0,
           locked_until = null,
           confirmed_at = coalesce(confirmed_at, now())
     where user_id = p_user_id;
  else
    update iam.totp_credential
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5
                               then now() + interval '15 minutes' end
     where user_id = p_user_id;
  end if;

  return v_ok;
end;
$$;

create function auth.totp_enrol(
  p_user_id uuid,
  p_secret text,
  p_algorithm text default 'sha1'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  select kind into v_kind from iam.app_user where id = p_user_id;
  if v_kind is null then
    raise exception 'unknown_user' using errcode = '22023';
  end if;
  -- Only external users get a second factor here; staff are covered by the
  -- identity provider's Conditional Access policy (flow A).
  if v_kind <> 'external' then
    raise exception 'totp_is_external_only' using errcode = '22023';
  end if;
  if p_algorithm not in ('sha1', 'sha256', 'sha512') then
    raise exception 'unsupported_totp_algorithm' using errcode = '22023';
  end if;

  -- Enrolment is intentionally idempotent-by-replacement: re-enrolling replaces the
  -- secret and clears the replay watermark, which is what "reset my authenticator"
  -- means. `confirmed_at` is set on the first successful verification.
  insert into iam.totp_credential (user_id, secret, algorithm, confirmed_at, last_step, failed_attempts)
  values (p_user_id, auth.base32_decode(p_secret), p_algorithm, null, null, 0)
  on conflict (user_id) do update
    set secret = excluded.secret,
        algorithm = excluded.algorithm,
        confirmed_at = null,
        enrolled_at = now(),
        last_step = null,
        failed_attempts = 0,
        locked_until = null;

  perform private.emit_event(
    'auth.mfa.enrolled', 'success', 'user', p_user_id, null, null,
    jsonb_build_object('algorithm', p_algorithm));
end;
$$;

create function auth.totp_disable(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from iam.totp_credential where user_id = p_user_id;
  if found then
    perform private.emit_event(
      'auth.mfa.disabled', 'success', 'user', p_user_id, null, null, '{}'::jsonb);
  end if;
end;
$$;

-- Whether this user must supply a second factor, and whether they already have
-- one. The BFF asks before showing the code field, so an unenrolled user is sent
-- to enrolment rather than being locked out of their own account.
create function auth.totp_status(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'required', true,
    'enrolled', coalesce(bool_or(c.confirmed_at is not null), false),
    'locked', coalesce(bool_or(c.locked_until > now()), false)
  )
  from iam.app_user u
  left join iam.totp_credential c on c.user_id = u.id
  where u.id = p_user_id
    and u.kind = 'external'
    and u.status = 'active'
  having count(u.id) > 0
  ;
$$;

revoke all on function auth.totp_verify(uuid, text) from public;
revoke all on function auth.totp_enrol(uuid, text, text) from public;
revoke all on function auth.totp_disable(uuid) from public;
revoke all on function auth.totp_status(uuid) from public;
grant execute on function auth.totp_verify(uuid, text) to auth_gateway;



grant execute on function auth.totp_enrol(uuid, text, text) to auth_gateway;
grant execute on function auth.totp_disable(uuid) to auth_gateway;
grant execute on function auth.totp_status(uuid) to auth_gateway;

-- ---------------------------------------------------------------------------
-- H-10: break-glass access.
--
-- A break-glass account is dormant: it holds no `iam.role_assignment`, so it
-- cannot pass `private.pre_request` and no page beyond the activation form is
-- reachable. Activation creates exactly one global `int_sysadmin` assignment for
-- a bounded window (at most 4 hours) and records why. Expiry needs no sweep: the
-- pre-request gate re-checks `valid @> now()` on every request, so the next request
-- after `valid_until` is refused.
--
-- This is the single documented exception to invariant I7 (`granted_by <> user_id`,
-- enforced by `iam.role_assignment_granted_by_ck`). A classic break-glass account
-- has no colleague who can approve while the incident is on, so the activation is
-- self-granted; the controls that replace the approver are dormancy, physical
-- custody of the keys, alerts to IT security and HO Compliance, and the mandatory
-- post-incident review.
-- ---------------------------------------------------------------------------
