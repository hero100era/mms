import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'

export type StepUpProps = {
  csrf: string
  returnTo: string
  error?: string
  googleEnabled?: boolean
  entraEnabled?: boolean
}

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '34rem', margin: '4rem auto', padding: '0 1rem' })
const errorAlertStyle = css({ color: 'red' })
const statusSuccessStyle = css({ color: 'green' })
const oauthSectionStyle = css({ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1.5rem' })
const inlineOAuthFormStyle = css({ display: 'inline', marginRight: '1rem' })
const inlineFormStyle = css({ display: 'inline' })
const linksMarginStyle = css({ marginTop: '2rem' })
const breakAllStyle = css({ wordBreak: 'break-all' })

export function StepUpPage(handle: Handle<StepUpProps>) {
  return () => {
    let { csrf, returnTo, error, googleEnabled, entraEnabled } = handle.props
    return (
      <Document title="Confirm identity">
        <main mix={mainContainerStyle}>
          <h1>Security verification</h1>
          <p>Recent authentication is required to perform this action. Please confirm your identity.</p>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          <form method="post" action={routes.mfa.stepUpSubmit.href()}>
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <p>
              <label>
                Password <input type="password" name="password" required />
              </label>
            </p>
            <button type="submit">Confirm password</button>
          </form>

          {entraEnabled || googleEnabled ? (
            <div mix={oauthSectionStyle}>
              <h2>Or confirm with linked account</h2>
              {entraEnabled ? (
                <form method="post" action={routes.mfa.stepUpOAuth.href({ provider: 'microsoft' })} mix={inlineOAuthFormStyle}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit">Confirm with Microsoft</button>
                </form>
              ) : null}
              {googleEnabled ? (
                <form method="post" action={routes.mfa.stepUpOAuth.href({ provider: 'google' })} mix={inlineFormStyle}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit">Confirm with Google</button>
                </form>
              ) : null}
            </div>
          ) : null}
        </main>
      </Document>
    )
  }
}

export type MfaProps = {
  csrf: string
  returnTo: string
  error?: string
}

export function MfaPage(handle: Handle<MfaProps>) {
  return () => {
    let { csrf, returnTo, error } = handle.props
    return (
      <Document title="Two-step verification">
        <main mix={mainContainerStyle}>
          <h1>Two-step verification</h1>
          <p>Enter the six-digit code from your authenticator app.</p>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          <form method="post" action={routes.mfa.submit.href()}>
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <p>
              <label>
                Code{' '}
                <input
                  type="text"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,8}"
                  maxLength={8}
                  required
                  autoFocus
                />
              </label>
            </p>
            <button type="submit">Verify</button>
          </form>
          {/* Unenrolled users are redirected to /mfa/enrol automatically by challenge(). */}
        </main>
      </Document>
    )
  }
}

export type MfaEnrolProps = {
  csrf: string
  /** otpauth:// URI, or null when no secret has been generated for this session yet. */
  otpauthUri: string | null
  secretLabel: string | null
  error?: string
  message?: string
}

export function MfaEnrolPage(handle: Handle<MfaEnrolProps>) {
  return () => {
    let { csrf, otpauthUri, secretLabel, error, message } = handle.props
    return (
      <Document title="Set up two-step verification">
        <main mix={mainContainerStyle}>
          <h1>Set up two-step verification</h1>
          {message ? <p role="status" mix={statusSuccessStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          {otpauthUri ? (
            <>
              <p>
                Add this account to your authenticator app, then confirm with the code it shows.
              </p>
              <p>
                Manual entry key: <code>{secretLabel}</code>
              </p>
              <p mix={breakAllStyle}>
                <code>{otpauthUri}</code>
              </p>
              {secretLabel ? (
                <form method="post" action={routes.mfa.enrolSubmit.href()}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <p>
                    <label>
                      Code from the app{' '}
                      <input
                        type="text"
                        name="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6,8}"
                        maxLength={8}
                        required
                      />
                    </label>
                  </p>
                  <button type="submit">Confirm and enable</button>
                </form>
              ) : null}
            </>
          ) : (
            <form method="post" action={routes.mfa.enrolSubmit.href()}>
              <input type="hidden" name="_csrf" value={csrf} />
              <button type="submit">Generate a key</button>
            </form>
          )}
        </main>
      </Document>
    )
  }
}
