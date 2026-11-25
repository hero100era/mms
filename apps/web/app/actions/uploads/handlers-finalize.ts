import type { AnyRequestContext } from '../context.ts'
import { getPgrst, requireAuth } from '../context.ts'
import {
  dbUploadGetForFinalize,
  dbUploadMarkVerdict,
  recordMalwareScanRun,
  recordScan,
} from '../../storage/upload-repository.ts'
import {
  finalizeUpload,
  MalwareDetectedError,
} from '../../storage/service.ts'
import { actionProblemResponse, safeActionError } from '../errors.ts'
import { parseFinalizeParams } from './validation.ts'
import { asErrorLike, assertUploadEntityAccess, parseRequestFormData } from './shared.ts'

export async function handleFinalize(context: AnyRequestContext): Promise<Response> {
  let auth = requireAuth(context)

  let form: FormData
  try {
    form = await parseRequestFormData(context)
  } catch (err: unknown) {
    let errLike = asErrorLike(err)
    if (errLike.status === 413) {
      return actionProblemResponse(context, err, {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        detail: 'Request JSON payload exceeds 1 MiB limit',
      })
    }
    form = new FormData()
  }

  let params
  try {
    params = parseFinalizeParams(form)
  } catch (err: unknown) {
    return actionProblemResponse(context, err, {
      status: 400,
      detail: safeActionError(err, 'invalid_finalize_parameters'),
      extra: { error: safeActionError(err, 'invalid_finalize_parameters') },
    })
  }

  const {
    parsedUploadId,
    quarantinePath,
    entityType,
    entityId,
    docType,
    title,
    safeName,
    expectedQuarantinePath,
  } = params

  if (quarantinePath !== expectedQuarantinePath) {
    return actionProblemResponse(context, new Error('invalid_quarantine_path'), {
      status: 400,
      detail: 'Invalid quarantine path',
      extra: { error: 'invalid_quarantine_path' },
    })
  }

  let accessError = await assertUploadEntityAccess(context, auth, entityType, entityId, 'finalize')
  if (accessError) return accessError

  let uploadRow = await dbUploadGetForFinalize(parsedUploadId)
  if (
    !uploadRow ||
    uploadRow.upload_state !== 'uploaded' ||
    uploadRow.entity_type !== entityType ||
    uploadRow.entity_id !== entityId ||
    uploadRow.doc_type !== docType ||
    uploadRow.quarantine_path !== expectedQuarantinePath ||
    (uploadRow.created_by !== auth.userId && auth.activeRole !== 'int_sysadmin')
  ) {
    return actionProblemResponse(context, new Error('upload_binding_mismatch'), {
      status: 403,
      detail: 'Upload does not belong to this user, entity, or document category',
      extra: { error: 'upload_binding_mismatch' },
    })
  }

  let finalizeResult
  try {
    finalizeResult = await finalizeUpload({
      uploadId: parsedUploadId,
      quarantinePath: expectedQuarantinePath,
      entityType,
      entityId,
      docType,
      title,
      fileName: safeName,
    })
  } catch (err: unknown) {
    let errLike = asErrorLike(err)
    if (err instanceof MalwareDetectedError || errLike.name === 'MalwareDetectedError') {
      let threatName = err instanceof MalwareDetectedError ? err.threatName : (errLike as any).threatName
      let sha256Hex = err instanceof MalwareDetectedError ? err.sha256Hex : (errLike as any).sha256Hex
      let scannerEngine = err instanceof MalwareDetectedError ? err.scannerEngine : (errLike as any).scannerEngine
      try {
        await recordMalwareScanRun({
          fileName: safeName,
          sha256Hex: sha256Hex ?? '',
          byteSize: 0,
          scannerEngine: scannerEngine || 'mock',
          status: 'infected',
          threatName,
          quarantinePath: expectedQuarantinePath,
          scannedBy: auth.userId,
          detail: { uploadId: parsedUploadId, entityType, entityId },
        })
        await dbUploadMarkVerdict({
          uploadId: parsedUploadId,
          state: 'infected',
          engine: scannerEngine || 'mock',
          threatName,
        })
      } catch (logErr) {
        console.error('Failed to log infected scan in audit ledger:', logErr)
      }

      return actionProblemResponse(context, err, {
        status: 422,
        detail: 'Malware detected in upload',
        extra: {
          error: 'malware_detected',
          threatName: typeof threatName === 'string' ? threatName : undefined,
        },
      })
    }
    return actionProblemResponse(context, err, {
      status: 400,
      detail: safeActionError(err, 'quarantine_verification_failed'),
      extra: { error: safeActionError(err, 'quarantine_verification_failed') },
    })
  }

  let client = getPgrst(context)
  try {
    let versionId = await client.rpc('document_create_version', {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_doc_type: docType,
      p_title: title,
      p_file_name: safeName,
      p_mime_type: finalizeResult.mimeType,
      p_byte_size: finalizeResult.byteSize,
      p_sha256: `\\x${finalizeResult.sha256Hex}`,
      p_storage_path: finalizeResult.storagePath,
    })
    let vers = await client.select('document_versions', { id: `eq.${versionId}` })
    let documentId = vers?.[0]?.document_id

    let scanSettled = false
    if (finalizeResult.status === 'promoted' && finalizeResult.scanStatus === 'clean') {
      try {
        await recordScan(
          versionId as string,
          'clean',
          finalizeResult.scannerEngine ?? 'mock',
          null,
          finalizeResult.storagePath,
          {
            promotedPath: finalizeResult.storagePath,
            byteSize: finalizeResult.byteSize,
            sha256: finalizeResult.sha256Hex,
            uploadId: parsedUploadId,
            engine_version: finalizeResult.engineVersion,
            signature_version: finalizeResult.signatureVersion,
            scan_timestamp: finalizeResult.scannedAt
              ? finalizeResult.scannedAt.toISOString()
              : new Date().toISOString(),
            outcome: 'clean',
            file_sha256: finalizeResult.sha256Hex,
          },
        )
        await dbUploadMarkVerdict({
          uploadId: parsedUploadId,
          state: 'clean',
          engine: finalizeResult.scannerEngine ?? 'mock',
          documentVersionId: versionId as string,
        })
        scanSettled = true
      } catch (recordErr) {
        console.error('Failed to record clean scan verdict:', recordErr)
      }
    } else {
      try {
        await dbUploadMarkVerdict({
          uploadId: parsedUploadId,
          state: 'pending_scan',
          engine: 'pending',
        })
      } catch {}
    }

    return Response.json({
      success: true,
      versionId,
      documentId,
      sha256: finalizeResult.sha256Hex,
      byteSize: finalizeResult.byteSize,
      mimeType: finalizeResult.mimeType,
      storagePath: finalizeResult.storagePath,
      status: finalizeResult.status,
      isQuarantined: finalizeResult.isQuarantined,
      scanStatus: scanSettled ? 'clean' : 'pending',
    })
  } catch (err: unknown) {
    return actionProblemResponse(context, err, {
      status: 400,
      detail: safeActionError(err, 'document_create_version_failed'),
      extra: { error: safeActionError(err, 'document_create_version_failed') },
    })
  }
}
