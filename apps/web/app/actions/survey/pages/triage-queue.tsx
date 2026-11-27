import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import {
  actionGroupStyle,
  alertBannerStyle,
  breadcrumbNavStyle,
  compactActionLinkStyle,
  countPillStyle,
  dataTableStyle,
  emptyStateStyle,
  heroHeaderStyle,
  heroSubtitleStyle,
  heroTitleStyle,
  monoTextStyle,
  pageShellStyle,
  panelCardStyle,
  secondaryLinkButtonStyle,
  sectionHeaderRowStyle,
  sectionTitleStyle,
  subMetaStyle,
  successBannerStyle,
  tableCaptionStyle,
  tableHeadStyle,
  tableRegionStyle,
  tableTdBoldStyle,
  tableTdStyle,
  tableThStyle,
  tableTrStyle,
} from '../../theme.ts'
import { routes } from '../../../routes.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import type { TriageQueueProps } from '../types.ts'

const filterTabsContainerStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginBottom: '1.25rem',
})
const tabActiveStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  minBlockSize: '34px',
  padding: '0.4rem 0.85rem',
  borderRadius: '999px',
  textDecoration: 'none',
  fontWeight: 600,
  fontSize: '0.88rem',
  backgroundColor: 'var(--accent)',
  color: 'var(--accent-ink)',
  border: '1px solid var(--accent)',
})
const tabInactiveStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  minBlockSize: '34px',
  padding: '0.4rem 0.85rem',
  borderRadius: '999px',
  textDecoration: 'none',
  fontWeight: 500,
  fontSize: '0.88rem',
  backgroundColor: 'var(--panel)',
  color: 'var(--ink)',
  border: '1px solid var(--line-strong)',
  '&:hover': { backgroundColor: 'var(--row-hover)' },
})
const pendingRowStyle = css({
  backgroundColor: 'var(--accent-soft)',
  '&:hover': { backgroundColor: 'var(--row-hover)' },
  '&:last-child td': { borderBottom: 'none' },
})

export function TriageQueuePage(handle: Handle<TriageQueueProps>) {
  return () => {
    let { role, requests, currentFilter, message, error } = handle.props
    let isPrivileged = ['int_coordinator', 'int_manager'].includes(role)

    return (
      <Document title="Station Triage Queue | MMS">
        <main mix={pageShellStyle}>
          <nav aria-label="Breadcrumb" mix={breadcrumbNavStyle}>
            <a href={routes.session.home.href()}>Home</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Station Triage Queue</span>
            <span aria-hidden="true">&middot;</span>
            <a href={routes.ships.index.href()}>Fleet Vessels</a>
          </nav>

          <header mix={heroHeaderStyle}>
            <div>
              <h1 mix={heroTitleStyle}>Station Triage Queue</h1>
              <p mix={heroSubtitleStyle}>
                Operational intake, triage, and transfer of survey requests within station coverage.
              </p>
            </div>
            <div mix={actionGroupStyle}>
              <a href={routes.survey.index.href()} mix={secondaryLinkButtonStyle}>
                Fleet View
              </a>
              <a href={routes.session.profile.href()} mix={secondaryLinkButtonStyle}>
                Profile
              </a>
            </div>
          </header>

          {message ? (
            <p role="status" mix={successBannerStyle}>
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" mix={alertBannerStyle}>
              {error}
            </p>
          ) : null}

          <nav aria-label="Queue status filter" mix={filterTabsContainerStyle}>
            {[
              { id: 'all', label: 'All Requests' },
              { id: 'submitted', label: 'Intake Queue (Submitted)' },
              { id: 'clarification_requested', label: 'In Clarification' },
              { id: 'accepted', label: 'Accepted' },
              { id: 'rejected', label: 'Rejected' },
            ].map((tab) => {
              let active = currentFilter === tab.id
              let href =
                tab.id === 'all'
                  ? routes.triage.queue.href()
                  : `${routes.triage.queue.href()}?status=${tab.id}`
              return (
                <a
                  key={tab.id}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  mix={active ? tabActiveStyle : tabInactiveStyle}
                >
                  {tab.label}
                </a>
              )
            })}
          </nav>

          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="triage-queue-heading" mix={sectionTitleStyle}>
                Triage Worklist <span mix={countPillStyle}>{requests.length}</span>
              </h2>
            </div>

            {requests.length === 0 ? (
              <div mix={emptyStateStyle}>
                <p>No survey requests found in this triage view.</p>
              </div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="triage-queue-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>
                    Station survey requests awaiting or completed in triage
                  </caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Request No</th>
                      <th scope="col" mix={tableThStyle}>Vessel</th>
                      <th scope="col" mix={tableThStyle}>Requesting Org</th>
                      <th scope="col" mix={tableThStyle}>Station</th>
                      <th scope="col" mix={tableThStyle}>Port</th>
                      <th scope="col" mix={tableThStyle}>Dates</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                      <th scope="col" mix={tableThStyle}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => {
                      let isPending = r.status === 'submitted'
                      return (
                        <tr key={r.id} mix={isPending ? pendingRowStyle : tableTrStyle}>
                          <td mix={tableTdBoldStyle}>
                            <a href={routes.triage.detail.href({ id: r.id })} mix={monoTextStyle}>
                              {r.request_no}
                            </a>
                          </td>
                          <td mix={tableTdStyle}>
                            <a href={routes.ships.detail.href({ id: r.ship_id })}>{r.ship_name}</a>
                            <span mix={subMetaStyle}>IMO {r.ship_imo_number}</span>
                          </td>
                          <td mix={tableTdStyle}>{r.org_name}</td>
                          <td mix={tableTdStyle}>{r.station_name}</td>
                          <td mix={tableTdStyle}>{r.port_name}</td>
                          <td mix={tableTdStyle}>
                            {new Date(r.estimated_arrival).toLocaleDateString()} &ndash;{' '}
                            {new Date(r.estimated_departure).toLocaleDateString()}
                          </td>
                          <td mix={tableTdStyle}>
                            <StatusBadge status={r.status} />
                          </td>
                          <td mix={tableTdStyle}>
                            <a
                              href={routes.triage.detail.href({ id: r.id })}
                              mix={compactActionLinkStyle}
                            >
                              {isPending && isPrivileged ? 'Triage Decision →' : 'Review Details'}
                            </a>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </Document>
    )
  }
}
