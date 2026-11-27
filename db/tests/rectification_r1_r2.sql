-- R1.1 / R1.2 / R2.1 / R2.2 rectification tests.
-- Each db/tests file runs in its own transaction and rolls back.
begin;
set search_path = extensions, public;

select plan(25);

\i db/fixtures/org.sql

-- ---------------------------------------------------------------------------
-- R1.1: canonical caller-class helper and internal guard.
-- ---------------------------------------------------------------------------
select ok(
  not private.is_emergency(),
  'an ordinary database caller is not the emergency runbook login'
);
select ok(
  has_function_privilege('mms_emergency', 'private.is_emergency()', 'EXECUTE'),
  'mms_emergency may call the canonical emergency helper'
);
select ok(
  not private.is_worker_or_admin(),
  'a direct call without JWT claims is not treated as a worker or admin'
);
select ok(
  (select prosrc like '%worker_or_admin_role_required%'
     from pg_proc
    where oid = 'private.record_malware_scan_run(text, bytea, bigint, text, text, text, text, text, text, jsonb, uuid, uuid)'::regprocedure),
  'record_malware_scan_run carries the same internal caller guard as its siblings'
);
select throws_ok(
  $$ select private.record_malware_scan_run('x', '\x00'::bytea, 1, 'mock', 'clean') $$,
  '42501', null,
  'a non-worker caller cannot write a scan-run ledger row'
);

