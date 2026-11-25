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
  begin
    insert into core.document_version (
      document_id, revision_no, storage_path, file_name, mime_type, byte_size, sha256,
      scan_status, scanned_at, created_by
    ) values (
      v_doc_id, v_rev, p_storage_path, p_file_name, p_mime_type, p_byte_size, p_sha256,
      case when p_storage_path like 'quarantine/%' then 'pending' else 'clean' end,
      case when p_storage_path like 'quarantine/%' then null else clock_timestamp() end,
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
