import type { fetch } from 'undici'
import { fastifyFetch } from './fastify-fetch'

export { fromNodeHeaders, splitCookiesString, toNodeHeaders } from './headers'
export { sameOrigin } from './same-origin'

export type Fetch = typeof fetch

export type {
  FastifyFetch,
  FastifyFetchBoundaryPolicy,
  FastifyFetchCallOverrides,
  FastifyFetchContract,
  FastifyFetchInit,
  FastifyFetchOptions,
  FastifyFetchOverflowPolicy,
  FastifyFetchPolicy,
  FastifyFetchRoute,
  FastifyFetchRouteContext,
  FastifyFetchRouteDecision,
  FastifyFetchTransport,
} from './types'

declare module 'fastify/types/instance' {
  interface FastifyInstance {
    fetch: import('./types').FastifyFetch
  }
}

export { fastifyFetch }
export default fastifyFetch
