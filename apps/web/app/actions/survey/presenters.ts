export function getStatusBadgeInfo(status: string): { bg: string; label: string; isLight: boolean } {
  let bg = '#6c757d'
  let label = status
  if (status === 'draft') {
    bg = '#ffc107'
    label = 'Draft'
  } else if (status === 'submitted') {
    bg = '#0d6efd'
    label = 'Submitted (Pending Triage)'
  } else if (status === 'accepted') {
    bg = '#198754'
    label = 'Accepted'
  } else if (status === 'clarification_requested') {
    bg = '#fd7e14'
    label = 'Clarification Requested'
  } else if (status === 'rejected') {
    bg = '#dc3545'
    label = 'Rejected'
  }
  return { bg, label, isLight: status === 'draft' }
}

export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '-'
  try {
    let d = new Date(isoString)
    return Number.isNaN(d.getTime()) ? String(isoString) : d.toLocaleString()
  } catch {
    return String(isoString)
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  let k = 1024
  let sizes = ['B', 'KB', 'MB', 'GB']
  let i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}
