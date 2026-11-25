begin;
set search_path = extensions, public;

select plan(58);

select has_table('audit_trail', 'change_log', 'audit_trail.change_log exists');
select has_table('audit_trail', 'event', 'audit_trail.event exists');
select has_table('audit_trail', 'event_type', 'audit_trail.event_type exists');
select has_table('audit_trail', 'excluded_column', 'audit_trail.excluded_column exists');
select has_table('audit_trail', 'seal', 'audit_trail.seal exists');
select has_table('audit_trail', 'controlled_column', 'audit_trail.controlled_column exists');
select has_table('audit_trail', 'reconciliation_run', 'audit_trail.reconciliation_run exists');
select has_table('audit_trail', 'reconciliation_discrepancy', 'audit_trail.reconciliation_discrepancy exists');
select has_table('audit_trail', 'forwarder_watermark', 'audit_trail.forwarder_watermark exists');
select has_table('audit_trail', 'retention_class', 'audit_trail.retention_class exists');
select has_table('audit_trail', 'table_retention_policy', 'audit_trail.table_retention_policy exists');
select has_table('audit_trail', 'crypto_shred_key', 'audit_trail.crypto_shred_key exists');
select has_table('audit_trail', 'retention_purge_run', 'audit_trail.retention_purge_run exists');

create table party.audit_probe (
  id uuid primary key,
  secret text,
  salary int,
  note text
);
grant select, insert, update, delete on party.audit_probe to int_viewer;
create trigger audit_probe_capture
  after insert or update or delete on party.audit_probe
  for each row execute function private.audit_capture();

insert into audit_trail.excluded_column (schema_name, table_name, column_name, mode, reason)
values
  ('party', 'audit_probe', 'secret', 'omit', 'test secret'),
  ('party', 'audit_probe', 'salary', 'mask', 'test salary');

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'role', 'int_viewer',
    'name', 'Audit Tester',
    'sid', '22222222-2222-2222-2222-222222222222',
    'amr', jsonb_build_array('pwd'),
    'src', 'web'
  )::text, true);

insert into party.audit_probe values
  ('33333333-3333-3333-3333-333333333333', 'topsecret', 100, 'first');
reset role;

select is(
  (select count(*) from audit_trail.change_log where table_name = 'audit_probe' and op = 'I'),
  1::bigint,
  'insert writes one change_log row'
);
select is(
  (select db_role from audit_trail.change_log where table_name = 'audit_probe' and op = 'I'),
  'int_viewer',
  'db_role comes from the claim, not the owner'
);
select is(
  (select new_row ? 'secret' from audit_trail.change_log where table_name = 'audit_probe' and op = 'I'),
  false,
  'omitted column is absent from new_row'
);
select is(
  (select new_row ->> 'salary' from audit_trail.change_log where table_name = 'audit_probe' and op = 'I'),
  '***',
  'masked column is masked in new_row'
);

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'int_viewer', 'name', 'Audit Tester')::text,
  true);
update party.audit_probe set secret = 'changed', salary = 200 where id = '33333333-3333-3333-3333-333333333333';
reset role;

select is(
  (select changed_cols from audit_trail.change_log where table_name = 'audit_probe' and op = 'U'),
  array['salary', 'secret'],
  'changed_cols records masked and omitted columns'
);
select is(
  (select old_row ? 'secret' from audit_trail.change_log where table_name = 'audit_probe' and op = 'U'),
  false,
  'old_row also redacted'
);

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'int_viewer', 'name', 'Audit Tester')::text,
  true);
update party.audit_probe set note = 'first' where id = '33333333-3333-3333-3333-333333333333';
reset role;

select is(
  (select count(*) from audit_trail.change_log where table_name = 'audit_probe' and op = 'U'),
  1::bigint,
  'no-op update writes nothing'
);

set local role int_viewer;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'int_viewer', 'name', 'Audit Tester')::text,
  true);
delete from party.audit_probe where id = '33333333-3333-3333-3333-333333333333';
reset role;

select is(
  (select count(*) from audit_trail.change_log where table_name = 'audit_probe' and op = 'D'),
  1::bigint,
  'delete writes one change_log row'
);

set local role int_compliance;
select throws_ok(
  'update audit_trail.change_log set reason = ''tamper''',
  '42501',
  null,
  'capability role cannot update audit_trail.change_log'
);
reset role;

