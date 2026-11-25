import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import type { TriageQueueProps } from '../types.ts'

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '68rem', margin: '2rem auto', padding: '0 1rem' })
const headerFlexStyle = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid #ddd', paddingBottom: '1rem' })
const headerTitleStyle = css({ margin: 0 })
const headerSubtitleStyle = css({ margin: '0.25rem 0 0', color: '#666' })
const navLinkMarginStyle = css({ marginRight: '1rem' })
const successBannerStyle = css({ padding: '0.75rem', background: '#d1e7dd', color: '#0f5132', borderRadius: '4px' })
const errorBannerStyle = css({ padding: '0.75rem', background: '#f8d7da', color: '#842029', borderRadius: '4px' })
const filterTabsContainerStyle = css({ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' })
const tabActiveStyle = css({
  padding: '0.4rem 0.8rem',
  borderRadius: '4px',
  textDecoration: 'none',
  fontWeight: 'bold',
  backgroundColor: '#0d6efd',
  color: '#fff',
  border: '1px solid #ccc',
})
const tabInactiveStyle = css({
  padding: '0.4rem 0.8rem',
  borderRadius: '4px',
  textDecoration: 'none',
  fontWeight: 'normal',
  backgroundColor: '#f8f9fa',
  color: '#333',
  border: '1px solid #ccc',
})
const emptyStateContainerStyle = css({ padding: '2rem', border: '1px dashed #ccc', textAlign: 'center', borderRadius: '6px' })
const emptyStateTextStyle = css({ margin: 0, color: '#666' })
const tableStyle = css({ width: '100%', borderCollapse: 'collapse', textAlign: 'left' })
const tableHeaderRowStyle = css({ borderBottom: '2px solid #333' })
const tableHeaderCellStyle = css({ padding: '0.6rem 0.5rem' })
const rowPendingStyle = css({ borderBottom: '1px solid #eee', background: '#fffdf0' })
const rowDefaultStyle = css({ borderBottom: '1px solid #eee', background: 'transparent' })
const tableCellBoldStyle = css({ padding: '0.6rem 0.5rem', fontWeight: 'bold' })
const tableCellStyle = css({ padding: '0.6rem 0.5rem' })
const subTextStyle = css({ fontSize: '0.8rem', color: '#666' })
const tableCellDateStyle = css({ padding: '0.6rem 0.5rem', fontSize: '0.85rem' })
const actionPendingStyle = css({
  padding: '0.3rem 0.7rem',
  backgroundColor: '#0d6efd',
  color: '#fff',
  textDecoration: 'none',
  borderRadius: '3px',
  fontSize: '0.85rem',
  fontWeight: 'bold',
})
const actionDefaultStyle = css({
  padding: '0.3rem 0.7rem',
  backgroundColor: '#6c757d',
  color: '#fff',
  textDecoration: 'none',
  borderRadius: '3px',
  fontSize: '0.85rem',
  fontWeight: 'bold',
})

export function TriageQueuePage(handle: Handle<TriageQueueProps>) {
  return () => {
    let { csrf, role, requests, currentFilter, message, error } = handle.props
    let isPrivileged = ['int_coordinator', 'int_manager'].includes(role)

    return (
      <Document title="Station Triage Queue">
        <main mix={mainContainerStyle}>
          <header mix={headerFlexStyle}>
            <div>
              <h1 mix={headerTitleStyle}>Station Triage Queue</h1>
              <p mix={headerSubtitleStyle}>
                Operational intake, triage, and transfer of survey requests within station coverage.
              </p>
            </div>
            <div>
              <a href={routes.survey.index.href()} mix={navLinkMarginStyle}>Fleet View</a>
              <a href={routes.session.profile.href()}>Profile</a>
            </div>
          </header>

          {message ? <p role="status" mix={successBannerStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorBannerStyle}>{error}</p> : null}

          {/* Filter tabs */}
          <div mix={filterTabsContainerStyle}>
            {[
              { id: 'all', label: 'All Requests' },
              { id: 'submitted', label: '📥 Intake Queue (Submitted)' },
              { id: 'clarification_requested', label: '⏳ In Clarification' },
              { id: 'accepted', label: '✅ Accepted' },
              { id: 'rejected', label: '❌ Rejected' },
            ].map((tab) => {
              let active = currentFilter === tab.id
              let href = tab.id === 'all' ? routes.triage.queue.href() : `${routes.triage.queue.href()}?status=${tab.id}`
              return (
                <a
                  key={tab.id}
                  href={href}
                  mix={active ? tabActiveStyle : tabInactiveStyle}
                >
                  {tab.label}
                </a>
              )
            })}
          </div>

          {/* Queue table */}
          {requests.length === 0 ? (
            <div mix={emptyStateContainerStyle}>
              <p mix={emptyStateTextStyle}>No survey requests found in this triage view.</p>
            </div>
          ) : (
            <table mix={tableStyle}>
              <thead>
                <tr mix={tableHeaderRowStyle}>
                  <th mix={tableHeaderCellStyle}>Request No</th>
                  <th mix={tableHeaderCellStyle}>Vessel</th>
                  <th mix={tableHeaderCellStyle}>Requesting Org</th>
                  <th mix={tableHeaderCellStyle}>Station</th>
                  <th mix={tableHeaderCellStyle}>Port</th>
                  <th mix={tableHeaderCellStyle}>Dates</th>
                  <th mix={tableHeaderCellStyle}>Status</th>
                  <th mix={tableHeaderCellStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  let isPending = r.status === 'submitted'
                  return (
                    <tr key={r.id} mix={isPending ? rowPendingStyle : rowDefaultStyle}>
                      <td mix={tableCellBoldStyle}>
                        <a href={routes.triage.detail.href({ id: r.id })}>{r.request_no}</a>
                      </td>
                      <td mix={tableCellStyle}>
                        {r.ship_name} <span mix={subTextStyle}>({r.ship_imo_number})</span>
                      </td>
                      <td mix={tableCellStyle}>{r.org_name}</td>
                      <td mix={tableCellStyle}>{r.station_name}</td>
                      <td mix={tableCellStyle}>{r.port_name}</td>
                      <td mix={tableCellDateStyle}>
                        {new Date(r.estimated_arrival).toLocaleDateString()} &ndash; {new Date(r.estimated_departure).toLocaleDateString()}
                      </td>
                      <td mix={tableCellStyle}>
                        <StatusBadge status={r.status} />
                      </td>
                      <td mix={tableCellStyle}>
                        <a
                          href={routes.triage.detail.href({ id: r.id })}
                          mix={isPending ? actionPendingStyle : actionDefaultStyle}
                        >
                          {isPending && isPrivileged ? 'Triage Decision &rarr;' : 'Review Details'}
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </main>
      </Document>
    )
  }
}
