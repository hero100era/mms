import type { DocumentVersionRow } from '@mms/pgrst-client'
import type { AnyRequestContext } from '../context.ts'
import { getPgrst, requireAuth } from '../context.ts'
import { parseUuidOrNull } from '../utils.ts'
import { actionProblemResponse } from '../errors.ts'
import { canDownloadStorageFile, getStorageFileStream } from '../../storage/service.ts'
import { sanitizeFileName } from '../../storage/sniff.ts'
import { executeVersionScanOrPromote } from './shared.ts'

export async function handlePromote(context: AnyRequestContext): Promise<Response> {
  return executeVersionScanOrPromote(context, 'promote')
}

export async function handleScan(context: AnyRequestContext): Promise<Response> {
  return executeVersionScanOrPromote(context, 'scan')
}

export async function handleDocumentDownload(context: AnyRequestContext): Promise<Response> {
  let auth = requireAuth(context)

  let params = context.params as Record<string, string | undefined> | undefined
  let documentId = parseUuidOrNull(params?.documentId)
  let versionId = parseUuidOrNull(params?.versionId)
  if (!documentId || !versionId) {
    return actionProblemResponse(context, new Error('invalid_id'), {
      status: 400,
      detail: 'Invalid document or version ID',
      extra: { error: 'invalid_id' },
    })
  }

  let client = getPgrst(context)
  let versions: DocumentVersionRow[] = []
  try {
    versions = await client.select('document_versions', {
      id: `eq.${versionId}`,
      document_id: `eq.${documentId}`,
    })
  } catch {
    return actionProblemResponse(context, new Error('forbidden'), {
      status: 403,
      detail: 'Forbidden',
      extra: { error: 'forbidden' },
    })
  }

  if (!versions || versions.length === 0) {
    return actionProblemResponse(context, new Error('not_found'), {
      status: 404,
      detail: 'Document version not found or access denied',
      extra: { error: 'not_found' },
    })
  }

  let version = versions[0]
  let check = canDownloadStorageFile(version.storage_path, version.scan_status)
  if (!check.allowed) {
    if (check.reason === 'malware_detected' || version.scan_status === 'infected') {
      return actionProblemResponse(context, new Error('malware_detected'), {
        status: 423,
        detail: 'File is infected with malware and cannot be downloaded',
        extra: {
          error: 'malware_detected',
          threatName: version.threat_name,
          message: 'File is infected with malware and cannot be downloaded',
        },
      })
    }
    return actionProblemResponse(context, new Error(check.reason), {
      status: 423,
      detail: 'File is quarantined awaiting malware scanning (H-05)',
      extra: {
        error: check.reason,
        message: 'File is quarantined awaiting malware scanning (H-05)',
      },
    })
  }

  let stored = await getStorageFileStream(version.storage_path)
  if (!stored) {
    return actionProblemResponse(context, new Error('not_found'), {
      status: 404,
      detail: 'File not found in storage',
      extra: { error: 'not_found' },
    })
  }

  let safeFileName = sanitizeFileName(version.file_name || stored.fileName)
  return new Response(stored.stream, {
    status: 200,
    headers: {
      'Content-Type': version.mime_type || stored.mimeType,
      'Content-Disposition': `attachment; filename="${safeFileName}"`,
      'Content-Length': String(stored.size),
      'ETag': `"${version.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  })
}
