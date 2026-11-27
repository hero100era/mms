import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import type { TriageDetailProps } from '../types.ts'

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '64rem', margin: '2rem auto', padding: '0 1rem' })
const headerFlexStyle = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #ddd', paddingBottom: '1rem', marginBottom: '1.5rem' })
const titleRowStyle = css({ display: 'flex', alignItems: 'center', gap: '0.75rem' })
const zeroMarginStyle = css({ margin: 0 })
const headerSubtitleStyle = css({ margin: '0.35rem 0 0', color: '#555' })
const stationLabelStyle = css({ fontSize: '0.9rem', color: '#666' })
const stationValueStyle = css({ fontSize: '1.1rem' })
const successBannerStyle = css({ padding: '0.75rem', background: '#d1e7dd', color: '#0f5132', borderRadius: '4px' })
const errorBannerStyle = css({ padding: '0.75rem', background: '#f8d7da', color: '#842029', borderRadius: '4px' })
const readOnlyNoticeStyle = css({ padding: '0.75rem 1rem', background: '#fff3cd', color: '#664d03', borderRadius: '4px', marginBottom: '1.5rem' })
const detailsGridStyle = css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' })
const detailsCardStyle = css({ background: '#f8f9fa', padding: '1rem', borderRadius: '6px' })
const cardHeadingStyle = css({ margin: '0 0 0.75rem' })
const cardParagraphStyle = css({ margin: '0 0 0.4rem' })
const marginBottomHalfRem = css({ marginBottom: '0.5rem' })
const tagsContainerStyle = css({ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' })
const tagBadgeStyle = css({ padding: '0.2rem 0.5rem', background: '#e2f0d9', color: '#276a3c', borderRadius: '3px', fontSize: '0.8rem', fontWeight: 'bold' })
const noneSpecifiedStyle = css({ color: '#888' })
const scopeParagraphStyle = css({ margin: '0.5rem 0 0.4rem' })
const agentInfoStyle = css({ marginTop: '0.5rem', fontSize: '0.85rem' })
const documentsSectionStyle = css({ marginBottom: '2rem' })
const documentsHeadingStyle = css({ margin: '0 0 0.75rem' })
const noDocumentsStyle = css({ color: '#888', fontStyle: 'italic' })
const tableStyle = css({ width: '100%', borderCollapse: 'collapse', textAlign: 'left' })
const tableHeaderRowStyle = css({ borderBottom: '2px solid #333' })
const tableHeaderCellStyle = css({ padding: '0.5rem' })
const tableRowStyle = css({ borderBottom: '1px solid #eee' })
const tableCellBoldStyle = css({ padding: '0.5rem', fontWeight: 'bold' })
const tableCellStyle = css({ padding: '0.5rem' })
const tableCellSmallStyle = css({ padding: '0.5rem', fontSize: '0.85rem' })
const downloadLinkStyle = css({
  padding: '0.2rem 0.5rem',
  border: '1px solid #333',
  borderRadius: '3px',
  textDecoration: 'none',
  fontSize: '0.8rem',
})
const decisionSectionStyle = css({ border: '2px solid #0d6efd', borderRadius: '8px', padding: '1.5rem', background: '#fdfefe', marginBottom: '2.5rem' })
const decisionHeadingStyle = css({ margin: '0 0 1rem', color: '#084298' })
const decisionDescriptionStyle = css({ color: '#555', marginBottom: '1.5rem' })
const decisionGridStyle = css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' })
const acceptCardStyle = css({ padding: '1rem', border: '1px solid #198754', borderRadius: '6px', background: '#f8fff9' })
const acceptHeadingStyle = css({ margin: '0 0 0.5rem', color: '#198754' })
const formFieldGroupStyle = css({ marginBottom: '0.75rem' })
const fieldLabelBoldStyle = css({ display: 'block', fontSize: '0.85rem', fontWeight: 'bold' })
const textInputStyle = css({ width: '100%', padding: '0.4rem', boxSizing: 'border-box' })
const fieldLabelStyle = css({ display: 'block', fontSize: '0.85rem' })
const acceptButtonStyle = css({
  padding: '0.5rem 1rem',
  background: '#198754',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})
const clarifyCardStyle = css({ padding: '1rem', border: '1px solid #fd7e14', borderRadius: '6px', background: '#fffcf8' })
const clarifyHeadingStyle = css({ margin: '0 0 0.5rem', color: '#fd7e14' })
const clarifyButtonStyle = css({
  padding: '0.5rem 1rem',
  background: '#fd7e14',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})
const transferCardStyle = css({ padding: '1rem', border: '1px solid #0dcaf0', borderRadius: '6px', background: '#f8fcfe' })
const transferHeadingStyle = css({ margin: '0 0 0.5rem', color: '#055160' })
const selectTargetStationStyle = css({ width: '100%', padding: '0.4rem' })
const transferButtonStyle = css({
  padding: '0.5rem 1rem',
  background: '#055160',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})
const rejectCardStyle = css({ padding: '1rem', border: '1px solid #dc3545', borderRadius: '6px', background: '#fff8f8' })
const rejectHeadingStyle = css({ margin: '0 0 0.5rem', color: '#dc3545' })
const rejectButtonStyle = css({
  padding: '0.5rem 1rem',
  background: '#dc3545',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})
const statusBoxStyle = css({ padding: '1rem', background: '#f8f9fa', border: '1px solid #ddd', borderRadius: '6px', marginBottom: '2.5rem' })
const triageNotesMarginStyle = css({ margin: '0.5rem 0 0' })
const auditSectionStyle = css({ borderTop: '2px solid #ddd', paddingTop: '1.5rem' })
const auditDescriptionStyle = css({ color: '#666', fontSize: '0.9rem' })
const auditTableStyle = css({ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginTop: '1rem', fontSize: '0.85rem' })
const actorIdSubStyle = css({ fontSize: '0.75rem', color: '#777' })
const dashMutedStyle = css({ color: '#999' })
const auditDetailCellStyle = css({ padding: '0.5rem', fontSize: '0.8rem', color: '#555' })

export function TriageDetailPage(handle: Handle<TriageDetailProps>) {
  return () => {
    let { csrf, role, request, documents, versions = [], stations, auditEvents, message, error } = handle.props
    let canTriage = ['int_coordinator', 'int_manager'].includes(role)
    let isPending = request.status === 'submitted'
    let isReadOnly = !canTriage

    // Other stations for transfer
    let otherStations = stations.filter((s) => s.id !== request.office_unit_id)

    return (
      <Document title={`Triage ${request.request_no}`}>
        <main mix={mainContainerStyle}>
          <p>
            <a href={routes.triage.queue.href()}>&larr; Back to Triage Queue</a>
          </p>

          <header mix={headerFlexStyle}>
            <div>
              <div mix={titleRowStyle}>
                <h1 mix={zeroMarginStyle}>Triage: {request.request_no}</h1>
                <StatusBadge status={request.status} />
              </div>
              <p mix={headerSubtitleStyle}>
                Vessel:{' '}
                <strong>
                  <a href={routes.ships.detail.href({ id: request.ship_id })}>{request.ship_name}</a>
                </strong>{' '}
                (IMO: {request.ship_imo_number}) | Requesting Organization: <strong>{request.org_name}</strong>
              </p>
            </div>
            <div>
              <span mix={stationLabelStyle}>Attending Station:</span>{' '}
              <strong mix={stationValueStyle}>{request.station_name}</strong>
            </div>
          </header>

          {message ? <p role="status" mix={successBannerStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorBannerStyle}>{error}</p> : null}

          {/* Read-only notification for interns / compliance */}
          {isReadOnly ? (
            <div mix={readOnlyNoticeStyle}>
              <strong>Notice:</strong> Your current capability role (<code>{role}</code>) has read-only access to this queue. Triage and transfer decisions require coordinator or manager authority.
            </div>
          ) : null}

          {/* Request details summary */}
          <section mix={detailsGridStyle}>
            <div mix={detailsCardStyle}>
              <h3 mix={cardHeadingStyle}>Port Stay & Schedule</h3>
              <p mix={cardParagraphStyle}>
                <strong>Port:</strong> {request.port_name}, {request.port_country} {request.port_code ? `(${request.port_code})` : ''}
              </p>
              <p mix={cardParagraphStyle}>
                <strong>Arrival (ETA):</strong> {new Date(request.estimated_arrival).toLocaleString()}
              </p>
              <p mix={cardParagraphStyle}>
                <strong>Departure (ETD):</strong> {new Date(request.estimated_departure).toLocaleString()}
              </p>
              <p mix={cardParagraphStyle}>
                <strong>Current Station:</strong> {request.station_name}
              </p>
            </div>

            <div mix={detailsCardStyle}>
              <h3 mix={cardHeadingStyle}>Requested Attendance Scope</h3>
              <div mix={marginBottomHalfRem}>
                <strong>Survey Types:</strong>
                <div mix={tagsContainerStyle}>
                  {request.survey_types?.length > 0 ? (
                    request.survey_types.map((st) => (
                      <span key={st} mix={tagBadgeStyle}>
                        {st}
                      </span>
                    ))
                  ) : (
                    <span mix={noneSpecifiedStyle}>None</span>
                  )}
                </div>
              </div>
              {request.scope_description ? (
                <p mix={scopeParagraphStyle}>
                  <strong>Client Scope:</strong> {request.scope_description}
                </p>
              ) : null}
              {request.agent_contact && Object.keys(request.agent_contact).length > 0 ? (
                <div mix={agentInfoStyle}>
                  <strong>Port Agent:</strong> {request.agent_contact.name ?? ''} | {request.agent_contact.email ?? ''} | {request.agent_contact.phone ?? ''}
                </div>
              ) : null}
            </div>
          </section>

          {/* Attached documents */}
          <section mix={documentsSectionStyle}>
            <h3 mix={documentsHeadingStyle}>Attached Documents ({versions.length})</h3>
            {versions.length === 0 ? (
              <p mix={noDocumentsStyle}>No documents attached by client.</p>
            ) : (
              <table mix={tableStyle}>
                <thead>
                  <tr mix={tableHeaderRowStyle}>
                    <th mix={tableHeaderCellStyle}>File Name</th>
                    <th mix={tableHeaderCellStyle}>Revision</th>
                    <th mix={tableHeaderCellStyle}>MIME</th>
                    <th mix={tableHeaderCellStyle}>Size</th>
                    <th mix={tableHeaderCellStyle}>Uploaded</th>
                    <th mix={tableHeaderCellStyle}>Download</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} mix={tableRowStyle}>
                      <td mix={tableCellBoldStyle}>{v.file_name}</td>
                      <td mix={tableCellStyle}>r{v.revision_no}</td>
                      <td mix={tableCellSmallStyle}>{v.mime_type}</td>
                      <td mix={tableCellStyle}>{(v.byte_size / 1024).toFixed(1)} KB</td>
                      <td mix={tableCellSmallStyle}>{new Date(v.created_at).toLocaleDateString()}</td>
                      <td mix={tableCellStyle}>
                        <a
                          href={routes.uploads.documentDownload.href({ documentId: v.document_id, versionId: v.id })}
                          mix={downloadLinkStyle}
                        >
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Triage Decision Section (visible for coordinators/managers) */}
          {canTriage && isPending ? (
            <section mix={decisionSectionStyle}>
              <h2 mix={decisionHeadingStyle}>Station Triage Decision</h2>
              <p mix={decisionDescriptionStyle}>
                Review request feasibility against surveyor resources and port coverage. All decisions are regulated business events recorded in the audit trail with your authority snapshot.
              </p>

              <div mix={decisionGridStyle}>
                {/* 1. Accept Request */}
                <div mix={acceptCardStyle}>
                  <h4 mix={acceptHeadingStyle}>✅ Accept Request</h4>
                  <form method="post" action={routes.triage.accept.href({ id: request.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelBoldStyle}>
                        Mandatory Reason *
                      </label>
                      <input
                        type="text"
                        name="reason"
                        required
                        placeholder="e.g. Scope verified, surveyor team available"
                        mix={textInputStyle}
                      />
                    </div>
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelStyle}>
                        Triage Notes (Optional)
                      </label>
                      <textarea
                        name="triage_notes"
                        rows={2}
                        placeholder="Attending team assignment or scheduling notes..."
                        mix={textInputStyle}
                      />
                    </div>
                    <button
                      type="submit"
                      mix={acceptButtonStyle}
                    >
                      Accept for Attendance
                    </button>
                  </form>
                </div>

                {/* 2. Request Clarification */}
                <div mix={clarifyCardStyle}>
                  <h4 mix={clarifyHeadingStyle}>⚠️ Request Clarification</h4>
                  <form method="post" action={routes.triage.clarify.href({ id: request.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelBoldStyle}>
                        Mandatory Reason *
                      </label>
                      <input
                        type="text"
                        name="reason"
                        required
                        placeholder="e.g. Missing thickness measurement report"
                        mix={textInputStyle}
                      />
                    </div>
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelStyle}>
                        Details for Client (Optional)
                      </label>
                      <textarea
                        name="notes"
                        rows={2}
                        placeholder="Specify requirements for resubmission..."
                        mix={textInputStyle}
                      />
                    </div>
                    <button
                      type="submit"
                      mix={clarifyButtonStyle}
                    >
                      Request Clarification
                    </button>
                  </form>
                </div>

                {/* 3. Station Transfer */}
                <div mix={transferCardStyle}>
                  <h4 mix={transferHeadingStyle}>🔄 Transfer Station</h4>
                  <form method="post" action={routes.triage.transfer.href({ id: request.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelBoldStyle}>
                        Target Station *
                      </label>
                      <select name="new_office_unit_id" required mix={selectTargetStationStyle}>
                        <option value="">-- Select Destination Station --</option>
                        {otherStations.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.name} ({st.code})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelBoldStyle}>
                        Mandatory Justification Reason *
                      </label>
                      <input
                        type="text"
                        name="reason"
                        required
                        placeholder="e.g. Vessel diverted to Ningbo port due to congestion"
                        mix={textInputStyle}
                      />
                    </div>
                    <button
                      type="submit"
                      mix={transferButtonStyle}
                    >
                      Transfer Request
                    </button>
                  </form>
                </div>

                {/* 4. Reject Request */}
                <div mix={rejectCardStyle}>
                  <h4 mix={rejectHeadingStyle}>⛔ Reject Request</h4>
                  <form method="post" action={routes.triage.reject.href({ id: request.id })}>
                    <input type="hidden" name="_csrf" value={csrf} />
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelBoldStyle}>
                        Mandatory Reason *
                      </label>
                      <input
                        type="text"
                        name="reason"
                        required
                        placeholder="e.g. Overdue condition of class; class suspended"
                        mix={textInputStyle}
                      />
                    </div>
                    <div mix={formFieldGroupStyle}>
                      <label mix={fieldLabelStyle}>
                        Rejection Notes (Optional)
                      </label>
                      <textarea
                        name="notes"
                        rows={2}
                        placeholder="Explanation for vessel operator..."
                        mix={textInputStyle}
                      />
                    </div>
                    <button
                      type="submit"
                      mix={rejectButtonStyle}
                    >
                      Reject Request
                    </button>
                  </form>
                </div>
              </div>
            </section>
          ) : !isPending ? (
            <div mix={statusBoxStyle}>
              <strong>Status:</strong> This request is currently in <code>{request.status}</code> state.
              {request.triage_notes ? <p mix={triageNotesMarginStyle}><strong>Triage Notes:</strong> {request.triage_notes}</p> : null}
            </div>
          ) : null}

          {/* Reconstructable Operating History (Audit Trail) */}
          <section mix={auditSectionStyle}>
            <h2>Reconstructable Operating History (audit_trail.*)</h2>
            <p mix={auditDescriptionStyle}>
              Statutory audit trail capturing all lifecycle transitions with actor authority snapshots (job title, grade, unit).
            </p>

            {auditEvents && auditEvents.length > 0 ? (
              <table mix={auditTableStyle}>
                <thead>
                  <tr mix={tableHeaderRowStyle}>
                    <th mix={tableHeaderCellStyle}>Occurred At</th>
                    <th mix={tableHeaderCellStyle}>Event Type</th>
                    <th mix={tableHeaderCellStyle}>Actor</th>
                    <th mix={tableHeaderCellStyle}>Title & Grade</th>
                    <th mix={tableHeaderCellStyle}>Reason</th>
                    <th mix={tableHeaderCellStyle}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEvents.map((e) => (
                    <tr key={e.id} mix={tableRowStyle}>
                      <td mix={tableCellStyle}>{new Date(e.occurred_at).toLocaleString()}</td>
                      <td mix={tableCellBoldStyle}>
                        <code>{e.event_type}</code>
                      </td>
                      <td mix={tableCellStyle}>
                        {e.db_role}
                        {e.actor_id ? <div mix={actorIdSubStyle}>{e.actor_id.slice(0, 8)}...</div> : null}
                      </td>
                      <td mix={tableCellStyle}>
                        {e.actor_title ? (
                          <span>
                            {e.actor_title} (Grade {e.actor_grade})
                          </span>
                        ) : (
                          <span mix={dashMutedStyle}>&mdash;</span>
                        )}
                      </td>
                      <td mix={tableCellStyle}>{e.reason ?? <span mix={dashMutedStyle}>&mdash;</span>}</td>
                      <td mix={auditDetailCellStyle}>
                        {e.detail && Object.keys(e.detail).length > 0 ? JSON.stringify(e.detail) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p mix={noDocumentsStyle}>No audit trail records visible for current session scope.</p>
            )}
          </section>
        </main>
      </Document>
    )
  }
}
