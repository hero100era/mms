import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import type { SurveyDetailProps } from '../types.ts'

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '56rem', margin: '2rem auto', padding: '0 1rem' })
const headerFlexStyle = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #ddd', paddingBottom: '1rem', marginBottom: '1.5rem' })
const titleRowStyle = css({ display: 'flex', alignItems: 'center', gap: '0.75rem' })
const zeroMarginStyle = css({ margin: 0 })
const headerSubtitleStyle = css({ margin: '0.35rem 0 0', color: '#555' })
const triageReviewButtonStyle = css({
  display: 'inline-block',
  padding: '0.5rem 1rem',
  background: '#198754',
  color: '#fff',
  textDecoration: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
})
const successBannerStyle = css({ padding: '0.75rem', background: '#d1e7dd', color: '#0f5132', borderRadius: '4px' })
const errorBannerStyle = css({ padding: '0.75rem', background: '#f8d7da', color: '#842029', borderRadius: '4px' })
const triageNotesClarificationStyle = css({ padding: '1rem', borderRadius: '6px', marginBottom: '1.5rem', background: '#fff3cd', border: '1px solid #ffc107' })
const triageNotesRejectedStyle = css({ padding: '1rem', borderRadius: '6px', marginBottom: '1.5rem', background: '#f8d7da', border: '1px solid #dc3545' })
const triageNotesDefaultStyle = css({ padding: '1rem', borderRadius: '6px', marginBottom: '1.5rem', background: '#e2f0d9', border: '1px solid #198754' })
const notesHeadingStyle = css({ margin: '0 0 0.35rem' })
const detailsGridStyle = css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' })
const detailsCardStyle = css({ background: '#f8f9fa', padding: '1rem', borderRadius: '6px' })
const cardHeadingStyle = css({ margin: '0 0 0.75rem' })
const cardParagraphStyle = css({ margin: '0 0 0.4rem' })
const marginBottomHalfRem = css({ marginBottom: '0.5rem' })
const tagsContainerStyle = css({ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' })
const tagBadgeStyle = css({ padding: '0.2rem 0.5rem', background: '#e9ecef', borderRadius: '3px', fontSize: '0.8rem' })
const noneSpecifiedStyle = css({ color: '#888' })
const scopeParagraphStyle = css({ margin: '0.5rem 0 0.4rem' })
const agentInfoStyle = css({ marginTop: '0.5rem', fontSize: '0.85rem' })
const submitSectionStyle = css({ padding: '1.25rem', border: '1px solid #0d6efd', borderRadius: '6px', background: '#f0f7ff', marginBottom: '2rem' })
const submitHeadingStyle = css({ margin: '0 0 0.5rem', color: '#084298' })
const submitDescriptionStyle = css({ fontSize: '0.9rem', color: '#555', margin: '0 0 1rem' })
const submitFormRowStyle = css({ display: 'flex', gap: '0.75rem', alignItems: 'center' })
const submitInputStyle = css({ flex: 1, padding: '0.5rem', boxSizing: 'border-box' })
const submitButtonStyle = css({
  padding: '0.55rem 1.2rem',
  background: '#0d6efd',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})
const documentsSectionStyle = css({ marginBottom: '2.5rem' })
const documentsHeaderStyle = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' })
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
const auditSectionStyle = css({ borderTop: '1px solid #ddd', paddingTop: '1.5rem' })
const auditListStyle = css({ listStyle: 'none', padding: 0 })
const auditItemStyle = css({
  marginBottom: '0.75rem',
  padding: '0.75rem',
  borderRadius: '4px',
  background: '#f8f9fa',
  borderLeft: '4px solid #0d6efd',
})
const auditHeaderStyle = css({ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' })
const auditTimeStyle = css({ color: '#666' })
const auditActorStyle = css({ fontSize: '0.8rem', color: '#555', marginTop: '0.2rem' })
const auditReasonStyle = css({ marginTop: '0.35rem', fontSize: '0.9rem' })

export function SurveyDetailPage(handle: Handle<SurveyDetailProps>) {
  return () => {
    let { csrf, role, request, documents, versions = [], auditEvents, message, error } = handle.props
    let isReadOnly = ['int_viewer', 'int_compliance'].includes(role)
    let canSubmit = (request.status === 'draft' || request.status === 'clarification_requested') && !isReadOnly

    return (
      <Document title={`Survey Request ${request.request_no}`}>
        <main mix={mainContainerStyle}>
          <p>
            <a href={routes.survey.index.href()}>&larr; Back to Survey Requests</a>
          </p>

          <header mix={headerFlexStyle}>
            <div>
              <div mix={titleRowStyle}>
                <h1 mix={zeroMarginStyle}>{request.request_no}</h1>
                <StatusBadge status={request.status} />
              </div>
              <p mix={headerSubtitleStyle}>
                Vessel: <strong>{request.ship_name}</strong> (IMO: {request.ship_imo_number}) | Attending Station: <strong>{request.station_name}</strong>
              </p>
            </div>
            <div>
              {role.startsWith('int_') ? (
                <a
                  href={routes.triage.detail.href({ id: request.id })}
                  mix={triageReviewButtonStyle}
                >
                  Open Triage Review &rarr;
                </a>
              ) : null}
            </div>
          </header>

          {message ? <p role="status" mix={successBannerStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorBannerStyle}>{error}</p> : null}

          {/* Coordinator feedback / triage notes callout */}
          {request.triage_notes ? (
            <div
              mix={
                request.status === 'clarification_requested'
                  ? triageNotesClarificationStyle
                  : request.status === 'rejected'
                  ? triageNotesRejectedStyle
                  : triageNotesDefaultStyle
              }
            >
              <h4 mix={notesHeadingStyle}>
                {request.status === 'clarification_requested'
                  ? '⚠️ Station Clarification Required'
                  : request.status === 'rejected'
                  ? '⛔ Rejection Justification'
                  : 'ℹ️ Station Triage Notes'}
              </h4>
              <p mix={zeroMarginStyle}>{request.triage_notes}</p>
            </div>
          ) : null}

          {/* Details grid */}
          <section mix={detailsGridStyle}>
            <div mix={detailsCardStyle}>
              <h3 mix={cardHeadingStyle}>Port & Attendance Schedule</h3>
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
                <strong>Assigned Station:</strong> {request.station_name}
              </p>
            </div>

            <div mix={detailsCardStyle}>
              <h3 mix={cardHeadingStyle}>Scope & Contacts</h3>
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
                    <span mix={noneSpecifiedStyle}>None specified</span>
                  )}
                </div>
              </div>
              {request.scope_description ? (
                <p mix={scopeParagraphStyle}>
                  <strong>Description:</strong> {request.scope_description}
                </p>
              ) : null}
              {request.agent_contact && Object.keys(request.agent_contact).length > 0 ? (
                <div mix={agentInfoStyle}>
                  <strong>Port Agent:</strong> {request.agent_contact.name ?? ''} | {request.agent_contact.email ?? ''} | {request.agent_contact.phone ?? ''}
                </div>
              ) : null}
            </div>
          </section>

          {/* Submit action for client */}
          {canSubmit ? (
            <section mix={submitSectionStyle}>
              <h3 mix={submitHeadingStyle}>Submit for Station Triage</h3>
              <p mix={submitDescriptionStyle}>
                {request.status === 'clarification_requested'
                  ? 'You have updated information or uploaded requested documents. Submit this request back to the station coordinator.'
                  : 'Submit this draft request to the attending station to initiate formal review and surveyor assignment.'}
              </p>
              <form method="post" action={routes.survey.submit.href({ id: request.id })}>
                <input type="hidden" name="_csrf" value={csrf} />
                <div mix={submitFormRowStyle}>
                  <input
                    type="text"
                    name="reason"
                    defaultValue={request.status === 'clarification_requested' ? 'Resubmitted with requested clarifications' : 'Submitted for station triage'}
                    placeholder="Submission note / reason..."
                    mix={submitInputStyle}
                  />
                  <button
                    type="submit"
                    mix={submitButtonStyle}
                  >
                    Submit Request
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {/* Attached documents */}
          <section mix={documentsSectionStyle}>
            <div mix={documentsHeaderStyle}>
              <h3 mix={zeroMarginStyle}>Attached Documents</h3>
            </div>
            {versions.length === 0 ? (
              <p mix={noDocumentsStyle}>No documents attached to this survey request.</p>
            ) : (
              <table mix={tableStyle}>
                <thead>
                  <tr mix={tableHeaderRowStyle}>
                    <th mix={tableHeaderCellStyle}>File Name</th>
                    <th mix={tableHeaderCellStyle}>Revision</th>
                    <th mix={tableHeaderCellStyle}>Type</th>
                    <th mix={tableHeaderCellStyle}>Size</th>
                    <th mix={tableHeaderCellStyle}>Uploaded</th>
                    <th mix={tableHeaderCellStyle}>Action</th>
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

          {/* Audit Timeline */}
          {auditEvents && auditEvents.length > 0 ? (
            <section mix={auditSectionStyle}>
              <h3>Activity & Audit History</h3>
              <ul mix={auditListStyle}>
                {auditEvents.map((evt) => (
                  <li
                    key={evt.id}
                    mix={auditItemStyle}
                  >
                    <div mix={auditHeaderStyle}>
                      <strong>{evt.event_type}</strong>
                      <span mix={auditTimeStyle}>{new Date(evt.occurred_at).toLocaleString()}</span>
                    </div>
                    {evt.actor_title ? (
                      <div mix={auditActorStyle}>
                        Actor: {evt.db_role} &bull; Title: {evt.actor_title} (Grade {evt.actor_grade})
                      </div>
                    ) : null}
                    {evt.reason ? (
                      <div mix={auditReasonStyle}>
                        <em>Reason:</em> {evt.reason}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </main>
      </Document>
    )
  }
}
