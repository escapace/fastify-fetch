import { fetch } from 'undici'
import { fastifyFetch } from './fastify-fetch'

export { fromNodeHeaders, toNodeHeaders } from './headers'
export { sameOrigin } from './same-origin'

export type Fetch = typeof fetch

declare module 'fastify/types/instance' {
  interface FastifyInstance {
    fetch: Fetch
  }
}

export { fastifyFetch }
export default fastifyFetch
