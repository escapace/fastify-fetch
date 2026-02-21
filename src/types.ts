import type { Request, RequestInfo, RequestInit, Response, fetch } from 'undici'

export type FastifyFetchTransport = 'external' | 'internal-buffered' | 'internal-stream' | 'reject'

export type FastifyFetchContract = 'fetch' | 'forward-safe' | 'wire-stream'

export type FastifyFetchBoundaryPolicy = 'delegate' | 'reject'
export type FastifyFetchOverflowPolicy = 'fallback' | 'reject'

export interface FastifyFetchRouteContext {
  readonly currentUrl: URL
  readonly isRedirect: boolean
  readonly originalRequest: Request
  readonly previousUrl: URL | undefined
  readonly redirectCount: number
  readonly isCrossOriginRedirect: () => boolean
}

export type FastifyFetchRouteDecision =
  | FastifyFetchTransport
  | {
      readonly transport: FastifyFetchTransport
      readonly contract?: FastifyFetchContract
    }

export type FastifyFetchRoute = (context: FastifyFetchRouteContext) => FastifyFetchRouteDecision

export interface FastifyFetchPolicy {
  readonly buffering?: {
    readonly maxRequestBytes?: number
    readonly maxResponseBytes?: number
    readonly onOverflow?: FastifyFetchOverflowPolicy
  }
  readonly defaultContract?: FastifyFetchContract
  readonly defaultTransport?: Exclude<FastifyFetchTransport, 'reject'>
  readonly redirects?: {
    readonly maxHops?: number
    readonly onBoundary?: FastifyFetchBoundaryPolicy
  }
  readonly route?: FastifyFetchRoute
}

export interface FastifyFetchCallOverrides {
  readonly contract?: FastifyFetchContract
  readonly transport?: Exclude<FastifyFetchTransport, 'reject'>
}

export interface FastifyFetchInit extends RequestInit {
  readonly fastifyFetch?: FastifyFetchCallOverrides
}

export interface FastifyFetchOptions {
  readonly allowPerCallOverrides?: boolean
  readonly externalFetch?: typeof fetch
  readonly policy?: FastifyFetchPolicy
}

export type FastifyFetch = (input: RequestInfo | URL, init?: FastifyFetchInit) => Promise<Response>
