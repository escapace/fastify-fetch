import { dataUriToBuffer } from 'data-uri-to-buffer'
import { FastifyInstance, LightMyRequestResponse } from 'fastify'
import fp from 'fastify-plugin'
import assert from 'node:assert'
import { promisify } from 'node:util'
import {
  brotliDecompress as _brotliDecompress,
  gunzip as _gunzip,
  inflate as _inflate
} from 'node:zlib'
import {
  Headers,
  Request,
  RequestInfo,
  RequestInit,
  Response,
  fetch
} from 'undici'
import symbols from 'undici/lib/web/fetch/symbols.js'
import { fromNodeHeaders, toNodeHeaders } from './headers'
import type { Options } from './types'

type Decoder = (value: Buffer) => Promise<Buffer>

const gunzip = promisify(_gunzip)
const brotliDecompress = promisify(_brotliDecompress)
const inflate = promisify(_inflate)

const supportedSchemas = new Set(['data:', 'http:', 'https:'])

const decompressPayload = async (rawPayload: Buffer, headers: Headers) => {
  if (rawPayload.length === 0) {
    return undefined
  }

  const codings: Array<string | undefined> =
    headers
      .get('content-encoding')
      ?.toLowerCase()
      .split(',')
      .map((x) => x.trim())
      .reverse() ?? []

  if (codings.length === 0) {
    return rawPayload
  }

  const decoders: Decoder[] = []

  for (const [index, coding] of codings.entries()) {
    if (coding === 'x-gzip' || coding === 'gzip') {
      decoders.push(async (value: Buffer) => await gunzip(value))
      codings[index] = undefined
    } else if (coding === 'deflate') {
      decoders.push(async (value: Buffer) => await inflate(value))
      codings[index] = undefined
    } else if (coding === 'br') {
      decoders.push(async (value: Buffer) => await brotliDecompress(value))
      codings[index] = undefined
    } else {
      break
    }
  }

  const remainingCodings = codings
    .filter((value): value is string => value !== undefined)
    .reverse()

  // If one or more encodings have been applied to a representation, the sender
  // that applied the encodings MUST generate a Content-Encoding header field that
  // lists the content codings in the order in which they were applied.
  const payload = await decoders.reduce(
    (previousValue, currentValue): Decoder =>
      async (value: Buffer) =>
        await currentValue(await previousValue(value)),
    async (value) => await Promise.resolve(value)
  )(rawPayload)

  if (remainingCodings.length === 0) {
    headers.delete('content-encoding')
  } else {
    headers.set('content-encoding', remainingCodings.join(','))
  }

  return payload
}

const redirectStatus = [301, 302, 303, 307, 308]

const last = <T>(list: T[]): T => list[list.length - 1]

const httpRedirectFetch = async (
  app: FastifyInstance,
  request: Request,
  options: Options
): Promise<[LightMyRequestResponse, URL[]] | 'network-error'> => {
  const originalURL = new URL(request.url)
  const list = [originalURL]

  const headers = toNodeHeaders(request.headers)
  const payload = Buffer.from(await request.arrayBuffer())
  const method = request.method.toUpperCase() as
    | 'DELETE'
    | 'GET'
    | 'HEAD'
    | 'OPTIONS'
    | 'PATCH'
    | 'POST'
    | 'PUT'

  const originalResponse: LightMyRequestResponse = await app.inject({
    url: originalURL.toString(),
    headers,
    payload,
    method
  })

  if (!redirectStatus.includes(originalResponse.statusCode)) {
    return [originalResponse, list]
  }

  if (request.redirect === 'manual') {
    return [originalResponse, list]
  }

  if (request.redirect === 'error') {
    return 'network-error'
  }

  assert(request.redirect === 'follow')

  let response = originalResponse

  while (list.length < 5) {
    const location = fromNodeHeaders(response.headers).get('location')

    if (location == null) {
      return [response, list]
    }

    const url = new URL(location, last(list))

    assertURLSupported(url)

    if (!match(url, request, options)) {
      return 'network-error'
    }

    list.push(url)

    response = await app.inject({
      url: url.toString(),
      headers,
      payload,
      method
    })

    if (!redirectStatus.includes(response.statusCode)) {
      return [response, list]
    }
  }

  return 'network-error'
}

const hasMatchFunction = (options: Options) =>
  typeof options.match === 'function'
const match = (url: URL, request: Request, options: Options) =>
  !hasMatchFunction(options) ||
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  (hasMatchFunction(options) && options.match!(url, request))

const assertURLSupported = (url: URL) => {
  if (!supportedSchemas.has(url.protocol)) {
    throw new TypeError(
      `URL scheme "${url.protocol.replace(/:$/, '')}" is not supported.`
    )
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
export const fastifyFetch = fp<Options>(async (app, options = {}) => {
  app.decorate(
    'fetch',
    async (
      requestInfo: RequestInfo,
      requestInit?: RequestInit
    ): Promise<Response> => {
      const request = new Request(requestInfo, requestInit)

      const url = new URL(request.url)

      assertURLSupported(url)

      if (url.protocol === 'data:') {
        const data = dataUriToBuffer(request.url)

        return new Response(data.buffer, {
          headers: { 'Content-Type': data.typeFull }
        })
      }

      if (
        !['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(
          request.method.toUpperCase()
        )
      ) {
        throw new TypeError(`${request.method} is not supported.`)
      }

      if (match(url, request, options)) {
        const result = await httpRedirectFetch(app, request, options)

        if (result === 'network-error') {
          return Response.error()
        }

        const [r, list] = result

        const headers = fromNodeHeaders(r.headers)
        const statusText = r.statusMessage
        const status = r.statusCode
        const payload = await decompressPayload(r.rawPayload, headers)

        if (headers.has('Content-Length') && payload !== undefined) {
          const contentLength = payload.byteLength

          headers.set('Content-Length', contentLength.toString())
        }

        const response = new Response(payload, {
          headers,
          statusText,
          status
        })

        if (list.length > 1) {
          // @ts-expect-error kState is not typed
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          response[symbols.kState].urlList.push(...list)
        }

        return response
      } else {
        /* c8 ignore next */
        return await (options.fetch ?? fetch)(request)
        /* c8 ignore next */
      }
    }
  )
})
