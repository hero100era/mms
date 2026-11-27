import { css } from 'remix/component'

export const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
export const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

/**
 * Shared MMS page container defining light/dark design tokens (ADR-0025).
 * Colors automatically adapt to OS light/dark preference and Forced Colors Mode.
 */
export const pageShellStyle = css({
  '--surface': '#f3f6fa',
  '--panel': '#ffffff',
  '--panel-subtle': '#f8fafc',
  '--row-hover': '#f1f5f9',
  '--ink': '#16202a',
  '--muted': '#52606d',
  '--line': '#d5dde5',
  '--line-strong': '#9aa5b1',
  '--accent': '#0b6bcb',
  '--accent-hover': '#0958a8',
  '--accent-ink': '#ffffff',
  '--accent-soft': '#e6f1fc',
  '--success-bg': '#dcfce7',
  '--success-ink': '#14532d',
  '--success-line': '#86efac',
  '--warn-bg': '#fef3c7',
  '--warn-ink': '#78350f',
  '--warn-line': '#fcd34d',
  '--info-bg': '#dbeafe',
  '--info-ink': '#1e3a8a',
  '--info-line': '#93c5fd',
  '--danger-bg': '#fee2e2',
  '--danger-ink': '#7f1d1d',
  '--danger-line': '#fca5a5',
  '--neutral-bg': '#e2e8f0',
  '--neutral-ink': '#334155',
  '--neutral-line': '#cbd5e1',
  '@media (prefers-color-scheme: dark)': {
    '--surface': '#11161d',
    '--panel': '#19212b',
    '--panel-subtle': '#1f2935',
    '--row-hover': '#24303e',
    '--ink': '#e6edf3',
    '--muted': '#9fb0c0',
    '--line': '#2d3948',
    '--line-strong': '#4b5c70',
    '--accent': '#58a6ff',
    '--accent-hover': '#79b8ff',
    '--accent-ink': '#0b1320',
    '--accent-soft': '#162b42',
    '--success-bg': '#133120',
    '--success-ink': '#86efac',
    '--success-line': '#22543d',
    '--warn-bg': '#36260b',
    '--warn-ink': '#fcd34d',
    '--warn-line': '#6b4710',
    '--info-bg': '#162b4a',
    '--info-ink': '#93c5fd',
    '--info-line': '#284b7e',
    '--danger-bg': '#3b1518',
    '--danger-ink': '#fca5a5',
    '--danger-line': '#7f1d1d',
    '--neutral-bg': '#252f3c',
    '--neutral-ink': '#cbd5e1',
    '--neutral-line': '#3d4c5f',
  },
  colorScheme: 'light dark',
  accentColor: 'var(--accent)',
  boxSizing: 'border-box',
  minHeight: '100vh',
  maxWidth: '76rem',
  marginInline: 'auto',
  padding: '1.5rem 1.25rem 3.5rem',
  color: 'var(--ink)',
  fontFamily: FONT_STACK,
  fontSize: '0.95rem',
  lineHeight: 1.55,
  '& *, & *::before, & *::after': { boxSizing: 'border-box' },
  '& a': { color: 'var(--accent)' },
  '& :where(a, button, input, select, textarea, [tabindex]):focus-visible': {
    outline: '3px solid var(--accent)',
    outlineOffset: '2px',
  },
})

export const breadcrumbNavStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem 0.9rem',
  marginBottom: '1rem',
  fontSize: '0.875rem',
  color: 'var(--muted)',
  '& a': {
    color: 'var(--accent)',
    textDecoration: 'none',
    fontWeight: 500,
    paddingBlock: '0.2rem',
  },
  '& a:hover': { textDecoration: 'underline' },
})

export const heroHeaderStyle = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: '1rem',
  backgroundColor: 'var(--panel)',
  border: '1px solid var(--line)',
  borderTop: '3px solid var(--accent)',
  borderRadius: '10px',
  padding: '1.25rem 1.5rem',
  marginBottom: '1.5rem',
})

export const heroTitleStyle = css({
  margin: 0,
  fontSize: '1.6rem',
  lineHeight: 1.25,
  letterSpacing: '-0.015em',
})

export const heroSubtitleStyle = css({
  margin: '0.35rem 0 0',
  color: 'var(--muted)',
  fontSize: '0.95rem',
})

export const actionGroupStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.65rem',
  alignItems: 'center',
})

export const primaryLinkButtonStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minBlockSize: '36px',
  backgroundColor: 'var(--accent)',
  color: 'var(--accent-ink)',
  border: '1px solid transparent',
  textDecoration: 'none',
  padding: '0.5rem 1rem',
  borderRadius: '7px',
  fontWeight: 600,
  fontSize: '0.9rem',
  cursor: 'pointer',
  '&:hover': { backgroundColor: 'var(--accent-hover)' },
})

export const secondaryLinkButtonStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minBlockSize: '36px',
  backgroundColor: 'var(--panel-subtle)',
  color: 'var(--ink)',
  border: '1px solid var(--line-strong)',
  textDecoration: 'none',
  padding: '0.5rem 1rem',
  borderRadius: '7px',
  fontWeight: 600,
  fontSize: '0.9rem',
  cursor: 'pointer',
  '&:hover': { backgroundColor: 'var(--row-hover)' },
})

export const panelCardStyle = css({
  backgroundColor: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  padding: '1.25rem 1.5rem',
  marginBottom: '1.5rem',
})

