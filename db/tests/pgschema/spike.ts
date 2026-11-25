import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  applyBootstrap,
  pgschemaPlanFile,
  psql,
  recreateDatabase,
  requireDatabaseUrl,
  splitMigrationSql,
  withDatabase,
} from '../../scripts/lib.ts'

type Fixture = {
  name: string
  schema: string
  setup?: string
  v1: string
  v2: string
  expectV1: RegExp[]
  expectV2: RegExp[]
  expectDrop: RegExp[]
  allowEmpty?: boolean
}

let url = requireDatabaseUrl()
let baseDb = 'mms_spike_base'
let planDb = 'mms_spike_plan'
let baseUrl = withDatabase(url, baseDb)
let planUrl = withDatabase(url, planDb)

function resetSchema(target: string, schema: string): void {
  psql(target, [
    '-c',
    `drop schema if exists ${schema} cascade`,
    '-c',
    `create schema ${schema} authorization mms_owner`,
  ])
}

function applySql(target: string, schema: string, sql: string): void {
  let split = splitMigrationSql(sql)
  if (split.transactional) {
    psql(target, [
      '-c',
      'begin',
      '-c',
      `set local search_path = ${schema}`,
      '-c',
      split.transactional,
      '-c',
      'commit',
    ])
  }
  for (let statement of split.nontx) {
    psql(target, ['-c', statement])
  }
}

function applySetup(target: string, setup: string | undefined): void {
  if (!setup) return
  psql(target, ['-c', 'begin', '-c', setup, '-c', 'commit'])
}

