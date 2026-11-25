import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'
import type { UserSession } from '../../../auth/service.ts'

export type ChooseRoleProps = { csrf: string; roles: string[]; current: string }

const mainContainerStyle = css({ fontFamily: 'system-ui', maxWidth: '34rem', margin: '4rem auto', padding: '0 1rem' })
const successMessageStyle = css({ color: 'green' })
const errorAlertStyle = css({ color: 'red' })
const sectionDividerStyle = css({ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1.5rem' })
const sessionListStyle = css({ listStyle: 'none', padding: 0 })
const sessionCardCurrentStyle = css({
  marginBottom: '1rem',
  padding: '0.75rem',
  border: '1px solid #ddd',
  borderRadius: '4px',
  background: '#f0f8ff',
})
const sessionCardOtherStyle = css({
  marginBottom: '1rem',
  padding: '0.75rem',
  border: '1px solid #ddd',
  borderRadius: '4px',
  background: '#fff',
})
const currentBadgeStyle = css({
  marginLeft: '0.5rem',
  padding: '0.1rem 0.4rem',
  background: '#28a745',
  color: '#fff',
  borderRadius: '3px',
  fontSize: '0.8rem',
})
const sessionMetaStyle = css({ fontSize: '0.85rem', color: '#555', marginTop: '0.25rem' })
const sessionSubMetaStyle = css({ fontSize: '0.8rem', color: '#777', marginTop: '0.25rem' })
const sessionActionFormStyle = css({ marginTop: '0.5rem' })
const marginTop1RemStyle = css({ marginTop: '1rem' })
const identityItemStyle = css({ marginBottom: '0.75rem' })
const unlinkFormStyle = css({ display: 'inline', marginLeft: '1rem' })
const inlineOAuthMarginStyle = css({ display: 'inline', marginRight: '1rem' })
const inlineFormStyle = css({ display: 'inline' })
const logoutFormStyle = css({ marginTop: '2rem' })

export function ChooseRolePage(handle: Handle<ChooseRoleProps>) {
  return () => {
    let { csrf, roles, current } = handle.props
    return (
      <Document title="Choose a role">
        <main mix={mainContainerStyle}>
          <h1>Choose a role</h1>
          <form method="post" action={routes.session.sessionRole.href()}>
            <input type="hidden" name="_csrf" value={csrf} />
            <p>
              <select name="role" defaultValue={current}>
                {roles.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </p>
            <button type="submit">Continue</button>
          </form>
        </main>
      </Document>
    )
  }
}

export type ProfileIdentity = {
  id: string
  provider: string
  issuer: string
  email_at_link: string | null
  linked_at: string
}

export type ProfileProps = {
  userId: string
  role: string
  roles: string[]
  csrf: string
  kind?: string
  identities?: ProfileIdentity[]
  sessions?: UserSession[]
  message?: string
  error?: string
}

export function ProfilePage(handle: Handle<ProfileProps>) {
  return () => {
    let { userId, role, roles, csrf, kind, identities, sessions, message, error } = handle.props
    return (
      <Document title="Profile">
        <main mix={mainContainerStyle}>
          <h1>Profile</h1>
          {message ? <p role="status" mix={successMessageStyle}>{message}</p> : null}
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          <p>User: {userId}</p>
          <p>Active role: {role}</p>
          <p>Assignable roles: {roles.join(', ') || 'none'}</p>

          <section mix={sectionDividerStyle}>
            <h2>Active sessions</h2>
            {sessions && sessions.length > 0 ? (
              <ul mix={sessionListStyle}>
                {sessions.map((s) => (
                  <li
                    key={s.id}
                    mix={s.is_current ? sessionCardCurrentStyle : sessionCardOtherStyle}
                  >
                    <div>
                      <strong>Role:</strong> {s.active_role} | <strong>Method:</strong> {s.auth_method}
                      {s.is_current ? (
                        <span mix={currentBadgeStyle}>
                          Current
                        </span>
                      ) : null}
                    </div>
                    <div mix={sessionMetaStyle}>
                      IP: {s.client_ip ?? 'unknown'} | UA: {s.user_agent ?? 'unknown'}
                    </div>
                    <div mix={sessionSubMetaStyle}>
                      Last seen: {new Date(s.last_seen_at).toLocaleString()}
                    </div>
                    {!s.is_current ? (
                      <form method="post" action={routes.session.profileSessionRevoke.href()} mix={sessionActionFormStyle}>
                        <input type="hidden" name="_csrf" value={csrf} />
                        <input type="hidden" name="sessionId" value={s.id} />
                        <button type="submit">Revoke session</button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No active sessions found.</p>
            )}

            {sessions && sessions.length > 1 ? (
              <form method="post" action={routes.session.profileSessionRevokeAll.href()} mix={marginTop1RemStyle}>
                <input type="hidden" name="_csrf" value={csrf} />
                <button type="submit">Revoke all other sessions</button>
              </form>
            ) : null}
          </section>

          {kind === 'external' ? (
            <section mix={sectionDividerStyle}>
              <h2>Linked sign-in methods</h2>
              {identities && identities.length > 0 ? (
                <ul>
                  {identities.map((id) => (
                    <li key={id.id} mix={identityItemStyle}>
                      <strong>{id.provider}</strong> ({id.email_at_link ?? id.issuer})
                      <form method="post" action={routes.identity.unlink.href()} mix={unlinkFormStyle}>
                        <input type="hidden" name="_csrf" value={csrf} />
                        <input type="hidden" name="identityId" value={id.id} />
                        <button type="submit">Unlink</button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No linked external accounts.</p>
              )}

              <div mix={marginTop1RemStyle}>
                <form method="post" action={routes.identity.link.href({ provider: 'microsoft' })} mix={inlineOAuthMarginStyle}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <button type="submit">Link Microsoft account</button>
                </form>
                <form method="post" action={routes.identity.link.href({ provider: 'google' })} mix={inlineFormStyle}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <button type="submit">Link Google account</button>
                </form>
              </div>
            </section>
          ) : null}

          <form method="post" action={routes.session.logout.href()} mix={logoutFormStyle}>
            <input type="hidden" name="_csrf" value={csrf} />
            <button type="submit">Sign out</button>
          </form>
        </main>
      </Document>
    )
  }
}