-- ---------------------------------------------------------------------------
-- R1.2: ACLs are the first gate; roles always rejected in the body hold no EXECUTE.
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('int_viewer', 'api.create_external_user(text, text, text)', 'EXECUTE'),
  'int_viewer holds no EXECUTE on api.create_external_user'
);
select ok(
  not has_function_privilege('int_viewer', 'api.invite_external_user(uuid, text)', 'EXECUTE'),
  'int_viewer holds no EXECUTE on api.invite_external_user'
);
select ok(
  not has_function_privilege('ext_user', 'api.document_version_promote(uuid, text)', 'EXECUTE'),
  'ext_user holds no EXECUTE on api.document_version_promote'
);
select ok(
  not has_function_privilege('int_viewer', 'api.document_version_promote(uuid, text)', 'EXECUTE'),
  'int_viewer holds no EXECUTE on api.document_version_promote'
);
select ok(
  not has_function_privilege('int_compliance', 'api.document_version_promote(uuid, text)', 'EXECUTE'),
  'int_compliance holds no EXECUTE on api.document_version_promote'
);
-- document_create_version rejects int_viewer/int_compliance in its body, so the
-- grant could never be exercised. ext_user keeps it (it passes the
-- org-membership branch for its own organisation).
select ok(
  not has_function_privilege('int_viewer', 'api.document_create_version(text, uuid, text, text, text, text, bigint, bytea, text)', 'EXECUTE')
  and not has_function_privilege('int_compliance', 'api.document_create_version(text, uuid, text, text, text, text, bigint, bytea, text)', 'EXECUTE'),
  'viewer and compliance hold no EXECUTE on api.document_create_version'
);
select ok(
  has_function_privilege('ext_user', 'api.document_create_version(text, uuid, text, text, text, text, bigint, bytea, text)', 'EXECUTE'),
  'ext_user still holds EXECUTE on api.document_create_version'
);
select ok(
  not has_function_privilege('int_coordinator', 'api.document_version_record_scan(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'int_coordinator holds no EXECUTE on api.document_version_record_scan'
);
select ok(
  not has_function_privilege('int_manager', 'api.document_version_record_scan(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'int_manager holds no EXECUTE on api.document_version_record_scan'
);
select ok(
  has_function_privilege('worker', 'api.document_version_record_scan(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'worker may still record a scan verdict'
);
select ok(
  has_function_privilege('int_sysadmin', 'api.document_version_record_scan(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'int_sysadmin may still record a scan verdict'
);

-- ---------------------------------------------------------------------------
-- R2.1 / R2.2: logical-document identity and serialized revisions.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from pg_constraint
    where conname = 'document_logical_uk' and contype = 'u'
      and conrelid = 'core.document'::regclass),
  1::bigint,
  'core.document has a unique logical identity (entity_type, entity_id, doc_type)'
);

select is(
  (select count(*) from pg_constraint
    where conname = 'document_version_revision_uk' and contype = 'u'
      and conrelid = 'core.document_version'::regclass),
  1::bigint,
  'core.document_version still has UNIQUE(document_id, revision_no)'
);

-- Minimal in-scope survey request for the functional document tests.
insert into party.organization (id, name, org_type, status)
values ('f1111111-0000-0000-0000-000000000001', 'Rectification Shipping', 'company', 'active');

insert into fleet.ship (id, imo_number, name, type_iacs, type_mms, flag_code, gross_tonnage, build_year, status)
values ('f1111111-0000-0000-0000-000000000010', '9123999', 'MV Rectification', 'BC', 'BC', 'PA', 30000, 2019, 'in_service');

insert into iam.app_user (id, kind, display_name, email, status)
values ('f1111111-0000-0000-0000-000000000031', 'external', 'Rectification Requester', 'r1r2@example.com', 'active');

insert into iam.org_membership (user_id, user_kind, org_id, member_role, granted_by)
values ('f1111111-0000-0000-0000-000000000031', 'external', 'f1111111-0000-0000-0000-000000000001', 'requester', '00000000-0000-0000-0000-000000000001');

insert into survey.survey_request (id, request_no, ship_id, org_id, office_unit_id, port_name, survey_types)
values (
  'f1111111-0000-0000-0000-000000000020', 'RECT-1',
  'f1111111-0000-0000-0000-000000000010',
  'f1111111-0000-0000-0000-000000000001',
  (select id from core.org_unit where code = 'SHA'),
  'Port of Shanghai', array['annual_hull']
);

select set_config('request.jwt.claims', json_build_object(
  'sub', 'f1111111-0000-0000-0000-000000000031',
  'role', 'ext_user',
  'sid', 'f1111111-0000-0000-0000-000000000099'
)::text, true);

select lives_ok(
  $$ select api.document_create_version(
       'survey_request', 'f1111111-0000-0000-0000-000000000020', 'specification',
       'First title', 'v1.pdf', 'application/pdf', 1024,
       decode(repeat('ab', 32), 'hex'), 'quarantine/r1r2/v1.pdf') $$,
  'first version is created'
);
select lives_ok(
  $$ select api.document_create_version(
       'survey_request', 'f1111111-0000-0000-0000-000000000020', 'specification',
       'Renamed title', 'v2.pdf', 'application/pdf', 2048,
       decode(repeat('cd', 32), 'hex'), 'quarantine/r1r2/v2.pdf') $$,
  'second version of the same logical document is created'
);
select lives_ok(
  $$ select api.document_create_version(
       'survey_request', 'f1111111-0000-0000-0000-000000000020', 'report',
       'Report', 'r1.pdf', 'application/pdf', 512,
       decode(repeat('ef', 32), 'hex'), 'quarantine/r1r2/r1.pdf') $$,
  'a different doc_type creates a different logical document'
);

select is(
  (select count(*) from core.document
    where entity_id = 'f1111111-0000-0000-0000-000000000020'
      and entity_type = 'survey_request' and doc_type = 'specification'),
  1::bigint,
  'two revisions and a title change produce exactly one logical document'
);
select is(
  (select array_agg(revision_no order by revision_no) from core.document_version v
     join core.document d on d.id = v.document_id
    where d.entity_id = 'f1111111-0000-0000-0000-000000000020'
      and d.doc_type = 'specification'),
  array[1, 2]::int[],
  'revisions are distinct and sequential'
);
select is(
  (select title from core.document
    where entity_id = 'f1111111-0000-0000-0000-000000000020' and doc_type = 'specification'),
  'Renamed title',
  'the logical document title follows the latest revision'
);
select is(
  (select count(*) from core.document
    where entity_id = 'f1111111-0000-0000-0000-000000000020'),
  2::bigint,
  'distinct doc_type values create distinct logical documents'
);

select * from finish();
rollback;
