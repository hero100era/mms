-- Columns that must never be copied into audit_trail.change_log.
insert into audit_trail.excluded_column (schema_name, table_name, column_name, mode, reason) values
  ('iam', 'password_credential', 'hash', 'omit', 'password hash'),
  ('iam', 'one_time_token', 'token_hash', 'omit', 'single-use token hash'),
  ('iam', 'totp_credential', 'secret', 'omit', 'TOTP shared secret'),
  ('iam', 'session', 'data', 'omit', 'session payload may contain OAuth transaction material'),
  ('core', 'outbox', 'payload', 'omit', 'outbox payload may contain single-use reset/invite tokens or PII'),
  ('audit_trail', 'seal', 'batch_hash', 'omit', 'seal batch hash metadata'),
  ('audit_trail', 'seal', 'prev_seal_hash', 'omit', 'seal chain previous hash metadata'),
  ('audit_trail', 'seal', 'seal_hash', 'omit', 'seal hash digest metadata'),
  ('audit_trail', 'forwarder_watermark', 'last_batch_hash', 'omit', 'forwarder watermark batch hash metadata'),
  ('audit_trail', 'crypto_shred_key', 'encrypted_key', 'omit', 'encrypted data encryption key material'),
  ('audit_trail', 'crypto_shred_key', 'key_fingerprint', 'omit', 'crypto shred key fingerprint'),
  ('audit_trail', 'crypto_shred_key', 'key_status', 'omit', 'crypto shred key lifecycle status'),
  ('core', 'breakdown_template_node_particular', 'attr_key', 'omit', 'attribute specification key'),
  ('core', 'checklist_item_particular', 'attr_key', 'omit', 'attribute specification key'),
  ('fleet', 'ship_breakdown_node_particular', 'attr_key', 'omit', 'attribute specification key'),
  ('survey', 'checklist_entry_particular', 'attr_key', 'omit', 'attribute specification key')
on conflict (schema_name, table_name, column_name) do update
  set mode = excluded.mode, reason = excluded.reason;

