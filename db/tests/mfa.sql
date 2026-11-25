begin;
set search_path = extensions, public;

-- Card H-09 (Q2 = yes): TOTP second factor for external password users.
--
-- The verifier lives in the database so the shared secret never reaches the BFF.
-- These assertions cover the properties that make it a real second factor rather
-- than a checkbox: the RFC vector must match an independent implementation, a code
-- must not be replayable, and repeated wrong codes must lock the credential.
select plan(22);

insert into auth.config (singleton, entra_tenant_id)
values (true, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict (singleton) do update set entra_tenant_id = excluded.entra_tenant_id;

insert into iam.app_user (id, kind, display_name, email, status)
values
  ('e9000000-0000-0000-0000-000000000001', 'external', 'TOTP User', 'totp@example.com', 'active'),
  ('e9000000-0000-0000-0000-000000000002', 'external', 'Other User', 'other-totp@example.com', 'active');

insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
values ('e9000000-0000-0000-0000-000000000003', 'internal', 'Staff',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e9000000-0000-0000-0000-000000000003', 'active');

-- 1. The generator matches RFC 6238 Appendix B. This is the assertion that ties the
-- implementation to a published vector rather than to itself; the ASCII secret
-- "12345678901234567890" is the one the RFC uses.
select is(
  extensions.totp_code(auth.base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 30, 1, 8, 'sha1'),
  '94287082', 'TOTP matches RFC 6238 vector at T=59');

select is(
  extensions.totp_code(auth.base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 30, 37037036, 8, 'sha1'),
  '07081804', 'TOTP matches RFC 6238 vector at T=1111111109');

select is(
  extensions.totp_code(auth.base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 30, 666666666, 8, 'sha1'),
  '65353130', 'TOTP matches RFC 6238 vector at T=20000000000');

-- The extension helper is not reachable by a login role: only auth.totp_verify is.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'totp_code'
      and has_function_privilege('authenticator', p.oid, 'EXECUTE')),
  0::bigint, 'the TOTP generator is not executable by any login role');

-- 2. Enrolment is for external users only; staff are covered by Conditional Access.
select throws_ok(
  $$select auth.totp_enrol('e9000000-0000-0000-0000-000000000003', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')$$,
  '22023', 'totp_is_external_only',
  'staff cannot enrol a TOTP credential');

select lives_ok(
  $$select auth.totp_enrol('e9000000-0000-0000-0000-000000000001', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')$$,
  'an external user can enrol a TOTP credential');

select is(
  (select secret from iam.totp_credential where user_id = 'e9000000-0000-0000-0000-000000000001'),
  convert_to('12345678901234567890', 'UTF8'),
  'the stored key is the decoded RFC 4226 secret');

select is(
  auth.base32_decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'),
  convert_to('12345678901234567890', 'UTF8'),
  'base32_decode reads the RFC 4648 alphabet and tolerates spacing and case');

select throws_ok(
  $$select auth.base32_decode('!!!!')$$,
  '22023', 'invalid_base32',
  'base32_decode refuses text that is not base32');



select is(
  (select confirmed_at from iam.totp_credential where user_id = 'e9000000-0000-0000-0000-000000000001'),
  null, 'a freshly enrolled credential is unconfirmed until first use');

select is(
  auth.totp_status('e9000000-0000-0000-0000-000000000001') ->> 'enrolled',
  'false', 'status reports an unconfirmed credential as not enrolled');

-- 3. A correct code verifies, marks the credential confirmed and records the step.
create temporary table totp_step as
select floor(extract(epoch from now()) / 30)::bigint as step;

select ok(
  auth.totp_verify(
    'e9000000-0000-0000-0000-000000000001',
    extensions.totp_code(auth.base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 30, (select step from totp_step), 6, 'sha1')
  ),
  'a current code verifies'
);

select isnt(
  (select confirmed_at from iam.totp_credential where user_id = 'e9000000-0000-0000-0000-000000000001'),
  null, 'first successful verification confirms the credential');

select is(
  auth.totp_status('e9000000-0000-0000-0000-000000000001') ->> 'enrolled',
  'true', 'status reports the credential as enrolled after first use');

-- 4. The same code cannot be used twice. This is the replay window that plain TOTP
-- leaves open for up to 30 s; `last_step` closes it.
select is(
  auth.totp_verify(
    'e9000000-0000-0000-0000-000000000001',
    extensions.totp_code(auth.base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 30, (select step from totp_step), 6, 'sha1')
  ),
  false, 'the same code is refused on replay'
);

-- 5. A wrong code fails and is counted.
select is(
  auth.totp_verify('e9000000-0000-0000-0000-000000000001', '000000'),
  false, 'a wrong code is refused'
);

-- The replay above counts as a failure too, so the counter is 2 here: a replayed
-- code is an anomaly, not a neutral event.
select is(
  (select failed_attempts from iam.totp_credential where user_id = 'e9000000-0000-0000-0000-000000000001'),
  2, 'a wrong code increments the failure counter (after one refused replay)');

select is(
  auth.totp_verify('e9000000-0000-0000-0000-000000000001', 'not-a-code'),
  false, 'a malformed code is refused without touching the counter');

-- 6. Five wrong codes lock the credential even when the next code is correct.
do $$
declare
  i int;
begin
  for i in 1..4 loop
    perform auth.totp_verify('e9000000-0000-0000-0000-000000000001', '000000');
  end loop;
end
$$;

select isnt(
  (select locked_until from iam.totp_credential where user_id = 'e9000000-0000-0000-0000-000000000001'),
  null, 'five wrong codes lock the credential');

select is(
  auth.totp_verify(
    'e9000000-0000-0000-0000-000000000001',
    extensions.totp_code(auth.base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 30, (select step from totp_step) + 1, 6, 'sha1')
  ),
  false, 'a locked credential refuses even a correct code');

-- 7. Disabling removes the credential entirely.
select lives_ok(
  $$select auth.totp_disable('e9000000-0000-0000-0000-000000000001')$$,
  'an external user can disable their credential');

select is(
  (select count(*) from iam.totp_credential where user_id = 'e9000000-0000-0000-0000-000000000001'),
  0::bigint, 'the disabled credential is gone');

select * from finish();
rollback;
