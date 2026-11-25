import * as fs from 'node:fs'
import * as path from 'node:path'

import { dbDir, repoRoot, schemaNames } from './lib.ts'

let errors: string[] = []
let schemas = schemaNames()

let srcDir = path.join(dbDir, 'src')
let srcSchemas = fs
  .readdirSync(srcDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_repeatable')
  .map((entry) => entry.name)
  .sort()

for (let schema of schemas) {
  if (!srcSchemas.includes(schema)) errors.push(`db/src/${schema}/ is missing`)
  let schemaDir = path.join(srcDir, schema)
  let sqlFiles = fs.existsSync(schemaDir)
    ? fs.readdirSync(schemaDir).filter((file) => file.endsWith('.sql'))
    : []
  if (sqlFiles.length === 0) errors.push(`db/src/${schema}/ has no .sql source files`)
}
for (let schema of srcSchemas) {
  if (!schemas.includes(schema)) errors.push(`db/src/${schema}/ is not listed in db/schemas.txt`)
}

let bootstrap = fs.readFileSync(path.join(dbDir, 'bootstrap', '02_schemas.sql'), 'utf8')
for (let schema of schemas) {
  if (!new RegExp(`create schema if not exists ${schema}\\b`, 'i').test(bootstrap)) {
    errors.push(`db/bootstrap/02_schemas.sql does not create ${schema}`)
  }
}

let forbidden = [
  [/\bcreate\s+schema\b/i, 'CREATE SCHEMA'],
  [/\bcreate\s+role\b/i, 'CREATE ROLE'],
  [/\bcreate\s+extension\b/i, 'CREATE EXTENSION'],
  [/\balter\s+.*\bowner\s+to\b/i, 'OWNER TO'],
  [/\brename\s+to\b/i, 'RENAME TO'],
  [
    /\b(serial|bigserial|smallserial)\b/i,
    'SERIAL / BIGSERIAL / SMALLSERIAL (use GENERATED ALWAYS AS IDENTITY instead; see "Where to use identity instead" in AGENTS.md and ADR-0034)',
  ],
]

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    let full = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

for (let file of walk(srcDir).filter((file) => file.endsWith('.sql'))) {
  let sql = fs.readFileSync(file, 'utf8')
  for (let [pattern, label] of forbidden) {
    if (pattern.test(sql)) {
      errors.push(`${path.relative(repoRoot, file)} contains forbidden ${label}`)
    }
  }
}

let repeatable = path.join(srcDir, '_repeatable')
if (fs.existsSync(repeatable) && fs.readdirSync(repeatable).length > 0) {
  errors.push('db/src/_repeatable/ is expected to be empty')
}

// Inside a SECURITY DEFINER function PostgreSQL switches the execution context to
// the definer, so `session_user` and `current_user` both report the owner
// (mms_owner) no matter who called the function. A guard written as
// `if session_user <> 'worker'` therefore never denies anyone: it compares the
// owner's own name, which is what the owner sees, so the branch is never taken.
// Use private.is_worker() or private.caller_role() instead; see ADR-0017.
//
// Only function bodies are affected. A table column default such as
// `sealed_by text not null default session_user` records the connection that
// inserted the row and is unaffected by the definer switch, so it stays allowed.
let isCallerCheckAllowed = (relative: string) =>
  relative === 'db/src/private/main.sql' || relative.startsWith('db/src/private/')

function functionBodies(sql: string): string[] {
  let bodies: string[] = []
  // `as $$ ... $$` / `as $tag$ ... $tag$`; nested blocks are not used in db/src.
  let pattern = /\bas\s+(\$[A-Za-z_]*\$)([\s\S]*?)\$[A-Za-z_]*\$/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) bodies.push(match[2]!)
  return bodies
}

for (let file of walk(srcDir).filter((file) => file.endsWith('.sql'))) {
  let relative = path.relative(repoRoot, file)
  if (isCallerCheckAllowed(relative)) continue
  let sql = fs.readFileSync(file, 'utf8')
  for (let body of functionBodies(sql)) {
    let match = body.match(/\b(session_user|current_user)\b/i)
    if (match) {
      errors.push(
        `${relative} uses ${match[1]} inside a function body; there it reports the definer, not the caller — use private.is_worker() or private.caller_role()`,
      )
      break
    }
  }
}


let ignore = path.join(dbDir, '.pgschemaignore')
if (fs.existsSync(ignore)) {
  let active = fs
    .readFileSync(ignore, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (active.length > 0) errors.push('db/.pgschemaignore has active entries; expected empty')
}

if (errors.length > 0) {
  for (let error of errors) console.error(`lint: ${error}`)
  process.exit(1)
}
console.log(`schema lint passed (${schemas.length} schemas)`)
