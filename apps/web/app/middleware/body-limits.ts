import type { Middleware } from 'remix/router'
import { isQuarantineUpload } from '../csrf-exemption.ts'
import { actionProblemResponse } from '../actions/errors.ts'

export const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024 // 1 MiB
export const MAX_FORM_BODY_BYTES = 2 * 1024 * 1024 // 2 MiB

/**
 * Middleware that rejects requests exceeding maximum request-body limits.
 * Quarantine uploads are exempted here because they use category-specific upload limits (up to 100 MiB).
 */
export function bodyLimits(): Middleware {
  return async (context, next) => {
    let method = context.request.method.toUpperCase()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (isQuarantineUpload(context.url, method)) {
        return next()
      }

      let contentType = (context.request.headers.get('content-type') || '').toLowerCase()
      let isJson = contentType.includes('application/json')
      let maxAllowed = isJson ? MAX_JSON_BODY_BYTES : MAX_FORM_BODY_BYTES

      let lengthHeader = context.request.headers.get('content-length')
      if (lengthHeader !== null) {
        let trimmedLength = lengthHeader.trim()
        let contentLength = /^\d+$/.test(trimmedLength) ? Number(trimmedLength) : Number.NaN
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          return actionProblemResponse(context, new Error('Invalid Content-Length header'), {
            status: 400,
            code: 'BAD_REQUEST',
            detail: 'Invalid Content-Length header.',
          })
        }
        if (contentLength > maxAllowed) {
          let err = new Error(`Request body exceeds maximum size of ${maxAllowed} bytes`)
          return actionProblemResponse(context, err, {
            status: 413,
            code: 'PAYLOAD_TOO_LARGE',
            detail: `Request body exceeds maximum allowed size (${maxAllowed} bytes).`,
            extra: { error: 'payload_too_large', maxAllowed, contentLength },
          })
        }
      }
      if (context.request.body) {
        // Chunked / unknown-length body: wrap stream with a byte counter so
        // downstream request.json()/request.text() cannot buffer unbounded RAM.
        let received = 0
        let limiter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength
            if (received > maxAllowed) {
              let err = new Error(`Request body exceeds maximum size of ${maxAllowed} bytes`) as Error & { status?: number }
              err.status = 413
              controller.error(err)
              return
            }
            controller.enqueue(chunk)
          },
        })
        let boundedBody = context.request.body.pipeThrough(limiter)
        context.request = new Request(context.request.url, {
          method: context.request.method,
          headers: context.request.headers,
          body: boundedBody,
          duplex: 'half',
        } as RequestInit)
      }
    }

    try {
      return await next()
    } catch (err: any) {
      let causes = [err, err?.cause, (err?.cause as any)?.cause].filter(Boolean)
      let isPayloadTooLarge = causes.some((e: any) => {
        let msg = (e?.message || '').toLowerCase()
        return (
          e?.status === 413 ||
          msg.includes('exceeds maximum') ||
          msg.includes('total size exceeds') ||
          msg.includes('file size exceeds') ||
          msg.includes('payload too large') ||
          msg.includes('maxtotalsize')
        )
      })
      if (isPayloadTooLarge) {
        return actionProblemResponse(context, err, {
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          detail: 'Request body exceeds maximum allowed size.',
          extra: { error: 'payload_too_large' },
        })
      }
      throw err
    }
  }
}
