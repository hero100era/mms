import { request, type APIRequestContext } from 'playwright'

export interface PersonaSession {
  context: APIRequestContext
  personaKey: string
  csrf: string
}

export async function createPersonaContext(
  baseUrl: string,
  personaKey: string,
): Promise<PersonaSession> {
  let context = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: {
      'x-forwarded-for': '203.0.113.199',
    },
  })

  // 1. Fetch CSRF token from /dev/login
  let getRes = await context.get('/dev/login')
  if (!getRes.ok()) {
    throw new Error(`Failed to GET /dev/login (status ${getRes.status()}): ensure ALLOW_DEV_LOGIN=true and APP_ENV in {local, test}`)
  }

  let html = await getRes.text()
  let csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/)
  if (!csrfMatch) {
    throw new Error('CSRF token not found on /dev/login')
  }
  let csrf = csrfMatch[1]!

  // 2. Submit persona login
  let postRes = await context.post('/dev/login', {
    form: {
      _csrf: csrf,
      personaKey,
    },
    maxRedirects: 0,
  })

  // 302 Redirect to /profile expected
  if (postRes.status() !== 302 && postRes.status() !== 200) {
    throw new Error(`Failed to login as persona ${personaKey}: HTTP ${postRes.status()}`)
  }

  // Refresh CSRF token for future POST actions
  let profileRes = await context.get('/profile')
  let profileHtml = await profileRes.text()
  let nextCsrf = profileHtml.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? csrf

  return {
    context,
    personaKey,
    csrf: nextCsrf,
  }
}
