import type { AnyRequestContext, RequestContextLike } from '../context.ts'
import { getPgrst, requireAuth, requireRole } from '../context.ts'
import { actionProblemResponse, safeActionError } from '../errors.ts'
import { MAX_JSON_BODY_BYTES } from '../../middleware/body-limits.ts'
import { readJsonWithLimit } from './validation.ts'
import { parseUuidOrNull } from '../utils.ts'
import { scanQuarantinedDocumentVersion } from '../../jobs/malware-scanner.ts'
import type { SessionAuth } from '../../auth/context.ts'

export interface ErrorLike {
  name?: string
  status?: number
  code?: string
  message?: string
  threatName?: string
  sha256Hex?: string
  scannerEngine?: string
}

export function asErrorLike(err: unknown): ErrorLike {
  if (err && typeof err === 'object') {
    return err as ErrorLike
  }
  return { message: String(err) }
}

/**
 * Parses request form data supporting both application/json (with bounded reading)
 * and form-encoded bodies.
 */
export async function parseRequestFormData(context: AnyRequestContext): Promise<FormData> {
  let ctx = context as RequestContextLike
  let req = ctx.request
  let contentType = req?.headers?.get('content-type') || ''

  if (contentType.includes('application/json')) {
    let body = await readJsonWithLimit(req!, MAX_JSON_BODY_BYTES)
    let form = new FormData()
    if (body && typeof body === 'object') {
      for (let [key, value] of Object.entries(body)) {
        form.append(key, String(value))
      }
    }
    return form
  }

  let existing = typeof ctx.get === 'function' ? ctx.get(FormData) : undefined
  if (existing instanceof FormData) {
    return existing
  }
  return await req!.formData()
}

/**
 * Asserts entity authorization and non-rejected status for upload operations.
 * Returns null if allowed, or an error Response if denied.
 */
export async function assertUploadEntityAccess(
  context: AnyRequestContext,
  auth: SessionAuth,
  entityType: string,
  entityId: string,
  actionName: 'prepare' | 'finalize' = 'prepare',
): Promise<Response | null> {
  if (entityType === 'survey_request') {
    if (auth.activeRole === 'int_viewer' || auth.activeRole === 'int_compliance') {
      return actionProblemResponse(context, new Error('insufficient_privilege'), {
        status: 403,
        detail: `Insufficient privileges to ${actionName} upload`,
        extra: { error: 'insufficient_privilege' },
      })
    }
    let client = getPgrst(context)
    let reqs: any[] = []
    try {
      reqs = await client.select('survey_requests', { id: `eq.${entityId}` })
    } catch {
      return actionProblemResponse(context, new Error('unauthorized'), {
        status: 403,
        detail: 'Unauthorized',
        extra: { error: 'unauthorized' },
      })
    }
    if (!reqs || reqs.length === 0) {
      return actionProblemResponse(context, new Error('survey_request_not_found'), {
        status: 404,
        detail: 'Survey request not found',
        extra: { error: 'survey_request_not_found' },
      })
    }
    let req = reqs[0]
    if (req.status === 'rejected') {
      return actionProblemResponse(context, new Error('invalid_state'), {
        status: 400,
        detail: 'cannot attach document to rejected request',
        extra: { error: 'invalid_state: cannot attach document to rejected request' },
      })
    }
    return null
  }

  return actionProblemResponse(context, new Error('unsupported_entity_type'), {
    status: 400,
    detail: `unsupported_entity_type: ${entityType}`,
    extra: { error: `unsupported_entity_type: ${entityType}` },
  })
}

/**
 * Unified execution core for document version scan and promote actions.
 */
