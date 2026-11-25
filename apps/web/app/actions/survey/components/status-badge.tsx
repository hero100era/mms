import type { Handle } from 'remix/component'
import { css } from 'remix/component'
import { getStatusBadgeInfo } from '../presenters.ts'

const baseBadgeStyle = {
  display: 'inline-block',
  padding: '0.2rem 0.5rem',
  borderRadius: '4px',
  fontSize: '0.8rem',
  fontWeight: 'bold',
}

const statusBadgeStyles: Record<string, ReturnType<typeof css>> = {
  draft: css({ ...baseBadgeStyle, backgroundColor: '#ffc107', color: '#000' }),
  submitted: css({ ...baseBadgeStyle, backgroundColor: '#0d6efd', color: '#fff' }),
  accepted: css({ ...baseBadgeStyle, backgroundColor: '#198754', color: '#fff' }),
  clarification_requested: css({ ...baseBadgeStyle, backgroundColor: '#fd7e14', color: '#fff' }),
  rejected: css({ ...baseBadgeStyle, backgroundColor: '#dc3545', color: '#fff' }),
}

const defaultStatusBadgeStyle = css({ ...baseBadgeStyle, backgroundColor: '#6c757d', color: '#fff' })

export function StatusBadge(handle: Handle<{ status: string }>) {
  return () => {
    let { status } = handle.props
    let { label } = getStatusBadgeInfo(status)
    let badgeStyle = statusBadgeStyles[status] ?? defaultStatusBadgeStyle

    return (
      <span mix={badgeStyle}>
        {label}
      </span>
    )
  }
}
