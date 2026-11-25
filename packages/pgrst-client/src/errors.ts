export type PgrstErrorBody = {
  code?: string
  message?: string
  details?: string
  hint?: string
}

export class PgrstError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly details: string | undefined
  readonly hint: string | undefined

  constructor(status: number, body: PgrstErrorBody) {
    super(body.message ?? `PostgREST request failed with ${status}`)
    this.name = 'PgrstError'
    this.status = status
    this.code = body.code
    this.details = body.details
    this.hint = body.hint
  }
}

export class UnauthorizedError extends PgrstError {
  constructor(body: PgrstErrorBody) {
    super(401, body)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends PgrstError {
  constructor(body: PgrstErrorBody) {
    super(403, body)
    this.name = 'ForbiddenError'
  }
}
