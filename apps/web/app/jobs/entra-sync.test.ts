import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { Pool } from 'pg'

import {
  checkAndRunOverdueEntraSync,
  DefaultEntraDirectoryClient,
  MockEntraDirectoryClient,
  resetEntraDirectoryClient,
  runEntraDeprovisionSync,
  setEntraDirectoryClient,
  type EntraDirectoryClient,
} from './entra-sync.ts'
import { pollOnce } from './poller.ts'
import { closeWorkerPool, getWorkerPool } from './worker-client.ts'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

describe('Card H-04: Entra Deprovisioning Sync Worker', () => {
  let adminPool: Pool
  let mockDirectory: MockEntraDirectoryClient

  const testTenantId = 'e0000000-0000-0000-0000-000000000001'
  const user1Oid = 'e0000000-0000-0000-0000-000000000011'
  const user1Id = 'e1111111-1111-1111-1111-111111111111'
  const user2Oid = 'e0000000-0000-0000-0000-000000000012'
  const user2Id = 'e2222222-2222-2222-2222-222222222222'
  const user3Oid = 'e0000000-0000-0000-0000-000000000013'
  const user3Id = 'e3333333-3333-3333-3333-333333333333'
  const externalUserId = 'e4444444-4444-4444-4444-444444444444'

  let testUnitId: string

  before(async () => {
    adminPool = new Pool({ connectionString: adminUrl })

    // Find active test organization unit
    let unitRes = await adminPool.query<{ id: string }>(`select id from core.org_unit limit 1`)
    testUnitId = unitRes.rows[0]!.id

    // Configure tenant in auth.config
    await adminPool.query(`
      insert into auth.config (singleton, entra_tenant_id, entra_app_role)
      values (true, $1, 'MMS.User')
      on conflict (singleton) do update
        set entra_tenant_id = excluded.entra_tenant_id,
            entra_app_role = excluded.entra_app_role
    `, [testTenantId])
  })

  after(async () => {
    resetEntraDirectoryClient()
    await adminPool.query(`delete from iam.session where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.role_assignment where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.position_proposal where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.staff_position where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.app_user where id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.end()
    await closeWorkerPool()
  })

  beforeEach(async () => {
    mockDirectory = new MockEntraDirectoryClient()
    setEntraDirectoryClient(mockDirectory)

    // Clean up test users
    await adminPool.query(`delete from iam.session where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.role_assignment where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.position_proposal where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.staff_position where user_id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
    await adminPool.query(`delete from iam.app_user where id in ($1, $2, $3, $4)`, [
      user1Id,
      user2Id,
      user3Id,
      externalUserId,
    ])
  })

  it('Flow 1: Deprovisions staff user when MMS.User role is removed in Microsoft Entra', async () => {
    // Setup staff user 1 with position, assignment, and active session
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Staff User 1', $2, $3, 'active')
    `, [user1Id, testTenantId, user1Oid])

    await adminPool.query(`
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      values ($1, 'internal', 'senior_admins', 'office_admin', $2,
              tstzrange(now() - interval '1 day', null), $3, 'initial assignment')
    `, [user1Id, testUnitId, '00000000-0000-0000-0000-000000000001'])

    let raRes = await adminPool.query<{ id: string }>(`
      insert into iam.role_assignment (user_id, user_kind, db_role, scope_type, source, granted_by, grant_reason)
      values ($1, 'internal', 'int_coordinator', 'global', 'manual', $2, 'role grant')
      returning id
    `, [user1Id, '00000000-0000-0000-0000-000000000001'])
    let assignmentId = raRes.rows[0]!.id

    let sessionRes = await adminPool.query<{ id: string }>(`
      insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
      values ($1, 'internal', 'int_coordinator', 'entra', now() + interval '1 hour', now() + interval '8 hours')
      returning id
    `, [user1Id])
    let sessionId = sessionRes.rows[0]!.id

    // Pre-condition: user is active in DB, but in Entra MMS.User role was removed
    mockDirectory.setUserStatus(testTenantId, user1Oid, {
      exists: true,
      accountEnabled: true,
      hasMmsUserRole: false, // Role revoked in Entra
      deleted: false,
    })

    let result = await runEntraDeprovisionSync()

    assert.equal(result.status, 'deprovisioned')
    assert.ok(result.usersChecked >= 1)
    assert.ok(result.deprovisionedUserIds.includes(user1Id))
    assert.equal(result.usersDeprovisioned, 1)

    // Verify 1: User transitioned to deactivated
    let userRes = await adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [user1Id])
    assert.equal(userRes.rows[0]?.status, 'deactivated')

    // Verify 2: Session was automatically revoked by trigger with reason user_deactivated
    let sRes = await adminPool.query<{ revoked_at: string; revoke_reason: string }>(
      'select revoked_at, revoke_reason from iam.session where id = $1',
      [sessionId],
    )
    assert.ok(sRes.rows[0]?.revoked_at, 'session was revoked')
    assert.equal(sRes.rows[0]?.revoke_reason, 'user_deactivated')

    // Verify 3: Role assignment was revoked
    let rRes = await adminPool.query<{ revoked_at: string; revoke_reason: string }>(
      'select revoked_at, revoke_reason from iam.role_assignment where id = $1',
      [assignmentId],
    )
    assert.ok(rRes.rows[0]?.revoked_at, 'assignment was revoked')
    assert.match(rRes.rows[0]?.revoke_reason ?? '', /Entra deprovisioning/i)

    // Verify 4: Staff position closed to now
    let pRes = await adminPool.query<{ is_closed: boolean }>(
      'select upper(valid) <= now() as is_closed from iam.staff_position where user_id = $1',
      [user1Id],
    )
    assert.equal(pRes.rows[0]?.is_closed, true)

    // Verify 5: Regulated audit event auth.user.deactivated emitted
    let evRes = await adminPool.query<{ event_type: string; subject_id: string; outcome: string }>(
      `select event_type, subject_id, outcome from audit_trail.event
        where event_type = 'auth.user.deactivated' and subject_id = $1
        order by id desc limit 1`,
      [user1Id],
    )
    assert.equal(evRes.rows.length, 1)
    assert.equal(evRes.rows[0]?.outcome, 'success')

    // Verify 6: Run recorded in audit_trail.entra_sync_run
    let runRes = await adminPool.query<{ status: string; users_deprovisioned: number }>(
      'select status, users_deprovisioned from audit_trail.entra_sync_run where id = $1',
      [result.runId],
    )
    assert.equal(runRes.rows[0]?.status, 'deprovisioned')
    assert.equal(runRes.rows[0]?.users_deprovisioned, 1)

    // Verify 7: Subsequent pre_request rejects the revoked session immediately with PT401
    await assert.rejects(
      async () => {
        let client = await adminPool.connect()
        try {
          await client.query('begin')
          await client.query(`
            select set_config('request.jwt.claims', jsonb_build_object(
              'sub', $1::text,
              'sid', $2::text,
              'role', 'int_coordinator'
            )::text, true)
          `, [user1Id, sessionId])
          await client.query('select private.pre_request()')
        } finally {
          await client.query('rollback').catch(() => {})
          client.release()
        }
      },
      /session_invalid/,
      'pre_request rejects request with PT401 session_invalid after deprovisioning',
    )
  })

  it('Flow 2: Deprovisions staff user when account is disabled in Microsoft Entra', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Disabled Staff', $2, $3, 'active')
    `, [user2Id, testTenantId, user2Oid])

    let sessionRes = await adminPool.query<{ id: string }>(`
      insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
      values ($1, 'internal', 'int_viewer', 'entra', now() + interval '1 hour', now() + interval '8 hours')
      returning id
    `, [user2Id])
    let sessionId = sessionRes.rows[0]!.id

    mockDirectory.setUserStatus(testTenantId, user2Oid, {
      exists: true,
      accountEnabled: false, // Disabled in Entra
      hasMmsUserRole: true,
      deleted: false,
    })

    let result = await runEntraDeprovisionSync()

    assert.equal(result.status, 'deprovisioned')
    assert.ok(result.deprovisionedUserIds.includes(user2Id))

    let userRes = await adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [user2Id])
    assert.equal(userRes.rows[0]?.status, 'deactivated')

    let sRes = await adminPool.query<{ revoke_reason: string }>(
      'select revoke_reason from iam.session where id = $1',
      [sessionId],
    )
    assert.equal(sRes.rows[0]?.revoke_reason, 'user_deactivated')
  })

  it('Flow 3: Deprovisions staff user when account is deleted/not found in Microsoft Entra', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Deleted Staff', $2, $3, 'active')
    `, [user3Id, testTenantId, user3Oid])

    mockDirectory.removeUser(testTenantId, user3Oid) // 404 / soft-deleted

    let result = await runEntraDeprovisionSync()

    assert.equal(result.status, 'deprovisioned')
    assert.ok(result.deprovisionedUserIds.includes(user3Id))

    let userRes = await adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [user3Id])
    assert.equal(userRes.rows[0]?.status, 'deactivated')
  })

  it('Flow 4: Clean sync run when all staff users are active and retain MMS.User', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Valid Staff', $2, $3, 'active')
    `, [user1Id, testTenantId, user1Oid])

    mockDirectory.setUserStatus(testTenantId, user1Oid, {
      exists: true,
      accountEnabled: true,
      hasMmsUserRole: true,
      deleted: false,
    })

    let result = await runEntraDeprovisionSync()

    assert.equal(result.status, 'clean')
    assert.equal(result.usersDeprovisioned, 0)
    assert.equal(result.deprovisionedUserIds.length, 0)

    let runRes = await adminPool.query<{ status: string; users_deprovisioned: number }>(
      'select status, users_deprovisioned from audit_trail.entra_sync_run where id = $1',
      [result.runId],
    )
    assert.equal(runRes.rows[0]?.status, 'clean')
    assert.equal(runRes.rows[0]?.users_deprovisioned, 0)
  })

  it('Flow 5: Idempotency — re-running sync on already deactivated users is a safe no-op', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Deactivated Staff', $2, $3, 'deactivated')
    `, [user1Id, testTenantId, user1Oid])

    mockDirectory.setUserStatus(testTenantId, user1Oid, {
      exists: false,
      accountEnabled: false,
      hasMmsUserRole: false,
      deleted: true,
    })

    let result = await runEntraDeprovisionSync()

    assert.equal(result.status, 'clean')
    assert.equal(result.usersDeprovisioned, 0)
  })

  it('Flow 6: External and service users are excluded from Entra staff sync', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, email, status)
      values ($1, 'external', 'External Customer', 'external@customer.example', 'active')
    `, [externalUserId])

    // Should not check external user against Entra directory
    let calledForExternal = false
    let origGet = mockDirectory.getUserStatus.bind(mockDirectory)
    mockDirectory.getUserStatus = async (tid, oid) => {
      if (oid === externalUserId) {
        calledForExternal = true
      }
      return origGet(tid, oid)
    }

    let result = await runEntraDeprovisionSync()
    assert.equal(calledForExternal, false, 'external user was not queried against Entra')
    assert.equal(result.status, 'clean')

    // Verify external user status unchanged
    let userRes = await adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [
      externalUserId,
    ])
    assert.equal(userRes.rows[0]?.status, 'active')
  })

  it('Flow 7: Outbox job execution — pollOnce processes entra_deprovision_sync job and completes', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Outbox Staff', $2, $3, 'active')
    `, [user1Id, testTenantId, user1Oid])

    mockDirectory.setUserStatus(testTenantId, user1Oid, {
      exists: true,
      accountEnabled: true,
      hasMmsUserRole: false, // Will trigger deprovisioning
      deleted: false,
    })

    // Enqueue entra_deprovision_sync job in core.outbox
    let insRes = await adminPool.query<{ id: string }>(`
      insert into core.outbox (kind, payload, status)
      values ('entra_deprovision_sync', '{}'::jsonb, 'pending')
      returning id
    `)
    let jobId = insRes.rows[0]!.id

    let processed = await pollOnce()
    assert.ok(processed >= 1, 'job was processed by outbox poller')

    let jobStatus = await adminPool.query<{ status: string; attempts: number }>(
      'select status, attempts from core.outbox where id = $1',
      [jobId],
    )
    assert.equal(jobStatus.rows[0]?.status, 'done')
    assert.equal(jobStatus.rows[0]?.attempts, 1)

    let userRes = await adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [user1Id])
    assert.equal(userRes.rows[0]?.status, 'deactivated')
  })

  it('Flow 8: Error resilience — directory failure records failed run and preserves error details', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Error Staff', $2, $3, 'active')
    `, [user1Id, testTenantId, user1Oid])

    let failingClient: EntraDirectoryClient = {
      async getUserStatus() {
        throw new Error('Microsoft Graph API connection timeout')
      },
    }

    await assert.rejects(
      async () => {
        await runEntraDeprovisionSync({ client: failingClient })
      },
      /Microsoft Graph API connection timeout/,
    )

    // Verify failure was recorded in audit_trail.entra_sync_run
    let runRes = await adminPool.query<{ status: string; error_message: string }>(
      `select status, error_message from audit_trail.entra_sync_run
        order by id desc limit 1`,
    )
    assert.equal(runRes.rows[0]?.status, 'failed')
    assert.match(runRes.rows[0]?.error_message ?? '', /connection timeout/i)
  })

  it('Flow 9: Terminal deactivation — resolve_entra keeps deactivated user status terminal upon Entra sign-in (F-H01)', async () => {
    // User was previously deactivated by Entra sync
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Rehired Staff', $2, $3, 'deactivated')
    `, [user1Id, testTenantId, user1Oid])

    // User logs in via Entra with MMS.User role present — status remains terminal until explicit reactivation
    let res = await adminPool.query<{ resolve_entra: { status: string; assignable_roles: string[] } }>(`
      select auth.resolve_entra($1, $2, 'rehired@example.com', 'Rehired Staff', array['MMS.User']) as resolve_entra
    `, [testTenantId, user1Oid])

    let resolved = res.rows[0]?.resolve_entra
    assert.equal(resolved?.status, 'deactivated', 'deactivated user status remains terminal')
    assert.deepEqual(resolved?.assignable_roles, [], 'user has no positions or assignments until HR grants them')
  })

  it('Flow 10: Append-only enforcement on audit_trail.entra_sync_run', async () => {
    // R1.1: the run recorder is worker/admin-only and now fails closed without
    // JWT claims. Supply the claims the sync worker carries, inside one
    // transaction (`set_config(..., true)` is transaction-local).
    let client = await adminPool.connect()
    let runId: string
    try {
      await client.query('begin')
      await client.query(
        `select set_config('request.jwt.claims', jsonb_build_object('role', 'int_sysadmin', 'sub', $1::text)::text, true)`,
        [user1Id],
      )
      let insRes = await client.query<{ run_id: string }>(`
        select private.record_entra_sync_run('clean', 5, 0, '{}', null, '{}'::jsonb) as run_id
      `)
      await client.query('commit')
      runId = insRes.rows[0]!.run_id
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    await assert.rejects(
      async () => {
        await adminPool.query(`update audit_trail.entra_sync_run set status = 'failed' where id = $1`, [runId])
      },
      /audit reconciliation records are append-only/,
      'updates to audit_trail.entra_sync_run are rejected by append-only trigger',
    )

    await assert.rejects(
      async () => {
        await adminPool.query(`delete from audit_trail.entra_sync_run where id = $1`, [runId])
      },
      /audit reconciliation records are append-only/,
      'deletes from audit_trail.entra_sync_run are rejected by append-only trigger',
    )
  })

  it('Flow 11: DefaultEntraDirectoryClient unit test — throws when credentials are not configured', async () => {
    let origClientId = process.env.MMS_ENTRA_CLIENT_ID
    let origSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    delete process.env.MMS_ENTRA_CLIENT_ID
    delete process.env.MMS_ENTRA_CLIENT_SECRET

    try {
      let client = new DefaultEntraDirectoryClient()
      await assert.rejects(
        async () => {
          await client.getUserStatus(testTenantId, user1Oid)
        },
        /MMS_ENTRA_CLIENT_ID and MMS_ENTRA_CLIENT_SECRET must be configured/,
      )
    } finally {
      if (origClientId) process.env.MMS_ENTRA_CLIENT_ID = origClientId
      if (origSecret) process.env.MMS_ENTRA_CLIENT_SECRET = origSecret
    }
  })

  it('Flow 12: DefaultEntraDirectoryClient unit test — parses Graph 404 as deleted user', async () => {
    let origClientId = process.env.MMS_ENTRA_CLIENT_ID
    let origSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    process.env.MMS_ENTRA_CLIENT_ID = 'test-client'
    process.env.MMS_ENTRA_CLIENT_SECRET = 'test-secret'

    let origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      let urlStr = String(input)
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/users/')) {
        return new Response(JSON.stringify({ error: { code: 'Request_ResourceNotFound' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    try {
      let client = new DefaultEntraDirectoryClient()
      let status = await client.getUserStatus(testTenantId, user1Oid)
      assert.equal(status.exists, false)
      assert.equal(status.deleted, true)
      assert.equal(status.hasMmsUserRole, false)
      assert.equal(status.accountEnabled, false)
    } finally {
      globalThis.fetch = origFetch
      if (origClientId) process.env.MMS_ENTRA_CLIENT_ID = origClientId
      else delete process.env.MMS_ENTRA_CLIENT_ID
      if (origSecret) process.env.MMS_ENTRA_CLIENT_SECRET = origSecret
      else delete process.env.MMS_ENTRA_CLIENT_SECRET
    }
  })

  it('Flow 13: Deprovisioning closes both active and future scheduled positions', async () => {
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'Multi Position Staff', $2, $3, 'active')
    `, [user1Id, testTenantId, user1Oid])

    // Position 1: currently active (ends tomorrow)
    let p1Res = await adminPool.query<{ id: string }>(`
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      values ($1, 'internal', 'senior_admins', 'office_admin', $2,
              tstzrange(now() - interval '2 days', now() + interval '1 day'), $3, 'active pos')
      returning id
    `, [user1Id, testUnitId, '00000000-0000-0000-0000-000000000001'])
    let pos1Id = p1Res.rows[0]!.id

    // Position 2: future position (starts tomorrow)
    let p2Res = await adminPool.query<{ id: string }>(`
      insert into iam.staff_position (user_id, user_kind, job_title_code, job_family, unit_id, valid, set_by, reason)
      values ($1, 'internal', 'senior_admins', 'office_admin', $2,
              tstzrange(now() + interval '1 day', null), $3, 'future pos')
      returning id
    `, [user1Id, testUnitId, '00000000-0000-0000-0000-000000000001'])
    let pos2Id = p2Res.rows[0]!.id

    mockDirectory.setUserStatus(testTenantId, user1Oid, {
      exists: true,
      accountEnabled: false,
    })

    let result = await runEntraDeprovisionSync()
    assert.equal(result.status, 'deprovisioned')
    assert.equal(result.usersDeprovisioned, 1)

    // Position 1 closed to now
    let p1Check = await adminPool.query<{ is_closed: boolean }>(
      'select upper(valid) <= now() as is_closed from iam.staff_position where id = $1',
      [pos1Id],
    )
    assert.equal(p1Check.rows[0]?.is_closed, true)

    // Position 2 future invalidated to empty range
    let p2Check = await adminPool.query<{ is_empty: boolean }>(
      'select isempty(valid) as is_empty from iam.staff_position where id = $1',
      [pos2Id],
    )
    assert.equal(p2Check.rows[0]?.is_empty, true)
  })

  it('Flow 14: Batch fault tolerance — user directory check failure does not block deprovisioning of subsequent terminated users', async () => {
    // User 1 will encounter a directory error
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'User 1 Directory Error', $2, $3, 'active')
    `, [user1Id, testTenantId, user1Oid])

    // User 2 has role removed in Entra and must be deprovisioned
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'User 2 Role Revoked', $2, $3, 'active')
    `, [user2Id, testTenantId, user2Oid])

    let session2Res = await adminPool.query<{ id: string }>(`
      insert into iam.session (user_id, user_kind, active_role, auth_method, idle_expires_at, expires_at)
      values ($1, 'internal', 'int_coordinator', 'entra', now() + interval '1 hour', now() + interval '8 hours')
      returning id
    `, [user2Id])
    let session2Id = session2Res.rows[0]!.id

    let customClient: EntraDirectoryClient = {
      async getUserStatus(tid, oid) {
        if (oid === user1Oid) {
          throw new Error('Graph transient timeout on user 1')
        }
        if (oid === user2Oid) {
          return {
            exists: true,
            accountEnabled: true,
            hasMmsUserRole: false, // Role revoked
            deleted: false,
          }
        }
        return { exists: true, accountEnabled: true, hasMmsUserRole: true, deleted: false }
      },
    }

    // Must reject due to error on user 1
    await assert.rejects(
      async () => {
        await runEntraDeprovisionSync({ client: customClient })
      },
      /Graph transient timeout on user 1/,
    )

    // BUT User 2 MUST STILL HAVE BEEN DEPROVISIONED (24-hour Revocation SLA fulfilled!)
    let u2Res = await adminPool.query<{ status: string }>('select status from iam.app_user where id = $1', [user2Id])
    assert.equal(u2Res.rows[0]?.status, 'deactivated', 'User 2 was deactivated despite User 1 error')

    let s2Res = await adminPool.query<{ revoke_reason: string }>(
      'select revoke_reason from iam.session where id = $1',
      [session2Id],
    )
    assert.equal(s2Res.rows[0]?.revoke_reason, 'user_deactivated')

    // Audit run records status = 'failed' with user 2 deprovisioned recorded
    let runRes = await adminPool.query<{ status: string; users_deprovisioned: number; deprovisioned_user_ids: string[] }>(
      `select status, users_deprovisioned, deprovisioned_user_ids from audit_trail.entra_sync_run
        order by id desc limit 1`,
    )
    assert.equal(runRes.rows[0]?.status, 'failed')
    assert.equal(runRes.rows[0]?.users_deprovisioned, 1)
    assert.ok(runRes.rows[0]?.deprovisioned_user_ids.includes(user2Id))
  })

  it('Flow 15: DefaultEntraDirectoryClient retries on HTTP 429 rate limit with Retry-After header', async () => {
    let origClientId = process.env.MMS_ENTRA_CLIENT_ID
    let origSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    process.env.MMS_ENTRA_CLIENT_ID = 'test-client'
    process.env.MMS_ENTRA_CLIENT_SECRET = 'test-secret'

    let attempts = 0
    let origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      let urlStr = String(input)
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/users/') && !urlStr.includes('/appRoleAssignments')) {
        attempts++
        if (attempts === 1) {
          // First attempt throttled with Retry-After: 0
          return new Response(JSON.stringify({ error: { code: 'Throttled' } }), {
            status: 429,
            headers: { 'Retry-After': '0', 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({
          id: user1Oid,
          accountEnabled: true,
          deletedDateTime: null,
          userPrincipalName: 'user@example.com',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/appRoleAssignments')) {
        return new Response(JSON.stringify({
          value: [{ appRoleId: 'MMS.User', resourceDisplayName: 'MMS' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    try {
      let client = new DefaultEntraDirectoryClient()
      let status = await client.getUserStatus(testTenantId, user1Oid)
      assert.equal(attempts, 2, 'retried after HTTP 429')
      assert.equal(status.exists, true)
      assert.equal(status.accountEnabled, true)
      assert.equal(status.hasMmsUserRole, true)
    } finally {
      globalThis.fetch = origFetch
      if (origClientId) process.env.MMS_ENTRA_CLIENT_ID = origClientId
      else delete process.env.MMS_ENTRA_CLIENT_ID
      if (origSecret) process.env.MMS_ENTRA_CLIENT_SECRET = origSecret
      else delete process.env.MMS_ENTRA_CLIENT_SECRET
    }
  })

  it('Flow 16: DefaultEntraDirectoryClient throws error on HTTP 500 in appRoleAssignments rather than deprovisioning user', async () => {
    let origClientId = process.env.MMS_ENTRA_CLIENT_ID
    let origSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    process.env.MMS_ENTRA_CLIENT_ID = 'test-client'
    process.env.MMS_ENTRA_CLIENT_SECRET = 'test-secret'

    let origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      let urlStr = String(input)
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/users/') && !urlStr.includes('/appRoleAssignments')) {
        return new Response(JSON.stringify({
          id: user1Oid,
          accountEnabled: true,
          deletedDateTime: null,
          userPrincipalName: 'user@example.com',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/appRoleAssignments')) {
        // Microsoft Graph internal server error
        return new Response(JSON.stringify({ error: { code: 'InternalServerError' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    try {
      let client = new DefaultEntraDirectoryClient()
      await assert.rejects(
        async () => {
          await client.getUserStatus(testTenantId, user1Oid)
        },
        /Failed to fetch Entra app role assignments for user.*500/,
        'API 500 error must throw, not silently mark role revoked',
      )
    } finally {
      globalThis.fetch = origFetch
      if (origClientId) process.env.MMS_ENTRA_CLIENT_ID = origClientId
      else delete process.env.MMS_ENTRA_CLIENT_ID
      if (origSecret) process.env.MMS_ENTRA_CLIENT_SECRET = origSecret
      else delete process.env.MMS_ENTRA_CLIENT_SECRET
    }
  })

  it('Flow 17: DefaultEntraDirectoryClient dynamically resolves app role GUID from Service Principal', async () => {
    let origClientId = process.env.MMS_ENTRA_CLIENT_ID
    let origSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    process.env.MMS_ENTRA_CLIENT_ID = 'test-client'
    process.env.MMS_ENTRA_CLIENT_SECRET = 'test-secret'

    const roleGuid = '12345678-abcd-1234-abcd-123456789012'

    let origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      let urlStr = String(input)
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/servicePrincipals')) {
        return new Response(JSON.stringify({
          value: [{
            id: 'sp-1',
            appRoles: [{
              id: roleGuid,
              value: 'MMS.User',
              displayName: 'MMS User',
            }],
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/users/') && !urlStr.includes('/appRoleAssignments')) {
        return new Response(JSON.stringify({
          id: user1Oid,
          accountEnabled: true,
          deletedDateTime: null,
          userPrincipalName: 'user@example.com',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/appRoleAssignments')) {
        return new Response(JSON.stringify({
          value: [{
            appRoleId: roleGuid, // Real Graph returns GUID!
            resourceDisplayName: 'MMS Application', // Real Graph returns App Name!
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    try {
      let client = new DefaultEntraDirectoryClient()
      let status = await client.getUserStatus(testTenantId, user1Oid)
      assert.equal(status.exists, true)
      assert.equal(status.accountEnabled, true)
      assert.equal(status.hasMmsUserRole, true, 'role GUID matched via service principal discovery')
    } finally {
      globalThis.fetch = origFetch
      if (origClientId) process.env.MMS_ENTRA_CLIENT_ID = origClientId
      else delete process.env.MMS_ENTRA_CLIENT_ID
      if (origSecret) process.env.MMS_ENTRA_CLIENT_SECRET = origSecret
      else delete process.env.MMS_ENTRA_CLIENT_SECRET
    }
  })

  it('P0.3: DefaultEntraDirectoryClient preserves jobTitle, department, and officeLocation for active users', async () => {
    let origClientId = process.env.MMS_ENTRA_CLIENT_ID
    let origSecret = process.env.MMS_ENTRA_CLIENT_SECRET
    process.env.MMS_ENTRA_CLIENT_ID = 'test-client'
    process.env.MMS_ENTRA_CLIENT_SECRET = 'test-secret'

    let origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      let urlStr = String(input)
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlStr.includes('/appRoleAssignments')) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'assignment-1',
                appRoleId: 'MMS.User',
                resourceDisplayName: 'MMS.User',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (urlStr.includes('/users/')) {
        return new Response(
          JSON.stringify({
            id: user1Oid,
            accountEnabled: true,
            deletedDateTime: null,
            userPrincipalName: 'active_staff@example.com',
            jobTitle: 'Senior Marine Surveyor',
            department: 'Marine Safety & Inspection',
            officeLocation: 'Rotterdam Port',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    }

    try {
      let client = new DefaultEntraDirectoryClient()
      let status = await client.getUserStatus(testTenantId, user1Oid)
      assert.equal(status.exists, true)
      assert.equal(status.accountEnabled, true)
      assert.equal(status.hasMmsUserRole, true)
      assert.equal(status.deleted, false)
      assert.equal(status.userPrincipalName, 'active_staff@example.com')
      assert.equal(status.jobTitle, 'Senior Marine Surveyor')
      assert.equal(status.department, 'Marine Safety & Inspection')
      assert.equal(status.officeLocation, 'Rotterdam Port')
    } finally {
      globalThis.fetch = origFetch
      if (origClientId) process.env.MMS_ENTRA_CLIENT_ID = origClientId
      else delete process.env.MMS_ENTRA_CLIENT_ID
      if (origSecret) process.env.MMS_ENTRA_CLIENT_SECRET = origSecret
      else delete process.env.MMS_ENTRA_CLIENT_SECRET
    }
  })

  it('Flow 18: checkAndRunOverdueEntraSync triggers immediate synchronization when overdue', async () => {
    // Insert an old clean sync run from 25 hours ago
    await adminPool.query(`
      insert into audit_trail.entra_sync_run (run_at, status, users_checked, users_deprovisioned)
      values (now() - interval '25 hours', 'clean', 1, 0)
    `)

    let syncRan = false
    mockDirectory.setUserStatus(testTenantId, user1Oid, { exists: true, accountEnabled: true, hasMmsUserRole: true })
    let origGet = mockDirectory.getUserStatus.bind(mockDirectory)
    mockDirectory.getUserStatus = async (tid, oid) => {
      syncRan = true
      return origGet(tid, oid)
    }

    await checkAndRunOverdueEntraSync(0)
    assert.equal(syncRan, true, 'overdue sync was triggered on startup')
  })

  it('Flow 19: a staff member with no position and directory attributes is staged as a proposal, never placed', async () => {
    // A fresh staff member with no position and a directory job title.
    await adminPool.query(`
      insert into iam.app_user (id, kind, display_name, email, entra_tenant_id, entra_object_id, status)
      values ($1, 'internal', 'H13 New Starter', 'new.starter.h19@mms.example.com', $2, $3, 'active')
    `, [user2Id, testTenantId, user2Oid])

    mockDirectory.setUserStatus(testTenantId, user2Oid, {
      exists: true,
      accountEnabled: true,
      hasMmsUserRole: true,
      deleted: false,
      jobTitle: 'Senior Surveyor (Asia)',
      department: 'Survey',
      officeLocation: 'SHA',
    })

    let result = await runEntraDeprovisionSync()

    assert.ok(result.proposalsStaged.includes(user2Id), 'the directory sync staged a proposal for the new staff member')
    assert.equal(result.deprovisionedUserIds.length, 0, 'no deprovisioning happened')
    assert.equal(result.status, 'clean')

    // The proposal carries the raw attributes; nothing is mapped to a position yet.
    let props = await adminPool.query<{
      job_title_code: string | null
      entra_job_title: string | null
      entra_department: string | null
      entra_office: string | null
      status: string
    }>(`select job_title_code, entra_job_title, entra_department, entra_office, status
           from iam.position_proposal where user_id = $1`, [user2Id])
    assert.equal(props.rows.length, 1, 'exactly one proposal exists')
    assert.equal(props.rows[0].status, 'pending')
    assert.equal(props.rows[0].entra_job_title, 'Senior Surveyor (Asia)')
    assert.equal(props.rows[0].entra_department, 'Survey')
    assert.equal(props.rows[0].entra_office, 'SHA')
    // The unmapped title stays unmapped until a human confirms it (exact codes only).
    assert.equal(props.rows[0].job_title_code, null)

    // No staff position may be created by the sync.
    let pos = await adminPool.query<{ count: bigint }>(
      'select count(*)::bigint as count from iam.staff_position where user_id = $1',
      [user2Id],
    )
    assert.equal(String(pos.rows[0].count), '0')
  })

})

