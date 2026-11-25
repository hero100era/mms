-- Helper functions that live in the unmanaged `extensions` schema.
--
-- pgschema only diffs the schemas listed in db/schemas.txt, and `extensions` is
-- deliberately not one of them: it is owned by bootstrap, alongside the
-- extensions themselves (ADR-0010). Functions here are created once and then
-- replaced by later bootstrap runs, so they survive a db:plan round trip.

-- ---------------------------------------------------------------------------
-- TOTP code generation (RFC 6238 / RFC 4226).
--
-- Lives in `extensions` beside hmac() and sha256(), which it is the only caller
-- of, and is granted to no login role: `auth.totp_verify` is the sole entry point,
-- so the shared secret is never reachable from a session that could call this.
-- SHA-1 is the default because every authenticator app implements it; the
-- algorithm is a credential column so a user can move to SHA-256 without a
-- migration.
-- ---------------------------------------------------------------------------
create or replace function extensions.totp_code(
  p_secret bytea,
  p_period integer,
  p_step bigint,
  p_digits integer,
  p_algorithm text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_mac bytea;
  v_offset integer;
  v_binary bigint;
begin
  v_mac := extensions.hmac(
    int8send(p_step),
    p_secret,
    case p_algorithm
      when 'sha256' then 'sha256'
      when 'sha512' then 'sha512'
      else 'sha1'
    end
  );
  -- Dynamic truncation, RFC 4226 section 5.3.
  v_offset := get_byte(v_mac, length(v_mac) - 1) & 15;
  v_binary := (
      (get_byte(v_mac, v_offset) & 127)::bigint * 16777216
    + get_byte(v_mac, v_offset + 1)::bigint * 65536
    + get_byte(v_mac, v_offset + 2)::bigint * 256
    + get_byte(v_mac, v_offset + 3)::bigint
  );
  return lpad((v_binary % (power(10::numeric, p_digits)::bigint))::text, p_digits, '0');
end;
$$;

revoke all on function extensions.totp_code(bytea, integer, bigint, integer, text) from public;

-- `auth.totp_verify` is SECURITY DEFINER and therefore runs as mms_owner, which
-- needs EXECUTE here even though no login role has it: PUBLIC was revoked above,
-- and revoking from PUBLIC does not cover the owner's own ACL check.
grant execute on function extensions.totp_code(bytea, integer, bigint, integer, text) to mms_owner;
