import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'

export type ForgotPasswordProps = {
  csrf: string
  submitted?: boolean
  error?: string
}

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '34rem', margin: '4rem auto', padding: '0 1rem' })
const successBoxStyle = css({ color: 'green', marginTop: '1rem', marginBottom: '1.5rem' })
const errorAlertStyle = css({ color: 'red' })
const backLinkParagraphStyle = css({ marginTop: '1.5rem' })
const oauthSectionStyle = css({ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1.5rem' })
const inlineOAuthFormStyle = css({ display: 'inline', marginRight: '1rem' })
const inlineFormStyle = css({ display: 'inline' })

export function ForgotPasswordPage(handle: Handle<ForgotPasswordProps>) {
  return () => {
    let { csrf, submitted, error } = handle.props
    return (
      <Document title="Reset password">
        <main mix={mainContainerStyle}>
          <h1>Reset password</h1>
          {submitted ? (
            <div role="status" mix={successBoxStyle}>
              <p>If an account with that email exists, we have sent instructions to reset your password.</p>
              <p>
                <a href={routes.session.login.href()}>Return to sign in</a>
              </p>
            </div>
          ) : (
            <>
              <p>Enter the email address associated with your external account and we will send you a reset link.</p>
              {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
              <form method="post" action={routes.session.forgotPasswordSubmit.href()}>
                <input type="hidden" name="_csrf" value={csrf} />
                <p>
                  <label>
                    Email <input type="email" name="email" required />
                  </label>
                </p>
                <button type="submit">Send reset link</button>
              </form>
              <p mix={backLinkParagraphStyle}>
                <a href={routes.session.login.href()}>Back to sign in</a>
              </p>
            </>
          )}
        </main>
      </Document>
    )
  }
}

export type ResetPasswordProps = {
  token: string
  csrf: string
  error?: string
}

export function ResetPasswordPage(handle: Handle<ResetPasswordProps>) {
  return () => {
    let { token, csrf, error } = handle.props
    return (
      <Document title="Set new password">
        <main mix={mainContainerStyle}>
          <h1>Set new password</h1>
          <p>Please enter your new password (minimum 12 characters).</p>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          <form method="post" action={routes.session.resetPasswordSubmit.href({ token })}>
            <input type="hidden" name="_csrf" value={csrf} />
            <p>
              <label>
                New password{' '}
                <input type="password" name="password" minLength={12} required />
              </label>
            </p>
            <p>
              <label>
                Confirm password{' '}
                <input type="password" name="confirmPassword" minLength={12} required />
              </label>
            </p>
            <button type="submit">Reset password</button>
          </form>
          <p mix={backLinkParagraphStyle}>
            <a href={routes.session.login.href()}>Back to sign in</a>
          </p>
        </main>
      </Document>
    )
  }
}

export type InviteProps = {
  token: string
  csrf: string
  error?: string
}

export function InvitePage(handle: Handle<InviteProps>) {
  return () => {
    let { token, csrf, error } = handle.props
    return (
      <Document title="Accept invitation">
        <main mix={mainContainerStyle}>
          <h1>Welcome to MMS</h1>
          <p>Please set your password to activate your account (minimum 12 characters).</p>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          <form method="post" action={routes.identity.accept.href({ token })}>
            <input type="hidden" name="_csrf" value={csrf} />
            <p>
              <label>
                New password{' '}
                <input type="password" name="password" minLength={12} required />
              </label>
            </p>
            <p>
              <label>
                Confirm password{' '}
                <input type="password" name="confirmPassword" minLength={12} required />
              </label>
            </p>
            <button type="submit">Set password and sign in</button>
          </form>

          <div mix={oauthSectionStyle}>
            <h2>Or activate by linking an account</h2>
            <form method="post" action={routes.identity.linkInvite.href({ token, provider: 'microsoft' })} mix={inlineOAuthFormStyle}>
              <input type="hidden" name="_csrf" value={csrf} />
              <button type="submit">Activate with Microsoft</button>
            </form>
            <form method="post" action={routes.identity.linkInvite.href({ token, provider: 'google' })} mix={inlineFormStyle}>
              <input type="hidden" name="_csrf" value={csrf} />
              <button type="submit">Activate with Google</button>
            </form>
          </div>
        </main>
      </Document>
    )
  }
}
