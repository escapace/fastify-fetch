# fastify-fetch

Fastify plugin that decorates the Fastify instance with `app.fetch` and routes requests through internal injection or external fetch according to policy.

This approach is most useful for services that combine in-process route calls with external HTTP(S) calls and need explicit policy control over redirects, trust boundaries, and payload behavior. It is not intended for non-Fastify runtimes, browser-side fetch abstractions, or workflow orchestration concerns such as retries, caching, and circuit breaking.

## Usage

```bash
pnpm add fastify-fetch
```

```ts
import fastify from 'fastify'
import fastifyFetch from 'fastify-fetch'

const app = fastify()

await app.register(fastifyFetch)

app.get('/health', async () => ({ status: 'ok' }))

const response = await app.fetch('https://example.com/health')
console.log(await response.json())
```

## Policy choices

Policy choices usually follow a service journey: set a routing baseline, define redirect boundary behavior, set payload limits, and select a response contract default.

### Local orchestration with selective external calls

This pattern fits when service-local calls should run internally for latency and test parity, while third-party domains delegate externally.

This example focuses on routing defaults and route decisions.

```ts
policy: {
  defaultTransport: 'external',
  route: ({ currentUrl }) =>
    currentUrl.hostname === 'api.internal.local' ? 'internal-buffered' : 'external',
}
```

This configuration keeps internal-domain targets internal and delegates other targets externally.

### Explicit deny rules for restricted paths

This pattern fits when selected paths should be rejected regardless of other routing defaults.

This example focuses on route-level rejection decisions.

```ts
policy: {
  defaultTransport: 'internal-buffered',
  route: ({ currentUrl }) =>
    currentUrl.pathname.startsWith('/admin/') ? 'reject' : 'internal-buffered',
}
```

This configuration rejects restricted paths and keeps other paths on internal transport.

### Redirect delegation with hop control

This pattern fits when same-origin redirects can remain internal, cross-origin redirects should delegate externally, and redirect depth must be bounded.

This example focuses on `redirects.onBoundary: 'delegate'` and `redirects.maxHops`.

```ts
import { sameOrigin } from 'fastify-fetch'

policy: {
  redirects: {
    onBoundary: 'delegate',
    maxHops: 10,
  },
  route: ({ currentUrl, isRedirect, previousUrl }) => {
    if (isRedirect && previousUrl && !sameOrigin(previousUrl, currentUrl)) {
      return 'external'
    }

    return 'internal-buffered'
  },
}
```

This configuration keeps same-origin redirects internal, delegates cross-origin redirects externally, and caps redirect chains at ten hops.

### Redirect hard-boundary enforcement

This pattern fits when redirects must never cross from internal execution to external fetch.

This example focuses on `redirects.onBoundary: 'reject'`.

```ts
policy: {
  redirects: {
    onBoundary: 'reject',
    maxHops: 10,
  },
  route: ({ currentUrl }) =>
    currentUrl.hostname === 'api.internal.local' ? 'internal-buffered' : 'external',
}
```

This configuration rejects cross-boundary redirects instead of delegating them.

### Large payload path with fallback streaming

This pattern fits when common calls can remain buffered while large upload and download paths avoid unbounded buffering.

This example focuses on payload limits with overflow fallback.

```ts
policy: {
  buffering: {
    maxRequestBytes: 1 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    onOverflow: 'fallback',
  },
  route: ({ currentUrl }) =>
    currentUrl.pathname.startsWith('/downloads/')
      ? { transport: 'internal-stream', contract: 'wire-stream' }
      : 'internal-buffered',
}
```

This configuration keeps standard paths buffered and moves `/downloads/*` paths to streaming with wire preservation. Overflow fallback applies to buffered paths and is conditional, so calls can still fail when fallback conditions are not met.

### Strict capacity rejection

This pattern fits when over-limit payloads should fail fast instead of changing transport mode.

This example focuses on `buffering.onOverflow: 'reject'`.

