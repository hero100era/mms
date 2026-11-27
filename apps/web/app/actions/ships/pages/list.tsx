import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import {
  actionGroupStyle,
  alertBannerStyle,
  badgeToneStyles,
  breadcrumbNavStyle,
  compactActionLinkStyle,
  countPillStyle,
  dataTableStyle,
  emptyStateStyle,
  heroHeaderStyle,
  heroSubtitleStyle,
  heroTitleStyle,
  kpiCardStyle,
  kpiGridStyle,
  kpiLabelStyle,
  kpiValueStyle,
  monoTextStyle,
  pageShellStyle,
  panelCardStyle,
  primaryLinkButtonStyle,
  secondaryLinkButtonStyle,
  sectionHeaderRowStyle,
  sectionTitleStyle,
  subMetaStyle,
  tableCaptionStyle,
  tableHeadStyle,
  tableRegionStyle,
  tableTdBoldStyle,
  tableTdStyle,
  tableThStyle,
  tableTrStyle,
} from '../../theme.ts'
import { routes } from '../../../routes.ts'
import { formatNumber, formatShipStatus, formatText, SHIP_STATUS_LABELS } from '../presenters.ts'
import type { ShipsListProps } from '../types.ts'

const filterFormStyle = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(14rem, 2fr) repeat(2, minmax(10rem, 1fr)) auto auto',
  gap: '0.85rem',
  alignItems: 'end',
  '@media (max-width: 760px)': {
    gridTemplateColumns: '1fr',
  },
})
const filterFieldStyle = css({ display: 'flex', flexDirection: 'column', gap: '0.3rem' })
const labelStyle = css({ fontSize: '0.82rem', fontWeight: 600, color: 'var(--muted)' })
const inputStyle = css({
  minBlockSize: '38px',
  padding: '0.45rem 0.65rem',
  border: '1px solid var(--line-strong)',
  borderRadius: '7px',
  fontSize: '0.92rem',
  backgroundColor: 'var(--panel-subtle)',
  color: 'var(--ink)',
})
const filterButtonStyle = css({
  minBlockSize: '38px',
  padding: '0.5rem 1.1rem',
  backgroundColor: 'var(--ink)',
  color: 'var(--panel)',
  border: '1px solid transparent',
  borderRadius: '7px',
  fontWeight: 600,
  fontSize: '0.9rem',
  cursor: 'pointer',
})
const vesselLinkStyle = css({
  fontWeight: 700,
  textDecoration: 'none',
  '&:hover': { textDecoration: 'underline' },
})

const STATUS_BADGE_MAP: Record<string, { tone: keyof typeof badgeToneStyles; symbol: string }> = {
  in_service: { tone: 'success', symbol: '●' },
  laid_up: { tone: 'warn', symbol: '⏸' },
  under_construction: { tone: 'info', symbol: '◐' },
  decommissioned: { tone: 'neutral', symbol: '○' },
}

