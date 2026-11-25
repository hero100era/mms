-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION totp_disable(
    p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  delete from iam.totp_credential where user_id = p_user_id;
  if found then
    perform private.emit_event(
      'auth.mfa.disabled', 'success', 'user', p_user_id, null, null, '{}'::jsonb);
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION totp_verify(
    p_user_id uuid,
    p_code text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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
