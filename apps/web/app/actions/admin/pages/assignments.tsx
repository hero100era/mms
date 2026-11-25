import type { Handle } from 'remix/component'
import type { StaffAssignmentRow } from '@mms/pgrst-client'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import type { UnitOption, UserRow } from './positions.tsx'

export type AssignmentRow = StaffAssignmentRow

export type AssignmentsProps = {
  csrf: string
  error?: string
  assignments: AssignmentRow[]
  users: UserRow[]
  grantableRoles?: { role_name: string; description: string }[]
  units?: UnitOption[]
  values?: {
    user_id?: string
    db_role?: string
    scope_type?: string
    scope_unit_id?: string
    reason?: string
  }
}

export function AssignmentsPage(handle: Handle<AssignmentsProps>) {
  return () => {
    let units = handle.props.units ?? []
    let unitMap = new Map(units.map((u) => [u.id, u]))

    return (
      <Document title="Assignments">
        <main>
          <h1>Role assignments</h1>
          <p>
            <a href={routes.session.home.href()}>Home</a> | <a href={routes.admin.positions.href()}>Positions</a>
          </p>
          {handle.props.error ? <p role="alert">{handle.props.error}</p> : null}
          <form method="post" action={routes.admin.assignmentGrant.href()}>
            <input type="hidden" name="_csrf" value={handle.props.csrf} />
            <p>
              <label>
                User
                <select name="user_id" required>
                  {handle.props.users.map((u) => (
                    <option key={u.id} value={u.id} selected={handle.props.values?.user_id === u.id}>
                      {u.display_name} ({u.status})
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Role
                <select name="db_role" required>
                  {(handle.props.grantableRoles ?? []).map((r) => (
                    <option key={r.role_name} value={r.role_name} selected={handle.props.values?.db_role === r.role_name}>
                      {r.role_name} — {r.description}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Scope type
                <select name="scope_type" required>
                  <option value="global" selected={handle.props.values?.scope_type === 'global'}>global</option>
                  <option value="unit" selected={handle.props.values?.scope_type === 'unit'}>unit</option>
                </select>
              </label>
            </p>
            <p>
              <label>
                Scope unit (required for unit scope)
                <select name="scope_unit_id">
                  <option value="">(None / Global scope)</option>
                  {units.map((u) => (
                    <option
                      key={u.id}
                      value={u.id}
                      selected={handle.props.values?.scope_unit_id === u.id}
                    >
                      {u.code} — {u.name} ({u.unit_type}{u.region_code ? `, ${u.region_code}` : ''})
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Reason
                <input name="reason" required minLength={5} placeholder="Reason for granting role" defaultValue={handle.props.values?.reason ?? ''} />
              </label>
            </p>
            <button type="submit">Grant</button>
          </form>
          <h2>Assignments</h2>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Source</th>
                <th>Revoked</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {handle.props.assignments.map((a) => {
                let u = a.scope_unit_id ? unitMap.get(a.scope_unit_id) : null
                let scopeLabel =
                  a.scope_type === 'unit'
                    ? `unit: ${u ? `${u.code} (${u.name})` : a.scope_unit_id}`
                    : 'global'

                return (
                  <tr key={a.id}>
                    <td>{a.display_name}</td>
                    <td>{a.db_role}</td>
                    <td>{scopeLabel}</td>
                    <td>{a.source}</td>
                    <td>{a.revoked_at ?? ''}</td>
                    <td>
                      {a.revoked_at ? null : (
                        <form method="post" action={routes.admin.assignmentRevoke.href()}>
                          <input type="hidden" name="_csrf" value={handle.props.csrf} />
                          <input type="hidden" name="id" value={a.id} />
                          <label>
                            Revocation reason:
                            <input
                              type="text"
                              name="reason"
                              placeholder="Reason for revoking role"
                              required
                              minLength={5}
                            />
                          </label>
                          <button type="submit">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </main>
      </Document>
    )
  }
}
