import type { OutgoingHttpHeaders } from 'node:http'
import { Readable } from 'node:stream'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { InjectOptions } from 'light-my-request'
import fp from 'fastify-plugin'
import {
  brotliDecompress as _brotliDecompress,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzip as _gunzip,
  inflate as _inflate,
} from 'node:zlib'
import { promisify } from 'node:util'
import {
  fetch,
  type BodyInit,
  type Headers,
  Request,
  type RequestInfo,
  type RequestInit,
  Response,
} from 'undici'
import { getRequestState } from 'undici/lib/web/fetch/request.js'
import { getResponseState } from 'undici/lib/web/fetch/response.js'
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  FETCH_FAILED_CAUSE_MESSAGES,
  FORWARD_SAFE_SANITIZED_HEADERS,
} from './constants'
import { fromNodeHeaders, toNodeHeaders } from './headers'
import { sameOrigin } from './same-origin'
import type {
  FastifyFetchCallOverrides,
  FastifyFetchContract,
  FastifyFetchInit,
  FastifyFetchOptions,
  FastifyFetchOverflowPolicy,
  FastifyFetchPolicy,
  FastifyFetchRouteDecision,
  FastifyFetchRouteContext,
  FastifyFetchTransport,
} from './types'

type Decoder = (value: Buffer) => Promise<Buffer>
type InternalTransport = 'internal-buffered' | 'internal-stream'

interface CompiledPolicy {
  allowPerCallOverrides: boolean
  defaultContract: FastifyFetchContract
  defaultTransport: 'external' | InternalTransport
  externalFetch: typeof fetch
  maxHops: number
  maxRequestBytes: number
  maxResponseBytes: number
  onBoundary: 'delegate' | 'reject'
  onOverflow: FastifyFetchOverflowPolicy
  route: FastifyFetchPolicy['route']
}

interface MutableRequestState {
  bodyBuffer: Buffer | undefined
  bodyReplayable: boolean
  bodyStream: Readable | undefined
  hasBody: boolean
  headers: OutgoingHttpHeaders
  method: string
}

interface InternalExecutionResult {
  contract: FastifyFetchContract
  method: string
  response: LightMyRequestResponse
  transport: InternalTransport
  urlList: URL[]
}

type FollowRedirectResult =
  | ({ kind: 'internal' } & InternalExecutionResult)
  | {
      kind: 'external'
      response: Response
    }

const gunzip = promisify(_gunzip)
const brotliDecompress = promisify(_brotliDecompress)
const inflate = promisify(_inflate)

const nullBodyStatuses = new Set([101, 103, 204, 205, 304])
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const requestBodyHeaders = new Set([
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
])
const sensitiveRedirectHeaders = new Set(['authorization', 'cookie', 'host', 'proxy-authorization'])
const safeMethods = new Set(['GET', 'HEAD'])
const supportedContentCodings = new Set(['br', 'deflate', 'gzip', 'x-gzip'])

const toFetchFailed = (cause?: unknown) =>
  cause === undefined ? new TypeError('fetch failed') : new TypeError('fetch failed', { cause })

const toAbortError = (reason: unknown) => {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }

  return new DOMException('This operation was aborted', 'AbortError')
}

const assertNotAborted = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw toAbortError(signal.reason)
  }
}

const isHttpScheme = (url: URL) => url.protocol === 'http:' || url.protocol === 'https:'
const isNullBodyStatus = (status: number) => nullBodyStatuses.has(status)

const deleteHeaderCaseInsensitive = (headers: OutgoingHttpHeaders, name: string) => {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      delete headers[key]
    }
  }
}

const applyRequestBodyHeaderCleanup = (headers: OutgoingHttpHeaders) => {
  for (const headerName of requestBodyHeaders) {
    deleteHeaderCaseInsensitive(headers, headerName)
  }
}

const applySensitiveRedirectHeaderCleanup = (headers: OutgoingHttpHeaders) => {
  for (const headerName of sensitiveRedirectHeaders) {
    deleteHeaderCaseInsensitive(headers, headerName)
  }
}

