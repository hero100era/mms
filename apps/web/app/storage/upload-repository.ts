import { getWorkerPool } from '../jobs/worker-client.ts'

export async function dbUploadPrepare(params: {
  uploadId: string
  entityType: string
  entityId: string
  docType: string
  fileName: string
  quarantinePath: string
  expiresAt: string
  createdBy?: string | null
}): Promise<void> {
  let pool = getWorkerPool()
  await pool.query(
    `select private.upload_prepare($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.uploadId,
      params.entityType,
      params.entityId,
      params.docType,
      params.fileName,
      params.quarantinePath,
      params.expiresAt,
      params.createdBy ?? null,
    ],
  )
}

export type UploadRecord = {
  id: string
  entity_type: string
  entity_id: string
  doc_type: string
  file_name: string
  quarantine_path: string
  upload_state: string
  created_by: string | null
}

export async function dbUploadGetForFinalize(uploadId: string): Promise<UploadRecord | null> {
  let pool = getWorkerPool()
  let res = await pool.query<UploadRecord>(
    `select * from private.upload_get_for_finalize($1)`,
    [uploadId],
  )
  return res.rows[0] ?? null
}

export async function dbUploadMarkUploaded(params: {
  uploadId: string
  sha256Hex: string
  byteSize: number
  mimeType: string
}): Promise<void> {
  let pool = getWorkerPool()
  await pool.query(
    `select private.upload_mark_uploaded($1, decode($2, 'hex'), $3, $4)`,
    [params.uploadId, params.sha256Hex, params.byteSize, params.mimeType],
  )
}

export async function dbUploadMarkVerdict(params: {
  uploadId: string
  state: 'pending_scan' | 'clean' | 'infected' | 'error' | 'abandoned'
  engine: string
  threatName?: string | null
  documentVersionId?: string | null
}): Promise<void> {
  let pool = getWorkerPool()
  await pool.query(
    `select private.upload_mark_verdict($1, $2, $3, $4, $5)`,
    [
      params.uploadId,
      params.state,
      params.engine,
      params.threatName ?? null,
      params.documentVersionId ?? null,
    ],
  )
}

export async function recordMalwareScanRun(params: {
  versionId?: string
  documentId?: string
  fileName: string
  sha256Hex: string
  byteSize: number
  scannerEngine: string
  status: 'clean' | 'infected' | 'error'
  threatName?: string
  quarantinePath: string
  promotedPath?: string
  scannedBy?: string
  detail?: Record<string, unknown>
}): Promise<void> {
  let pool = getWorkerPool()
  await pool.query(
    `select private.record_malware_scan_run(
       $1, decode($2, 'hex'), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     )`,
    [
      params.fileName,
      params.sha256Hex,
      params.byteSize,
      params.scannerEngine,
      params.status,
      params.threatName ?? null,
      params.quarantinePath,
      params.promotedPath ?? null,
      params.scannedBy ?? 'system',
      JSON.stringify(params.detail ?? {}),
      params.versionId ?? null,
      params.documentId ?? null,
    ],
  )
}

export async function recordScan(
  versionId: string,
  status: 'clean' | 'infected' | 'error',
  scannerEngine: string,
  threatName: string | null,
  promotedPath: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  let pool = getWorkerPool()
  await pool.query(
    `select private.document_version_record_scan($1, $2, $3, $4, $5, $6)`,
    [versionId, status, scannerEngine, threatName, promotedPath, JSON.stringify(detail ?? {})],
  )
}
