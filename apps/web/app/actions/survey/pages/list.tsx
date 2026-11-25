import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import type { SurveyListProps } from '../types.ts'

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '64rem', margin: '2rem auto', padding: '0 1rem' })
const headerFlexStyle = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid #ddd', paddingBottom: '1rem' })
const headerTitleStyle = css({ margin: 0 })
const headerSubtitleStyle = css({ margin: '0.25rem 0 0', color: '#666' })
const newSurveyButtonStyle = css({
  display: 'inline-block',
  backgroundColor: '#0d6efd',
  color: '#fff',
  textDecoration: 'none',
  padding: '0.5rem 1rem',
  borderRadius: '4px',
  fontWeight: 'bold',
})
const triageQueueButtonStyle = css({
  display: 'inline-block',
  marginLeft: '0.75rem',
  backgroundColor: '#198754',
  color: '#fff',
  textDecoration: 'none',
  padding: '0.5rem 1rem',
  borderRadius: '4px',
  fontWeight: 'bold',
})
const successBannerStyle = css({ padding: '0.75rem', background: '#d1e7dd', color: '#0f5132', borderRadius: '4px' })
const errorBannerStyle = css({ padding: '0.75rem', background: '#f8d7da', color: '#842029', borderRadius: '4px' })
const requestsSectionStyle = css({ marginBottom: '2.5rem' })
const emptyContainerStyle = css({ padding: '2rem', border: '1px dashed #ccc', textAlign: 'center', borderRadius: '6px' })
const emptyTextStyle = css({ margin: 0, color: '#666' })
const emptyActionStyle = css({ marginTop: '0.5rem' })
const tableStyle = css({ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginTop: '1rem' })
const tableHeaderRowStyle = css({ borderBottom: '2px solid #333' })
const tableHeaderCellStyle = css({ padding: '0.6rem 0.5rem' })
const tableRowStyle = css({ borderBottom: '1px solid #eee' })
const tableCellBoldStyle = css({ padding: '0.6rem 0.5rem', fontWeight: 'bold' })
const tableCellStyle = css({ padding: '0.6rem 0.5rem' })
const subTextStyle = css({ fontSize: '0.8rem', color: '#666' })
const tableCellDateStyle = css({ padding: '0.6rem 0.5rem', fontSize: '0.85rem' })
const actionLinkStyle = css({
  padding: '0.25rem 0.6rem',
  border: '1px solid #0d6efd',
  color: '#0d6efd',
  borderRadius: '3px',
  textDecoration: 'none',
  fontSize: '0.85rem',
})
const fleetSectionStyle = css({ borderTop: '1px solid #eee', paddingTop: '1.5rem' })
const fleetSubtitleStyle = css({ fontSize: '0.9rem', color: '#666' })
const noFleetTextStyle = css({ color: '#888' })
const fleetGridStyle = css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))', gap: '1rem', marginTop: '0.75rem' })
const fleetCardStyle = css({ padding: '0.75rem 1rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fafafa' })
const vesselNameStyle = css({ fontWeight: 'bold' })
const vesselDetailsStyle = css({ fontSize: '0.85rem', color: '#555', marginTop: '0.25rem' })
const vesselSubDetailsStyle = css({ fontSize: '0.8rem', color: '#777', marginTop: '0.25rem' })

export function SurveyListPage(handle: Handle<SurveyListProps>) {
  return () => {
    let { csrf, role, requests, ships, message, error } = handle.props
    let isInternal = role.startsWith('int_')

    return (
      <Document title="Survey Requests">
        <main mix={mainContainerStyle}>
          <header mix={headerFlexStyle}>
            <div>
              <h1 mix={headerTitleStyle}>Survey Requests</h1>
              <p mix={headerSubtitleStyle}>
                Manage class and statutory survey requests for your fleet.
              </p>
            </div>
            <div>
              <a
                href={routes.survey.new.href()}
                mix={newSurveyButtonStyle}
              >
                + New Survey Request
              </a>
              {isInternal ? (
                <a
                  href={routes.triage.queue.href()}
                  mix={triageQueueButtonStyle}
                >
                  Station Triage Queue &rarr;
                </a>
              ) : null}
            </div>
          </header>

          {message ? <p role="status" mix={successBannerStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorBannerStyle}>{error}</p> : null}

          {/* Existing requests table */}
          <section mix={requestsSectionStyle}>
            <h2>Your Requests</h2>
            {requests.length === 0 ? (
              <div mix={emptyContainerStyle}>
                <p mix={emptyTextStyle}>No survey requests found.</p>
                <p mix={emptyActionStyle}>
                  <a href={routes.survey.new.href()}>Create a survey request</a> to schedule attendance with a classification station.
                </p>
              </div>
            ) : (
              <table mix={tableStyle}>
                <thead>
                  <tr mix={tableHeaderRowStyle}>
                    <th mix={tableHeaderCellStyle}>Request No</th>
                    <th mix={tableHeaderCellStyle}>Vessel</th>
                    <th mix={tableHeaderCellStyle}>Port</th>
                    <th mix={tableHeaderCellStyle}>Dates</th>
                    <th mix={tableHeaderCellStyle}>Attending Station</th>
                    <th mix={tableHeaderCellStyle}>Status</th>
                    <th mix={tableHeaderCellStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} mix={tableRowStyle}>
                      <td mix={tableCellBoldStyle}>
                        <a href={routes.survey.detail.href({ id: r.id })}>{r.request_no}</a>
                      </td>
                      <td mix={tableCellStyle}>
                        {r.ship_name} <span mix={subTextStyle}>({r.ship_imo_number})</span>
                      </td>
                      <td mix={tableCellStyle}>{r.port_name}</td>
                      <td mix={tableCellDateStyle}>
                        {new Date(r.estimated_arrival).toLocaleDateString()} &ndash; {new Date(r.estimated_departure).toLocaleDateString()}
                      </td>
                      <td mix={tableCellStyle}>{r.station_name}</td>
                      <td mix={tableCellStyle}>
                        <StatusBadge status={r.status} />
                      </td>
                      <td mix={tableCellStyle}>
                        <a
                          href={routes.survey.detail.href({ id: r.id })}
                          mix={actionLinkStyle}
                        >
                          View / Submit
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Affiliated fleet info */}
          <section mix={fleetSectionStyle}>
            <h3>Affiliated Fleet Vessels</h3>
            <p mix={fleetSubtitleStyle}>
              Vessels registered to your organization eligible for survey requests:
            </p>
            {ships.length === 0 ? (
              <p mix={noFleetTextStyle}>No fleet vessels currently registered with active affiliation.</p>
            ) : (
              <div mix={fleetGridStyle}>
                {ships.map((s) => (
                  <div key={s.id} mix={fleetCardStyle}>
                    <div mix={vesselNameStyle}>{s.name}</div>
                    <div mix={vesselDetailsStyle}>
                      IMO: {s.imo_number} | Flag: {s.flag_code} | Type: {s.ship_type}
                    </div>
                    <div mix={vesselSubDetailsStyle}>
                      GT: {s.gross_tonnage?.toLocaleString() ?? '—'} | Built: {s.build_year}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      </Document>
    )
  }
}
