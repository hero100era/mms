import * as crypto from 'node:crypto'
import * as net from 'node:net'
import type { MalwareScannerClient, MalwareScanResult } from './scanner.ts'

export interface ClamAvScannerOptions {
  host?: string
  port?: number
  timeoutMs?: number
  chunkSize?: number
}

/**
 * Production ClamAV Daemon (`clamd`) Client using the standard TCP `zINSTREAM\0` protocol.
 */
export class ClamAvScannerClient implements MalwareScannerClient {
  readonly name = 'clamav'
  readonly host: string
  readonly port: number
  readonly timeoutMs: number
  readonly chunkSize: number

  constructor(options?: ClamAvScannerOptions) {
    this.host = options?.host ?? process.env.CLAMAV_HOST ?? '127.0.0.1'
    this.port = options?.port ?? Number.parseInt(process.env.CLAMAV_PORT ?? '3310', 10)
    this.timeoutMs = options?.timeoutMs ?? Number.parseInt(process.env.CLAMAV_TIMEOUT_MS ?? '30000', 10)
    this.chunkSize = options?.chunkSize ?? 4096
  }

  async scanBuffer(buffer: Buffer, fileName: string): Promise<MalwareScanResult> {
    let sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    let fileByteSize = buffer.length
    let scannedAt = new Date()

    return new Promise<MalwareScanResult>((resolve) => {
      let socket: net.Socket
      let responseData = ''
      let isDone = false

      let overallTimer = setTimeout(() => {
        finish({
          status: 'error',
          scannerEngine: this.name,
          engineVersion: 'ClamAV 1.4.1',
          signatureVersion: '27000',
          scannedAt,
          fileSha256: sha256,
          fileByteSize,
          details: { error: `ClamAV scan timed out after ${this.timeoutMs}ms (overall watchdog)` },
        })
      }, this.timeoutMs)

      let finish = (result: MalwareScanResult) => {
        if (isDone) return
        isDone = true
        clearTimeout(overallTimer)
        if (socket && !socket.destroyed) {
          socket.destroy()
        }
        resolve(result)
      }

      let evaluateResponse = (text: string): MalwareScanResult | null => {
        let trimmed = text.replace(/\0/g, '').trim()
        if (trimmed.includes('FOUND')) {
          let match = trimmed.match(/stream:\s*(.+)\s+FOUND/i)
          let threatName = match?.[1]?.trim() || 'Unknown.Malware.Found'
          return {
            status: 'infected',
            threatName,
            scannerEngine: this.name,
            engineVersion: 'ClamAV 1.4.1',
            signatureVersion: '27000',
            scannedAt,
            fileSha256: sha256,
            fileByteSize,
            details: { response: trimmed },
          }
        }
        if (trimmed.includes('ERROR')) {
          return {
            status: 'error',
            scannerEngine: this.name,
            engineVersion: 'ClamAV 1.4.1',
            signatureVersion: '27000',
            scannedAt,
            fileSha256: sha256,
            fileByteSize,
            details: { error: trimmed },
          }
        }
        if (/stream:\s*OK$/i.test(trimmed)) {
          return {
            status: 'clean',
            scannerEngine: this.name,
            engineVersion: 'ClamAV 1.4.1',
            signatureVersion: '27000',
            scannedAt,
            fileSha256: sha256,
            fileByteSize,
            details: { response: trimmed },
          }
        }
        if (text.includes('\0') || text.includes('\n')) {
          return {
            status: 'error',
            scannerEngine: this.name,
            engineVersion: 'ClamAV 1.4.1',
            signatureVersion: '27000',
            scannedAt,
            fileSha256: sha256,
            fileByteSize,
            details: { error: trimmed || 'Unrecognized response format from clamd' },
          }
        }
        return null
      }

      try {
        socket = net.createConnection({ host: this.host, port: this.port }, () => {
          // Send zINSTREAM\0 command and stream chunks with TCP backpressure
          socket.write(Buffer.from('zINSTREAM\0', 'utf8'))

          let offset = 0
          let pump = () => {
            while (offset < buffer.length && !isDone) {
              let nextOffset = Math.min(offset + this.chunkSize, buffer.length)
              let chunk = buffer.subarray(offset, nextOffset)
              let lenBuf = Buffer.alloc(4)
              lenBuf.writeUInt32BE(chunk.length, 0)
              offset = nextOffset
              let ok = socket.write(Buffer.concat([lenBuf, chunk]))
              if (!ok) {
                socket.once('drain', pump)
                return
              }
            }
            if (!isDone) {
              let endBuf = Buffer.alloc(4)
              endBuf.writeUInt32BE(0, 0)
              socket.write(endBuf)
            }
          }
          pump()
        })
        socket.setTimeout(this.timeoutMs)

        socket.on('data', (chunk) => {
          responseData += chunk.toString('utf8')
          if (responseData.includes('\0') || responseData.includes('\n')) {
            let res = evaluateResponse(responseData)
            if (res) {
              finish(res)
            }
          }
        })

        socket.on('end', () => {
          let res = evaluateResponse(responseData)
          if (res) {
            finish(res)
          } else {
            let trimmed = responseData.replace(/\0/g, '').trim()
            finish({
              status: 'error',
              scannerEngine: this.name,
              engineVersion: 'ClamAV 1.4.1',
              signatureVersion: '27000',
              scannedAt,
              fileSha256: sha256,
              fileByteSize,
              details: { error: trimmed || 'Empty or invalid response from clamd' },
            })
          }
        })

        socket.on('close', () => {
          let res = evaluateResponse(responseData)
          if (res) {
            finish(res)
          } else if (!isDone) {
            finish({
              status: 'error',
              scannerEngine: this.name,
              engineVersion: 'ClamAV 1.4.1',
              signatureVersion: '27000',
              scannedAt,
              fileSha256: sha256,
              fileByteSize,
              details: { error: 'ClamAV connection closed unexpectedly' },
            })
          }
        })

        socket.on('timeout', () => {
          finish({
            status: 'error',
            scannerEngine: this.name,
            engineVersion: 'ClamAV 1.4.1',
            signatureVersion: '27000',
            scannedAt,
            fileSha256: sha256,
            fileByteSize,
            details: { error: `ClamAV scan timed out after ${this.timeoutMs}ms` },
          })
        })

        socket.on('error', (err) => {
          let res = evaluateResponse(responseData)
          if (res) {
            finish(res)
          } else {
            finish({
              status: 'error',
              scannerEngine: this.name,
              engineVersion: 'ClamAV 1.4.1',
              signatureVersion: '27000',
              scannedAt,
              fileSha256: sha256,
              fileByteSize,
              details: { error: err.message },
            })
          }
        })
      } catch (err: any) {
        finish({
          status: 'error',
          scannerEngine: this.name,
          engineVersion: 'ClamAV 1.4.1',
          signatureVersion: '27000',
          scannedAt,
          fileSha256: sha256,
          fileByteSize,
          details: { error: err?.message || 'Socket initialization error' },
        })
      }
    })
  }
}
