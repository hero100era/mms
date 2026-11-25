import { createController } from 'remix/router'
import { routes } from '../routes.ts'
import { assets } from '../assets.ts'
import { publicJwks } from '../auth/token-signer.ts'

export default createController(routes, {
  actions: {
    async assets(context) {
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
    },
    jwks() {
      let body = JSON.stringify(publicJwks())
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      })
    },
  },
})
