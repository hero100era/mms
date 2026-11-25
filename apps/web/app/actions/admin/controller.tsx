import { createController } from 'remix/router'
import type { PgrstClient } from '@mms/pgrst-client'
import { routes } from '../../routes.ts'
import { getCsrfToken } from 'remix/middleware/csrf'
import { redirect } from 'remix/response/redirect'
import { getPgrst, render, requireRole } from '../context.ts'
import { AssignmentsPage, PositionsPage } from '../admin-pages.tsx'
import { safeActionError, actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import {
  optionalText,
  optionalUuid,
  requireBoundedReason,
  requireEnum,
  requireText,
  requireUuid,
  safeFormText,
  ValidationError,
} from '../validation.ts'

async function loadPositionsData(client: PgrstClient) {
  return Promise.all([
    client.select('staff_positions', { order: 'display_name' }),
    client.rpc('staff_directory', {}),
    client.select('position_units'),
    client.select('position_job_titles'),
  ])
}

async function loadAssignmentsData(client: PgrstClient) {
  return Promise.all([
    client.rpc('staff_assignments', {}),
    client.rpc('staff_directory', {}),
    client.rpc('assignable_roles', {}),
    client.select('position_units'),
  ])
}

export default createController(routes.admin, {
  actions: {
    async positions(context) {
      let auth = requireRole(context, ['int_hr'])

      let client = getPgrst(context)
      let [positions, users, units, jobTitles] = await loadPositionsData(client)
      return render(
        context,
        <PositionsPage
          csrf={getCsrfToken(context)}
          positions={positions}
          users={users}
          units={units}
          jobTitles={jobTitles}
        />,
      )
    },
    async positionSet(context) {
      let auth = requireRole(context, ['int_hr'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)
      try {
        let userId = requireUuid(form, 'user_id')
        let jobTitleCode = requireText(form, 'job_title_code')
        let unitId = requireUuid(form, 'unit_id')
        let familyOverride = optionalText(form, 'family_override')
        let lineManagerId = optionalUuid(form, 'line_manager_id')
        let reason = requireBoundedReason(form, 'reason', 5)

        await client.rpc('staff_position_set', {
          p_user_id: userId,
          p_job_title_code: jobTitleCode,
          p_unit_id: unitId,
          p_family_override: familyOverride,
          p_line_manager_id: lineManagerId,
          p_valid_from: new Date().toISOString(),
          p_reason: reason,
        })
        return redirect(routes.admin.positions.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let [positions, users, units, jobTitles] = await loadPositionsData(client)
        return render(
          context,
          <PositionsPage
            csrf={getCsrfToken(context)}
            positions={positions}
            users={users}
            units={units}
            jobTitles={jobTitles}
            values={{
              user_id: safeFormText(form, 'user_id'),
              job_title_code: safeFormText(form, 'job_title_code'),
              unit_id: safeFormText(form, 'unit_id'),
              family_override: safeFormText(form, 'family_override'),
              line_manager_id: safeFormText(form, 'line_manager_id'),
              reason: safeFormText(form, 'reason'),
            }}
            error={safeActionError(error, 'Could not set position')}
          />,
          { status: 422 },
        )
      }
    },

    // Card H-13: positions proposed by the directory sync, decided by HR. The sync only
    // stages the proposal; a person becomes staff here by a human decision with a reason.
    async assignments(context) {
      let auth = requireRole(context, ['int_sysadmin'])
      let client = getPgrst(context)
      let [assignments, users, grantableRoles, units] = await loadAssignmentsData(client)
      return render(
        context,
        <AssignmentsPage
          csrf={getCsrfToken(context)}
          assignments={assignments}
          users={users}
          grantableRoles={grantableRoles}
          units={units}
        />,
      )
    },
    async assignmentGrant(context) {
      let auth = requireRole(context, ['int_sysadmin'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)
      try {
        let userId = requireUuid(form, 'user_id')
        let dbRole = requireText(form, 'db_role')
        let scopeType = requireEnum(form, 'scope_type', ['global', 'unit'] as const)
        let scopeUnitId = optionalUuid(form, 'scope_unit_id')
        let reason = requireBoundedReason(form, 'reason', 5)

        if (scopeType === 'unit' && !scopeUnitId) {
          throw new ValidationError(
            {
              scope_unit_id: 'Unit required for unit scope',
            },
            'Unit scope requires a valid unit selection',
          )
        }

        await client.rpc('role_assignment_grant', {
          p_user_id: userId,
          p_db_role: dbRole,
          p_scope_type: scopeType,
          p_scope_unit_id: scopeType === 'global' ? null : scopeUnitId,
          p_reason: reason,
        })
        return redirect(routes.admin.assignments.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let [assignments, users, grantableRoles, units] = await loadAssignmentsData(client)
        return render(
          context,
          <AssignmentsPage
            csrf={getCsrfToken(context)}
            assignments={assignments}
            users={users}
            grantableRoles={grantableRoles}
            units={units}
            values={{
              user_id: safeFormText(form, 'user_id'),
              db_role: safeFormText(form, 'db_role'),
              scope_type: safeFormText(form, 'scope_type'),
              scope_unit_id: safeFormText(form, 'scope_unit_id'),
              reason: safeFormText(form, 'reason'),
            }}
            error={safeActionError(error, 'Could not grant assignment')}
          />,
          { status: 422 },
        )
      }
    },
    async assignmentRevoke(context) {
      let auth = requireRole(context, ['int_sysadmin'])
      let form = (await context.get(FormData)) as FormData
      let client = getPgrst(context)

      try {
        let id = requireUuid(form, 'id')
        let reason = requireBoundedReason(form, 'reason', 5)

        await client.rpc('role_assignment_revoke', {
          p_id: id,
          p_reason: reason,
        })
        return redirect(routes.admin.assignments.href())
      } catch (error) {
        if (isJsonOrProblemRequest(context.request)) {
          return actionProblemResponse(context, error)
        }
        let [assignments, users, grantableRoles, units] = await loadAssignmentsData(client)
        return render(
          context,
          <AssignmentsPage
            csrf={getCsrfToken(context)}
            assignments={assignments}
            users={users}
            grantableRoles={grantableRoles}
            units={units}
            error={safeActionError(error, 'Could not revoke assignment')}
          />,
          { status: 422 },
        )
      }
    },
  },
})