```ts
policy: {
  buffering: {
    maxRequestBytes: 512 * 1024,
    maxResponseBytes: 2 * 1024 * 1024,
    onOverflow: 'reject',
  },
}
```

This configuration rejects requests or responses that exceed configured buffered limits.

### Forward-safe default for relay-heavy services

This pattern fits when most responses are forwarded downstream and relay-safe header normalization should be the default.

This example focuses on `defaultContract`.

```ts
policy: {
  defaultContract: 'forward-safe',
  route: ({ currentUrl }) =>
    currentUrl.pathname.startsWith('/client/')
      ? { transport: 'internal-buffered', contract: 'fetch' }
      : 'internal-buffered',
}
```

This configuration applies `forward-safe` by default and uses `fetch` only on client-facing paths.

### Contract selection quick reference

| Contract       | Best-fit use case                                                                   |
| -------------- | ----------------------------------------------------------------------------------- |
| `fetch`        | direct client consumption where decoded payload behavior is preferred               |
| `forward-safe` | downstream forwarding after decode where relay-sensitive headers must be normalized |
| `wire-stream`  | byte-preserving relay and large transfer paths                                      |

## Compliance and behavior boundaries

This package targets server-side Fetch compatibility for Fastify HTTP(S) workloads. Compatibility depends on transport and policy selection, so strict browser-equivalent behavior is not guaranteed in every mode.

### Compatibility baseline

- `external` transport inherits request and response semantics from `externalFetch` (`undici.fetch` by default).
- `internal-buffered` and `internal-stream` return Fetch `Response` objects and apply Fetch-style behavior for redirect handling, abort propagation, origin-sensitive header handling, and fetch-style failure normalization.
- Policy resolution order is fixed: call override when enabled, then route decision, then policy defaults.

### Policy-controlled divergence points

- `route` can return `reject`, which fails the call with `TypeError('fetch failed')`.
- `redirects.onBoundary: 'reject'` blocks internal-to-external redirect transitions.
- `buffering.onOverflow: 'reject'` fails over-limit payload paths instead of falling back.
- `forward-safe` decodes supported content codings and normalizes relay-sensitive headers by removing `content-encoding` and updating or removing `content-length`.
- `wire-stream` preserves encoded payload bytes and wire headers without decode.

### Runtime distinctions to account for

- `redirect: 'manual'` follows Undici server-runtime behavior and returns redirect responses instead of browser `opaqueredirect` responses.
- Automatic redirect following applies to `301`, `302`, `303`, `307`, and `308`.
- Redirect targets are restricted to HTTP(S); redirects to other schemes fail.
- Non-HTTP(S) request URLs are routed to external transport unless policy explicitly returns `reject`.

# API

## function fromNodeHeaders [↗](src/headers.ts#L104-L119 'fromNodeHeaders')

Converts Node.js outgoing headers into a Fetch `Headers` instance.

```typescript
export declare function fromNodeHeaders(nodeHeaders: OutgoingHttpHeaders): Headers
```

### Parameters

| Parameter     | Type                           | Description                     |
| ------------- | ------------------------------ | ------------------------------- |
| `nodeHeaders` | <pre>OutgoingHttpHeaders</pre> | Node.js outgoing header object. |

### Returns

Fetch headers containing all defined entries.

### Remarks

Numeric values are stringified and `undefined` values are skipped.

## function sameOrigin [↗](src/same-origin.ts#L12-L30 'sameOrigin')

Returns whether two URLs share the same origin.

```typescript
export declare function sameOrigin(sourceUrl: URL, targetUrl: URL): boolean
```

### Parameters

| Parameter   | Type           | Description                   |
| ----------- | -------------- | ----------------------------- |
| `sourceUrl` | <pre>URL</pre> | Source URL in the comparison. |
| `targetUrl` | <pre>URL</pre> | Target URL in the comparison. |

### Returns

`true` when both URLs resolve to the same origin; otherwise `false`.

### Remarks