const parseContentCodings = (headers: Headers): string[] | undefined => {
  const value = headers.get('content-encoding')

  if (value == null) {
    return
  }

  const codings = value
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0)

  if (codings.length === 0) {
    return
  }

  if (codings.every((coding) => supportedContentCodings.has(coding))) {
    return codings
  }

  return
}

const decodeBufferPayload = async (payload: Buffer, codings: string[]) => {
  if (payload.length === 0 || codings.length === 0) {
    return payload
  }

  const decoders: Decoder[] = []

  for (const coding of [...codings].reverse()) {
    if (coding === 'x-gzip' || coding === 'gzip') {
      decoders.push(async (value) => await gunzip(value))
    } else if (coding === 'deflate') {
      decoders.push(async (value) => await inflate(value))
    } else {
      decoders.push(async (value) => await brotliDecompress(value))
    }
  }

  return await decoders.reduce(
    (previous, decoder): Decoder =>
      async (value) =>
        await decoder(await previous(value)),
    async (value) => await Promise.resolve(value),
  )(payload)
}

const decodeStreamPayload = (payload: Readable, codings: string[]) => {
  if (codings.length === 0) {
    return payload
  }

  return [...codings].reverse().reduce((stream, coding) => {
    if (coding === 'x-gzip' || coding === 'gzip') {
      return stream.pipe(createGunzip())
    }

    if (coding === 'deflate') {
      return stream.pipe(createInflate())
    }

    return stream.pipe(createBrotliDecompress())
  }, payload)
}

const parseRouteDecision = (value: FastifyFetchRouteDecision | undefined) => {
  if (value == null) {
    return
  }

  if (typeof value === 'string') {
    return {
      contract: undefined,
      transport: value,
    }
  }

  return {
    contract: value.contract,
    transport: value.transport,
  }
}

const createRouteContext = (
  originalRequest: Request,
  currentUrl: URL,
  previousUrl: URL | undefined,
  redirectCount: number,
): FastifyFetchRouteContext => {
  let evaluated = false
  let value = false

  return {
    currentUrl,
    isRedirect: previousUrl !== undefined,
    originalRequest,
    previousUrl,
    redirectCount,
    isCrossOriginRedirect() {
      if (previousUrl === undefined) {
        return false
      }

      if (!evaluated) {
        value = !sameOrigin(previousUrl, currentUrl)
        evaluated = true
      }

      return value
    },
  }
}

const compilePolicy = (options: FastifyFetchOptions | undefined): CompiledPolicy => {
  const policy = options?.policy

  return {
    allowPerCallOverrides: options?.allowPerCallOverrides ?? false,
    defaultContract: policy?.defaultContract ?? 'fetch',
    defaultTransport: policy?.defaultTransport ?? 'internal-buffered',
    externalFetch: options?.externalFetch ?? fetch,
    maxHops: policy?.redirects?.maxHops ?? 20,
    maxRequestBytes: policy?.buffering?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes: policy?.buffering?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    onBoundary: policy?.redirects?.onBoundary ?? 'delegate',
    onOverflow: policy?.buffering?.onOverflow ?? 'fallback',
    route: policy?.route,
  }
}

const resolveDecision = (
  compiled: CompiledPolicy,
  context: FastifyFetchRouteContext,
  overrides: FastifyFetchCallOverrides | undefined,
) => {
  const routeDecision = parseRouteDecision(compiled.route?.(context))
  const perCallDecision =
    compiled.allowPerCallOverrides && overrides !== undefined
      ? {
          contract: overrides.contract,
          transport: overrides.transport,
        }
      : undefined

  const transport =
    perCallDecision?.transport ?? routeDecision?.transport ?? compiled.defaultTransport
  const contract = perCallDecision?.contract ?? routeDecision?.contract ?? compiled.defaultContract

  return {
    contract,
    transport,
  }
}

const getDeclaredContentLength = (headers: Headers) => {
  const value = headers.get('content-length')

  if (value == null) {
    return
  }

  const number = Number.parseInt(value, 10)

  if (Number.isNaN(number) || number < 0) {
    return
  }

  return number
}