set local role int_compliance;
select throws_ok(
  'select private.set_change_context('''')',
  'P0001',
  'reason_required',
  'set_change_context rejects an empty reason'
);
select lives_ok(
  'select private.set_change_context(''test reason'')',
  'set_change_context accepts a reason'
);
reset role;

set local role int_compliance;
select throws_ok(
  $$insert into audit_trail.seal (from_xid, to_xid, change_log_count, event_count, batch_hash, prev_seal_hash, seal_hash, worm_uri, worm_sha256)
    values ('10'::xid8, '20'::xid8, 0, 0, repeat('0', 64), repeat('0', 64), repeat('0', 64), 'worm/test', repeat('0', 64))$$,
  '42501',
  null,
  'compliance role cannot insert into audit_trail.seal'
);
reset role;

set local role audit_sealer;
select lives_ok(
  'select count(*) from audit_trail.change_log',
  'audit_sealer can select from audit_trail.change_log'
);
select lives_ok(
  'select count(*) from audit_trail.event',
  'audit_sealer can select from audit_trail.event'
);
select lives_ok(
  $$insert into audit_trail.seal (from_xid, to_xid, change_log_count, event_count, batch_hash, prev_seal_hash, seal_hash, worm_uri, worm_sha256)
    values ('10'::xid8, '20'::xid8, 0, 0, repeat('0', 64), repeat('0', 64), repeat('0', 64), 'worm/test', repeat('0', 64))$$,
  'audit_sealer can insert into audit_trail.seal'
);
select throws_ok(
  'update audit_trail.seal set worm_uri = ''tampered'' where from_xid = ''10''::xid8',
  '42501',
  null,
  'audit_sealer cannot update audit_trail.seal (grant denied)'
);
select throws_ok(
  'delete from audit_trail.seal where from_xid = ''10''::xid8',
  '42501',
  null,
  'audit_sealer cannot delete from audit_trail.seal (grant denied)'
);
select throws_ok(
  $$insert into audit_trail.seal (from_xid, to_xid, change_log_count, event_count, batch_hash, prev_seal_hash, seal_hash, worm_uri, worm_sha256)
    values ('30'::xid8, '20'::xid8, 0, 0, repeat('0', 64), repeat('0', 64), repeat('0', 64), 'worm/test', repeat('0', 64))$$,
  '23514',
  null,
  'audit_trail.seal rejects from_xid > to_xid'
);
reset role;

select throws_ok(
  'update audit_trail.seal set worm_uri = ''tampered'' where from_xid = ''10''::xid8',
  'P0001',
  'audit_trail.seal is append-only',
  'append-only trigger blocks update on audit_trail.seal'
);
select throws_ok(
  'delete from audit_trail.seal where from_xid = ''10''::xid8',
  'P0001',
  'audit_trail.seal is append-only',
  'append-only trigger blocks delete on audit_trail.seal'
);

set local role worker;
select lives_ok(
  'select count(*) from audit_trail.change_log',
  'worker can select from audit_trail.change_log'
);
select lives_ok(
  $$insert into audit_trail.reconciliation_run (window_start, window_end, from_xid, to_xid, checked_change_count, checked_event_count, discrepancy_count, status)
    values (now() - interval '1 day', now(), '10'::xid8, '20'::xid8, 5, 5, 0, 'clean')$$,
  'worker can insert into audit_trail.reconciliation_run'
);
select lives_ok(
  $$insert into audit_trail.forwarder_watermark (sink_id, last_change_log_id, last_event_id, last_tx_id)
    values ('test-sink', 10, 10, '20'::xid8)
    on conflict (sink_id) do update set last_change_log_id = excluded.last_change_log_id$$,
  'worker can upsert audit_trail.forwarder_watermark'
);
select throws_ok(
  'update audit_trail.reconciliation_run set status = ''failed''',
  '42501',
  null,
  'worker cannot update audit_trail.reconciliation_run (grant denied)'
);
reset role;

select throws_ok(
  'update audit_trail.reconciliation_run set status = ''failed''',
  'P0001',
  'audit reconciliation records are append-only',
  'append-only trigger blocks update on audit_trail.reconciliation_run'
);
select throws_ok(
  'delete from audit_trail.reconciliation_run',
  'P0001',
  'audit reconciliation records are append-only',
  'append-only trigger blocks delete on audit_trail.reconciliation_run'
);

-- Card H-03: Retention Classes & Crypto-Shredding Tests
select is(
  (select count(*) from audit_trail.retention_class),
  7::bigint,
  'all 7 statutory retention classes seeded'
);
select is(
  (select crypto_shred_eligible from audit_trail.retention_class where class_code = 'RC-1'),
  true,
  'RC-1 is crypto-shred eligible'
);
select is(
  (select crypto_shred_eligible from audit_trail.retention_class where class_code = 'RC-2'),
  false,
  'RC-2 maritime survey records are exempt from erasure'
);

