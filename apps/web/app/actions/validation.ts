// Shared validation layer for action requests (R4.1).
// Prevents raw FormDataEntryValue or unexpected types from flowing into database RPCs.

export class ValidationError extends Error {
  readonly status = 400
  readonly fields: Record<string, string>

  constructor(fields: Record<string, string>, message = 'Validation failed') {
    super(message)
    this.name = 'ValidationError'
    this.fields = fields
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Ensures an input is a text string and never a File object or missing. */
export function ensureText(
  val: unknown,
  fieldName = 'field',
  options?: { minLength?: number; maxLength?: number; allowEmpty?: boolean },
): string {
  if (val === undefined || val === null) {
    if (options?.allowEmpty) return ''
    throw new ValidationError({ [fieldName]: `${fieldName} is required` })
  }
  if (typeof (val as any)?.arrayBuffer === 'function' || val instanceof Blob) {
    throw new ValidationError({ [fieldName]: `${fieldName} must be a text value, not a file` })
  }
  let str = String(val).trim()
  if (!options?.allowEmpty && str.length === 0) {
    throw new ValidationError({ [fieldName]: `${fieldName} cannot be empty` })
  }
  if (options?.minLength && str.length < options.minLength) {
    throw new ValidationError({
      [fieldName]: `${fieldName} must be at least ${options.minLength} characters`,
    })
  }
  if (options?.maxLength && str.length > options.maxLength) {
    throw new ValidationError({
      [fieldName]: `${fieldName} cannot exceed ${options.maxLength} characters`,
    })
  }
  return str
}

export function requireText(form: FormData, name: string, options?: { minLength?: number; maxLength?: number }): string {
  return ensureText(form.get(name), name, options)
}

export function optionalText(form: FormData, name: string, maxLength = 1000): string | null {
  return validateOptionalString(form.get(name), name, maxLength)
}

export function requireUuid(form: FormData, name: string): string {
  return validateUuid(form.get(name), name)
}

export function optionalUuid(form: FormData, name: string): string | null {
  return validateOptionalUuid(form.get(name), name)
}

export function requireEmail(form: FormData, name: string): string {
  return validateEmail(form.get(name), name)
}

export function safeFormText(form: FormData, name: string): string {
  let val = form.get(name)
  if (typeof val !== 'string') return ''
  return val.trim()
}

export function requireUuidFromParams(params: Record<string, string | undefined>, name: string): string {
  return validateUuid(params[name], name)
}

export function requireEnum<T extends string>(form: FormData, name: string, allowed: readonly T[]): T {
  return validateEnum(form.get(name), allowed, name)
}

export function requireBoundedReason(form: FormData, name: string, minLen?: number, maxLen?: number): string {
  return validateReason(form.get(name), minLen, maxLen, name)
}

export function requireFile(form: FormData, name: string): File {
  let val = form.get(name)
  if (!(val instanceof File)) {
    throw new ValidationError({ [name]: `${name} is required and must be a file` })
  }
  return val
}

export function optionalFile(form: FormData, name: string): File | null {
  let val = form.get(name)
  if (val === null || val === undefined) return null
  if (!(val instanceof File)) {
    throw new ValidationError({ [name]: `${name} must be a file` })
  }
  return val
}

export function optionalInteger(
  form: FormData,
  name: string,
  options?: { min?: number; max?: number; defaultValue?: number },
): number {
  return validateInteger(form.get(name), name, options)
}

/** Validates and canonicalizes a UUID. */
export function validateUuid(val: unknown, fieldName = 'id'): string {
  let text = ensureText(val, fieldName)
  if (!UUID_RE.test(text)) {
    throw new ValidationError({ [fieldName]: `${fieldName} must be a valid UUID` })
  }
  return text.toLowerCase()
}

/** Validates an optional UUID, returning null if empty or undefined. */
export function validateOptionalUuid(val: unknown, fieldName = 'id'): string | null {
  if (val === undefined || val === null) return null
  if (typeof (val as any)?.arrayBuffer === 'function' || val instanceof Blob) {
    throw new ValidationError({ [fieldName]: `${fieldName} must be a text value, not a file` })
  }
  let text = String(val).trim()
  if (text.length === 0) return null
  if (!UUID_RE.test(text)) {
    throw new ValidationError({ [fieldName]: `${fieldName} must be a valid UUID` })
  }
  return text.toLowerCase()
}

/** Normalizes and validates an email address. */
export function validateEmail(val: unknown, fieldName = 'email'): string {
  let text = ensureText(val, fieldName, { minLength: 3, maxLength: 254 }).toLowerCase()
  if (!EMAIL_RE.test(text)) {
    throw new ValidationError({ [fieldName]: 'Invalid email address format' })
  }
  return text
}

/** Validates an audit or change reason string with strict length boundaries. */
export function validateReason(
  val: unknown,
  minLen = 3,
  maxLen = 500,
  fieldName = 'reason',
): string {
  return ensureText(val, fieldName, { minLength: minLen, maxLength: maxLen })
}

/** Validates that an input matches an allowed set of enum values. */
export function validateEnum<T extends string>(
  val: unknown,
  allowed: readonly T[],
  fieldName = 'value',
): T {
  let text = ensureText(val, fieldName)
  if (!allowed.includes(text as T)) {
    throw new ValidationError({
      [fieldName]: `Invalid ${fieldName}; allowed: ${allowed.join(', ')}`,
    })
  }
  return text as T
}

/** Validates an optional text field, returning null if empty. */
export function validateOptionalString(
  val: unknown,
  fieldName = 'field',
  maxLength = 1000,
): string | null {
  if (val === undefined || val === null) return null
  if (typeof (val as any)?.arrayBuffer === 'function' || val instanceof Blob) {
    throw new ValidationError({ [fieldName]: `${fieldName} must be a text value, not a file` })
  }
  let text = String(val).trim()
  if (text.length === 0) return null
  if (text.length > maxLength) {
    throw new ValidationError({ [fieldName]: `${fieldName} cannot exceed ${maxLength} characters` })
  }
  return text
}

/** Validates integer values within boundaries. */
export function validateInteger(
  val: unknown,
  fieldName = 'value',
  options?: { min?: number; max?: number; defaultValue?: number },
): number {
  if (val === undefined || val === null || String(val).trim() === '') {
    if (options?.defaultValue !== undefined) return options.defaultValue
    throw new ValidationError({ [fieldName]: `${fieldName} is required` })
  }
  let num = Number(String(val).trim())
  if (!Number.isInteger(num)) {
    throw new ValidationError({ [fieldName]: `${fieldName} must be an integer` })
  }
  if (options?.min !== undefined && num < options.min) {
    throw new ValidationError({ [fieldName]: `${fieldName} cannot be less than ${options.min}` })
  }
  if (options?.max !== undefined && num > options.max) {
    throw new ValidationError({ [fieldName]: `${fieldName} cannot exceed ${options.max}` })
  }
  return num
}

/** Clamps pagination parameters to safe defaults. */
export function validatePagination(
  limitVal?: unknown,
  offsetVal?: unknown,
  maxLimit = 100,
  defaultLimit = 20,
): { limit: number; offset: number } {
  let limit = validateInteger(limitVal, 'limit', { min: 1, max: maxLimit, defaultValue: defaultLimit })
  let offset = validateInteger(offsetVal, 'offset', { min: 0, defaultValue: 0 })
  return { limit, offset }
}

/** Safe filename validator rejecting path traversal, control chars, and reserved names. */
export function validateFilename(val: unknown, fieldName = 'file_name'): string {
  let name = ensureText(val, fieldName, { minLength: 1, maxLength: 255 })
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    /[\x00-\x1f\x7f"';]/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)
  ) {
    throw new ValidationError({ [fieldName]: 'Invalid filename: disallowed characters or reserved name' })
  }
  return name
}
