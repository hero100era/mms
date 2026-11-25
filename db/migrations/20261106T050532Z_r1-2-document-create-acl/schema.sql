-- ===== schema: api  (pgschema 1.13.4) =====

set local search_path = api;

REVOKE EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) FROM int_compliance;

REVOKE EXECUTE ON FUNCTION document_create_version(p_entity_type text, p_entity_id uuid, p_doc_type text, p_title text, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 bytea, p_storage_path text) FROM int_viewer;