export async function executeVersionScanOrPromote(
  context: AnyRequestContext,
  mode: 'scan' | 'promote',
): Promise<Response> {
  requireAuth(context)

  // Enforce role authorization: external users and interns cannot trigger scans or promotions
  requireRole(context, ['int_surveyor', 'int_coordinator', 'int_manager', 'int_sysadmin'])

  let ctx = context as any
  let versionId = parseUuidOrNull(ctx.params?.versionId)
  if (!versionId) {
    return actionProblemResponse(context, new Error('invalid_version_id'), {
      status: 400,
      detail: 'Invalid version ID',
      extra: { error: 'invalid_version_id' },
    })
  }

  let client = getPgrst(context)
  let versions: any[] = []
  try {
    versions = await client.select('document_versions', { id: `eq.${versionId}` })
  } catch {
    return actionProblemResponse(context, new Error('unauthorized'), {
      status: 403,
      detail: 'Unauthorized',
      extra: { error: 'unauthorized' },
    })
  }
  if (!versions || versions.length === 0) {
    return actionProblemResponse(context, new Error('version_not_found'), {
      status: 404,
      detail: 'Version not found',
      extra: { error: 'version_not_found' },
    })
  }
  let version = versions[0]

  if (!version.storage_path.startsWith('quarantine/')) {
    if (mode === 'promote') {
      if (version.scan_status !== 'clean') {
        return actionProblemResponse(context, new Error('unscanned_document_cannot_be_promoted'), {
          status: 403,
          detail: 'Unscanned document cannot be promoted',
          extra: { error: 'unscanned_document_cannot_be_promoted', scanStatus: version.scan_status },
        })
      }
      return actionProblemResponse(context, new Error('already_promoted'), {
        status: 400,
        detail: 'Document version is already promoted',
        extra: { error: 'already_promoted', storagePath: version.storage_path },
      })
    }

    if (mode === 'scan') {
      if (version.scan_status === 'clean') {
        return Response.json({
          success: true,
          versionId,
          promotedPath: version.storage_path,
          scanStatus: 'clean',
          sha256: version.sha256,
          mimeType: version.mime_type,
          byteSize: version.byte_size,
        })
      }
      if (version.scan_status === 'infected') {
        return actionProblemResponse(context, new Error('malware_detected'), {
          status: 422,
          detail: `Malware detected in quarantined file: ${version.threat_name}`,
          extra: { error: 'malware_detected', threatName: version.threat_name },
        })
      }
      return actionProblemResponse(context, new Error('already_promoted'), {
        status: 400,
        detail: 'File is already promoted',
        extra: { error: 'already_promoted', scanStatus: version.scan_status, storagePath: version.storage_path },
      })
    }
  }

  if (mode === 'promote' && version.scan_status === 'infected') {
    return actionProblemResponse(context, new Error('malware_detected'), {
      status: 422,
      detail: `Malware detected in quarantined file: ${version.threat_name}`,
      extra: {
        error: 'malware_detected',
        threatName: version.threat_name,
        message: `Malware detected in quarantined file: ${version.threat_name}`,
      },
    })
  }

  let docs = await client.select('documents', { id: `eq.${version.document_id}` })
  if (!docs || docs.length === 0) {
    return actionProblemResponse(context, new Error('document_not_found'), {
      status: 404,
      detail: 'Document not found',
      extra: { error: 'document_not_found' },
    })
  }
  let doc = docs[0]

  try {
    let outcome = await scanQuarantinedDocumentVersion({
      version_id: version.id,
      document_id: version.document_id,
      entity_type: doc.entity_type,
      entity_id: doc.entity_id,
      file_name: version.file_name,
      mime_type: version.mime_type,
      byte_size: version.byte_size,
      sha256: version.sha256,
      storage_path: version.storage_path,
      created_at: version.created_at,
    })

    if (outcome.status === 'clean') {
      return Response.json({
        success: true,
        versionId,
        promotedPath: outcome.promotedPath,
        scanStatus: 'clean',
        sha256: version.sha256,
        mimeType: version.mime_type,
        byteSize: version.byte_size,
      })
    }

    if (outcome.status === 'infected') {
      return actionProblemResponse(context, new Error('malware_detected'), {
        status: 422,
        detail: `Malware detected in quarantined file: ${outcome.threatName}`,
        extra: {
          error: 'malware_detected',
          threatName: outcome.threatName,
          message: `Malware detected in quarantined file: ${outcome.threatName}`,
        },
      })
    }

    if (outcome.error) {
      console.error('malware scan error:', { versionId, error: outcome.error })
    }
    let genericMessage = 'Malware scanning service unavailable; file remains quarantined'
    return actionProblemResponse(context, new Error('scanner_unavailable'), {
      status: 503,
      detail: genericMessage,
      extra: {
        error: 'scanner_unavailable',
        message: genericMessage,
      },
    })
  } catch (err: any) {
    if (mode === 'scan' && (err?.code === '22023' || (err instanceof Error && err.message === 'scan_already_recorded'))) {
      let settled = await client.select('document_versions', { id: `eq.${versionId}` })
      let row = settled?.[0]
      if (row?.scan_status === 'clean') {
        return Response.json({
          success: true,
          versionId,
          promotedPath: row.storage_path,
          scanStatus: 'clean',
          sha256: row.sha256,
          mimeType: row.mime_type,
          byteSize: row.byte_size,
        })
      }
      return actionProblemResponse(context, new Error('malware_detected'), {
        status: 422,
        detail: `Malware detected in quarantined file: ${row?.threat_name ?? 'unknown'}`,
        extra: {
          error: 'malware_detected',
          threatName: row?.threat_name,
          message: `Malware detected in quarantined file: ${row?.threat_name ?? 'unknown'}`,
        },
      })
    }

    let safeMsg = safeActionError(err, mode === 'promote' ? 'Promotion and scanning failed' : 'Malware scanning failed')
    return actionProblemResponse(context, err, {
      status: 503,
      detail: safeMsg,
      extra: {
        error: 'scanner_unavailable',
        message: safeMsg,
      },
    })
  }
}