insert into audit_trail.crypto_shred_key (subject_id, encrypted_key, key_fingerprint)
values ('99999999-9999-9999-9999-999999999999', 'TEST_CIPHERTEXT_DEK', 'TEST_FINGERPRINT_SHA256');

select throws_ok(
  'delete from audit_trail.crypto_shred_key where subject_id = ''99999999-9999-9999-9999-999999999999''',
  'P0001',
  'audit_trail.crypto_shred_key records cannot be deleted',
  'crypto_shred_key cannot be deleted'
);

select is(
  private.shred_subject_key('99999999-9999-9999-9999-999999999999'::uuid, 'GDPR Article 17 request'),
  true,
  'shred_subject_key transitions key successfully'
);

select is(
  (select key_status from audit_trail.crypto_shred_key where subject_id = '99999999-9999-9999-9999-999999999999'),
  'shredded',
  'key_status transitioned to shredded'
);

select throws_ok(
  'update audit_trail.crypto_shred_key set key_status = ''active'' where subject_id = ''99999999-9999-9999-9999-999999999999''',
  'P0001',
  'shredded keys cannot be modified or restored',
  'shredded key cannot be restored to active'
);

insert into audit_trail.retention_purge_run (retention_class, cutoff_time, max_sealed_xid, change_log_purged_count, event_purged_count, reason, status)
values ('RC-1', now(), '10'::xid8, 0, 0, 'test', 'completed');

select throws_ok(
  'delete from audit_trail.retention_purge_run',
  'P0001',
  'audit_trail.retention_purge_run is append-only',
  'retention_purge_run is append-only'
);

select throws_ok(
  $$select private.purge_sealed_audit_records('INVALID_CLASS', now())$$,
  '22023',
  null,
  'purge_sealed_audit_records rejects invalid retention class'
);

-- Test active key updates & guards
insert into audit_trail.crypto_shred_key (subject_id, encrypted_key, key_fingerprint)
values ('88888888-8888-8888-8888-888888888888', 'WRAPPED_KEY_V1', 'FINGERPRINT_1');

select lives_ok(
  'update audit_trail.crypto_shred_key set encrypted_key = ''WRAPPED_KEY_V2'' where subject_id = ''88888888-8888-8888-8888-888888888888''',
  'active key can be re-wrapped with updated encrypted_key'
);

select throws_ok(
  'update audit_trail.crypto_shred_key set subject_id = ''77777777-7777-7777-7777-777777777777'' where subject_id = ''88888888-8888-8888-8888-888888888888''',
  'P0001',
  'subject_id is immutable',
  'subject_id is immutable'
);

select throws_ok(
  'update audit_trail.crypto_shred_key set key_status = ''archived'' where subject_id = ''88888888-8888-8888-8888-888888888888''',
  'P0001',
  'crypto_shred_key status can only transition to shredded',
  'key_status cannot transition to invalid status'
);

select throws_ok(
  'select private.shred_subject_key(''88888888-8888-8888-8888-888888888888''::uuid, ''   '')',
  '22023',
  'shred_reason_required',
  'shred_subject_key rejects empty reason'
);

-- Test shredding non-existent key creates pre-shredded record
select is(
  private.shred_subject_key('77777777-7777-7777-7777-777777777777'::uuid, 'Erasure before key generation'),
  true,
  'shred_subject_key succeeds for un-keyed subject'
);

select is(
  (select key_status from audit_trail.crypto_shred_key where subject_id = '77777777-7777-7777-7777-777777777777'),
  'shredded',
  'un-keyed subject is stored as shredded'
);

select is(
  private.shred_subject_key('77777777-7777-7777-7777-777777777777'::uuid, 'Repeat erasure'),
  false,
  're-shredding is idempotent and returns false'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'privacy.crypto_shred.executed' and subject_id = '77777777-7777-7777-7777-777777777777'),
  1::bigint,
  'privacy.crypto_shred.executed event was recorded once'
);

select lives_ok(
  $$select private.purge_sealed_audit_records('RC-1', now() - interval '100 years')$$,
  'purge_sealed_audit_records executes successfully with valid parameters'
);

select is(
  (select count(*) from audit_trail.event where event_type = 'audit_trail.retention.purged' and detail->>'run_id' = (select max(id)::text from audit_trail.retention_purge_run)),
  1::bigint,
  'audit_trail.retention.purged event was emitted for this purge run'
);

select * from finish();
rollback;