export function ShipsListPage(handle: Handle<ShipsListProps>) {
  return () => {
    let { role, ships, filters, availableTypes, error } = handle.props
    let isInternal = role.startsWith('int_')
    let inServiceCount = ships.filter((s) => s.status === 'in_service').length
    let distinctTypeCount = new Set(ships.map((s) => s.type_iacs).filter(Boolean)).size

    return (
      <Document title="Fleet Vessels | MMS">
        <main mix={pageShellStyle}>
          <nav aria-label="Breadcrumb" mix={breadcrumbNavStyle}>
            <a href={routes.session.home.href()}>Home</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Fleet Vessels</span>
            <span aria-hidden="true">&middot;</span>
            <a href={routes.survey.index.href()}>Survey Requests</a>
            {isInternal ? (
              <>
                <span aria-hidden="true">&middot;</span>
                <a href={routes.triage.queue.href()}>Triage Queue</a>
              </>
            ) : null}
          </nav>

          <header mix={heroHeaderStyle}>
            <div>
              <h1 mix={heroTitleStyle}>Fleet Vessels</h1>
              <p mix={heroSubtitleStyle}>
                {isInternal
                  ? 'Registered vessels and classification particulars across the fleet.'
                  : 'Classed vessels affiliated with your organization.'}
              </p>
            </div>
            <div mix={actionGroupStyle}>
              <a href={routes.survey.new.href()} mix={primaryLinkButtonStyle}>
                + New Survey Request
              </a>
              <a href={routes.survey.index.href()} mix={secondaryLinkButtonStyle}>
                Survey Requests
              </a>
            </div>
          </header>

          {error ? (
            <p role="alert" mix={alertBannerStyle}>
              {error}
            </p>
          ) : null}

          <section aria-label="Fleet summary" mix={kpiGridStyle}>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>Vessels Shown</p>
              <p mix={kpiValueStyle}>{ships.length}</p>
            </div>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>In Service</p>
              <p mix={kpiValueStyle}>{inServiceCount}</p>
            </div>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>Vessel Types</p>
              <p mix={kpiValueStyle}>{distinctTypeCount}</p>
            </div>
          </section>

          <section aria-label="Filter vessels" mix={panelCardStyle}>
            <form method="get" action={routes.ships.index.href()} mix={filterFormStyle}>
              <div mix={filterFieldStyle}>
                <label htmlFor="ship-search-q" mix={labelStyle}>
                  Search Vessels
                </label>
                <input
                  id="ship-search-q"
                  type="search"
                  name="q"
                  defaultValue={filters.q}
                  placeholder="Name, IMO, class no., call sign, port..."
                  mix={inputStyle}
                />
              </div>

              <div mix={filterFieldStyle}>
                <label htmlFor="ship-filter-status" mix={labelStyle}>
                  Operational Status
                </label>
                <select id="ship-filter-status" name="status" mix={inputStyle}>
                  <option value="all" selected={filters.status === 'all'}>
                    All statuses
                  </option>
                  {Object.entries(SHIP_STATUS_LABELS).map(([code, label]) => (
                    <option key={code} value={code} selected={filters.status === code}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div mix={filterFieldStyle}>
                <label htmlFor="ship-filter-type" mix={labelStyle}>
                  Vessel Type
                </label>
                <select id="ship-filter-type" name="type_iacs" mix={inputStyle}>
                  <option value="all" selected={filters.typeIacs === 'all'}>
                    All types
                  </option>
                  {availableTypes.map((t) => (
                    <option key={t.code} value={t.code} selected={filters.typeIacs === t.code}>
                      {t.name} ({t.code})
                    </option>
                  ))}
                </select>
              </div>

              <button type="submit" mix={filterButtonStyle}>
                Apply Filter
              </button>
              <a href={routes.ships.index.href()} mix={secondaryLinkButtonStyle}>
                Reset
              </a>
            </form>
          </section>

          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="fleet-register-heading" mix={sectionTitleStyle}>
                Vessel Register <span mix={countPillStyle}>{ships.length}</span>
              </h2>
            </div>

            {ships.length === 0 ? (
              <div mix={emptyStateStyle}>
                <p>No vessels found matching your scope and filters.</p>
              </div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="fleet-register-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>
                    Showing {ships.length} {ships.length === 1 ? 'vessel' : 'vessels'} in your authorized scope
                  </caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Vessel</th>
                      <th scope="col" mix={tableThStyle}>IMO / Class No.</th>
                      <th scope="col" mix={tableThStyle}>Flag</th>
                      <th scope="col" mix={tableThStyle}>Type</th>
                      <th scope="col" mix={tableThStyle}>Gross Tonnage</th>
                      <th scope="col" mix={tableThStyle}>Built</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                      <th scope="col" mix={tableThStyle}>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ships.map((s) => {
                      let badgeInfo = STATUS_BADGE_MAP[s.status] ?? { tone: 'neutral', symbol: '○' }
                      return (
                        <tr key={s.id} mix={tableTrStyle}>
                          <td mix={tableTdBoldStyle}>
                            <a href={routes.ships.detail.href({ id: s.id })} mix={vesselLinkStyle}>
                              {s.name}
                            </a>
                            {s.call_sign ? (
                              <span mix={subMetaStyle}>
                                Call Sign: <span mix={monoTextStyle}>{s.call_sign}</span>
                              </span>
                            ) : null}
                          </td>
                          <td mix={tableTdStyle}>
                            <span mix={monoTextStyle}>IMO {s.imo_number}</span>
                            {s.class_number != null ? (
                              <span mix={subMetaStyle}>Class #{s.class_number}</span>
                            ) : null}
                          </td>
                          <td mix={tableTdStyle}>
                            <span mix={monoTextStyle}>{s.flag_code}</span>
                            {s.flag_name ? <span mix={subMetaStyle}>{s.flag_name}</span> : null}
                          </td>
                          <td mix={tableTdStyle}>
                            {formatText(s.type_iacs_name ?? s.type_iacs)}
                            {s.type_mms_name ? <span mix={subMetaStyle}>{s.type_mms_name}</span> : null}
                          </td>
                          <td mix={tableTdStyle}>{formatNumber(s.gross_tonnage)}</td>
                          <td mix={tableTdStyle}>{s.build_year ?? '—'}</td>
                          <td mix={tableTdStyle}>
                            <span mix={badgeToneStyles[badgeInfo.tone]}>
                              <span aria-hidden="true">{badgeInfo.symbol}</span>
                              {formatShipStatus(s.status)}
                            </span>
                          </td>
                          <td mix={tableTdStyle}>
                            <a
                              href={routes.ships.detail.href({ id: s.id })}
                              mix={compactActionLinkStyle}
                              aria-label={`View particulars for ${s.name}`}
                            >
                              Particulars &rarr;
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
