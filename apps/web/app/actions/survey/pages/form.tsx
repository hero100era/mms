import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import type { NewSurveyProps } from '../types.ts'

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '44rem', margin: '2rem auto', padding: '0 1rem' })
const subtitleStyle = css({ color: '#555' })
const errorBannerStyle = css({ padding: '0.75rem', background: '#f8d7da', color: '#842029', borderRadius: '4px' })
const warningBannerStyle = css({ padding: '1rem', background: '#fff3cd', color: '#664d03', borderRadius: '4px' })
const formContainerStyle = css({ marginTop: '1.5rem' })
const formGroupStyle = css({ marginBottom: '1.25rem' })
const fieldLabelStyle = css({ display: 'block', fontWeight: 'bold', marginBottom: '0.3rem' })
const selectFieldStyle = css({ width: '100%', padding: '0.5rem', fontSize: '1rem' })
const hintTextStyle = css({ color: '#666', display: 'block', marginTop: '0.2rem' })
const portGridStyle = css({ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' })
const textInputStyle = css({ width: '100%', padding: '0.5rem', boxSizing: 'border-box' })
const datesGridStyle = css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' })
const surveyTypesContainerStyle = css({ marginBottom: '1.25rem', padding: '1rem', background: '#f8f9fa', borderRadius: '4px' })
const surveyTypesLabelStyle = css({ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' })
const surveyTypesGridStyle = css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' })
const checkboxLabelStyle = css({ display: 'flex', alignItems: 'center', gap: '0.4rem' })
const agentSectionStyle = css({ marginBottom: '1.5rem', padding: '1rem', border: '1px solid #e0e0e0', borderRadius: '4px' })
const agentHeadingStyle = css({ margin: '0 0 0.5rem' })
const agentGridStyle = css({ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' })
const agentLabelStyle = css({ display: 'block', fontSize: '0.85rem' })
const agentInputStyle = css({ width: '100%', padding: '0.4rem', boxSizing: 'border-box' })
const buttonsContainerStyle = css({ display: 'flex', gap: '1rem' })
const draftButtonStyle = css({
  padding: '0.6rem 1.2rem',
  background: '#6c757d',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})
const submitButtonStyle = css({
  padding: '0.6rem 1.2rem',
  background: '#0d6efd',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 'bold',
  cursor: 'pointer',
})

export function NewSurveyRequestPage(handle: Handle<NewSurveyProps>) {
  return () => {
    let { csrf, ships, stations, orgs, error, values } = handle.props

    return (
      <Document title="Create Survey Request">
        <main mix={mainContainerStyle}>
          <p>
            <a href={routes.survey.index.href()}>&larr; Back to Survey Requests</a>
          </p>
          <h1>Create Survey Request</h1>
          <p mix={subtitleStyle}>
            Submit notice of upcoming port call for classification attendance.
          </p>

          {error ? <p role="alert" mix={errorBannerStyle}>{error}</p> : null}

          {ships.length === 0 ? (
            <div mix={warningBannerStyle}>
              <strong>No eligible vessels found:</strong> You must have an active affiliation with at least one classed vessel to submit a request.
            </div>
          ) : (
            <form method="post" action={routes.survey.create.href()} mix={formContainerStyle}>
              <input type="hidden" name="_csrf" value={csrf} />

              {/* Vessel selection */}
              <div mix={formGroupStyle}>
                <label mix={fieldLabelStyle}>
                  Vessel *
                </label>
                <select name="ship_id" required mix={selectFieldStyle}>
                  <option value="">-- Select Vessel --</option>
                  {ships.map((s) => (
                    <option key={s.id} value={s.id} selected={values?.ship_id === s.id}>
                      {s.name} (IMO {s.imo_number}) &mdash; {s.ship_type}
                    </option>
                  ))}
                </select>
              </div>

              {/* Organization (if multiple) */}
              {orgs.length > 1 ? (
                <div mix={formGroupStyle}>
                  <label mix={fieldLabelStyle}>
                    Requesting Organization *
                  </label>
                  <select name="org_id" required mix={selectFieldStyle}>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id} selected={values?.org_id === o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
              ) : orgs.length === 1 ? (
                <input type="hidden" name="org_id" value={values?.org_id ?? orgs[0].id} />
              ) : null}

              {/* Attending Station */}
              <div mix={formGroupStyle}>
                <label mix={fieldLabelStyle}>
                  Attending Station *
                </label>
                <select name="office_unit_id" required mix={selectFieldStyle}>
                  <option value="">-- Select Attending Station --</option>
                  {stations.map((st) => (
                    <option key={st.id} value={st.id} selected={values?.office_unit_id === st.id}>
                      {st.name} ({st.code})
                    </option>
                  ))}
                </select>
                <small mix={hintTextStyle}>
                  Select the society office responsible for survey attendance at the port of call.
                </small>
              </div>

              {/* Port details */}
              <div mix={portGridStyle}>
                <div>
                  <label mix={fieldLabelStyle}>
                    Port Name *
                  </label>
                  <input
                    type="text"
                    name="port_name"
                    placeholder="e.g. Port of Shanghai"
                    defaultValue={values?.port_name ?? ''}
                    required
                    mix={textInputStyle}
                  />
                </div>
                <div>
                  <label mix={fieldLabelStyle}>
                    Country Code *
                  </label>
                  <input
                    type="text"
                    name="port_country"
                    defaultValue={values?.port_country ?? 'CN'}
                    maxLength={2}
                    required
                    mix={textInputStyle}
                  />
                </div>
                <div>
                  <label mix={fieldLabelStyle}>
                    UN/LOCODE
                  </label>
                  <input
                    type="text"
                    name="port_code"
                    placeholder="e.g. CNSHA"
                    defaultValue={values?.port_code ?? ''}
                    maxLength={5}
                    mix={textInputStyle}
                  />
                </div>
              </div>

              {/* Port schedule */}
              <div mix={datesGridStyle}>
                <div>
                  <label mix={fieldLabelStyle}>
                    Estimated Arrival (ETA) *
                  </label>
                  <input
                    type="datetime-local"
                    name="estimated_arrival"
                    defaultValue={values?.estimated_arrival ?? ''}
                    required
                    mix={textInputStyle}
                  />
                </div>
                <div>
                  <label mix={fieldLabelStyle}>
                    Estimated Departure (ETD) *
                  </label>
                  <input
                    type="datetime-local"
                    name="estimated_departure"
                    defaultValue={values?.estimated_departure ?? ''}
                    required
                    mix={textInputStyle}
                  />
                </div>
              </div>

              {/* Survey types checkboxes */}
              <div mix={surveyTypesContainerStyle}>
                <label mix={surveyTypesLabelStyle}>
                  Requested Survey Types *
                </label>
                <div mix={surveyTypesGridStyle}>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="annual_hull"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('annual_hull') : true}
                    />
                    Annual Hull Survey
                  </label>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="annual_machinery"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('annual_machinery') : true}
                    />
                    Annual Machinery Survey
                  </label>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="docking"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('docking') : false}
                    />
                    Docking Survey / Drydock
                  </label>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="intermediate"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('intermediate') : false}
                    />
                    Intermediate Class Survey
                  </label>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="special_survey"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('special_survey') : false}
                    />
                    Special Class Renewal
                  </label>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="ism_renewal"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('ism_renewal') : false}
                    />
                    ISM Code Verification / Renewal
                  </label>
                  <label mix={checkboxLabelStyle}>
                    <input
                      type="checkbox"
                      name="survey_types"
                      value="damage_survey"
                      defaultChecked={values?.survey_types ? values.survey_types.includes('damage_survey') : false}
                    />
                    Damage / Occasional Inspection
                  </label>
                </div>
              </div>

              {/* Scope description */}
              <div mix={formGroupStyle}>
                <label mix={fieldLabelStyle}>
                  Scope Description / Special Instructions
                </label>
                <textarea
                  name="scope_description"
                  rows={3}
                  placeholder="Detail any specific items, holds, machinery, or class conditions to be addressed..."
                  defaultValue={values?.scope_description ?? ''}
                  mix={textInputStyle}
                />
              </div>

              {/* Agent contact */}
              <div mix={agentSectionStyle}>
                <h4 mix={agentHeadingStyle}>Local Port Agent Information</h4>
                <div mix={agentGridStyle}>
                  <div>
                    <label mix={agentLabelStyle}>Agent Name</label>
                    <input
                      type="text"
                      name="agent_name"
                      placeholder="Contact person"
                      defaultValue={values?.agent_name ?? ''}
                      mix={agentInputStyle}
                    />
                  </div>
                  <div>
                    <label mix={agentLabelStyle}>Agent Email</label>
                    <input
                      type="email"
                      name="agent_email"
                      placeholder="agent@agency.com"
                      defaultValue={values?.agent_email ?? ''}
                      mix={agentInputStyle}
                    />
                  </div>
                  <div>
                    <label mix={agentLabelStyle}>Agent Phone</label>
                    <input
                      type="tel"
                      name="agent_phone"
                      placeholder="+86 21 ..."
                      defaultValue={values?.agent_phone ?? ''}
                      mix={agentInputStyle}
                    />
                  </div>
                </div>
              </div>

              {/* Submission buttons */}
              <div mix={buttonsContainerStyle}>
                <button
                  type="submit"
                  name="submit_action"
                  value="draft"
                  mix={draftButtonStyle}
                >
                  Save as Draft
                </button>
                <button
                  type="submit"
                  name="submit_action"
                  value="submit"
                  mix={submitButtonStyle}
                >
                  Save & Submit for Triage
                </button>
              </div>
            </form>
          )}
        </main>
      </Document>
    )
  }
}
