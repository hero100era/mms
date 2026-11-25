import type { AnyRequestContext } from '../context.ts'
import { getPgrst, requireAuth } from '../context.ts'
import {
  dbUploadMarkUploaded,
  dbUploadPrepare,
} from '../../storage/upload-repository.ts'
import {
  MAX_UPLOAD_BYTES,
  prepareQuarantineUpload,
  putQuarantineStream,
  UploadEmptyError,
  UploadTooLargeError,
  verifyUploadToken,
} from '../../storage/service.ts'
import { sanitizeFileName } from '../../storage/sniff.ts'
import { actionProblemResponse, isJsonOrProblemRequest } from '../errors.ts'
import { MAX_JSON_BODY_BYTES } from '../../middleware/body-limits.ts'
import {
  parsePrepareParams,
  parseQuarantineParams,
} from './validation.ts'
import { asErrorLike, assertUploadEntityAccess, parseRequestFormData } from './shared.ts'

export async function handlePrepare(context: AnyRequestContext): Promise<Response> {
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
    params = parsePrepareParams(form)
  } catch {
    return actionProblemResponse(context, new Error('missing_parameters'), {
      status: 400,
      title: 'Bad Request',
      code: 'BAD_REQUEST',
      type: 'https://mms.local/problems/bad-request',
      detail: 'Missing required upload parameters',
      extra: { error: 'missing_parameters' },
    })
  }

  const { entityType, entityId, docType, fileName, expiresInMinutes } = params

  let accessError = await assertUploadEntityAccess(context, auth, entityType, entityId, 'prepare')
  if (accessError) return accessError

  let result = await prepareQuarantineUpload({
    entityType,
    entityId,
    docType,
    fileName,
    expiresInMinutes,
    baseUrl: new URL(context.request?.url ?? 'http://localhost').origin,
  })

  try {
    await dbUploadPrepare({
      uploadId: result.uploadId,
      entityType,
      entityId,
      docType,
      fileName,
      quarantinePath: result.quarantinePath,
      expiresAt: result.expiresAt,
      createdBy: auth.userId,
    })
  } catch (uploadErr) {
    return actionProblemResponse(context, uploadErr, {
      status: 500,
      detail: 'Failed to record core.upload prepare state',
      extra: { error: 'upload_prepare_failed' },
    })
  }

  return Response.json(result)
}

export async function handleQuarantine(context: AnyRequestContext): Promise<Response> {
  let req = context.request
  if (!req || !context.url) {
    return new Response('Bad Request', { status: 400 })
  }
  const {
    uploadId,
    fileName,
    entityType,
    entityId,
    docType,
    exp,
    token,
    maxBytes,
  } = parseQuarantineParams(context.url, context.params as Record<string, string | undefined>)

  // Token verification — clamp caller-supplied maxBytes and always bind the
  // enforced byte ceiling to the exact value authenticated by the HMAC token.
  let effectiveMaxBytes = Math.min(maxBytes, MAX_UPLOAD_BYTES)
  let validToken = verifyUploadToken(
    { uploadId, fileName, entityType, entityId, docType, expiresAtMs: exp, maxBytes: effectiveMaxBytes },
    token,
  )
  if (!validToken && effectiveMaxBytes !== MAX_UPLOAD_BYTES) {
    validToken = verifyUploadToken(
      { uploadId, fileName, entityType, entityId, docType, expiresAtMs: exp, maxBytes: MAX_UPLOAD_BYTES },
      token,
    )
    if (validToken) {
      effectiveMaxBytes = MAX_UPLOAD_BYTES
    }
  }
  if (!uploadId || !validToken) {
    if (isJsonOrProblemRequest(req)) {
      return actionProblemResponse(context, new Error('invalid_or_expired_upload_token'), {
        status: 403,
        detail: 'Forbidden: invalid or expired upload token',
        extra: { error: 'forbidden' },
      })
    }
    return new Response('Forbidden: invalid or expired upload token', { status: 403 })
  }

  // ADR-0023 §5: reject an oversized body before reading it if declared length is known.
  let declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > effectiveMaxBytes) {
    let tooLargeErr = new UploadTooLargeError(`Payload Too Large: upload exceeds ${effectiveMaxBytes} bytes`)
    if (isJsonOrProblemRequest(req)) {
      return actionProblemResponse(context, tooLargeErr, {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        detail: `Payload Too Large: upload exceeds ${effectiveMaxBytes} bytes`,
        extra: { error: 'payload_too_large', maxBytes: effectiveMaxBytes },
      })
    }
    return new Response(`Payload Too Large: upload exceeds ${effectiveMaxBytes} bytes`, { status: 413 })
  }

  if (!req.body) {
    let emptyErr = new UploadEmptyError('Bad Request: empty upload body')
    if (isJsonOrProblemRequest(req)) {
      return actionProblemResponse(context, emptyErr, {
        status: 400,
        code: 'BAD_REQUEST',
        detail: 'Bad Request: empty upload body',
        extra: { error: 'bad_request' },
      })
    }
    return new Response('Bad Request: empty upload body', { status: 400 })
  }

  let safeName = sanitizeFileName(fileName)
  let quarantinePath = `quarantine/${uploadId}/${safeName}`
  let contentType = req.headers.get('content-type') || 'application/octet-stream'

  let streamResult
  try {
    streamResult = await putQuarantineStream(
      quarantinePath,
      req.body,
      safeName,
      contentType,
      effectiveMaxBytes,
    )
  } catch (err: unknown) {
    let errLike = asErrorLike(err)
    if (err instanceof UploadTooLargeError || errLike.code === 'UPLOAD_TOO_LARGE' || errLike.status === 413) {
      if (isJsonOrProblemRequest(req)) {
        return actionProblemResponse(context, err, {
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          detail: `Payload Too Large: upload exceeds ${effectiveMaxBytes} bytes`,
          extra: { error: 'payload_too_large', maxBytes: effectiveMaxBytes },
        })
      }
      return new Response(`Payload Too Large: upload exceeds ${effectiveMaxBytes} bytes`, { status: 413 })
    }
    if (err instanceof UploadEmptyError || errLike.code === 'UPLOAD_EMPTY' || errLike.status === 400) {
      if (isJsonOrProblemRequest(req)) {
        return actionProblemResponse(context, err, {
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'Bad Request: empty upload body',
          extra: { error: 'bad_request' },
        })
      }
      return new Response('Bad Request: empty upload body', { status: 400 })
    }
    throw err
  }

  try {
    await dbUploadMarkUploaded({
      uploadId,
      sha256Hex: streamResult.sha256Hex,
      byteSize: streamResult.byteSize,
      mimeType: contentType,
    })
  } catch (markErr) {
    return actionProblemResponse(context, markErr, {
      status: 500,
      detail: 'Failed to record core.upload uploaded state',
      extra: { error: 'upload_record_failed' },
    })
  }

  return new Response(null, { status: 201 })
}

