// R5.1: the MMS application shell.
//
// This replaced the Remix starter page (Remix/Shopify/Discord links, AI prompt
// cards, starter copyright). It is a server-rendered dashboard entry point: it
// shows the signed-in caller, their active capability role and the navigation
// their role can actually reach. Unauthenticated visitors get the sign-in entry
// point instead.
//
// ADR-0025 is proposed for the full design system (R5.2). This page already
// follows its rules: styling comes from `css()` mixins only (no inline `style`
// attributes, so the CSP needs no `style-src-attr` exception), headings are
// ordered, and links are real anchors.
import type { Handle, RemixNode } from 'remix/component'
import { css } from 'remix/component'

import type { SessionAuth } from '../auth/context.ts'
import { routes } from '../routes.ts'
import { Document } from './document.tsx'

export interface HomePageProps {
  auth: SessionAuth | null
  csrf: string
}

interface NavItem {
  href: string
  label: string
  description: string
}

// Human labels for capability roles. Raw role codes are never shown as the
// primary label; they appear only as the technical identifier.
const ROLE_LABELS: Record<string, string> = {
  int_viewer: 'Viewer',
  int_surveyor: 'Surveyor',
  int_auditor: 'Auditor',
  int_coordinator: 'Coordinator',
  int_manager: 'Manager',
  int_compliance: 'Compliance',
  int_hr: 'Human Resources',
  int_finance: 'Finance',
  int_sysadmin: 'System Administrator',
  ext_user: 'External Requester',
}

// Which navigation entries each capability role may use. This mirrors the
// database's RLS/authority model; it is a presentation aid only and never the
// authorization decision — every target page is enforced server-side.
const ROLE_NAV: Record<string, NavItem[]> = {
  ext_user: [
    { href: routes.ships.index.href(), label: 'Fleet vessels', description: 'Vessels and particulars in your scope' },
    { href: routes.survey.index.href(), label: 'My survey requests', description: 'Track and submit survey requests' },
    { href: routes.survey.new.href(), label: 'New survey request', description: 'Raise a new request for a vessel' },
    { href: routes.session.profile.href(), label: 'Profile', description: 'Sign-in methods and sessions' },
  ],
  int_viewer: [
    { href: routes.ships.index.href(), label: 'Fleet vessels', description: 'Read-only vessel register and particulars' },
    { href: routes.survey.index.href(), label: 'Survey requests', description: 'Read-only view of requests' },
    { href: routes.triage.queue.href(), label: 'Triage queue', description: 'Station triage worklist' },
    { href: routes.session.profile.href(), label: 'Profile', description: 'Sign-in methods and sessions' },
  ],
  int_sysadmin: [
    { href: routes.admin.positions.href(), label: 'Positions', description: 'Staff positions and assignments' },
    { href: routes.admin.assignments.href(), label: 'Role assignments', description: 'Grant and revoke capability roles' },
    { href: routes.admin.proposals.index.href(), label: 'Position proposals', description: 'Review directory-proposed positions' },
    { href: routes.admin.externalUsers.index.href(), label: 'External users', description: 'Create and invite external accounts' },
    { href: routes.breakGlass.index.href(), label: 'Break-glass', description: 'Emergency access status' },
    { href: routes.session.profile.href(), label: 'Profile', description: 'Sign-in methods and sessions' },
  ],
}

const DEFAULT_STAFF_NAV: NavItem[] = [
  { href: routes.ships.index.href(), label: 'Fleet vessels', description: 'Vessel register and particulars' },
  { href: routes.survey.index.href(), label: 'Survey requests', description: 'Requests in your scope' },
  { href: routes.triage.queue.href(), label: 'Triage queue', description: 'Station triage worklist' },
  { href: routes.session.profile.href(), label: 'Profile', description: 'Sign-in methods and sessions' },
]

function navFor(auth: SessionAuth | null): NavItem[] {
  if (!auth) return []
  return ROLE_NAV[auth.activeRole] ?? (auth.kind === 'external' ? ROLE_NAV.ext_user! : DEFAULT_STAFF_NAV)
}

