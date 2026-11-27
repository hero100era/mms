import type { Handle } from 'remix/component'
import { badgeToneStyles } from '../../theme.ts'
import { getStatusBadgeInfo } from '../presenters.ts'

const STATUS_TONE: Record<string, { tone: keyof typeof badgeToneStyles; symbol: string }> = {
  draft: { tone: 'warn', symbol: '○' },
  submitted: { tone: 'info', symbol: '◐' },
  accepted: { tone: 'success', symbol: '●' },
  clarification_requested: { tone: 'warn', symbol: '▲' },
  rejected: { tone: 'danger', symbol: '✕' },
}

export function StatusBadge(handle: Handle<{ status: string }>) {
  return () => {
    let { status } = handle.props
    let { label } = getStatusBadgeInfo(status)
    let mapped = STATUS_TONE[status] ?? { tone: 'neutral', symbol: '○' }

    return (
      <span mix={badgeToneStyles[mapped.tone]}>
        <span aria-hidden="true">{mapped.symbol}</span>
        {label}
      </span>
    )
  }
}