export const kpiGridStyle = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.9rem',
  marginBottom: '1.5rem',
})

export const kpiCardStyle = css({
  backgroundColor: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  padding: '0.9rem 1.1rem',
})

export const kpiLabelStyle = css({
  margin: 0,
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--muted)',
  fontWeight: 600,
})

export const kpiValueStyle = css({
  margin: '0.25rem 0 0',
  fontSize: '1.35rem',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--ink)',
})

export const sectionHeaderRowStyle = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginBottom: '0.9rem',
})

export const sectionTitleStyle = css({
  margin: 0,
  fontSize: '1.1rem',
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})

export const countPillStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.1rem 0.55rem',
  borderRadius: '999px',
  fontSize: '0.78rem',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  backgroundColor: 'var(--panel-subtle)',
  color: 'var(--muted)',
  border: '1px solid var(--line)',
})

export const tableRegionStyle = css({
  overflowX: 'auto',
  maxInlineSize: '100%',
  containerType: 'inline-size',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  backgroundColor: 'var(--panel)',
})

export const dataTableStyle = css({
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  textAlign: 'left',
  fontSize: '0.9rem',
  fontVariantNumeric: 'tabular-nums',
})

export const tableCaptionStyle = css({
  textAlign: 'left',
  padding: '0.6rem 0.9rem',
  fontSize: '0.82rem',
  color: 'var(--muted)',
  backgroundColor: 'var(--panel-subtle)',
  borderBottom: '1px solid var(--line)',
})

export const tableHeadStyle = css({
  position: 'sticky',
  insetBlockStart: 0,
  zIndex: 1,
  backgroundColor: 'var(--panel-subtle)',
})

export const tableThStyle = css({
  padding: '0.65rem 0.85rem',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  color: 'var(--muted)',
  fontWeight: 700,
  borderBottom: '1px solid var(--line)',
  whiteSpace: 'nowrap',
})

export const tableTrStyle = css({
  '&:hover': { backgroundColor: 'var(--row-hover)' },
  '&:last-child td': { borderBottom: 'none' },
})

export const tableTdStyle = css({
  padding: '0.7rem 0.85rem',
  verticalAlign: 'top',
  borderBottom: '1px solid var(--line)',
})

export const tableTdBoldStyle = css({
  padding: '0.7rem 0.85rem',
  verticalAlign: 'top',
  fontWeight: 600,
  borderBottom: '1px solid var(--line)',
})

export const subMetaStyle = css({
  display: 'block',
  marginTop: '0.15rem',
  fontSize: '0.8rem',
  fontWeight: 400,
  color: 'var(--muted)',
})

export const monoTextStyle = css({
  fontFamily: MONO_STACK,
  fontSize: '0.85em',
})

export const emptyStateStyle = css({
  padding: '2rem 1.25rem',
  border: '1px dashed var(--line-strong)',
  borderRadius: '8px',
  textAlign: 'center',
  color: 'var(--muted)',
  backgroundColor: 'var(--panel-subtle)',
})

export const mutedNoteStyle = css({
  margin: 0,
  color: 'var(--muted)',
  fontStyle: 'italic',
  fontSize: '0.9rem',
})

export const alertBannerStyle = css({
  padding: '0.8rem 1rem',
  borderRadius: '8px',
  marginBottom: '1rem',
  fontWeight: 500,
  border: '1px solid var(--danger-line)',
  backgroundColor: 'var(--danger-bg)',
  color: 'var(--danger-ink)',
})

export const successBannerStyle = css({
  padding: '0.8rem 1rem',
  borderRadius: '8px',
  marginBottom: '1rem',
  fontWeight: 500,
  border: '1px solid var(--success-line)',
  backgroundColor: 'var(--success-bg)',
  color: 'var(--success-ink)',
})

const badgeBase = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.2rem 0.6rem',
  borderRadius: '999px',
  fontSize: '0.78rem',
  fontWeight: 600,
  whiteSpace: 'nowrap' as const,
  borderWidth: '1px',
  borderStyle: 'solid',
}

export const badgeToneStyles = {
  success: css({
    ...badgeBase,
    backgroundColor: 'var(--success-bg)',
    color: 'var(--success-ink)',
    borderColor: 'var(--success-line)',
  }),
  warn: css({
    ...badgeBase,
    backgroundColor: 'var(--warn-bg)',
    color: 'var(--warn-ink)',
    borderColor: 'var(--warn-line)',
  }),
  info: css({
    ...badgeBase,
    backgroundColor: 'var(--info-bg)',
    color: 'var(--info-ink)',
    borderColor: 'var(--info-line)',
  }),
  danger: css({
    ...badgeBase,
    backgroundColor: 'var(--danger-bg)',
    color: 'var(--danger-ink)',
    borderColor: 'var(--danger-line)',
  }),
  neutral: css({
    ...badgeBase,
    backgroundColor: 'var(--neutral-bg)',
    color: 'var(--neutral-ink)',
    borderColor: 'var(--neutral-line)',
  }),
}

export const compactActionLinkStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  minBlockSize: '28px',
  padding: '0.25rem 0.65rem',
  border: '1px solid var(--accent)',
  color: 'var(--accent)',
  backgroundColor: 'var(--accent-soft)',
  borderRadius: '6px',
  textDecoration: 'none',
  fontSize: '0.84rem',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  '&:hover': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-ink)',
  },
})
