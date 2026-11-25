/**
 * Admin UI Pages (Facade & Re-exports)
 * Decomposed into modular page components under ./admin/pages/
 */

export {
  PositionsPage,
  type JobTitleOption,
  type PositionRow,
  type PositionsProps,
  type UnitOption,
  type UserRow,
} from './admin/pages/positions.tsx'

export {
  AssignmentsPage,
  type AssignmentRow,
  type AssignmentsProps,
} from './admin/pages/assignments.tsx'

export {
  PositionProposalsPage,
  type PositionProposalsProps,
  type ProposalRow,
} from './admin/pages/proposals.tsx'
