import * as fs from 'node:fs'
import * as path from 'node:path'
import { psql, repoRoot, requireDatabaseUrl } from './lib.ts'

type Row = Record<string, unknown>

function strip(value: string): string {
  return value.trim().replace(/^`|`$/g, '')
}

function nullable(value: string): string | null {
  let text = value.trim()
  if (text === '' || text === '—' || text === '-' || text === '*any*') return null
  return strip(text)
}

function readTable(file: string, header: string): string[][] {
  let lines = fs.readFileSync(file, 'utf8').split('\n')
  let rows: string[][] = []
  let inTable = false
  for (let line of lines) {
    if (!line.trim().startsWith('|')) {
      if (inTable) break
      continue
    }
    let cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    if (!inTable) {
      if (cells[0] === header) inTable = true
      continue
    }
    if (cells[0] === 'Code' || cells[0] === 'Unit type' || cells[0] === 'Action') break
    rows.push(cells)
  }
  return rows
}

function jsonRows(url: string, sql: string): Row[] {
  let output = psql(url, ['-Atc', sql]).stdout.trim()
  return JSON.parse(output) as Row[]
}

function parseGradeRange(value: string): { min: number; max: number } {
  let match = value.match(/(\d+)\s*[–-]\s*(\d+)/)
  if (match) return { min: Number(match[1]), max: Number(match[2]) }
  let grade = Number(value)
  if (!Number.isInteger(grade)) throw new Error(`bad grade range: ${value}`)
  return { min: grade, max: grade }
}

function parseLimit(value: string): { max: number | null; currency: string | null } {
  let text = value.trim()
  if (text === '—' || text === '-' || text === 'unlimited') {
    return { max: null, currency: null }
  }
  let match = text.match(/^([\d,]+)\s+([A-Z]{3})$/)
  if (!match) throw new Error(`bad authority limit: ${value}`)
  return { max: Number(match[1].replaceAll(',', '')), currency: match[2] }
}

export function checkOrgDocs(url: string): void {
  let titles = readTable(path.join(repoRoot, 'docs', 'org', 'job-titles.md'), 'Code').map(
    ([code, label, family, grade]) => ({
      code: strip(code),
      label_en: label,
      job_family: family.trim() === 'from unit' ? null : nullable(family),
      grade: Number(grade),
    }),
  )

  let rules = readTable(path.join(repoRoot, 'docs', 'org', 'default-role-rules.md'), 'Unit type')
    .map(([unitType, family, grade, role, scope]) => {
      let range = parseGradeRange(grade)
      return {
        unit_type: nullable(unitType),
        job_family: nullable(family),
        min_grade: range.min,
        max_grade: range.max,
        db_role: strip(role),
        scope_target: strip(scope),
      }
    })
    .filter((row) => row.scope_target === 'own_unit' || row.scope_target === 'parent_unit' || row.scope_target === 'global')

  let authorities = readTable(path.join(repoRoot, 'docs', 'org', 'default-role-rules.md'), 'Action')
    .map(([action, role, family, unitType, minGrade, limit, qualification]) => {
      let parsed = parseLimit(limit)
      return {
        action_code: strip(action),
        db_role: strip(role),
        job_family: nullable(family),
        unit_type: nullable(unitType),
        min_grade: Number(minGrade),
        max_amount: parsed.max,
        currency: parsed.currency,
        requires_qualification: qualification.trim() === 'yes',
      }
    })

  let dbTitles = jsonRows(
    url,
    `select coalesce(json_agg(json_build_object(
       'code', code, 'label_en', label_en, 'job_family', job_family, 'grade', grade
     ) order by code), '[]') from iam.job_title`,
  )
  let dbRules = jsonRows(
    url,
    `select coalesce(json_agg(json_build_object(
       'unit_type', unit_type, 'job_family', job_family,
       'min_grade', min_grade, 'max_grade', max_grade,
       'db_role', db_role, 'scope_target', scope_target
     ) order by unit_type nulls first, job_family nulls first, min_grade, db_role, scope_target), '[]')
     from iam.default_role_rule`,
  )
  let dbAuthorities = jsonRows(
    url,
    `select coalesce(json_agg(json_build_object(
       'action_code', action_code, 'db_role', db_role,
       'job_family', job_family, 'unit_type', unit_type,
       'min_grade', min_grade, 'max_amount', max_amount,
       'currency', currency, 'requires_qualification', requires_qualification
     ) order by action_code, db_role, min_grade, unit_type nulls first), '[]')
     from iam.authority_rule`,
  )

  let problems: string[] = []
  let compare = (name: string, docs: Row[], db: Row[]) => {
    let left = JSON.stringify(docs)
    let right = JSON.stringify(db)
    if (left !== right) {
      problems.push(`${name} does not match docs`)
      for (let index = 0; index < Math.max(docs.length, db.length); index++) {
        if (JSON.stringify(docs[index]) !== JSON.stringify(db[index])) {
          console.error(`first ${name} difference at row ${index}:`)
          console.error(`  docs: ${JSON.stringify(docs[index])}`)
          console.error(`  db:   ${JSON.stringify(db[index])}`)
          break
        }
      }
    }
  }

  titles.sort((a, b) => a.code.localeCompare(b.code))
  rules.sort((a, b) =>
    String(a.unit_type ?? '').localeCompare(String(b.unit_type ?? '')) ||
    String(a.job_family ?? '').localeCompare(String(b.job_family ?? '')) ||
    Number(a.min_grade) - Number(b.min_grade) ||
    String(a.db_role).localeCompare(String(b.db_role)) ||
    String(a.scope_target).localeCompare(String(b.scope_target)),
  )
  authorities.sort((a, b) =>
    String(a.action_code).localeCompare(String(b.action_code)) ||
    String(a.db_role).localeCompare(String(b.db_role)) ||
    Number(a.min_grade) - Number(b.min_grade) ||
    String(a.unit_type ?? '').localeCompare(String(b.unit_type ?? '')),
  )

  compare('job titles', titles, dbTitles as Row[])
  compare('default role rules', rules, dbRules as Row[])
  compare('authority rules', authorities, dbAuthorities as Row[])

  if (problems.length > 0) {
    throw new Error(problems.join('\n'))
  }
  console.log('org seed docs match iam tables')
}

if (process.argv[1]?.endsWith('check-org-docs.ts')) {
  checkOrgDocs(requireDatabaseUrl())
}