const createMutableRequestState = async (request: Request, streamNonReplayableBody: boolean) => {
  const requestState = getRequestState(request)
  const bodyReplayable = requestState.body == null || requestState.body.source != null
  const headers = toNodeHeaders(request.headers)
  const method = request.method.toUpperCase()

  if (requestState.body == null) {
    return {
      bodyBuffer: undefined,
      bodyReplayable,
      bodyStream: undefined,
      hasBody: false,
      headers,
      method,
    } satisfies MutableRequestState
  }

  // eslint-disable-next-line baseline-js/use-baseline
  if (streamNonReplayableBody && !bodyReplayable && request.body !== null) {
    return {
      bodyBuffer: undefined,
      bodyReplayable,
      // eslint-disable-next-line baseline-js/use-baseline
      bodyStream: Readable.fromWeb(request.body),
      hasBody: true,
      headers,
      method,
    } satisfies MutableRequestState
  }

  const bodyBuffer = Buffer.from(await request.arrayBuffer())

  return {
    bodyBuffer: bodyBuffer.length === 0 ? undefined : bodyBuffer,
    bodyReplayable,
    bodyStream: undefined,
    hasBody: bodyBuffer.length > 0,
    headers,
    method,
  } satisfies MutableRequestState
}

const delegateExternal = async (
  compiled: CompiledPolicy,
  request: Request,
  mutableRequestState: MutableRequestState,
  url: URL,
) => {
  const init: RequestInit = {
    headers: fromNodeHeaders(mutableRequestState.headers),
    method: mutableRequestState.method,
    redirect: request.redirect,
    signal: request.signal,
  }

  if (mutableRequestState.hasBody && !safeMethods.has(mutableRequestState.method)) {
    if (mutableRequestState.bodyBuffer !== undefined) {
      init.body = mutableRequestState.bodyBuffer
    } else if (mutableRequestState.bodyStream !== undefined) {
      init.body = Readable.toWeb(mutableRequestState.bodyStream)
      mutableRequestState.bodyStream = undefined
    }
  }

  const delegatedRequest = new Request(url.toString(), init)

  return await compiled.externalFetch(delegatedRequest)
}

const applyForwardSafeHeaderSanitization = (headers: Headers, decodedLength?: number) => {
  for (const header of FORWARD_SAFE_SANITIZED_HEADERS) {
    headers.delete(header)
  }

  if (decodedLength !== undefined) {
    headers.set('content-length', decodedLength.toString())
  }
}

const buildResponseFromInternal = async (result: InternalExecutionResult) => {
  const headers = fromNodeHeaders(result.response.headers)
  const status = result.response.statusCode
  const statusText = result.response.statusMessage
  const codings = parseContentCodings(headers)
  const shouldSuppressBody = result.method === 'HEAD' || isNullBodyStatus(status)

  let body: BodyInit | null | undefined

  if (result.transport === 'internal-buffered') {
    const rawPayload = result.response.rawPayload ?? Buffer.alloc(0)
    let payload = rawPayload

    if (
      !shouldSuppressBody &&
      codings !== undefined &&
      codings.length > 0 &&
      result.contract !== 'wire-stream'
    ) {
      payload = await decodeBufferPayload(payload, codings)

      if (result.contract === 'forward-safe') {
        applyForwardSafeHeaderSanitization(headers, payload.byteLength)
      }
    }

    body = shouldSuppressBody ? undefined : payload
  } else {
    const stream = result.response.stream()

    if (!shouldSuppressBody) {
      let bodyStream = stream

      if (codings !== undefined && codings.length > 0 && result.contract !== 'wire-stream') {
        bodyStream = decodeStreamPayload(stream, codings)

        if (result.contract === 'forward-safe') {
          applyForwardSafeHeaderSanitization(headers)
        }
      }

      body = Readable.toWeb(bodyStream)
    }
  }

  let response: Response

  try {
    response = new Response(body, {
      headers,
      status,
      statusText,
    })
  } catch (error) {
    throw toFetchFailed(error)
  }

  const responseState = getResponseState(response)
  responseState.urlList.push(...result.urlList)

  return response
}

