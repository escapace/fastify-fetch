import type { Request, RequestInfo, RequestInit, Response, fetch } from 'undici'

/**
 * Selects where and how a fetch call is executed.
 *
 * @remarks
 * `internal-buffered` and `internal-stream` dispatch through Fastify injection, `external` delegates to the configured external fetch implementation, and `reject` fails the call with a fetch-style error.
 * `reject` can be returned by {@link FastifyFetchPolicy.route}, but it is intentionally excluded from {@link FastifyFetchPolicy.defaultTransport} and {@link FastifyFetchCallOverrides.transport}.
 */
export type FastifyFetchTransport = 'external' | 'internal-buffered' | 'internal-stream' | 'reject'

/**
 * Selects response payload and header handling for internal executions.
 *
 * @remarks
 * `fetch` decodes supported content codings while preserving wire headers, `forward-safe` decodes and normalizes relay-sensitive headers, and `wire-stream` preserves encoded payload bytes.
 */
export type FastifyFetchContract = 'fetch' | 'forward-safe' | 'wire-stream'

/**
 * Defines redirect behavior when handling reaches an internal-to-external boundary.
 *
 * @remarks
 * `delegate` allows boundary transition to external transport, while `reject` fails the call when that transition is required.
 */
export type FastifyFetchBoundaryPolicy = 'delegate' | 'reject'

/**
 * Defines overflow behavior when buffered payload limits are exceeded.
 *
 * @remarks
 * `fallback` attempts stream transport only when fallback is applicable for the current request and response path.
 * Calls still fail when fallback cannot be applied.
 * `reject` fails immediately when buffered limits are exceeded.
 */
export type FastifyFetchOverflowPolicy = 'fallback' | 'reject'

/**
 * Provides request and redirect metadata for route policy decisions.
 */
export interface FastifyFetchRouteContext {
  /**
   * URL currently being evaluated for transport and contract decisions.
   */
  readonly currentUrl: URL

  /**
   * Indicates whether the current evaluation occurs after at least one redirect hop.
   */
  readonly isRedirect: boolean

  /**
   * Original Fetch request constructed for the `app.fetch` call.
   */
  readonly originalRequest: Request

  /**
   * URL from the previous hop, when evaluation occurs during redirect handling.
   */
  readonly previousUrl: URL | undefined

  /**
   * Number of redirects followed before the current evaluation.
   */
  readonly redirectCount: number

  /**
   * Returns whether the redirect transition crosses origins.
   */
  readonly isCrossOriginRedirect: () => boolean
}

/**
 * Represents the result returned by a route policy callback.
 *
 * @remarks
 * String form selects transport directly, while object form sets transport and optional response contract.
 */
export type FastifyFetchRouteDecision =
  | FastifyFetchTransport
  | {
      /**
       * Transport selected for the current request evaluation.
       */
      readonly transport: FastifyFetchTransport

      /**
       * Optional contract selected for the current request evaluation.
       */
      readonly contract?: FastifyFetchContract
    }

/**
 * Computes a route decision from the current routing context.
 *
 * @param context - Request and redirect metadata used for decision making.
 * @returns Transport-only or transport-plus-contract decision.
 */
export type FastifyFetchRoute = (context: FastifyFetchRouteContext) => FastifyFetchRouteDecision

/**
 * Defines default routing, redirect, buffering, and contract policy for `app.fetch`.
 *
 * @remarks
 * Decision precedence is: call overrides from {@link FastifyFetchInit.fastifyFetch} when {@link FastifyFetchOptions.allowPerCallOverrides} is `true`, then {@link FastifyFetchPolicy.route}, then policy defaults.
 *
 * @see {@link FastifyFetchRoute}
 * @see {@link FastifyFetchTransport}
 * @see {@link FastifyFetchContract}
 */
