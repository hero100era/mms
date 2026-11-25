import type { Handle } from 'remix/component'
import type { PositionProposalRow } from '@mms/pgrst-client'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'

export type ProposalRow = PositionProposalRow

export type PositionProposalsProps = {
  csrf: string
  error?: string
  proposals: ProposalRow[]
  jobTitles: { code: string; label_en: string }[]
  units: { id: string; code: string; name: string }[]
}

/**
 * Card H-13: the queue of positions the directory suggests and HR has not decided yet.
 * The submitted form fields are prefilled with the guess, so confirming an unmapped
 * proposal means typing a title and a unit; confirming a mapped one means only giving a
 * reason. The sync never writes a position itself.
 */
export function PositionProposalsPage(handle: Handle<PositionProposalsProps>) {
  return () => (
    <Document title="Position proposals">
      <main>
        <h1>Position proposals</h1>
        <p>
          <a href={routes.session.home.href()}>Home</a> | 
          <a href={routes.admin.positions.href()}>Positions</a>
        </p>
        <p>
          Proposed by the directory sync from job title, department and office. Nothing
          here is a position until you confirm it.
        </p>
        {handle.props.error ? <p role="alert">{handle.props.error}</p> : null}
        {handle.props.proposals.length === 0 ? (
          <p>No proposals waiting.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Directory</th>
                <th>Proposed as</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {handle.props.proposals.map((p) => (
                <tr key={p.id}>
                  <td>{p.display_name}</td>
                  <td>
                    {p.entra_job_title ?? 'no title'} / {p.entra_department ?? 'no department'} /
                    {' '}
                    {p.entra_office ?? 'no office'}
                  </td>
                  <td>
                    {p.job_title_label ?? 'unmapped title'} at {p.unit_name ?? 'unmapped unit'}
                  </td>
                  <td>{p.source}</td>
                  <td>
                    <form method="post" action={routes.admin.proposals.confirm.href()}>
                      <input type="hidden" name="_csrf" value={handle.props.csrf} />
                      <input type="hidden" name="id" value={p.id} />
                      <p>
                        <label>
                          Job title
                          <select name="job_title_code" required>
                            {handle.props.jobTitles.map((t) => (
                              <option key={t.code} value={t.code} selected={t.code === p.job_title_code}>
                                {t.code}
                              </option>
                            ))}
                          </select>
                        </label>
                      </p>
                      <p>
                        <label>
                          Unit
                          <select name="unit_id" required>
                            {handle.props.units.map((u) => (
                              <option key={u.id} value={u.id} selected={u.code === p.unit_code}>
                                {u.code} {u.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </p>
                      <p>
                        <label>
                          Reason
                          <input name="reason" required />
                        </label>
                      </p>
                      <button type="submit">Confirm</button>
                    </form>
                    <form method="post" action={routes.admin.proposals.reject.href()}>
                      <input type="hidden" name="_csrf" value={handle.props.csrf} />
                      <input type="hidden" name="id" value={p.id} />
                      <p>
                        <label>
                          Reason
                          <input name="reason" required />
                        </label>
                      </p>
                      <button type="submit">Reject</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </Document>
  )
}