function plan(schema: string, sql: string) {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), `mms-spike-${schema}-`))
  let file = path.join(dir, 'desired.sql')
  fs.writeFileSync(file, sql)
  try {
    return pgschemaPlanFile(baseUrl, planUrl, schema, file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function setDesired(schema: string, sql: string): void {
  resetSchema(planUrl, schema)
  applySql(planUrl, schema, sql)
}

let fixtures: Fixture[] = [
  {
    name: 'table-columns-constraints-indexes',
    schema: 'party',
    v1: `
      create table party.spike_table (
        id uuid primary key default uuidv7(),
        name text not null,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        constraint spike_table_status_check check (status in ('active', 'inactive'))
      );
      create unique index spike_table_name_key on party.spike_table (lower(name));
      create index spike_table_active on party.spike_table (created_at) where status = 'active';
    `,
    v2: `
      create table party.spike_table (
        id uuid primary key default uuidv7(),
        name text not null,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        code text,
        constraint spike_table_status_check check (status in ('active', 'inactive'))
      );
      create unique index spike_table_name_key on party.spike_table (lower(name));
      create index spike_table_active on party.spike_table (created_at) where status = 'active';
      create index spike_table_code on party.spike_table (code);
    `,
    expectV1: [/CREATE TABLE/i, /uuidv7/i, /CREATE UNIQUE INDEX/i, /WHERE/i],
    expectV2: [/ADD COLUMN/i, /CREATE INDEX/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'exclusion-constraint',
    schema: 'iam',
    v1: `
      create table iam.spike_assignment (
        user_id uuid not null,
        valid tstzrange not null,
        constraint spike_assignment_ex exclude using gist (user_id with =, valid with &&)
      );
    `,
    v2: `
      create table iam.spike_assignment (
        user_id uuid not null,
        valid tstzrange not null,
        note text,
        constraint spike_assignment_ex exclude using gist (user_id with =, valid with &&)
      );
    `,
    expectV1: [/EXCLUDE USING gist/i],
    expectV2: [/ADD COLUMN/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'composite-kind-fk',
    schema: 'iam',
    setup: `
      create table core.spike_org (
        id uuid primary key,
        name text not null
      );
    `,
    v1: `
      create table iam.spike_user (
        id uuid not null,
        kind text not null,
        org_id uuid not null references core.spike_org(id),
        primary key (id, kind)
      );
    `,
    v2: `
      create table iam.spike_user (
        id uuid not null,
        kind text not null,
        org_id uuid not null references core.spike_org(id),
        email text,
        primary key (id, kind)
      );
    `,
    expectV1: [/FOREIGN KEY/i, /core\.spike_org|REFERENCES core/i],
    expectV2: [/ADD COLUMN/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'defaults',
    schema: 'core',
    v1: `
      create table core.spike_defaults (
        id uuid primary key default uuidv7(),
        valid_window tstzrange not null default tstzrange(now(), null),
        touched_at timestamptz not null default clock_timestamp()
      );
    `,
    v2: `
      create table core.spike_defaults (
        id uuid primary key default uuidv7(),
        valid_window tstzrange not null default tstzrange(now(), null),
        touched_at timestamptz not null default clock_timestamp(),
        label text
      );
    `,
    expectV1: [/uuidv7/i, /tstzrange\(now\(\), null\)/i, /clock_timestamp/i],
    expectV2: [/ADD COLUMN/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'rls-policy-private-helper',
    schema: 'iam',
    setup: `
      create function private.spike_allowed(p_user uuid) returns boolean
      language sql stable security definer set search_path = '' as $$
        select true
      $$;
      revoke all on function private.spike_allowed(uuid) from public;
    `,
    v1: `
      create table iam.spike_secure (
        id uuid primary key default uuidv7(),
        user_id uuid not null
      );
      alter table iam.spike_secure enable row level security;
      create policy spike_secure_read on iam.spike_secure
        for select using (private.spike_allowed(user_id));
    `,
    v2: `
      create table iam.spike_secure (
        id uuid primary key default uuidv7(),
        user_id uuid not null,
        label text
      );
      alter table iam.spike_secure enable row level security;
      create policy spike_secure_read on iam.spike_secure
        for select using (private.spike_allowed(user_id));
    `,
    expectV1: [/ENABLE ROW LEVEL SECURITY/i, /CREATE POLICY/i, /private\.spike_allowed/i],
    expectV2: [/ADD COLUMN/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'function-security-definer-and-grants',
    schema: 'private',
    v1: `
      create function private.spike_echo(p_id uuid) returns uuid
      language sql stable security definer set search_path = '' as $$
        select p_id
      $$;
      revoke all on function private.spike_echo(uuid) from public;
      grant execute on function private.spike_echo(uuid) to web_anon;
    `,
    v2: `
      create function private.spike_echo(p_id uuid, p_extra text default null) returns uuid
      language sql stable security definer set search_path = '' as $$
        select p_id
      $$;
      revoke all on function private.spike_echo(uuid, text) from public;
      grant execute on function private.spike_echo(uuid, text) to web_anon;
    `,
    expectV1: [/SECURITY DEFINER/i, /SET search_path/i, /GRANT EXECUTE/i, /REVOKE/i],
    expectV2: [/CREATE OR REPLACE FUNCTION|CREATE FUNCTION/i],
    expectDrop: [/DROP FUNCTION/i],
  },
  {
    name: 'trigger',
    schema: 'party',
    setup: `
      create function private.spike_touch() returns trigger
      language plpgsql security definer set search_path = '' as $$
      begin
        new.updated_at := now();
        return new;
      end
      $$;
      revoke all on function private.spike_touch() from public;
    `,
    v1: `
      create table party.spike_triggered (
        id uuid primary key default uuidv7(),
        updated_at timestamptz not null default now()
      );
      create trigger spike_triggered_touch before update on party.spike_triggered
        for each row execute function private.spike_touch();
    `,
    v2: `
      create table party.spike_triggered (
        id uuid primary key default uuidv7(),
        updated_at timestamptz not null default now(),
        label text
      );
      create trigger spike_triggered_touch before update on party.spike_triggered
        for each row execute function private.spike_touch();
    `,
    expectV1: [/CREATE(?: OR REPLACE)? TRIGGER/i, /private\.spike_touch/i],
    expectV2: [/ADD COLUMN/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'grants-converge',
    schema: 'party',
    v1: `
      create table party.spike_grant (
        id uuid primary key default uuidv7(),
        name text not null
      );
      grant select (id) on party.spike_grant to int_viewer;
    `,
    v2: `
      create table party.spike_grant (
        id uuid primary key default uuidv7(),
        name text not null
      );
      grant select (id, name) on party.spike_grant to int_viewer;
    `,
    expectV1: [/GRANT SELECT/i],
    expectV2: [/GRANT SELECT/i],
    expectDrop: [/DROP TABLE/i],
  },
  {
    name: 'schema-usage',
    schema: 'party',
    v1: `grant usage on schema party to int_viewer;`,
    v2: `grant usage on schema party to int_viewer, int_auditor;`,
    expectV1: [],
    expectV2: [],
    expectDrop: [],
    allowEmpty: true,
  },
  {
    name: 'view-security-invoker',
    schema: 'api',
    setup: `
      create table core.spike_view_base (
        id uuid primary key default uuidv7(),
        name text not null,
        extra text
      );
    `,
    v1: `
      create view api.spike_view with (security_invoker = true) as
        select id, name from core.spike_view_base;
      grant select on api.spike_view to web_anon;
    `,
    v2: `
      create view api.spike_view with (security_invoker = true) as
        select id, name, extra from core.spike_view_base;
      grant select on api.spike_view to web_anon;
    `,
    expectV1: [/CREATE(?: OR REPLACE)? VIEW/i, /security_invoker/i],
    expectV2: [/CREATE OR REPLACE VIEW|DROP VIEW|ALTER VIEW/i],
    expectDrop: [/DROP VIEW/i],
  },
  {
    name: 'partitioned-table-indexes-triggers',
    schema: 'party',
    setup: `
      create or replace function private.spike_part_guard() returns trigger
      language plpgsql security definer set search_path = '' as $$
      begin
        raise exception 'partitioned table is append-only';
      end
      $$;
      revoke all on function private.spike_part_guard() from public;
    `,
    v1: `
      create table party.spike_partitioned (
        id bigint not null,
        occurred_at timestamptz not null default clock_timestamp(),
        payload text not null,
        primary key (id, occurred_at)
      ) partition by range (occurred_at);

      create table party.spike_partitioned_y2026 partition of party.spike_partitioned
        for values from ('2026-01-01 00:00:00+00') to ('2027-01-01 00:00:00+00');

      create index spike_part_payload_ix on party.spike_partitioned (payload);

      create trigger spike_partitioned_append_only
        before update or delete on party.spike_partitioned
        for each row execute function private.spike_part_guard();
    `,
    v2: `
      create table party.spike_partitioned (
        id bigint not null,
        occurred_at timestamptz not null default clock_timestamp(),
        payload text not null,
        primary key (id, occurred_at)
      ) partition by range (occurred_at);

      create table party.spike_partitioned_y2026 partition of party.spike_partitioned
        for values from ('2026-01-01 00:00:00+00') to ('2027-01-01 00:00:00+00');

      create table party.spike_partitioned_y2027 partition of party.spike_partitioned
        for values from ('2027-01-01 00:00:00+00') to ('2028-01-01 00:00:00+00');

      create index spike_part_payload_ix on party.spike_partitioned (payload);

      create trigger spike_partitioned_append_only
        before update or delete on party.spike_partitioned
        for each row execute function private.spike_part_guard();
    `,
    expectV1: [/PARTITION BY RANGE/i, /PARTITION OF/i, /CREATE(?: OR REPLACE)? TRIGGER/i],
    expectV2: [/spike_partitioned_y2027/i, /PARTITION OF/i],
    expectDrop: [/DROP TRIGGER/i, /DROP TABLE/i],
  },
]

let failures: string[] = []
let results: string[] = []

recreateDatabase(url, baseDb)
applyBootstrap(baseUrl)
recreateDatabase(url, planDb)
applyBootstrap(planUrl)

for (let fixture of fixtures) {
  console.log(`fixture: ${fixture.name}`)
  resetSchema(baseUrl, fixture.schema)
  resetSchema(planUrl, fixture.schema)
  applySetup(baseUrl, fixture.setup)
  applySetup(planUrl, fixture.setup)

  let first = plan(fixture.schema, fixture.v1)
  if (first.status !== 0 || /warning/i.test(`${first.human}\n${first.stderr}`)) {
    failures.push(`${fixture.name}: v1 plan failed\n${first.human}\n${first.stderr}`)
    continue
  }
  for (let expected of fixture.expectV1) {
    if (!expected.test(first.sql)) failures.push(`${fixture.name}: v1 SQL missing ${expected}\n${first.sql}`)
  }
  if (!fixture.allowEmpty && first.sql.trim().length === 0) {
    failures.push(`${fixture.name}: v1 produced no SQL`)
  }
  applySql(baseUrl, fixture.schema, first.sql)
  let firstAgain = plan(fixture.schema, fixture.v1)
  if (firstAgain.sql.trim().length > 0) {
    failures.push(`${fixture.name}: v1 did not converge\n${firstAgain.human}`)
  }

  setDesired(fixture.schema, fixture.v2)
  let second = plan(fixture.schema, fixture.v2)
  if (second.status !== 0 || /warning/i.test(`${second.human}\n${second.stderr}`)) {
    failures.push(`${fixture.name}: v2 plan failed\n${second.human}\n${second.stderr}`)
    continue
  }
  for (let expected of fixture.expectV2) {
    if (!expected.test(second.sql)) failures.push(`${fixture.name}: v2 SQL missing ${expected}`)
  }
  applySql(baseUrl, fixture.schema, second.sql)
  let secondAgain = plan(fixture.schema, fixture.v2)
  if (secondAgain.sql.trim().length > 0) {
    failures.push(`${fixture.name}: v2 did not converge\n${secondAgain.human}`)
  }

  setDesired(fixture.schema, '')
  let removal = plan(fixture.schema, '')
  for (let expected of fixture.expectDrop) {
    if (!expected.test(removal.sql)) failures.push(`${fixture.name}: drop SQL missing ${expected}`)
  }
  applySql(baseUrl, fixture.schema, removal.sql)
  let removalAgain = plan(fixture.schema, '')
  if (removalAgain.sql.trim().length > 0) {
    failures.push(`${fixture.name}: drop did not converge\n${removalAgain.human}`)
  }

  results.push(`${fixture.name}: ${first.sql ? 'managed' : 'no SQL (ignored by pgschema)'}`)
}

console.log('')
for (let result of results) console.log(result)
if (failures.length > 0) {
  for (let failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log('pgschema spike suite passed')
