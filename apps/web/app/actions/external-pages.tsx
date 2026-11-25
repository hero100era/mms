import type { Handle } from 'remix/component'
import { css } from 'remix/component'
import type { ExternalUserRow } from '@mms/pgrst-client'

import { Document } from './document.tsx'
import { routes } from '../routes.ts'

export type { ExternalUserRow }

type ExternalUsersProps = {
  users: ExternalUserRow[]
  csrf: string
  error?: string
  values?: {
    email?: string
    display_name?: string
    reason?: string
  }
}

const mainStyle = css({ fontFamily: 'system-ui', maxWidth: '54rem', margin: '3rem auto', padding: '0 1rem' })
const errorAlertStyle = css({ color: 'red' })
const sectionBoxStyle = css({ marginBottom: '2rem', padding: '1rem', border: '1px solid #ccc' })
const tableStyle = css({ width: '100%', borderCollapse: 'collapse', textAlign: 'left' })
const headerRowStyle = css({ borderBottom: '2px solid #333' })
const tableHeaderCellStyle = css({ padding: '0.5rem' })
const tableRowStyle = css({ borderBottom: '1px solid #eee' })
const tableBodyCellStyle = css({ padding: '0.5rem' })
const inlineFormStyle = css({ display: 'inline' })

export function ExternalUsersPage(handle: Handle<ExternalUsersProps>) {
  return () => {
    let { users, csrf, error, values } = handle.props
    return (
      <Document title="External Users">
        <main mix={mainStyle}>
          <h1>External User Provisioning</h1>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}

          <section mix={sectionBoxStyle}>
            <h2>Invite New External User</h2>
            <form method="post" action={routes.admin.externalUsers.create.href()}>
              <input type="hidden" name="_csrf" value={csrf} />
              <p>
                <label>
                  Email <input type="email" name="email" required defaultValue={values?.email ?? ''} />
                </label>
              </p>
              <p>
                <label>
                  Display Name <input type="text" name="display_name" required defaultValue={values?.display_name ?? ''} />
                </label>
              </p>
              <p>
                <label>
                  Reason <input type="text" name="reason" placeholder="e.g. client onboarding" required defaultValue={values?.reason ?? ''} />
                </label>
              </p>
              <button type="submit">Provision & Invite User</button>
            </form>
          </section>

          <section>
            <h2>Existing External Users</h2>
            <table mix={tableStyle}>
              <thead>
                <tr mix={headerRowStyle}>
                  <th mix={tableHeaderCellStyle}>Name</th>
                  <th mix={tableHeaderCellStyle}>Email</th>
                  <th mix={tableHeaderCellStyle}>Status</th>
                  <th mix={tableHeaderCellStyle}>Created</th>
                  <th mix={tableHeaderCellStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={5} mix={tableBodyCellStyle}>No external users found.</td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id} mix={tableRowStyle}>
                      <td mix={tableBodyCellStyle}>{u.display_name}</td>
                      <td mix={tableBodyCellStyle}>{u.email}</td>
                      <td mix={tableBodyCellStyle}>{u.status}</td>
                      <td mix={tableBodyCellStyle}>{new Date(u.created_at).toLocaleDateString()}</td>
                      <td mix={tableBodyCellStyle}>
                        {u.status === 'invited' ? (
                          <form method="post" action={routes.admin.externalUsers.invite.href()} mix={inlineFormStyle}>
                            <input type="hidden" name="_csrf" value={csrf} />
                            <input type="hidden" name="user_id" value={u.id} />
                            <label>
                              Reason:
                              <input
                                type="text"
                                name="reason"
                                placeholder="Reason for re-inviting"
                                required
                                minLength={5}
                                defaultValue="Token expired, client requested resend"
                              />
                            </label>
                            <button type="submit">Re-invite</button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </main>
      </Document>
    )
  }
}