export interface FastifyFetchPolicy {
  /**
   * Configures buffered payload limits and overflow behavior.
   *
   * Defaults are `1048576` request bytes (`1 MiB`), `8388608` response bytes (`8 MiB`), and `onOverflow: 'fallback'`.
   */
  readonly buffering?: {
    /**
     * Maximum request bytes buffered before overflow handling applies.
     *
     * Default is `1048576` bytes (`1 MiB`).
     *
     * @defaultValue `1048576`
     */
    readonly maxRequestBytes?: number

    /**
     * Maximum response bytes buffered before overflow handling applies.
     *
     * Default is `8388608` bytes (`8 MiB`).
     *
     * @defaultValue `8388608`
     */
    readonly maxResponseBytes?: number

    /**
     * Overflow behavior when buffered limits are exceeded.
     *
     * @defaultValue `'fallback'`
     */
    readonly onOverflow?: FastifyFetchOverflowPolicy
  }

  /**
   * Default response contract when route and call overrides do not set one.
   *
   * Default is `'fetch'`.
   *
   * @defaultValue `'fetch'`
   */
  readonly defaultContract?: FastifyFetchContract

  /**
   * Default transport when route and call overrides do not set one.
   *
   * Default is `'internal-buffered'`.
   *
   * @defaultValue `'internal-buffered'`
   */
  readonly defaultTransport?: Exclude<FastifyFetchTransport, 'reject'>

  /**
   * Configures redirect hop limits and boundary behavior.
   *
   * Defaults are `maxHops: 20` and `onBoundary: 'delegate'`.
   */
  readonly redirects?: {
    /**
     * Maximum redirects followed before failure.
     *
     * @defaultValue `20`
     */
    readonly maxHops?: number

    /**
     * Behavior when redirect handling reaches an internal-to-external boundary.
     *
     * @defaultValue `'delegate'`
     */
    readonly onBoundary?: FastifyFetchBoundaryPolicy
  }

  /**
   * Callback used to resolve transport and optional contract per request evaluation.
   */
  readonly route?: FastifyFetchRoute
}

/**
 * Defines optional contract and transport overrides for a single `app.fetch` call.
 *
 * @remarks
 * Call overrides are applied only when {@link FastifyFetchOptions.allowPerCallOverrides} is `true`.
 * `transport` intentionally excludes `reject`, so call-level overrides can choose execution location but cannot force policy rejection.
 */
export interface FastifyFetchCallOverrides {
  /**
   * Contract override for a single call.
   */
  readonly contract?: FastifyFetchContract

  /**
   * Transport override for a single call.
   */
  readonly transport?: Exclude<FastifyFetchTransport, 'reject'>
}

/**
 * Extends Fetch `RequestInit` with optional fastify-fetch call overrides.
 *
 * @see {@link FastifyFetchOptions.allowPerCallOverrides}
 */
export interface FastifyFetchInit extends RequestInit {
  /**
   * Per-call policy overrides for transport and contract decisions.
   *
   * @remarks
   * This field is applied only when {@link FastifyFetchOptions.allowPerCallOverrides} is `true`; otherwise it is ignored.
   */
  readonly fastifyFetch?: FastifyFetchCallOverrides
}

/**
 * Defines plugin registration options for `fastifyFetch`.
 */
export interface FastifyFetchOptions {
  /**
   * Enables call-level overrides provided through {@link FastifyFetchInit.fastifyFetch}.
   *
   * @remarks
   * When `true`, {@link FastifyFetchCallOverrides.transport} and {@link FastifyFetchCallOverrides.contract} can override route and default policy decisions for one call.
   * Call-level transport overrides can choose internal or external execution, but cannot force `reject`.
   * When `false`, values in {@link FastifyFetchInit.fastifyFetch} are ignored.
   *
   * @defaultValue `false`
   */
  readonly allowPerCallOverrides?: boolean

  /**
   * External fetch implementation used when policy delegates to `external` transport.
   *
   * @defaultValue `undici.fetch`
   */
  readonly externalFetch?: typeof fetch

  /**
   * Global policy used to resolve routing, redirects, buffering, and contract defaults.
   *
   * @see {@link FastifyFetchPolicy}
   */
  readonly policy?: FastifyFetchPolicy
}

/**
 * Fetch-compatible call signature decorated on the Fastify instance.
 *
 * @param input - Request input accepted by Fetch.
 * @param init - Optional request initialization including fastify-fetch call overrides.
 * @returns Promise resolving to a Fetch `Response`.
 */
export type FastifyFetch = (input: RequestInfo | URL, init?: FastifyFetchInit) => Promise<Response>
