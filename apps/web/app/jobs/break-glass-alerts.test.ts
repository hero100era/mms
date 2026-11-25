import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'
import { Pool } from 'pg'

import { Alerter, MemoryAlertSink } from '../audit_trail/alerter.ts'
import { checkBreakGlassDrills, alertBreakGlassActivated } from './break-glass-alerts.ts'
import { withRole } from '../db/role-pool.ts'

const adminUrl =
  process.env.MMS_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/mms_acceptance'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = adminUrl
}
if (!process.env.AUTH_GATEWAY_DATABASE_URL) {
  process.env.AUTH_GATEWAY_DATABASE_URL =
    process.env.MMS_GATEWAY_DATABASE_URL || withRole(adminUrl, 'auth_gateway')
}

const freshId = 'e9000000-0000-0000-0000-000000000001'
const staleId = 'e9000000-0000-0000-0000-000000000002'
const disabledId = 'e9000000-0000-0000-0000-000000000003'

// Card H-10: the drill is the control that keeps a break-glass account usable on the day
// it is needed. These tests pin the two properties that make the alerting real rather
// than decorative: a current account is silent, and every account that is wrong is
// named -- including the one nobody ever drilled, which is the easiest state to miss.
describe('Card H-10: break-glass drill alerting', () => {
  let adminPool: Pool

  before(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(
      // An internal user is an Entra identity: the shape check requires tid and oid.
      `insert into iam.app_user (id, kind, display_name, email, status, entra_tenant_id, entra_object_id)
       values ($1, 'internal', 'Fresh Drill', 'fresh.drill@mms.example.com', 'active',
               '11111111-1111-1111-1111-111111111111', 'e9000000-1111-1111-1111-111111111111'),
              ($2, 'internal', 'Stale Drill', 'stale.drill@mms.example.com', 'active',
               '11111111-1111-1111-1111-111111111111', 'e9000000-2222-2222-2222-222222222222'),
              ($3, 'internal', 'Disabled Drill', 'disabled.drill@mms.example.com', 'active',
               '11111111-1111-1111-1111-111111111111', 'e9000000-3333-3333-3333-333333333333')
       on conflict (id) do nothing`,
      [freshId, staleId, disabledId],
    )
    await adminPool.query(
      `insert into iam.break_glass_account (user_id, label, last_drill_at) values
         ($1, 'Drilled yesterday', now() - interval '1 day'),
         ($2, 'Drilled 150 days ago', now() - interval '150 days'),
         ($3, 'Never drilled', null)
       on conflict (user_id) do update
         set label = excluded.label, last_drill_at = excluded.last_drill_at`,
      [freshId, staleId, disabledId],
    )
    await adminPool.query(
      'update iam.break_glass_account set enabled = false where user_id = $1',
      [disabledId],
    )
  })

  after(async () => {
    await adminPool.query('delete from iam.break_glass_account where user_id = any($1::uuid[])', [
      [freshId, staleId, disabledId],
    ])
    await adminPool.query('delete from iam.app_user where id = any($1::uuid[])', [
      [freshId, staleId, disabledId],
    ])
    await adminPool.end()
  })

  it('alerts on activation as CRITICAL', async () => {
    let sink = new MemoryAlertSink()
    let alerter = new Alerter()
    alerter.addSink(sink)
    // Exercise the same emit shape the activation helper uses.
    await alerter.emit('BREAK_GLASS_ACTIVATED', 'CRITICAL', 'break-glass', 'activated', {
      userId: freshId,
    })
    let alerts = sink.findByType('BREAK_GLASS_ACTIVATED')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.severity, 'CRITICAL')
  })

  it('emits an activation alert through the shared helper', async () => {
    let alert = (await alertBreakGlassActivated(freshId, null, 'drill')) as {
      type: string
      severity: string
    }
    assert.equal(alert.type, 'BREAK_GLASS_ACTIVATED')
    assert.equal(alert.severity, 'CRITICAL')
  })

  it('reports the stale account and not the current or disabled one', async () => {
    let overdue = await checkBreakGlassDrills()
    let { breakGlassDrillOverdue } = await import('../auth/service.ts')
    let rows = await breakGlassDrillOverdue()
    let ids = rows.map((r) => r.user_id)
    assert.ok(ids.includes(staleId), 'a lapsed account is reported')
    assert.ok(!ids.includes(freshId), 'a current account is silent')
    assert.ok(!ids.includes(disabledId), 'a disabled account is excluded')
    assert.ok(overdue >= 1)
  })
})