The comparison matches scheme, host, and port for tuple origins and treats matching opaque origins (`origin === 'null'`) as same-origin. This helper is commonly used in redirect policy decisions to distinguish same-origin transitions from cross-origin transitions.

## function splitCookiesString [↗](src/headers.ts#L35-L93 'splitCookiesString')

Splits a potentially comma-joined `set-cookie` header value into individual cookie values.

```typescript
export declare function splitCookiesString(cookiesString: string): string[]
```

### Parameters

| Parameter       | Type              | Description                                                         |
| --------------- | ----------------- | ------------------------------------------------------------------- |
| `cookiesString` | <pre>string</pre> | Raw `set-cookie` header value that may contain one or more cookies. |

### Returns

Cookie header values in original order.

### Remarks

Commas inside cookie attributes such as `Expires` are preserved, so commas are treated as separators only when they begin a new cookie key-value pair.

## function toNodeHeaders [↗](src/headers.ts#L130-L146 'toNodeHeaders')

Converts Fetch `Headers` into a Node.js outgoing header object.

```typescript
export declare function toNodeHeaders(headers: Headers): OutgoingHttpHeaders
```

### Parameters

| Parameter | Type               | Description               |
| --------- | ------------------ | ------------------------- |
| `headers` | <pre>Headers</pre> | Fetch headers to convert. |

### Returns

Node.js outgoing header object.

### Remarks

`set-cookie` values are normalized to preserve multiple cookie entries when comma-joined values are encountered.

## const fastifyFetch [↗](src/fastify-fetch.ts#L716-L744 'fastifyFetch')

Decorates a Fastify instance with `app.fetch` and applies policy-routed internal or external request execution.

```typescript
fastifyFetch: import('fastify').FastifyPluginCallback<
  FastifyFetchOptions,
  import('fastify').RawServerDefault,
  import('fastify').FastifyTypeProviderDefault,
  import('fastify').FastifyBaseLogger
>
```

### Remarks

