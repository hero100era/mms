-- ===== schema: iam  (pgschema 1.13.4) =====

set local search_path = iam;

CREATE TABLE IF NOT EXISTS totp_credential (
    user_id uuid,
    user_kind text DEFAULT 'external' NOT NULL,
    secret bytea NOT NULL,
    digits integer DEFAULT 6 NOT NULL,
    period integer DEFAULT 30 NOT NULL,
    algorithm text DEFAULT 'sha1' NOT NULL,
    enrolled_at timestamptz DEFAULT now() NOT NULL,
    confirmed_at timestamptz,
    last_step bigint,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamptz,
    CONSTRAINT totp_credential_pk PRIMARY KEY (user_id),
    CONSTRAINT totp_credential_algorithm_ck CHECK (algorithm IN ('sha1'::text, 'sha256'::text, 'sha512'::text)),
    CONSTRAINT totp_credential_digits_ck CHECK (digits >= 6 AND digits <= 8),
    CONSTRAINT totp_credential_period_ck CHECK (period >= 15 AND period <= 120),
    CONSTRAINT totp_credential_secret_ck CHECK (octet_length(secret) >= 10),
    CONSTRAINT totp_credential_user_kind_ck CHECK (user_kind = 'external'::text)
);

ALTER TABLE totp_credential ENABLE ROW LEVEL SECURITY;

ALTER TABLE totp_credential
ADD CONSTRAINT totp_credential_user_fk FOREIGN KEY (user_id, user_kind) REFERENCES app_user (id, kind);

CREATE OR REPLACE TRIGGER totp_credential_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON totp_credential
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

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
      'auth.mfa.disabled', 'success', 'user', p_user_id, null, null, null);
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION totp_enrol(
    p_user_id uuid,
    p_secret text,
    p_algorithm text DEFAULT 'sha1'
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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
  values (p_user_id, convert_to(p_secret, 'UTF8'), p_algorithm, null, null, 0)
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

CREATE OR REPLACE FUNCTION totp_status(
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
  for v_offset in -1..1 loop
    exit when v_ok;
    if v_cred.last_step is not null and v_step + v_offset <= v_cred.last_step then
      continue;
    end if;
    v_expected := extensions.totp_code(v_cred.secret, v_cred.period, v_step + v_offset,
                                       v_cred.digits, v_cred.algorithm);
    if v_expected = p_code then
      v_ok := true;
    end if;
  end loop;

  if v_ok then
    update iam.totp_credential
       set last_step = v_step + v_offset,
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

REVOKE EXECUTE ON FUNCTION totp_disable(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION totp_enrol(p_user_id uuid, p_secret text, p_algorithm text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION totp_status(p_user_id uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION totp_verify(p_user_id uuid, p_code text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION totp_disable(p_user_id uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION totp_enrol(p_user_id uuid, p_secret text, p_algorithm text) TO auth_gateway;

GRANT EXECUTE ON FUNCTION totp_status(p_user_id uuid) TO auth_gateway;

GRANT EXECUTE ON FUNCTION totp_verify(p_user_id uuid, p_code text) TO auth_gateway;
