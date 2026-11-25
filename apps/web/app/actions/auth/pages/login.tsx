import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import { DEV_PERSONAS, type DevPersona } from '../../../auth/dev-personas.ts'

export type LoginProps = {
  csrf: string
  entraEnabled: boolean
  googleEnabled?: boolean
  devEnabled: boolean
  message?: string
  error?: string
}

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '34rem', margin: '4rem auto', padding: '0 1rem' })
const successMessageStyle = css({ color: 'green' })
const errorAlertStyle = css({ color: 'red' })
const passwordFormStyle = css({ marginTop: '2rem' })
const forgotPasswordLinkStyle = css({ marginTop: '1rem' })
const devBoxStyle = css({ marginTop: '2rem', padding: '1rem', border: '1px solid #d0d7de', borderRadius: '6px', background: '#f6f8fa' })
const devHeadingStyle = css({ margin: '0 0 0.5rem 0', fontSize: '1.1rem' })
const devDescriptionStyle = css({ margin: '0 0 1rem 0', fontSize: '0.85rem', color: '#57606a' })
const devSelectStyle = css({ padding: '0.4rem', borderRadius: '4px', border: '1px solid #d0d7de', maxWidth: '100%' })
const devButtonStyle = css({
  padding: '0.4rem 1rem',
  cursor: 'pointer',
  background: '#0969da',
  color: 'white',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 600,
})
const devBrowseSpanStyle = css({ marginLeft: '1rem', fontSize: '0.85rem' })
const devPageMainStyle = css({ fontFamily: 'system-ui', maxWidth: '56rem', margin: '2rem auto', padding: '0 1rem' })
const devGridStyle = css({ display: 'grid', gap: '1rem', marginTop: '1.5rem' })
const devCardStyle = css({
  border: '1px solid #d0d7de',
  borderRadius: '6px',
  padding: '1rem',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: '#f6f8fa',
})
const devCardHeadingStyle = css({ margin: '0 0 0.25rem 0' })
const devCardSubStyle = css({ fontSize: '0.85rem', color: '#57606a' })
const devCardScopeStyle = css({ fontSize: '0.85rem', color: '#57606a', marginTop: '0.25rem' })
const devCardNotesStyle = css({ fontSize: '0.8rem', color: '#6e7781', fontStyle: 'italic', marginTop: '0.25rem' })
const devCardSubmitStyle = css({
  padding: '0.5rem 1.25rem',
  cursor: 'pointer',
  background: '#0969da',
  color: 'white',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 600,
})
const returnLinkStyle = css({ marginTop: '2rem' })

export function LoginPage(handle: Handle<LoginProps>) {
  return () => {
    let { csrf, entraEnabled, googleEnabled, devEnabled, message, error } = handle.props
    return (
      <Document title="Sign in">
        <main mix={mainContainerStyle}>
          <h1>MMS</h1>
          {message ? <p role="status" mix={successMessageStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          {entraEnabled ? (
            <p>
              <a href={routes.auth.start.href()}>Sign in with Microsoft</a>
            </p>
          ) : (
            <p>Microsoft sign-in is not configured in this environment.</p>
          )}

          {googleEnabled ? (
            <p>
              <a href={routes.auth.googleStart.href()}>Sign in with Google</a>
            </p>
          ) : null}

          <form method="post" action={routes.session.loginPassword.href()} mix={passwordFormStyle}>
            <input type="hidden" name="_csrf" value={csrf} />
            <h2>External account sign-in</h2>
            <p>
              <label>
                Email <input type="email" name="email" required />
              </label>
            </p>
            <p>
              <label>
                Password <input type="password" name="password" required />
              </label>
            </p>
            <button type="submit">Sign in with password</button>
          </form>

          <p mix={forgotPasswordLinkStyle}>
            <a href={routes.session.forgotPassword.href()}>Forgot password?</a>
          </p>

          {devEnabled ? (
            <div mix={devBoxStyle}>
              <h2 mix={devHeadingStyle}>Development Sign-in</h2>
              <p mix={devDescriptionStyle}>
                Select an approved test persona. Dev login establishes identity only; roles and scopes are resolved through the normal server-side path.
              </p>
              <form method="post" action={routes.session.devLoginSubmit.href()}>
                <input type="hidden" name="_csrf" value={csrf} />
                <p>
                  <label>
                    Test Persona{' '}
                    <select name="personaKey" required mix={devSelectStyle}>
                      {DEV_PERSONAS.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name} ({p.role} &mdash; {p.category})
                        </option>
                      ))}
                    </select>
                  </label>
                </p>
                <button
                  type="submit"
                  mix={devButtonStyle}
                >
                  Sign in as Persona
                </button>
                <span mix={devBrowseSpanStyle}>
                  or <a href={routes.session.devLogin.href()}>Browse all personas &rarr;</a>
                </span>
              </form>
            </div>
          ) : null}
        </main>
      </Document>
    )
  }
}

export function NoAccessPage() {
  return () => (
    <Document title="No access assigned">
      <main mix={mainContainerStyle}>
        <h1>No access assigned</h1>
        <p>Contact HR to assign a position or role.</p>
      </main>
    </Document>
  )
}

export type DevLoginProps = {
  csrf: string
  personas: DevPersona[]
  returnTo?: string
  error?: string
}

export function DevLoginPage(handle: Handle<DevLoginProps>) {
  return () => {
    let { csrf, personas, returnTo, error } = handle.props
    return (
      <Document title="MMS Dev Persona Login">
        <main mix={devPageMainStyle}>
          <h1>R8.6 Acceptance Test Persona Sign-In</h1>
          <p>
            Select a synthetic test persona to establish an acceptance testing session.
            All sessions use normal MMS session handling, PostgREST authorization, and PostgreSQL RLS.
          </p>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}

          <div mix={devGridStyle}>
            {personas.map((persona) => (
              <div
                key={persona.key}
                mix={devCardStyle}
              >
                <div>
                  <h3 mix={devCardHeadingStyle}>{persona.name} ({persona.role})</h3>
                  <div mix={devCardSubStyle}>
                    <strong>Category:</strong> {persona.category} | <strong>Email:</strong> {persona.email}
                  </div>
                  <div mix={devCardScopeStyle}>
                    <strong>Scope:</strong> {persona.scope}
                  </div>
                  {persona.notes ? (
                    <div mix={devCardNotesStyle}>
                      {persona.notes}
                    </div>
                  ) : null}
                </div>
                <form method="post" action={routes.session.devLoginSubmit.href()}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <input type="hidden" name="personaKey" value={persona.key} />
                  {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
                  <button
                    type="submit"
                    mix={devCardSubmitStyle}
                  >
                    Sign In
                  </button>
                </form>
              </div>
            ))}
          </div>
          <p mix={returnLinkStyle}>
            <a href={routes.session.login.href()}>&larr; Return to regular sign-in</a>
          </p>
        </main>
      </Document>
    )
  }
}
