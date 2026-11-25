import type { Handle } from 'remix/component'
import type {
  PositionJobTitleRow,
  PositionUnitRow,
  StaffDirectoryRow,
  StaffPositionRow,
} from '@mms/pgrst-client'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'

export type PositionRow = StaffPositionRow
export type UserRow = StaffDirectoryRow
export type UnitOption = PositionUnitRow
export type JobTitleOption = PositionJobTitleRow

export type PositionsProps = {
  csrf: string
  error?: string
  positions: PositionRow[]
  users: UserRow[]
  units?: UnitOption[]
  jobTitles?: JobTitleOption[]
  values?: {
    user_id?: string
    job_title_code?: string
    unit_id?: string
    family_override?: string
    line_manager_id?: string
    reason?: string
  }
}

export function PositionsPage(handle: Handle<PositionsProps>) {
  return () => {
    let units = handle.props.units ?? []
    let jobTitles = handle.props.jobTitles ?? []
    let unitMap = new Map(units.map((u) => [u.id, u]))

    return (
      <Document title="Positions">
        <main>
          <h1>Staff positions</h1>
          <p>
            <a href={routes.session.home.href()}>Home</a> | <a href={routes.admin.assignments.href()}>Assignments</a>
          </p>
          {handle.props.error ? <p role="alert">{handle.props.error}</p> : null}
          <form method="post" action={routes.admin.positionSet.href()}>
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
                Job title
                <select name="job_title_code" required>
                  <option value="">Select job title...</option>
                  {jobTitles.map((t) => (
                    <option
                      key={t.code}
                      value={t.code}
                      selected={handle.props.values?.job_title_code === t.code}
                    >
                      {t.label_en ?? t.code} ({t.code}, {t.job_family}, grade {t.grade})
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Organizational unit
                <select name="unit_id" required>
                  <option value="">Select organizational unit...</option>
                  {units.map((u) => (
                    <option
                      key={u.id}
                      value={u.id}
                      selected={handle.props.values?.unit_id === u.id}
                    >
                      {u.code} — {u.name} ({u.unit_type}{u.region_code ? `, ${u.region_code}` : ''})
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Family override (optional)
                <input name="family_override" placeholder="mts" defaultValue={handle.props.values?.family_override ?? ''} />
              </label>
            </p>
            <p>
              <label>
                Line manager (optional)
                <select name="line_manager_id">
                  <option value="">None</option>
                  {handle.props.users.map((u) => (
                    <option key={u.id} value={u.id} selected={handle.props.values?.line_manager_id === u.id}>
                      {u.display_name} ({u.status})
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Reason
                <input name="reason" required minLength={5} placeholder="Reason for position assignment" defaultValue={handle.props.values?.reason ?? ''} />
              </label>
            </p>
            <button type="submit">Set position</button>
          </form>
          <h2>Current positions</h2>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Title</th>
                <th>Family</th>
                <th>Unit</th>
                <th>Valid</th>
              </tr>
            </thead>
            <tbody>
              {handle.props.positions.map((p) => {
                let u = unitMap.get(p.unit_id)
                return (
                  <tr key={p.id}>
                    <td>{p.display_name}</td>
                    <td>{p.job_title_code}</td>
                    <td>{p.job_family}</td>
                    <td>{u ? `${u.code} — ${u.name}` : p.unit_id}</td>
                    <td>{p.valid}</td>
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
