import type { Handle } from 'remix/component'
import { css } from 'remix/component'

import { Document } from '../../document.tsx'
import { routes } from '../../../routes.ts'

export type BreakGlassProps = {
  csrf: string
  label: string
  dormant: boolean
  validUntil?: string | null
  reason?: string | null
  drillOverdue?: boolean
  error?: string
}

const mainStyle = css({ fontFamily: 'system-ui', maxWidth: '34rem', margin: '4rem auto', padding: '0 1rem' })
const errorAlertStyle = css({ color: 'red' })
const warningAlertStyle = css({ color: '#b45309' })
const fullWidthInputStyle = css({ width: '100%' })
const hintTextStyle = css({ fontSize: '0.9rem' })
const footerTextStyle = css({ marginTop: '2rem' })

export function BreakGlassPage(handle: Handle<BreakGlassProps>) {
  return () => {
    let { csrf, label, dormant, validUntil, reason, drillOverdue, error } = handle.props
    return (
      <Document title="Break-glass access">
        <main mix={mainStyle}>
          <h1>Break-glass access</h1>
          <p>
            This is the emergency account <strong>{label}</strong>. It holds no authority
            until an activation is recorded, and every activation is reported to IT
            security and HO Compliance.
          </p>
          {error ? <p role="alert" mix={errorAlertStyle}>{error}</p> : null}
          {drillOverdue ? (
            <p role="alert" mix={warningAlertStyle}>
              This account has not been drilled in over 100 days. The drill is part of the
              control, not an optional check: activate, do one harmless thing, let the
              window expire, then record the review.
            </p>
          ) : null}
          {dormant ? (
            <>
              <p>
                Say why this access is needed. The reason is stored with the activation and
                cannot be changed afterwards.
              </p>
              <form method="post" action={routes.breakGlass.activate.href()}>
                <input type="hidden" name="_csrf" value={csrf} />
                <p>
                  <label htmlFor="reason">Reason</label>
                  <br />
                  <textarea
                    id="reason"
                    name="reason"
                    rows={4}
                    required
                    minLength={10}
                    mix={fullWidthInputStyle}
                  />
                </p>
                <p mix={hintTextStyle}>
                  Activation grants <code>int_sysadmin</code> for at most four hours, or
                  fewer if this request is submitted early. Access ends at that moment,
                  whether or not you sign out.
                </p>
                <button type="submit">Activate for up to 4 hours</button>
              </form>
            </>
          ) : (
            <>
              <p>
                The window is open until <strong>{validUntil ?? 'unknown'}</strong>.
              </p>
              {reason ? <p>Reason recorded: {reason}</p> : null}
              <p>
                It ends automatically at that moment. Deactivating early is recorded too,
                so do it as soon as the emergency is over.
              </p>
              <form method="post" action={routes.breakGlass.deactivate.href()}>
                <input type="hidden" name="_csrf" value={csrf} />
                <p>
                  <label htmlFor="reason">Why are you ending it</label>
                  <br />
                  <input
                    id="reason"
                    name="reason"
                    type="text"
                    required
                    minLength={10}
                    mix={fullWidthInputStyle}
                  />
                </p>
                <button type="submit">Deactivate and revoke the window</button>
              </form>
            </>
          )}
          <p mix={footerTextStyle}>
            While activated this account can administer users, roles and reference data.
            It cannot approve business records, and no certificate or report can be signed
            with break-glass authority.
          </p>
        </main>
      </Document>
    )
  }
}
