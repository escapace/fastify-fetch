/**
 * Provides a Fastify plugin and policy types for policy-routed Fetch execution across internal injection and external HTTP(S) calls.
 *
 * @packageDocumentation
 */
import { fastifyFetch } from './fastify-fetch'
import type { FastifyFetch, FastifyFetchExternalFetch } from './types'

export { fromNodeHeaders, splitCookiesString, toNodeHeaders } from './headers'
export { sameOrigin } from './same-origin'

/**
 * Fetch function type used by {@link FastifyFetchOptions.externalFetch}.
 */
export type Fetch = FastifyFetchExternalFetch

export type {
  FastifyFetch,
  FastifyFetchBoundaryPolicy,
  FastifyFetchCallOverrides,
  FastifyFetchContract,
  FastifyFetchExternalFetch,
  FastifyFetchInit,
  FastifyFetchInput,
  FastifyFetchOptions,
  FastifyFetchOverflowPolicy,
  FastifyFetchPolicy,
  FastifyFetchResponse,
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
    fetch: FastifyFetch
  }
}

export { fastifyFetch }

/**
 * Default export alias for {@link fastifyFetch}.
 */
export default fastifyFetch