Routing and response behavior are resolved from plugin policy defaults and optional per-call overrides when [FastifyFetchOptions.allowPerCallOverrides](#fastifyfetchoptionsallowpercalloverrides) is `true`. Internal execution failures are normalized to `TypeError('fetch failed')` with nested causes when available. Delegated external execution follows the configured external fetch behavior.

## interface FastifyFetchCallOverrides [↗](src/types.ts#L209-L219 'FastifyFetchCallOverrides')

Defines optional contract and transport overrides for a single `app.fetch` call.

```typescript
export interface FastifyFetchCallOverrides
```

### Remarks

Call overrides are applied only when [FastifyFetchOptions.allowPerCallOverrides](#fastifyfetchoptionsallowpercalloverrides) is `true`. `transport` intentionally excludes `reject`, so call-level overrides can choose execution location but cannot force policy rejection.

### FastifyFetchCallOverrides.contract

Contract override for a single call.

```typescript
readonly contract?: FastifyFetchContract;
```

### FastifyFetchCallOverrides.transport

Transport override for a single call.

```typescript
readonly transport?: Exclude<FastifyFetchTransport, 'reject'>;
```

## interface FastifyFetchInit [↗](src/types.ts#L226-L234 'FastifyFetchInit')

Extends Fetch `RequestInit` with optional fastify-fetch call overrides.

```typescript
export interface FastifyFetchInit extends RequestInit
```

### FastifyFetchInit.fastifyFetch

Per-call policy overrides for transport and contract decisions.

```typescript
readonly fastifyFetch?: FastifyFetchCallOverrides;
```

#### Remarks

This field is applied only when [FastifyFetchOptions.allowPerCallOverrides](#fastifyfetchoptionsallowpercalloverrides) is `true`; otherwise it is ignored.

## interface FastifyFetchOptions [↗](src/types.ts#L239-L265 'FastifyFetchOptions')

Defines plugin registration options for `fastifyFetch`.

```typescript
export interface FastifyFetchOptions
```

### FastifyFetchOptions.allowPerCallOverrides

Enables call-level overrides provided through [FastifyFetchInit.fastifyFetch](#fastifyfetchinitfastifyfetch).

```typescript
readonly allowPerCallOverrides?: boolean;
```

#### Remarks

When `true`, [FastifyFetchCallOverrides.transport](#fastifyfetchcalloverridestransport) and [FastifyFetchCallOverrides.contract](#fastifyfetchcalloverridescontract) can override route and default policy decisions for one call. Call-level transport overrides can choose internal or external execution, but cannot force `reject`. When `false`, values in [FastifyFetchInit.fastifyFetch](#fastifyfetchinitfastifyfetch) are ignored.

### FastifyFetchOptions.externalFetch

External fetch implementation used when policy delegates to `external` transport.

```typescript
readonly externalFetch?: FastifyFetchExternalFetch;
```

### FastifyFetchOptions.policy

Global policy used to resolve routing, redirects, buffering, and contract defaults.

```typescript
readonly policy?: FastifyFetchPolicy;
```

## interface FastifyFetchPolicy [↗](src/types.ts#L124-L200 'FastifyFetchPolicy')

Defines default routing, redirect, buffering, and contract policy for `app.fetch`.

```typescript
export interface FastifyFetchPolicy
```

### Remarks

Decision precedence is: call overrides from [FastifyFetchInit.fastifyFetch](#fastifyfetchinitfastifyfetch) when [FastifyFetchOptions.allowPerCallOverrides](#fastifyfetchoptionsallowpercalloverrides) is `true`, then [FastifyFetchPolicy.route](#fastifyfetchpolicyroute), then policy defaults.

### FastifyFetchPolicy.buffering

Configures buffered payload limits and overflow behavior.

Defaults are `1048576` request bytes (`1 MiB`), `8388608` response bytes (`8 MiB`), and `onOverflow: 'fallback'`.

```typescript
readonly buffering?: {
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly onOverflow?: FastifyFetchOverflowPolicy;
};
```

### FastifyFetchPolicy.defaultContract

Default response contract when route and call overrides do not set one.

Default is `'fetch'`.

```typescript
readonly defaultContract?: FastifyFetchContract;
```

### FastifyFetchPolicy.defaultTransport

Default transport when route and call overrides do not set one.

Default is `'internal-buffered'`.

```typescript
readonly defaultTransport?: Exclude<FastifyFetchTransport, 'reject'>;
```

### FastifyFetchPolicy.redirects

Configures redirect hop limits and boundary behavior.

Defaults are `maxHops: 20` and `onBoundary: 'delegate'`.

```typescript
readonly redirects?: {
  readonly maxHops?: number;
  readonly onBoundary?: FastifyFetchBoundaryPolicy;
};
```

### FastifyFetchPolicy.route

Callback used to resolve transport and optional contract per request evaluation.

```typescript
readonly route?: FastifyFetchRoute;
```

## interface FastifyFetchRouteContext [↗](src/types.ts#L54-L84 'FastifyFetchRouteContext')

Provides request and redirect metadata for route policy decisions.

```typescript
export interface FastifyFetchRouteContext
```

### FastifyFetchRouteContext.currentUrl

URL currently being evaluated for transport and contract decisions.

```typescript
readonly currentUrl: URL;
```

### FastifyFetchRouteContext.isCrossOriginRedirect

Returns whether the redirect transition crosses origins.

```typescript
readonly isCrossOriginRedirect: () => boolean;
```

### FastifyFetchRouteContext.isRedirect

Indicates whether the current evaluation occurs after at least one redirect hop.

```typescript
readonly isRedirect: boolean;
```

### FastifyFetchRouteContext.originalRequest

Original Fetch request constructed for the `app.fetch` call.

```typescript
readonly originalRequest: Request;
```

### FastifyFetchRouteContext.previousUrl

URL from the previous hop, when evaluation occurs during redirect handling.

```typescript
readonly previousUrl: URL | undefined;
```

### FastifyFetchRouteContext.redirectCount

Number of redirects followed before the current evaluation.

```typescript
readonly redirectCount: number;
```

## type FastifyFetch [↗](src/types.ts#L274-L277 'FastifyFetch')

Fetch-compatible call signature decorated on the Fastify instance.

```typescript
export type FastifyFetch = (
  input: FastifyFetchInput,
  init?: FastifyFetchInit,
) => Promise<FastifyFetchResponse>
```

## type FastifyFetchBoundaryPolicy [↗](src/types.ts#L39 'FastifyFetchBoundaryPolicy')

Defines redirect behavior when handling reaches an internal-to-external boundary.

```typescript
export type FastifyFetchBoundaryPolicy = 'delegate' | 'reject'
```

### Remarks

`delegate` allows boundary transition to external transport, while `reject` fails the call when that transition is required.

## type FastifyFetchContract [↗](src/types.ts#L31 'FastifyFetchContract')

Selects response payload and header handling for internal executions.

```typescript
export type FastifyFetchContract = 'fetch' | 'forward-safe' | 'wire-stream'
```

### Remarks

`fetch` decodes supported content codings while preserving wire headers, `forward-safe` decodes and normalizes relay-sensitive headers, and `wire-stream` preserves encoded payload bytes.

## type FastifyFetchExternalFetch [↗](src/types.ts#L11-L14 'FastifyFetchExternalFetch')

Fetch-compatible function signature used by [FastifyFetchOptions.externalFetch](#fastifyfetchoptionsexternalfetch).

```typescript
export type FastifyFetchExternalFetch = (
  input: FastifyFetchInput,
  init?: RequestInit,
) => Promise<FastifyFetchResponse>
```

## type FastifyFetchOverflowPolicy [↗](src/types.ts#L49 'FastifyFetchOverflowPolicy')

Defines overflow behavior when buffered payload limits are exceeded.

```typescript
export type FastifyFetchOverflowPolicy = 'fallback' | 'reject'
```

### Remarks

`fallback` attempts stream transport only when fallback is applicable for the current request and response path. Calls still fail when fallback cannot be applied. `reject` fails immediately when buffered limits are exceeded.

## type FastifyFetchResponse [↗](src/types.ts#L6 'FastifyFetchResponse')

Response type returned by `app.fetch` and accepted from `externalFetch`.

```typescript
export type FastifyFetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>
```

## type FastifyFetchRoute [↗](src/types.ts#L112 'FastifyFetchRoute')

Computes a route decision from the current routing context.

```typescript
export type FastifyFetchRoute = (context: FastifyFetchRouteContext) => FastifyFetchRouteDecision
```

## type FastifyFetchRouteDecision [↗](src/types.ts#L92-L104 'FastifyFetchRouteDecision')

Represents the result returned by a route policy callback.

```typescript
export type FastifyFetchRouteDecision =
  | FastifyFetchTransport
  | {
      readonly transport: FastifyFetchTransport
      readonly contract?: FastifyFetchContract
    }
```

### Remarks

String form selects transport directly, while object form sets transport and optional response contract.

## type FastifyFetchTransport [↗](src/types.ts#L23 'FastifyFetchTransport')

Selects where and how a fetch call is executed.

```typescript
export type FastifyFetchTransport = 'external' | 'internal-buffered' | 'internal-stream' | 'reject'
```

### Remarks

`internal-buffered` and `internal-stream` dispatch through Fastify injection, `external` delegates to the configured external fetch implementation, and `reject` fails the call with a fetch-style error. `reject` can be returned by [FastifyFetchPolicy.route](#fastifyfetchpolicyroute), but it is intentionally excluded from [FastifyFetchPolicy.defaultTransport](#fastifyfetchpolicydefaulttransport) and [FastifyFetchCallOverrides.transport](#fastifyfetchcalloverridestransport).

## type Fetch [↗](src/index.ts#L15 'Fetch')

Fetch function type used by [FastifyFetchOptions.externalFetch](#fastifyfetchoptionsexternalfetch).

```typescript
export type Fetch = FastifyFetchExternalFetch
```
