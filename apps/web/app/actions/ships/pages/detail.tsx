import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import {
  actionGroupStyle,
  badgeToneStyles,
  breadcrumbNavStyle,
  countPillStyle,
  dataTableStyle,
  heroHeaderStyle,
  heroSubtitleStyle,
  heroTitleStyle,
  kpiCardStyle,
  kpiGridStyle,
  kpiLabelStyle,
  kpiValueStyle,
  monoTextStyle,
  mutedNoteStyle,
  pageShellStyle,
  panelCardStyle,
  primaryLinkButtonStyle,
  secondaryLinkButtonStyle,
  sectionHeaderRowStyle,
  sectionTitleStyle,
  tableCaptionStyle,
  tableHeadStyle,
  tableRegionStyle,
  tableTdBoldStyle,
  tableTdStyle,
  tableThStyle,
  tableTrStyle,
} from '../../theme.ts'
import { routes } from '../../../routes.ts'
import {
  formatDate,
  formatNumber,
  formatPartyRole,
  formatShipStatus,
  formatShipType,
  formatText,
} from '../presenters.ts'
import type { ShipDetailProps } from '../types.ts'

const titleRowStyle = css({ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' })
const particularsGridStyle = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(21rem, 1fr))',
  gap: '1.15rem',
  marginBottom: '1.5rem',
})
const particularCardStyle = css({
  backgroundColor: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  padding: '1.15rem 1.35rem',
})
const cardHeadingStyle = css({
  margin: '0 0 0.85rem',
  fontSize: '1rem',
  fontWeight: 700,
  borderBottom: '1px solid var(--line)',
  paddingBottom: '0.5rem',
})
const dlStyle = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(9.5rem, auto) 1fr',
  gap: '0.45rem 0.9rem',
  margin: 0,
  fontSize: '0.88rem',
  '@media (max-width: 440px)': {
    gridTemplateColumns: '1fr',
    gap: '0.15rem',
  },
})
const dtStyle = css({ fontWeight: 600, color: 'var(--muted)' })
const ddStyle = css({ margin: 0, fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' })
const breakdownCardStyle = css({
  border: '1px solid var(--line)',
  borderRadius: '8px',
  padding: '1rem 1.15rem',
  marginBottom: '1rem',
  backgroundColor: 'var(--panel-subtle)',
  '&:last-child': { marginBottom: 0 },
})
const breakdownTitleStyle = css({ margin: '0 0 0.35rem', fontSize: '1rem', fontWeight: 700 })
const breakdownDescStyle = css({ margin: '0 0 0.85rem', color: 'var(--muted)', fontSize: '0.9rem' })
const nodeCardStyle = css({
  borderLeft: '3px solid var(--accent)',
  backgroundColor: 'var(--panel)',
  borderTop: '1px solid var(--line)',
  borderRight: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
  borderRadius: '0 8px 8px 0',
  padding: '0.85rem 1rem',
  marginBottom: '0.85rem',
  '&:last-child': { marginBottom: 0 },
})
const nodeTitleStyle = css({ fontWeight: 700, marginBottom: '0.2rem', fontSize: '0.95rem' })
const nodeMetaStyle = css({ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.6rem' })

const STATUS_BADGE_MAP: Record<string, { tone: keyof typeof badgeToneStyles; symbol: string }> = {
  in_service: { tone: 'success', symbol: '●' },
  laid_up: { tone: 'warn', symbol: '⏸' },
  under_construction: { tone: 'info', symbol: '◐' },
  decommissioned: { tone: 'neutral', symbol: '○' },
}

export function ShipDetailPage(handle: Handle<ShipDetailProps>) {
  return () => {
    let {
      ship,
      parties,
      notations,
      certificates,
      surveyAudits,
      findings,
      breakdowns,
      breakdownNodes,
      breakdownParticulars,
      surveyRequests,
    } = handle.props

    let particularsByNode = new Map<number, typeof breakdownParticulars>()
    for (let p of breakdownParticulars) {
      let existing = particularsByNode.get(p.ship_breakdown_node_id) ?? []
      existing.push(p)
      particularsByNode.set(p.ship_breakdown_node_id, existing)
    }

    let nodesByBreakdown = new Map<number, typeof breakdownNodes>()
    for (let node of breakdownNodes) {
      let existing = nodesByBreakdown.get(node.ship_breakdown_id) ?? []
      existing.push(node)
      nodesByBreakdown.set(node.ship_breakdown_id, existing)
    }

    let badgeInfo = STATUS_BADGE_MAP[ship.status] ?? { tone: 'neutral', symbol: '○' }

    return (
      <Document title={`${ship.name} (IMO ${ship.imo_number}) | Vessel Particulars`}>
        <main mix={pageShellStyle}>
          <nav aria-label="Breadcrumb" mix={breadcrumbNavStyle}>
            <a href={routes.session.home.href()}>Home</a>
            <span aria-hidden="true">/</span>
            <a href={routes.ships.index.href()}>Fleet Vessels</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{ship.name}</span>
          </nav>

          <header mix={heroHeaderStyle}>
            <div>
              <div mix={titleRowStyle}>
                <h1 mix={heroTitleStyle}>{ship.name}</h1>
                <span mix={badgeToneStyles[badgeInfo.tone]}>
                  <span aria-hidden="true">{badgeInfo.symbol}</span>
                  {formatShipStatus(ship.status)}
                </span>
              </div>
              <p mix={heroSubtitleStyle}>
                <span mix={monoTextStyle}>IMO {ship.imo_number}</span>
                {ship.class_number != null ? (
                  <>
                    {' '}&bull; <span mix={monoTextStyle}>Class #{ship.class_number}</span>
                  </>
                ) : null}{' '}
                &bull; Flag:{' '}
                <strong>{ship.flag_name ? `${ship.flag_name} (${ship.flag_code})` : ship.flag_code}</strong>
              </p>
            </div>
            <div mix={actionGroupStyle}>
              <a href={routes.survey.new.href()} mix={primaryLinkButtonStyle}>
                + Request Survey
              </a>
              <a href={routes.ships.index.href()} mix={secondaryLinkButtonStyle}>
                &larr; Fleet List
              </a>
            </div>
          </header>

          {/* Key Vessel Metrics */}
          <section aria-label="Key vessel figures" mix={kpiGridStyle}>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>Gross Tonnage</p>
              <p mix={kpiValueStyle}>{formatNumber(ship.gross_tons ?? ship.gross_tonnage)}</p>
            </div>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>Deadweight</p>
              <p mix={kpiValueStyle}>{formatNumber(ship.deadweight, 't')}</p>
            </div>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>Length Overall</p>
              <p mix={kpiValueStyle}>{formatNumber(ship.length_oa ?? ship.length, 'm')}</p>
            </div>
            <div mix={kpiCardStyle}>
              <p mix={kpiLabelStyle}>Build Year</p>
              <p mix={kpiValueStyle}>{formatText(ship.build_year)}</p>
            </div>
          </section>

          {/* Core Ship Particulars */}
          <section aria-label="Vessel Particulars" mix={particularsGridStyle}>
            <div mix={particularCardStyle}>
              <h2 mix={cardHeadingStyle}>Identification &amp; Registry</h2>
              <dl mix={dlStyle}>
                <dt mix={dtStyle}>IMO Number</dt>
                <dd mix={ddStyle}>
                  <span mix={monoTextStyle}>{ship.imo_number}</span>
                </dd>
                <dt mix={dtStyle}>Class Number</dt>
                <dd mix={ddStyle}>{formatText(ship.class_number)}</dd>
                <dt mix={dtStyle}>Call Sign / Signal</dt>
                <dd mix={ddStyle}>
                  <span mix={monoTextStyle}>{formatText(ship.call_sign ?? ship.signal_letter)}</span>
                </dd>
                <dt mix={dtStyle}>MMSI Number</dt>
                <dd mix={ddStyle}>
                  <span mix={monoTextStyle}>{formatText(ship.mmsi_number)}</span>
                </dd>
                <dt mix={dtStyle}>Official Number</dt>
                <dd mix={ddStyle}>
                  <span mix={monoTextStyle}>{formatText(ship.official_number)}</span>
                </dd>
                <dt mix={dtStyle}>Port of Registry</dt>
                <dd mix={ddStyle}>{formatText(ship.port_of_registry)}</dd>
                <dt mix={dtStyle}>Registry No. / Date</dt>
                <dd mix={ddStyle}>
                  {formatText(ship.registry_number)} / {formatDate(ship.date_of_registry)}
                </dd>
                <dt mix={dtStyle}>Previous Names</dt>
                <dd mix={ddStyle}>{formatText(ship.previous_names)}</dd>
              </dl>
            </div>

            <div mix={particularCardStyle}>
              <h2 mix={cardHeadingStyle}>Classification &amp; Dates</h2>
              <dl mix={dlStyle}>
                <dt mix={dtStyle}>Vessel Type</dt>
                <dd mix={ddStyle}>
                  {formatShipType(ship.ship_type)}
                  {ship.type_iacs_name ? ` (${ship.type_iacs} — ${ship.type_iacs_name})` : ''}
                </dd>
                <dt mix={dtStyle}>Main Class</dt>
                <dd mix={ddStyle}>{formatText(ship.main_class)}</dd>
                <dt mix={dtStyle}>Classed By / Dual</dt>
                <dd mix={ddStyle}>
                  {formatText(ship.classed_by)} / {formatText(ship.dual_class)}
                </dd>
                <dt mix={dtStyle}>Class / Ship Status</dt>
                <dd mix={ddStyle}>
                  {formatText(ship.class_status_name ?? ship.class_status)} /{' '}
                  {formatText(ship.ship_status_name ?? ship.ship_status)}
                </dd>
                <dt mix={dtStyle}>Administration</dt>
                <dd mix={ddStyle}>{formatText(ship.administration_types)}</dd>
                <dt mix={dtStyle}>MTS Unit</dt>
                <dd mix={ddStyle}>{formatText(ship.responsible_mts_unit_name)}</dd>
                <dt mix={dtStyle}>Built / Build Date</dt>
                <dd mix={ddStyle}>
                  {formatText(ship.build_year)} ({formatDate(ship.build_date)})
                </dd>
                <dt mix={dtStyle}>Keel Laid / Class Entry</dt>
                <dd mix={ddStyle}>
                  {formatDate(ship.keel_laid_date)} / {formatDate(ship.class_entry_date)}
                </dd>
                <dt mix={dtStyle}>Contract / Commission</dt>
                <dd mix={ddStyle}>
                  {formatDate(ship.contract_date)} / {formatDate(ship.commissioning_date)}
                </dd>
              </dl>
            </div>

            <div mix={particularCardStyle}>
              <h2 mix={cardHeadingStyle}>Tonnage &amp; Dimensions</h2>
              <dl mix={dlStyle}>
                <dt mix={dtStyle}>Gross Tonnage (GT)</dt>
                <dd mix={ddStyle}>{formatNumber(ship.gross_tons ?? ship.gross_tonnage)}</dd>
                <dt mix={dtStyle}>Net / National Tons</dt>
                <dd mix={ddStyle}>
                  {formatNumber(ship.net_tons)} / {formatNumber(ship.national_tons)}
                </dd>
                <dt mix={dtStyle}>Deadweight (DWT)</dt>
                <dd mix={ddStyle}>{formatNumber(ship.deadweight, 't')}</dd>
                <dt mix={dtStyle}>Light Ship / Ballast</dt>
                <dd mix={ddStyle}>
                  {formatNumber(ship.light_ship, 't')} / {formatNumber(ship.ballast_capacity, 'm³')}
                </dd>
                <dt mix={dtStyle}>Equipment Number</dt>
                <dd mix={ddStyle}>{formatNumber(ship.equipment_number)}</dd>
                <dt mix={dtStyle}>Length (L / LOA / LBP)</dt>
                <dd mix={ddStyle}>
                  {formatNumber(ship.length, 'm')} / {formatNumber(ship.length_oa, 'm')} /{' '}
                  {formatNumber(ship.length_bp, 'm')}
                </dd>
                <dt mix={dtStyle}>Moulded Breadth / Depth</dt>
                <dd mix={ddStyle}>
                  {formatNumber(ship.moulded_breadth, 'm')} / {formatNumber(ship.moulded_depth, 'm')}
                </dd>
                <dt mix={dtStyle}>Moulded / Design Draft</dt>
                <dd mix={ddStyle}>
                  {formatNumber(ship.moulded_draft, 'm')} / {formatNumber(ship.design_draft, 'm')}
                </dd>
              </dl>
            </div>
          </section>

          {/* Ship Breakdown & Technical Particulars */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 mix={sectionTitleStyle}>
                Technical Breakdown &amp; Node Particulars{' '}
                <span mix={countPillStyle}>{breakdowns.length}</span>
              </h2>
            </div>
            {breakdowns.length === 0 ? (
              <p mix={mutedNoteStyle}>No ship technical breakdown recorded.</p>
            ) : (
              breakdowns.map((bd) => {
                let nodes = nodesByBreakdown.get(bd.id) ?? []
                return (
                  <div key={bd.id} mix={breakdownCardStyle}>
                    <h3 mix={breakdownTitleStyle}>
                      {bd.name} (Rev. {bd.revision}) {bd.is_active ? '— Active' : ''}
                    </h3>
                    {bd.description ? <p mix={breakdownDescStyle}>{bd.description}</p> : null}
                    {nodes.length === 0 ? (
                      <p mix={mutedNoteStyle}>No breakdown nodes defined.</p>
                    ) : (
                      nodes.map((node) => {
                        let nodeParticulars = particularsByNode.get(node.id) ?? []
                        return (
                          <div key={node.id} mix={nodeCardStyle}>
                            <div mix={nodeTitleStyle}>
                              <span mix={monoTextStyle}>{node.code}</span> &mdash; {node.name}
                            </div>
                            <div mix={nodeMetaStyle}>
                              Level {node.level}
                              {node.category ? ` · Category: ${node.category}` : ''}
                              {node.node_type ? ` · Type: ${node.node_type}` : ''}
                            </div>
                            {nodeParticulars.length > 0 ? (
                              <div
                                tabIndex={0}
                                role="region"
                                aria-label={`Particulars for ${node.name}`}
                                mix={tableRegionStyle}
                              >
                                <table mix={dataTableStyle}>
                                  <thead mix={tableHeadStyle}>
                                    <tr>
                                      <th scope="col" mix={tableThStyle}>Particular</th>
                                      <th scope="col" mix={tableThStyle}>Key</th>
                                      <th scope="col" mix={tableThStyle}>Value</th>
                                      <th scope="col" mix={tableThStyle}>Unit</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {nodeParticulars.map((p) => (
                                      <tr key={p.id} mix={tableTrStyle}>
                                        <td mix={tableTdBoldStyle}>{p.attr_title}</td>
                                        <td mix={tableTdStyle}>
                                          <span mix={monoTextStyle}>{p.attr_key}</span>
                                        </td>
                                        <td mix={tableTdStyle}>{formatText(p.attr_value)}</td>
                                        <td mix={tableTdStyle}>{formatText(p.unit)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : null}
                          </div>
                        )
                      })
                    )}
                  </div>
                )
              })
            )}
          </section>

          {/* Affiliated Parties */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="ship-parties-heading" mix={sectionTitleStyle}>
                Affiliated Parties <span mix={countPillStyle}>{parties.length}</span>
              </h2>
            </div>
            {parties.length === 0 ? (
              <p mix={mutedNoteStyle}>No affiliated organizations visible in your scope.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="ship-parties-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Commercial and statutory party affiliations</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Organization</th>
                      <th scope="col" mix={tableThStyle}>Role</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parties.map((p) => (
                      <tr key={p.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>{p.org_name}</td>
                        <td mix={tableTdStyle}>{formatPartyRole(p.party_role)}</td>
                        <td mix={tableTdStyle}>
                          <span mix={p.is_current ? badgeToneStyles.success : badgeToneStyles.neutral}>
                            <span aria-hidden="true">{p.is_current ? '●' : '○'}</span>
                            {p.is_current ? 'Active' : 'Historical'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Class Notations */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="ship-notations-heading" mix={sectionTitleStyle}>
                Class Notations <span mix={countPillStyle}>{notations.length}</span>
              </h2>
            </div>
            {notations.length === 0 ? (
              <p mix={mutedNoteStyle}>No class notations assigned.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="ship-notations-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Assigned classification notations and due dates</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Notation</th>
                      <th scope="col" mix={tableThStyle}>Group</th>
                      <th scope="col" mix={tableThStyle}>Society</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                      <th scope="col" mix={tableThStyle}>Next Survey Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notations.map((n) => (
                      <tr key={n.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>
                          <span mix={monoTextStyle}>
                            {n.resolved_notation ?? n.notation_symbol ?? n.notation_code}
                          </span>{' '}
                          &mdash; {n.notation_name}
                        </td>
                        <td mix={tableTdStyle}>{n.group_name}</td>
                        <td mix={tableTdStyle}>{n.society_code}</td>
                        <td mix={tableTdStyle}>{n.status}</td>
                        <td mix={tableTdStyle}>{formatDate(n.next_survey_due)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Certificates */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="ship-certs-heading" mix={sectionTitleStyle}>
                Certificates <span mix={countPillStyle}>{certificates.length}</span>
              </h2>
            </div>
            {certificates.length === 0 ? (
              <p mix={mutedNoteStyle}>No certificates issued for this vessel.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="ship-certs-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Issued statutory and classification certificates</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Certificate No.</th>
                      <th scope="col" mix={tableThStyle}>Code</th>
                      <th scope="col" mix={tableThStyle}>Description</th>
                      <th scope="col" mix={tableThStyle}>Issue Date</th>
                      <th scope="col" mix={tableThStyle}>Expiry Date</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {certificates.map((c) => (
                      <tr key={c.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>
                          <span mix={monoTextStyle}>#{c.certificate_no}</span> (v{c.version})
                        </td>
                        <td mix={tableTdStyle}>
                          <span mix={monoTextStyle}>{c.cert_code}</span>
                        </td>
                        <td mix={tableTdStyle}>{formatText(c.description)}</td>
                        <td mix={tableTdStyle}>{formatDate(c.issue_date)}</td>
                        <td mix={tableTdStyle}>{formatDate(c.expiry_date)}</td>
                        <td mix={tableTdStyle}>{formatText(c.status_name ?? c.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Survey & Audit Schedule */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="ship-schedule-heading" mix={sectionTitleStyle}>
                Survey &amp; Audit Schedule <span mix={countPillStyle}>{surveyAudits.length}</span>
              </h2>
            </div>
            {surveyAudits.length === 0 ? (
              <p mix={mutedNoteStyle}>No scheduled survey or audit items.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="ship-schedule-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Survey and audit periodicity schedule</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Description</th>
                      <th scope="col" mix={tableThStyle}>Last Held</th>
                      <th scope="col" mix={tableThStyle}>Place</th>
                      <th scope="col" mix={tableThStyle}>Next Due</th>
                      <th scope="col" mix={tableThStyle}>Window</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {surveyAudits.map((sa) => (
                      <tr key={sa.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>{sa.description}</td>
                        <td mix={tableTdStyle}>{formatDate(sa.last_held_date)}</td>
                        <td mix={tableTdStyle}>{sa.place_held}</td>
                        <td mix={tableTdStyle}>{formatDate(sa.next_due_date)}</td>
                        <td mix={tableTdStyle}>
                          {formatDate(sa.range_from_date)} &ndash; {formatDate(sa.range_to_date)}
                        </td>
                        <td mix={tableTdStyle}>{formatText(sa.survey_status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Findings / Conditions */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="ship-findings-heading" mix={sectionTitleStyle}>
                Findings &amp; Conditions <span mix={countPillStyle}>{findings.length}</span>
              </h2>
            </div>
            {findings.length === 0 ? (
              <p mix={mutedNoteStyle}>No findings or conditions recorded.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="ship-findings-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Open and historical conditions or findings</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Ref</th>
                      <th scope="col" mix={tableThStyle}>Type</th>
                      <th scope="col" mix={tableThStyle}>Subject</th>
                      <th scope="col" mix={tableThStyle}>Issued</th>
                      <th scope="col" mix={tableThStyle}>Due Date</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr key={f.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>
                          <span mix={monoTextStyle}>{formatText(f.mms_reference)}</span>
                        </td>
                        <td mix={tableTdStyle}>{formatText(f.comment_type_name ?? f.comment_type)}</td>
                        <td mix={tableTdStyle}>{f.subject}</td>
                        <td mix={tableTdStyle}>{formatDate(f.date_issued)}</td>
                        <td mix={tableTdStyle}>{formatDate(f.due_date)}</td>
                        <td mix={tableTdStyle}>{formatText(f.status_name ?? f.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent Survey Requests */}
          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="ship-requests-heading" mix={sectionTitleStyle}>
                Survey Requests <span mix={countPillStyle}>{surveyRequests.length}</span>
              </h2>
            </div>
            {surveyRequests.length === 0 ? (
              <p mix={mutedNoteStyle}>No survey requests recorded for this vessel.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="ship-requests-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Survey attendance requests submitted for this vessel</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>Request No</th>
                      <th scope="col" mix={tableThStyle}>Port</th>
                      <th scope="col" mix={tableThStyle}>Station</th>
                      <th scope="col" mix={tableThStyle}>ETA</th>
                      <th scope="col" mix={tableThStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {surveyRequests.map((r) => (
                      <tr key={r.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>
                          <a href={routes.survey.detail.href({ id: r.id })} mix={monoTextStyle}>
                            {r.request_no}
                          </a>
                        </td>
                        <td mix={tableTdStyle}>{r.port_name}</td>
                        <td mix={tableTdStyle}>{r.station_name}</td>
                        <td mix={tableTdStyle}>{formatDate(r.estimated_arrival)}</td>
                        <td mix={tableTdStyle}>{r.status}</td>
                      </tr>
                    ))}
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
