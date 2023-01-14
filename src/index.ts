import { fetch } from 'undici'
import { fastifyFetch } from './fastify-fetch'

export type Fetch = typeof fetch

declare module 'fastify/types/instance' {
  interface FastifyInstance {
    fetch: Fetch
  }
}

export { fastifyFetch }
export default fastifyFetch
