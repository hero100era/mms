import { getWorkerPool } from './worker-client.ts'
import { getStorage } from '../storage/service.ts'
import { createScheduler } from './scheduler.ts'

export interface AbandonedUploadInfo {
  uploadId: string
  quarantinePath: string
  sha256: string
  byteSize: number
}

export interface QuarantineSweepResult {
  sweptCount: number
  freedBytes: number
  abandonedUploads: AbandonedUploadInfo[]
  failedUploads?: Array<{ uploadId: string; quarantinePath: string; error: string }>
}

/**
 * Sweeps expired and abandoned quarantine uploads from the database and storage.
 * Enforces quarantine retention limits (default 24h retention or expired uploads).
 */
export async function runQuarantineSweep(retentionInterval = '24 hours'): Promise<QuarantineSweepResult> {
  let res = await getWorkerPool().query<{
    upload_id: string
    quarantine_path: string
    sha256: string
    byte_size: string | number
    upload_state: string
  }>(
    `select * from private.quarantine_sweep_expired($1::interval)`,
    [retentionInterval],
  )
  let candidateUploads = res.rows

  let storage = getStorage()
  let freedBytes = 0
  let sweptCount = 0
  let sweptUploads: AbandonedUploadInfo[] = []
  let failedUploads: Array<{ uploadId: string; quarantinePath: string; error: string }> = []

  for (let upload of candidateUploads) {
    try {
      if (upload.quarantine_path) {
        await storage.remove(upload.quarantine_path)
      }
      sweptCount++
      let bytes = Number(upload.byte_size || 0)
      freedBytes += bytes
      sweptUploads.push({
        uploadId: upload.upload_id,
        quarantinePath: upload.quarantine_path,
        sha256: upload.sha256,
        byteSize: bytes,
      })
    } catch (err: any) {
      console.error(`Failed to remove swept quarantine file ${upload.quarantine_path}:`, err)
      failedUploads.push({
        uploadId: upload.upload_id,
        quarantinePath: upload.quarantine_path,
        error: err?.message || String(err),
      })
    }
  }

  return {
    sweptCount,
    freedBytes,
    abandonedUploads: sweptUploads,
    failedUploads: failedUploads.length > 0 ? failedUploads : undefined,
  }
}

const quarantineSweepScheduler = createScheduler({
  label: 'quarantine sweeper',
  intervalMs: 60000,
  run: () => runQuarantineSweep(),
  onError: (error) => console.error('Quarantine sweeper batch error:', error),
})

export function startQuarantineSweepScheduler(intervalMs = 60000): void {
  quarantineSweepScheduler.start(intervalMs)
}

export function stopQuarantineSweepScheduler(): void {
  quarantineSweepScheduler.stop()
}

export function drainQuarantineSweepScheduler(timeoutMs = 15_000): Promise<void> {
  return quarantineSweepScheduler.drain(timeoutMs)
}
