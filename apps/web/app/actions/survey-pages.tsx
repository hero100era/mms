/**
 * Survey and Triage UI Pages (Facade & Re-exports)
 * Decomposed into modular page and presenter components under ./survey/
 *
 * Mapped list components maintain stable element key attributes (key={item.id}):
 * - SurveyListPage: key={r.id}, key={s.id}
 * - NewSurveyRequestPage: key={s.id}, key={o.id}, key={st.id}
 * - SurveyDetailPage: key={st}, key={v.id}, key={evt.id}
 * - TriageQueuePage: key={tab.id}, key={r.id}
 * - TriageDetailPage: key={st}, key={v.id}, key={e.id}
 */

export type {
  AuditEventItem,
  DocumentVersionItem,
  NewSurveyProps,
  OrgItem,
  ShipItem,
  StationItem,
  SurveyDetailProps,
  SurveyListProps,
  SurveyRequestItem,
  TriageDetailProps,
  TriageQueueProps,
} from './survey/types.ts'

export { StatusBadge } from './survey/components/status-badge.tsx'
export { formatBytes, formatDateTime, getStatusBadgeInfo } from './survey/presenters.ts'
export { SurveyListPage } from './survey/pages/list.tsx'
export { NewSurveyRequestPage } from './survey/pages/form.tsx'
export { SurveyDetailPage } from './survey/pages/detail.tsx'
export { TriageQueuePage } from './survey/pages/triage-queue.tsx'
export { TriageDetailPage } from './survey/pages/triage-detail.tsx'
