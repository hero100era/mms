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
import type { SurveyDetailProps } from '../types.ts'

const titleRowStyle = css({ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' })
const notesCalloutClarificationStyle = css({
  padding: '1rem 1.25rem',
  borderRadius: '8px',
  marginBottom: '1.5rem',
  backgroundColor: 'var(--warn-bg)',
  color: 'var(--warn-ink)',
  border: '1px solid var(--warn-line)',
})
const notesCalloutRejectedStyle = css({
  padding: '1rem 1.25rem',
  borderRadius: '8px',
  marginBottom: '1.5rem',
  backgroundColor: 'var(--danger-bg)',
  color: 'var(--danger-ink)',
  border: '1px solid var(--danger-line)',
})
const notesCalloutDefaultStyle = css({
  padding: '1rem 1.25rem',
  borderRadius: '8px',
  marginBottom: '1.5rem',
  backgroundColor: 'var(--success-bg)',
  color: 'var(--success-ink)',
  border: '1px solid var(--success-line)',
})
const notesHeadingStyle = css({ margin: '0 0 0.35rem', fontSize: '1rem' })
const zeroMarginStyle = css({ margin: 0 })
const detailsGridStyle = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))',
  gap: '1.15rem',
  marginBottom: '1.5rem',
})
const detailsCardStyle = css({
  backgroundColor: 'var(--panel)',
  border: '1px solid var(--line)',
  padding: '1.15rem 1.35rem',
  borderRadius: '10px',
})
const cardHeadingStyle = css({
  margin: '0 0 0.75rem',
  fontSize: '1.02rem',
  borderBottom: '1px solid var(--line)',
  paddingBottom: '0.45rem',
})
const cardParagraphStyle = css({ margin: '0 0 0.45rem', fontSize: '0.92rem' })
const tagsContainerStyle = css({ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.4rem' })
const tagBadgeStyle = css({
  padding: '0.2rem 0.55rem',
  backgroundColor: 'var(--panel-subtle)',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  fontSize: '0.82rem',
})
const submitPanelStyle = css({
  padding: '1.25rem 1.5rem',
  border: '1px solid var(--info-line)',
  borderRadius: '10px',
  backgroundColor: 'var(--info-bg)',
  color: 'var(--info-ink)',
  marginBottom: '1.5rem',
})
const submitHeadingStyle = css({ margin: '0 0 0.45rem', fontSize: '1.05rem' })
const submitDescriptionStyle = css({ fontSize: '0.9rem', margin: '0 0 1rem' })
const submitFormRowStyle = css({ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' })
const submitInputStyle = css({
  flex: '1 1 16rem',
  minBlockSize: '38px',
  padding: '0.5rem 0.7rem',
  borderRadius: '7px',
  border: '1px solid var(--line-strong)',
  backgroundColor: 'var(--panel)',
  color: 'var(--ink)',
})
const auditListStyle = css({ listStyle: 'none', padding: 0, margin: 0 })
const auditItemStyle = css({
  marginBottom: '0.75rem',
  padding: '0.85rem 1rem',
  borderRadius: '8px',
  backgroundColor: 'var(--panel-subtle)',
  border: '1px solid var(--line)',
  borderLeft: '4px solid var(--accent)',
  '&:last-child': { marginBottom: 0 },
})
const auditHeaderStyle = css({ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.88rem' })
const auditTimeStyle = css({ color: 'var(--muted)' })
const auditActorStyle = css({ fontSize: '0.82rem', color: 'var(--muted)', marginTop: '0.2rem' })
const auditReasonStyle = css({ marginTop: '0.35rem', fontSize: '0.9rem' })

export function SurveyDetailPage(handle: Handle<SurveyDetailProps>) {
  return () => {
    let { csrf, role, request, versions = [], auditEvents, message, error } = handle.props
    let isReadOnly = ['int_viewer', 'int_compliance'].includes(role)
    let canSubmit = (request.status === 'draft' || request.status === 'clarification_requested') && !isReadOnly

    return (
      <Document title={`Survey Request ${request.request_no} | MMS`}>
        <main mix={pageShellStyle}>
          <nav aria-label="Breadcrumb" mix={breadcrumbNavStyle}>
            <a href={routes.session.home.href()}>Home</a>
            <span aria-hidden="true">/</span>
            <a href={routes.survey.index.href()}>Survey Requests</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{request.request_no}</span>
          </nav>

          <header mix={heroHeaderStyle}>
            <div>
              <div mix={titleRowStyle}>
                <h1 mix={heroTitleStyle}>{request.request_no}</h1>
                <StatusBadge status={request.status} />
              </div>
              <p mix={heroSubtitleStyle}>
                Vessel:{' '}
                <strong>
                  <a href={routes.ships.detail.href({ id: request.ship_id })}>{request.ship_name}</a>
                </strong>{' '}
                (<span mix={monoTextStyle}>IMO {request.ship_imo_number}</span>) | Attending Station:{' '}
                <strong>{request.station_name}</strong>
              </p>
            </div>
            <div mix={actionGroupStyle}>
              {role.startsWith('int_') ? (
                <a
                  href={routes.triage.detail.href({ id: request.id })}
                  mix={primaryLinkButtonStyle}
                >
                  Open Triage Review &rarr;
                </a>
              ) : null}
              <a href={routes.survey.index.href()} mix={secondaryLinkButtonStyle}>
                &larr; Back to Survey Requests
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

          {request.triage_notes ? (
            <div
              mix={
                request.status === 'clarification_requested'
                  ? notesCalloutClarificationStyle
                  : request.status === 'rejected'
                  ? notesCalloutRejectedStyle
                  : notesCalloutDefaultStyle
              }
            >
              <h2 mix={notesHeadingStyle}>
                {request.status === 'clarification_requested'
                  ? 'Station Clarification Required'
                  : request.status === 'rejected'
                  ? 'Rejection Justification'
                  : 'Station Triage Notes'}
              </h2>
              <p mix={zeroMarginStyle}>{request.triage_notes}</p>
            </div>
          ) : null}

          <section aria-label="Request details" mix={detailsGridStyle}>
            <div mix={detailsCardStyle}>
              <h2 mix={cardHeadingStyle}>Port &amp; Attendance Schedule</h2>
              <p mix={cardParagraphStyle}>
                <strong>Port:</strong> {request.port_name}, {request.port_country}{' '}
                {request.port_code ? `(${request.port_code})` : ''}
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
              <h2 mix={cardHeadingStyle}>Scope &amp; Contacts</h2>
              <div mix={cardParagraphStyle}>
                <strong>Survey Types:</strong>
                <div mix={tagsContainerStyle}>
                  {request.survey_types?.length > 0 ? (
                    request.survey_types.map((st) => (
                      <span key={st} mix={tagBadgeStyle}>
                        {st}
                      </span>
                    ))
                  ) : (
                    <span mix={mutedNoteStyle}>None specified</span>
                  )}
                </div>
              </div>
              {request.scope_description ? (
                <p mix={cardParagraphStyle}>
                  <strong>Description:</strong> {request.scope_description}
                </p>
              ) : null}
              {request.agent_contact && Object.keys(request.agent_contact).length > 0 ? (
                <p mix={cardParagraphStyle}>
                  <strong>Port Agent:</strong> {request.agent_contact.name ?? ''} |{' '}
                  {request.agent_contact.email ?? ''} | {request.agent_contact.phone ?? ''}
                </p>
              ) : null}
            </div>
          </section>

          {canSubmit ? (
            <section mix={submitPanelStyle}>
              <h2 mix={submitHeadingStyle}>Submit for Station Triage</h2>
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
                    aria-label="Submission note or reason"
                    defaultValue={
                      request.status === 'clarification_requested'
                        ? 'Resubmitted with requested clarifications'
                        : 'Submitted for station triage'
                    }
                    placeholder="Submission note / reason..."
                    mix={submitInputStyle}
                  />
                  <button type="submit" mix={primaryLinkButtonStyle}>
                    Submit Request
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          <section mix={panelCardStyle}>
            <div mix={sectionHeaderRowStyle}>
              <h2 id="survey-docs-heading" mix={sectionTitleStyle}>
                Attached Documents <span mix={countPillStyle}>{versions.length}</span>
              </h2>
            </div>
            {versions.length === 0 ? (
              <p mix={mutedNoteStyle}>No documents attached to this survey request.</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="survey-docs-heading"
                mix={tableRegionStyle}
              >
                <table mix={dataTableStyle}>
                  <caption mix={tableCaptionStyle}>Attached supporting document revisions</caption>
                  <thead mix={tableHeadStyle}>
                    <tr>
                      <th scope="col" mix={tableThStyle}>File Name</th>
                      <th scope="col" mix={tableThStyle}>Revision</th>
                      <th scope="col" mix={tableThStyle}>Type</th>
                      <th scope="col" mix={tableThStyle}>Size</th>
                      <th scope="col" mix={tableThStyle}>Uploaded</th>
                      <th scope="col" mix={tableThStyle}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id} mix={tableTrStyle}>
                        <td mix={tableTdBoldStyle}>{v.file_name}</td>
                        <td mix={tableTdStyle}>r{v.revision_no}</td>
                        <td mix={tableTdStyle}>{v.mime_type}</td>
                        <td mix={tableTdStyle}>{(v.byte_size / 1024).toFixed(1)} KB</td>
                        <td mix={tableTdStyle}>{new Date(v.created_at).toLocaleDateString()}</td>
                        <td mix={tableTdStyle}>
                          <a
                            href={routes.uploads.documentDownload.href({
                              documentId: v.document_id,
                              versionId: v.id,
                            })}
                            mix={compactActionLinkStyle}
                          >
                            Download
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {auditEvents && auditEvents.length > 0 ? (
            <section mix={panelCardStyle}>
              <div mix={sectionHeaderRowStyle}>
                <h2 mix={sectionTitleStyle}>
                  Activity &amp; Audit History <span mix={countPillStyle}>{auditEvents.length}</span>
                </h2>
              </div>
              <ul mix={auditListStyle}>
                {auditEvents.map((evt) => (
                  <li key={evt.id} mix={auditItemStyle}>
                    <div mix={auditHeaderStyle}>
                      <strong mix={monoTextStyle}>{evt.event_type}</strong>
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
