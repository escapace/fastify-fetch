/**
 * Provides a Fastify plugin and policy types for policy-routed Fetch execution across internal injection and external HTTP(S) calls.
 *
 * @packageDocumentation
 */
import type { fetch } from 'undici'
import { fastifyFetch } from './fastify-fetch'

export { fromNodeHeaders, splitCookiesString, toNodeHeaders } from './headers'
export { sameOrigin } from './same-origin'

/**
 * Fetch function type used by {@link FastifyFetchOptions.externalFetch}.
 */
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
    /**
     * Fetch-compatible method decorated by {@link fastifyFetch}.
     */
    fetch: import('./types').FastifyFetch
  }
}

export { fastifyFetch }

/**
 * Default export alias for {@link fastifyFetch}.
 */
export default fastifyFetch
