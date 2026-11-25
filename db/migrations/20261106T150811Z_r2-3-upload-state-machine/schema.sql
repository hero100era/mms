-- ===== schema: private  (pgschema 1.13.4) =====

set local search_path = private;

CREATE TABLE IF NOT EXISTS approved_scanner_engine (
    engine text,
    description text NOT NULL,
    production boolean DEFAULT true NOT NULL,
    CONSTRAINT approved_scanner_engine_pkey PRIMARY KEY (engine),
    CONSTRAINT approved_scanner_engine_engine_ck CHECK (btrim(engine) <> ''::text)
);

CREATE OR REPLACE FUNCTION is_approved_scanner(
    p_engine text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select exists (
    select 1
      from private.approved_scanner_engine e
     where e.engine = p_engine
       and (e.production or not (
             current_setting('mms.runtime', true) = 'production'
           ))
  );
$$;

REVOKE EXECUTE ON FUNCTION is_approved_scanner(p_engine text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION is_approved_scanner(p_engine text) TO web_anon;

GRANT EXECUTE ON FUNCTION is_approved_scanner(p_engine text) TO worker;

-- ===== schema: core  (pgschema 1.13.4) =====

set local search_path = core;

CREATE TABLE IF NOT EXISTS upload (
    id uuid DEFAULT uuidv7(),
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    doc_type text NOT NULL,
    file_name text NOT NULL,
    mime_type text,
    byte_size bigint,
    sha256 bytea,
    quarantine_path text NOT NULL,
    upload_state text DEFAULT 'prepared' NOT NULL,
    scanner_engine text,
    threat_name text,
    scanned_at timestamptz,
    document_version_id uuid,
    expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT upload_pk PRIMARY KEY (id),
    CONSTRAINT upload_clean_version_ck CHECK (upload_state = 'clean'::text AND document_version_id IS NOT NULL OR upload_state <> 'clean'::text AND document_version_id IS NULL),
    CONSTRAINT upload_entity_type_ck CHECK (entity_type = 'survey_request'::text),
    CONSTRAINT upload_expiry_ck CHECK (expires_at > created_at),
    CONSTRAINT upload_sha256_ck CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
    CONSTRAINT upload_state_ck CHECK (upload_state IN ('prepared'::text, 'uploaded'::text, 'pending_scan'::text, 'clean'::text, 'infected'::text, 'error'::text, 'abandoned'::text)),
    CONSTRAINT upload_verdict_ck CHECK ((upload_state <> ALL (ARRAY['clean'::text, 'infected'::text])) OR scanner_engine IS NOT NULL AND scanned_at IS NOT NULL AND private.is_approved_scanner(scanner_engine))
);

CREATE INDEX IF NOT EXISTS upload_entity_ix ON upload (entity_type, entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS upload_path_uk ON upload (quarantine_path);

CREATE INDEX IF NOT EXISTS upload_state_ix ON upload (upload_state, expires_at);

ALTER TABLE upload ENABLE ROW LEVEL SECURITY;

ALTER TABLE upload
ADD CONSTRAINT upload_document_version_fk FOREIGN KEY (document_version_id) REFERENCES document_version (id);

CREATE OR REPLACE TRIGGER upload_audit_capture
    AFTER INSERT OR UPDATE OR DELETE ON upload
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_capture();

CREATE OR REPLACE TRIGGER upload_stamp
    BEFORE INSERT OR UPDATE ON upload
    FOR EACH ROW
    EXECUTE FUNCTION private.stamp();

-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

CREATE OR REPLACE FUNCTION document_create_version(
    p_entity_type text,
    p_entity_id uuid,
    p_doc_type text,
    p_title text,
    p_file_name text,
    p_mime_type text,
    p_byte_size bigint,
    p_sha256 bytea,
    p_storage_path text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_doc_id uuid;
  v_rev int;
  v_version_id uuid;
  v_req survey.survey_request;
  v_role text := private.active_role();
begin
  if p_entity_type = 'survey_request' then
    select * into v_req from survey.survey_request where id = p_entity_id;
    if not found then
      raise exception 'survey_request_not_found' using errcode = '22023';
    end if;
    if v_role = 'ext_user' then
      if not (v_req.org_id = any (private.my_org_ids())) then
        raise exception 'unauthorized' using errcode = '42501';
      end if;
    elsif v_role in ('int_viewer', 'int_compliance') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    else
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
    if v_req.status = 'rejected' then
      raise exception 'invalid_state: cannot attach document to rejected request' using errcode = '22023';
    end if;
  else
    raise exception 'unsupported_entity_type: %', p_entity_type using errcode = '22023';
  end if;

  if p_sha256 is null or octet_length(p_sha256) <> 32 then
    raise exception 'sha256_required_32_bytes' using errcode = '22023';
  end if;

  -- R2.1: create-or-find the logical document atomically. ON CONFLICT takes a
  -- row lock on an existing document, so two concurrent first uploads resolve
  -- to one logical document. The title belongs to the logical document, so a
  -- later revision may rename it without creating a second document.
  insert into core.document (entity_type, entity_id, doc_type, title, created_by)
  values (p_entity_type, p_entity_id, p_doc_type, p_title, private.uid())
  on conflict (entity_type, entity_id, doc_type) do update
     set title = excluded.title
  returning id into v_doc_id;

  -- R2.2: serialise revision allocation for this document. The lock is held
  -- until commit, so concurrent callers cannot both read the same max(revision_no).
  select id into v_doc_id from core.document where id = v_doc_id for update;

  select coalesce(max(revision_no), 0) + 1 into v_rev
    from core.document_version
   where document_id = v_doc_id;

  -- A duplicate revision should be impossible while the lock is held. If one
  -- still reaches unique(document_id, revision_no), return a stable domain
  -- error rather than leaking a raw 23505 to the caller.
  -- ADR-0023 §3: "clean" is not a property of a path.
  --
  -- A version starts `pending` and no upload row is attached. The only thing
  -- that can turn it `clean` is private.document_version_record_scan, called by
  -- the worker after the approved scanner returns a verdict, which also stamps
  -- scanned_at and links the core.upload row it verified. A caller that writes a
  -- non-quarantine path therefore gets an unscanned version, not a clean one.
  begin
    insert into core.document_version (
      document_id, revision_no, storage_path, file_name, mime_type, byte_size, sha256,
      scan_status, scanned_at, created_by
    ) values (
      v_doc_id, v_rev, p_storage_path, p_file_name, p_mime_type, p_byte_size, p_sha256,
      'pending', null,
      private.uid()
    ) returning id into v_version_id;
  exception
    when unique_violation then
      raise exception 'document_revision_conflict' using errcode = '40001';
  end;

  perform private.emit_event(
    'core.document.created', 'success', 'document_version', v_version_id, v_req.office_unit_id, null,
    jsonb_build_object(
      'document_id', v_doc_id,
      'revision_no', v_rev,
      'file_name', p_file_name,
      'mime_type', p_mime_type,
      'byte_size', p_byte_size,
      'sha256', encode(p_sha256, 'hex')
    )
  );

  return v_version_id;
end;
$$;

CREATE OR REPLACE FUNCTION document_version_promote(
    p_version_id uuid,
    p_storage_path text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_version core.document_version;
  v_doc core.document;
  v_req survey.survey_request;
  v_role text := private.active_role();
begin
  if v_role in ('ext_user', 'int_viewer', 'int_compliance') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_version from core.document_version where id = p_version_id;
  if not found then
    raise exception 'version_not_found' using errcode = '22023';
  end if;

  if not (v_version.storage_path like 'quarantine/%') then
    raise exception 'already_promoted' using errcode = '22023';
  end if;

  if p_storage_path is null or p_storage_path like 'quarantine/%' then
    raise exception 'invalid_promoted_path' using errcode = '22023';
  end if;

  select * into v_doc from core.document where id = v_version.document_id;
  if not found then
    raise exception 'document_not_found' using errcode = '22023';
  end if;

  if v_doc.entity_type = 'survey_request' then
    select * into v_req from survey.survey_request where id = v_doc.entity_id;
    if not found then
      raise exception 'survey_request_not_found' using errcode = '22023';
    end if;
    if v_role not in ('int_sysadmin', 'worker') then
      perform private.assert_in_scope(v_req.office_unit_id);
    end if;
  end if;

  -- ADR-0023 §8: promotion moves a file out of quarantine for download. It must
  -- therefore require a *recorded clean verdict*, not merely "not infected".
  -- A pending version has never been scanned; allowing it through is the hole
  -- this ADR closes.
  if v_version.scan_status = 'infected' then
    raise exception 'infected_document_cannot_be_promoted' using errcode = '42501';
  end if;
  if v_version.scan_status <> 'clean' or v_version.scanned_at is null then
    raise exception 'unscanned_document_cannot_be_promoted' using errcode = '42501';
  end if;

  update core.document_version
     set storage_path = p_storage_path,
         scan_status = 'clean',
         scanned_at = coalesce(scanned_at, clock_timestamp())
   where id = p_version_id;
end;
$$;