const followRedirect = async (
  app: FastifyInstance,
  compiled: CompiledPolicy,
  request: Request,
  initialUrl: URL,
  overrides: FastifyFetchCallOverrides | undefined,
): Promise<FollowRedirectResult> => {
  const urlList: URL[] = [initialUrl]
  let currentUrl = initialUrl
  let previousUrl: URL | undefined
  let redirectCount = 0
  let latestContract = compiled.defaultContract
  let mutableRequestState: MutableRequestState | undefined

  const declaredContentLength = getDeclaredContentLength(request.headers)
  const requestState = getRequestState(request)
  const hasRequestBody = requestState.body != null
  const requestBodyReplayable = requestState.body == null || requestState.body.source != null

  const ensureMutableRequestState = async (streamNonReplayableBody: boolean) => {
    mutableRequestState ??= await createMutableRequestState(request, streamNonReplayableBody)

    return mutableRequestState
  }

  const injectInternal = async (state: MutableRequestState, transport: InternalTransport) => {
    const payload = state.bodyBuffer ?? state.bodyStream

    if (payload === state.bodyStream) {
      state.bodyStream = undefined
    }

    const injectOptions: InjectOptions = {
      headers: state.headers,
      method: state.method as InjectOptions['method'],
      payload,
      payloadAsStream: transport === 'internal-stream',
      signal: request.signal,
      url: currentUrl.toString(),
    }

    return await app.inject(injectOptions)
  }

  const applyResponseOverflowPolicy = async (
    state: MutableRequestState,
    response: LightMyRequestResponse,
    transport: InternalTransport,
  ) => {
    if (transport !== 'internal-buffered') {
      return {
        response,
        transport,
      }
    }

    if (response.rawPayload.byteLength <= compiled.maxResponseBytes) {
      return {
        response,
        transport,
      }
    }

    if (compiled.onOverflow !== 'fallback' || !safeMethods.has(state.method)) {
      throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.responsePayloadExceeded))
    }

    return {
      response: await injectInternal(state, 'internal-stream'),
      transport: 'internal-stream' as const,
    }
  }

  while (true) {
    assertNotAborted(request.signal)

    const context = createRouteContext(request, currentUrl, previousUrl, redirectCount)
    const decision = resolveDecision(compiled, context, overrides)

    latestContract = decision.contract

    let transport: FastifyFetchTransport = decision.transport

    if (!isHttpScheme(currentUrl) && transport !== 'external' && transport !== 'reject') {
      transport = 'external'
    }

    if (transport === 'reject') {
      throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.requestRejectedByPolicy))
    }

    if (transport === 'external') {
      if (previousUrl !== undefined && compiled.onBoundary === 'reject') {
        throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.redirectBoundaryBlocked))
      }

      if (previousUrl === undefined && redirectCount === 0) {
        return {
          kind: 'external',
          response: await compiled.externalFetch(request),
        }
      }

      const mutableState = await ensureMutableRequestState(false)

      return {
        kind: 'external',
        response: await delegateExternal(compiled, request, mutableState, currentUrl),
      }
    }

    let resolvedTransport: InternalTransport = transport

    if (resolvedTransport === 'internal-buffered') {
      if (compiled.onOverflow === 'fallback' && hasRequestBody && !requestBodyReplayable) {
        resolvedTransport = 'internal-stream'
      } else if (
        declaredContentLength !== undefined &&
        declaredContentLength > compiled.maxRequestBytes
      ) {
        if (compiled.onOverflow === 'fallback') {
          resolvedTransport = 'internal-stream'
        } else {
          throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded))
        }
      }
    }

    const mutableState = await ensureMutableRequestState(resolvedTransport === 'internal-stream')

    if (
      resolvedTransport === 'internal-buffered' &&
      (mutableState.bodyBuffer?.byteLength ?? 0) > compiled.maxRequestBytes
    ) {
      if (compiled.onOverflow === 'fallback') {
        resolvedTransport = 'internal-stream'
      } else {
        throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded))
      }
    }

    let injected: LightMyRequestResponse

    try {
      injected = await injectInternal(mutableState, resolvedTransport)
    } catch (error) {
      if (request.signal.aborted) {
        throw toAbortError(request.signal.reason)
      }

      throw toFetchFailed(error)
    }

    const status = injected.statusCode

    if (!redirectStatuses.has(status)) {
      const withOverflowPolicy = await applyResponseOverflowPolicy(
        mutableState,
        injected,
        resolvedTransport,
      )

      return {
        contract: latestContract,
        kind: 'internal',
        method: mutableState.method,
        response: withOverflowPolicy.response,
        transport: withOverflowPolicy.transport,
        urlList,
      }
    }

    if (request.redirect === 'manual') {
      const withOverflowPolicy = await applyResponseOverflowPolicy(
        mutableState,
        injected,
        resolvedTransport,
      )

      return {
        contract: latestContract,
        kind: 'internal',
        method: mutableState.method,
        response: withOverflowPolicy.response,
        transport: withOverflowPolicy.transport,
        urlList,
      }
    }

    if (request.redirect === 'error') {
      throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.unexpectedRedirect))
    }

    const location = fromNodeHeaders(injected.headers).get('location')

    if (location == null) {
      const withOverflowPolicy = await applyResponseOverflowPolicy(
        mutableState,
        injected,
        resolvedTransport,
      )

      return {
        contract: latestContract,
        kind: 'internal',
        method: mutableState.method,
        response: withOverflowPolicy.response,
        transport: withOverflowPolicy.transport,
        urlList,
      }
    }

    if (redirectCount === compiled.maxHops) {
      throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.redirectCountExceeded))
    }

    let nextUrl: URL

    try {
      nextUrl = new URL(location, currentUrl)
    } catch (error) {
      throw toFetchFailed(error)
    }

    if (!isHttpScheme(nextUrl)) {
      throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.redirectTargetMustBeHttp))
    }

    if (status !== 303 && mutableState.hasBody && !mutableState.bodyReplayable) {
      throw toFetchFailed(new Error(FETCH_FAILED_CAUSE_MESSAGES.requestBodyNotReplayable))
    }

    if (
      ([301, 302].includes(status) && mutableState.method === 'POST') ||
      (status === 303 && !safeMethods.has(mutableState.method))
    ) {
      mutableState.bodyBuffer = undefined
      mutableState.hasBody = false
      mutableState.method = 'GET'
      applyRequestBodyHeaderCleanup(mutableState.headers)
    }

    if (!sameOrigin(currentUrl, nextUrl)) {
      applySensitiveRedirectHeaderCleanup(mutableState.headers)
    }

    previousUrl = currentUrl
    currentUrl = nextUrl
    redirectCount += 1
    urlList.push(nextUrl)
  }
}

/**
 * Decorates a Fastify instance with `app.fetch` and applies policy-routed internal or external request execution.
 *
 * @remarks
 * Routing and response behavior are resolved from plugin policy defaults and optional per-call overrides when {@link FastifyFetchOptions.allowPerCallOverrides} is `true`.
 * Internal execution failures are normalized to `TypeError('fetch failed')` with nested causes when available.
 * Delegated external execution follows the configured external fetch behavior.
 */
export const fastifyFetch = fp<FastifyFetchOptions>((app, options = {}) => {
  const compiled = compilePolicy(options)

  app.decorate(
    'fetch',
    async (requestInfo: RequestInfo | URL, requestInit?: FastifyFetchInit): Promise<Response> => {
      const { fastifyFetch: callOverrides, ...requestInitWithoutOverrides } = requestInit ?? {}
      const request = new Request(requestInfo, requestInitWithoutOverrides)

      assertNotAborted(request.signal)

      const initialUrl = new URL(request.url)

      const result = await followRedirect(app, compiled, request, initialUrl, callOverrides)

      if (result.kind === 'external') {
        return result.response
      }

      return await buildResponseFromInternal(result)
    },
  )
})