export function HomePage(handle: Handle<HomePageProps>) {
  return () => {
    let { auth, csrf } = handle.props
    let nav = navFor(auth)

    return (
      <Document title="MMS">
        <main mix={pageStyle}>
          <header mix={headerStyle}>
            <h1 mix={titleStyle}>Marine Management System</h1>
            <p mix={subtitleStyle}>
              Survey and inspection operations for the fleet, with organisation-scoped access.
            </p>
          </header>

          {auth ? (
            <section aria-labelledby="session-heading" mix={panelStyle}>
              <h2 id="session-heading" mix={sectionHeadingStyle}>
                Signed in
              </h2>
              <dl mix={definitionListStyle}>
                <dt mix={termStyle}>Account</dt>
                <dd mix={detailStyle}>{auth.email ?? auth.userId}</dd>
                <dt mix={termStyle}>Active role</dt>
                <dd mix={detailStyle}>
                  {ROLE_LABELS[auth.activeRole] ?? auth.activeRole}{' '}
                  <span mix={codeStyle}>{auth.activeRole}</span>
                </dd>
                <dt mix={termStyle}>Signed in with</dt>
                <dd mix={detailStyle}>{auth.authMethod}</dd>
              </dl>
              <form method="post" action={routes.session.logout.href()}>
                <input type="hidden" name="_csrf" value={csrf} />
                <button type="submit" mix={secondaryButtonStyle}>
                  Sign out
                </button>
              </form>
            </section>
          ) : (
            <section aria-labelledby="signin-heading" mix={panelStyle}>
              <h2 id="signin-heading" mix={sectionHeadingStyle}>
                Sign in
              </h2>
              <p mix={bodyStyle}>
                MMS uses your organisation account. Continue to the sign-in page to choose a
                provider.
              </p>
              <a href={routes.session.login.href()} mix={primaryLinkStyle}>
                Continue to sign in
              </a>
            </section>
          )}

          {nav.length > 0 ? (
            <nav aria-labelledby="nav-heading" mix={panelStyle}>
              <h2 id="nav-heading" mix={sectionHeadingStyle}>
                Available to you
              </h2>
              <ul mix={listStyle}>
                {nav.map((item) => (
                  <li key={item.href}>
                    <a href={item.href} mix={navLinkStyle}>
                      {item.label}
                    </a>
                    <p mix={navDescriptionStyle}>{item.description}</p>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <footer mix={footerStyle}>
            <p mix={bodyStyle}>
              Access is recorded in the audit trail. Report suspected misuse to IT security.
            </p>
          </footer>
        </main>
      </Document>
    )
  }
}

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const pageStyle = css({
  '--surface': '#f7fbff',
  '--panel': '#ffffff',
  '--ink': '#1f2429',
  '--muted': '#5a6169',
  '--line': '#d5dbe1',
  '--accent': '#0b6bcb',
  '@media (prefers-color-scheme: dark)': {
    '--surface': '#1e2226',
    '--panel': '#2a2f34',
    '--ink': '#e6eaee',
    '--muted': '#a8b0b8',
    '--line': '#3a4148',
    '--accent': '#6cb6ff',
  },
  boxSizing: 'border-box',
  minHeight: '100vh',
  margin: 0,
  padding: '32px 16px 48px',
  background: 'var(--surface)',
  color: 'var(--ink)',
  fontFamily: FONT_STACK,
  fontSize: '15px',
  lineHeight: 1.6,
  '& *, & *::before, & *::after': { boxSizing: 'border-box' },
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
  maxWidth: '60rem',
  marginInline: 'auto',
})

const headerStyle = css({ display: 'flex', flexDirection: 'column', gap: '4px' })
const titleStyle = css({ margin: 0, fontSize: '26px', lineHeight: 1.25 })
const subtitleStyle = css({ margin: 0, color: 'var(--muted)' })

const panelStyle = css({
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  padding: '20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
})

const sectionHeadingStyle = css({ margin: 0, fontSize: '17px', lineHeight: 1.3 })
const bodyStyle = css({ margin: 0 })
const definitionListStyle = css({
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  columnGap: '16px',
  rowGap: '4px',
  '@media (max-width: 480px)': { gridTemplateColumns: '1fr', rowGap: 0 },
})
const termStyle = css({ margin: 0, color: 'var(--muted)', fontWeight: 400 })
const detailStyle = css({ margin: 0, wordBreak: 'break-word' })
const codeStyle = css({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '13px',
  color: 'var(--muted)',
})

const listStyle = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
})

const navLinkStyle = css({
  color: 'var(--accent)',
  fontWeight: 600,
  textDecoration: 'underline',
  '&:focus-visible': { outline: '3px solid var(--accent)', outlineOffset: '2px' },
})
const navDescriptionStyle = css({ margin: '2px 0 0', color: 'var(--muted)', fontSize: '14px' })

const primaryLinkStyle = css({
  alignSelf: 'flex-start',
  background: 'var(--accent)',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '10px 16px',
  fontWeight: 600,
  textDecoration: 'none',
  '&:focus-visible': { outline: '3px solid var(--accent)', outlineOffset: '2px' },
})

const secondaryButtonStyle = css({
  alignSelf: 'flex-start',
  background: 'transparent',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  padding: '8px 14px',
  font: 'inherit',
  cursor: 'pointer',
  '&:focus-visible': { outline: '3px solid var(--accent)', outlineOffset: '2px' },
})

const footerStyle = css({ color: 'var(--muted)', fontSize: '13px' })

export type { RemixNode }
