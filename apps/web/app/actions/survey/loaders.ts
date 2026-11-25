import type { PgrstClient } from '@mms/pgrst-client'

export interface SurveyDetailResult {
  request: any
  documents: any[]
  versions: any[]
  auditEvents: any[]
  stations: any[]
}

export async function loadSurveyDetail(
  client: PgrstClient,
  id: string,
  options?: { includeStations?: boolean; includeAudit?: boolean },
): Promise<SurveyDetailResult | null> {
  let requests: any[] = []
  try {
    requests = await client.select('survey_requests', { id: `eq.${id}` })
  } catch {
    return null
  }

  if (!requests || requests.length === 0) {
    return null
  }
  let request = requests[0]

  let docsPromise = client
    .select('documents', { entity_type: 'eq.survey_request', entity_id: `eq.${id}` })
    .catch(() => [])

  let stationsPromise = options?.includeStations
    ? client
        .select('org_units', {
          unit_type: 'eq.station',
          active: 'eq.true',
          order: 'name.asc',
        })
        .catch(() => [])
    : Promise.resolve([])

  let auditEventsPromise =
    options?.includeAudit !== false
      ? client
          .select('audit_events', { subject_id: `eq.${id}`, order: 'occurred_at.desc' })
          .catch(() => [])
      : Promise.resolve([])

  let docs: any[] = (await docsPromise) ?? []
  let docIds = docs.map((d: any) => d.id)

  let versionsPromise =
    docIds.length > 0
      ? client
          .select('document_versions', {
            document_id: `in.(${docIds.join(',')})`,
            order: 'revision_no.desc',
          })
          .catch(() => [])
      : Promise.resolve([])

  let [stations, auditEvents, versions] = await Promise.all([
    stationsPromise,
    auditEventsPromise,
    versionsPromise,
  ])

  return {
    request,
    documents: docs,
    versions: versions ?? [],
    auditEvents: auditEvents ?? [],
    stations: stations ?? [],
  }
}

export async function loadSurveyFormLookups(
  client: PgrstClient,
): Promise<[any[], any[], any[]]> {
  let [ships, stations, orgs] = await Promise.all([
    client.select('ships', { order: 'name.asc' }).catch(() => []),
    client.select('org_units', {
      unit_type: 'eq.station',
      active: 'eq.true',
      order: 'name.asc',
    }).catch(() => []),
    client.select('organizations', { order: 'name.asc' }).catch(() => []),
  ])

  return [ships ?? [], stations ?? [], orgs ?? []]
}
