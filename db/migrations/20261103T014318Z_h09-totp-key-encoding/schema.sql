-- ===== schema: auth  (pgschema 1.13.4) =====

set local search_path = auth;

CREATE OR REPLACE FUNCTION base32_decode(
    p_text text
)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
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

REVOKE EXECUTE ON FUNCTION base32_decode(p_text text) FROM PUBLIC;

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
