-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE OR REPLACE FUNCTION audit_redact(
    p_schema text,
    p_table text,
    p_row jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select case
    when p_row is null then null
    else coalesce(
      (select jsonb_object_agg(e.key,
         case when x.mode = 'mask' then to_jsonb('***'::text) else e.value end)
       from jsonb_each(p_row) as e(key, value)
       left join audit_trail.excluded_column x
         on x.schema_name = p_schema
        and x.table_name = p_table
        and x.column_name = e.key
       where x.mode is distinct from 'omit'),
      '{}'::jsonb)
  end;
$$;

CREATE OR REPLACE FUNCTION change_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  raise exception 'audit_trail.change_log is append-only';
end;
$$;

CREATE OR REPLACE FUNCTION claims()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

CREATE OR REPLACE FUNCTION audit_capture()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  c     jsonb := private.claims();
  h     jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  raw_o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  raw_n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  cols  text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(k.key order by k.key) into cols
      from jsonb_object_keys(raw_n) as k(key)
     where raw_n -> k.key is distinct from raw_o -> k.key
       and k.key not in ('updated_at', 'row_version');
    if cols is null then
      return null;
    end if;
  end if;

  insert into audit_trail.change_log (
    schema_name, table_name, op, row_id, old_row, new_row, changed_cols,
    actor_id, actor_label, db_role, session_id, auth_method, on_behalf_of, initiated_by,
    request_id, trace_id, source, client_ip, reason
  ) values (
    tg_table_schema, tg_table_name, left(tg_op, 1),
    coalesce(raw_n ->> 'id', raw_o ->> 'id')::uuid,
    private.audit_redact(tg_table_schema, tg_table_name, raw_o),
    private.audit_redact(tg_table_schema, tg_table_name, raw_n),
    cols,
    nullif(c ->> 'sub', '')::uuid,
    c ->> 'name',
    coalesce(nullif(c ->> 'role', ''), session_user),
    nullif(c ->> 'sid', '')::uuid,
    c -> 'amr' ->> 0,
    nullif(current_setting('mms.on_behalf_of', true), '')::uuid,
    nullif(current_setting('mms.initiated_by', true), '')::uuid,
    h ->> 'x-request-id',
    split_part(h ->> 'traceparent', '-', 2),
    coalesce(c ->> 'src', case when c = '{}'::jsonb then 'dba' else 'web' end),
    nullif(h ->> 'x-client-ip', '')::inet,
    nullif(current_setting('mms.reason', true), '')
  );
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION claim(
    p_claim text
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  select nullif(private.claims() ->> p_claim, '');
$$;

CREATE OR REPLACE FUNCTION event_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  raise exception 'audit_trail.event is append-only';
end;
$$;

CREATE OR REPLACE FUNCTION set_change_context(
    p_reason text,
    p_on_behalf_of uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required';
  end if;
  perform set_config('mms.reason', p_reason, true);
  perform set_config('mms.on_behalf_of', coalesce(p_on_behalf_of::text, ''), true);
end;
$$;

REVOKE EXECUTE ON FUNCTION audit_capture() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION audit_redact(p_schema text, p_table text, p_row jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION change_log_append_only() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION claim(p_claim text) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION claims() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION event_append_only() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_compliance;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_manager;

GRANT EXECUTE ON FUNCTION claim(p_claim text) TO int_sysadmin;

GRANT EXECUTE ON FUNCTION claims() TO int_compliance;

GRANT EXECUTE ON FUNCTION claims() TO int_manager;

GRANT EXECUTE ON FUNCTION claims() TO int_sysadmin;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_compliance;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_manager;

GRANT EXECUTE ON FUNCTION set_change_context(p_reason text, p_on_behalf_of uuid) TO int_sysadmin;

-- ===== schema: audit_trail  (pgschema 1.13.4) =====

set local search_path = audit_trail;

CREATE TABLE IF NOT EXISTS change_log (
    id bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    tx_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    op character(1) NOT NULL,
    row_id uuid,
    old_row jsonb,
    new_row jsonb,
    changed_cols text[],
    actor_id uuid,
    actor_label text,
    db_role text NOT NULL,
    session_id uuid,
    auth_method text,
    on_behalf_of uuid,
    initiated_by uuid,
    request_id text,
    trace_id text,
    source text NOT NULL,
    client_ip inet,
    reason text,
    CONSTRAINT change_log_pk PRIMARY KEY (id),
    CONSTRAINT change_log_op_ck CHECK (op IN ('I'::bpchar, 'U'::bpchar, 'D'::bpchar)),
    CONSTRAINT change_log_source_ck CHECK (source IN ('web'::text, 'job'::text, 'import'::text, 'integration'::text, 'dba'::text))
);

CREATE INDEX IF NOT EXISTS change_log_subject_ix ON change_log (schema_name, table_name, row_id);

CREATE INDEX IF NOT EXISTS change_log_tx_ix ON change_log (tx_id);

ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY change_log_read ON change_log FOR SELECT TO int_compliance, int_sysadmin USING (true);

CREATE TABLE IF NOT EXISTS event_type (
    code text,
    description text NOT NULL,
    regulated boolean NOT NULL,
    reason_required boolean DEFAULT false NOT NULL,
    CONSTRAINT event_type_pk PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS event (
    id bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    tx_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
    event_type text NOT NULL,
    outcome text NOT NULL,
    actor_id uuid,
    session_id uuid,
    db_role text NOT NULL,
    auth_method text,
    on_behalf_of uuid,
    initiated_by uuid,
    actor_title text,
    actor_grade integer,
    actor_unit_id uuid,
    authority_rule_id uuid,
    subject_type text,
    subject_id uuid,
    subject_revision integer,
    scope_unit_id uuid,
    request_id text,
    trace_id text,
    source text NOT NULL,
    client_ip inet,
    user_agent text,
    reason text,
    detail jsonb DEFAULT '{}' NOT NULL,
    CONSTRAINT event_pk PRIMARY KEY (id),
    CONSTRAINT event_type_fk FOREIGN KEY (event_type) REFERENCES event_type (code),
    CONSTRAINT event_detail_size_ck CHECK (pg_column_size(detail) < 8192),
    CONSTRAINT event_outcome_ck CHECK (outcome IN ('success'::text, 'failure'::text, 'denied'::text))
);

CREATE INDEX IF NOT EXISTS event_scope_ix ON event (scope_unit_id, occurred_at);

CREATE INDEX IF NOT EXISTS event_subject_ix ON event (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS event_tx_ix ON event (tx_id);

ALTER TABLE event ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_manager_read ON event FOR SELECT TO int_manager USING (scope_unit_id = (NULLIF(private.claim('org_unit_id'), ''::text))::uuid);

CREATE POLICY event_read ON event FOR SELECT TO int_compliance, int_sysadmin USING (true);

CREATE TABLE IF NOT EXISTS excluded_column (
    schema_name text,
    table_name text,
    column_name text,
    mode text NOT NULL,
    reason text NOT NULL,
    CONSTRAINT excluded_column_pk PRIMARY KEY (schema_name, table_name, column_name),
    CONSTRAINT excluded_column_mode_ck CHECK (mode IN ('omit'::text, 'mask'::text))
);

CREATE OR REPLACE TRIGGER change_log_append_only
    BEFORE UPDATE OR DELETE ON change_log
    FOR EACH ROW
    EXECUTE FUNCTION private.change_log_append_only();

CREATE OR REPLACE TRIGGER event_append_only
    BEFORE UPDATE OR DELETE ON event
    FOR EACH ROW
    EXECUTE FUNCTION private.event_append_only();

GRANT SELECT ON TABLE change_log TO int_compliance;

GRANT SELECT ON TABLE change_log TO int_manager;

GRANT SELECT ON TABLE change_log TO int_sysadmin;

GRANT SELECT ON TABLE event TO int_compliance;

GRANT SELECT ON TABLE event TO int_manager;

GRANT SELECT ON TABLE event TO int_sysadmin;

GRANT SELECT ON TABLE event_type TO int_compliance;

GRANT SELECT ON TABLE event_type TO int_manager;

GRANT SELECT ON TABLE event_type TO int_sysadmin;
