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
  mutedNoteStyle,
  pageShellStyle,
  panelCardStyle,
  primaryLinkButtonStyle,
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
import type { SurveyListProps } from '../types.ts'

const fleetGridStyle = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))',
  gap: '0.9rem',
  marginTop: '0.75rem',
})
const fleetCardStyle = css({
  padding: '0.9rem 1.05rem',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  backgroundColor: 'var(--panel-subtle)',
})
const vesselNameStyle = css({ fontWeight: 700, fontSize: '0.98rem' })
const vesselDetailsStyle = css({ fontSize: '0.84rem', color: 'var(--muted)', marginTop: '0.25rem' })
const vesselSubDetailsStyle = css({
  fontSize: '0.8rem',
  color: 'var(--muted)',
  marginTop: '0.2rem',
  fontVariantNumeric: 'tabular-nums',
})

export function SurveyListPage(handle: Handle<SurveyListProps>) {
  return () => {
    let { role, requests, ships, message, error } = handle.props
    let isInternal = role.startsWith('int_')

    return (
      <Document title="Survey Requests | MMS">
        <main mix={pageShellStyle}>
          <nav aria-label="Breadcrumb" mix={breadcrumbNavStyle}>
            <a href={routes.session.home.href()}>Home</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Survey Requests</span>
            <span aria-hidden="true">&middot;</span>
            <a href={routes.ships.index.href()}>Fleet Vessels</a>
            {isInternal ? (
              <>
                <span aria-hidden="true">&middot;</span>
                <a href={routes.triage.queue.href()}>Triage Queue</a>
              </>
            ) : null}
          </nav>

          <header mix={heroHeaderStyle}>
            <div>
              <h1 mix={heroTitleStyle}>Survey Requests</h1>
              <p mix={heroSubtitleStyle}>
                Manage class and statutory survey requests for your fleet.
              </p>
            </div>
            <div mix={actionGroupStyle}>
              <a href={routes.survey.new.href()} mix={primaryLinkButtonStyle}>
                + New Survey Request
              </a>
              {isInternal ? (
                <a href={routes.triage.queue.href()} mix={secondaryLinkButtonStyle}>
                  Station Triage Queue &rarr;
                </a>
              ) : null}
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

          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="survey-requests-heading" mix={sectionTitleStyle}>
                Your Requests <span mix={countPillStyle}>{requests.length}</span>
              </h2>
            </div>

            {requests.length === 0 ? (
              <div mix={emptyStateStyle}>
                <p>No survey requests found.</p>
                <p>
                  <a href={routes.survey.new.href()}>Create a survey request</a> to schedule
                  attendance with a classification station.
                </p>
              </div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="survey-requests-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>
                    Submitted and draft survey requests in your scope
                  </caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Request No</th>
                      <th scope="col" mix={tableThStyle}>Vessel</th>
                      <th scope="col" mix={tableThStyle}>Port</th>
                      <th scope="col" mix={tableThStyle}>Dates</th>
                      <th scope="col" mix={tableThStyle}>Attending Station</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                      <th scope="col" mix={tableThStyle}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>
                          <a href={routes.survey.detail.href({ id: r.id })} mix={monoTextStyle}>
                            {r.request_no}
                          </a>
                        </td>
                        <td mix={tableTdStyle}>
                          <a href={routes.ships.detail.href({ id: r.ship_id })}>{r.ship_name}</a>
                          <span mix={subMetaStyle}>IMO {r.ship_imo_number}</span>
                        </td>
                        <td mix={tableTdStyle}>{r.port_name}</td>
                        <td mix={tableTdStyle}>
                          {new Date(r.estimated_arrival).toLocaleDateString()} &ndash;{' '}
                          {new Date(r.estimated_departure).toLocaleDateString()}
                        </td>
                        <td mix={tableTdStyle}>{r.station_name}</td>
                        <td mix={tableTdStyle}>
                          <StatusBadge status={r.status} />
                        </td>
                        <td mix={tableTdStyle}>
                          <a
                            href={routes.survey.detail.href({ id: r.id })}
                            mix={compactActionLinkStyle}
                          >
                            View / Submit
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 mix={sectionTitleStyle}>
                Affiliated Fleet Vessels <span mix={countPillStyle}>{ships.length}</span>
              </h2>
              <a href={routes.ships.index.href()} mix={secondaryLinkButtonStyle}>
                View Fleet Register
              </a>
            </div>
            <p mix={mutedNoteStyle}>
              Vessels registered to your organization eligible for survey requests:
            </p>
            {ships.length === 0 ? (
              <p mix={mutedNoteStyle}>
                No fleet vessels currently registered with active affiliation.
              </p>
            ) : (
              <div mix={fleetGridStyle}>
                {ships.map((s) => (
                  <div key={s.id} mix={fleetCardStyle}>
                    <div mix={vesselNameStyle}>
                      <a href={routes.ships.detail.href({ id: s.id })}>{s.name}</a>
                    </div>
                    <div mix={vesselDetailsStyle}>
                      IMO: <span mix={monoTextStyle}>{s.imo_number}</span> | Flag: {s.flag_code} |
                      Type: {s.type_iacs_name ?? s.type_iacs}
                    </div>
                    <div mix={vesselSubDetailsStyle}>
                      GT: {s.gross_tonnage?.toLocaleString() ?? '—'} | Built: {s.build_year ?? '—'}
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
