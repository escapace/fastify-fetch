import { dataUriToBuffer } from 'data-uri-to-buffer'
import fp from 'fastify-plugin'
import {
  fetch,
  Headers,
  Request,
  RequestInfo,
  RequestInit,
  Response
} from 'undici'
import { promisify } from 'node:util'
import {
  brotliDecompress as _brotliDecompress,
  gunzip as _gunzip,
  inflate as _inflate
} from 'node:zlib'
import type { Options } from './types'
import { fromNodeHeaders, toNodeHeaders } from './headers'

type Decoder = (value: Buffer) => Promise<Buffer>

const gunzip = promisify(_gunzip)
const brotliDecompress = promisify(_brotliDecompress)
const inflate = promisify(_inflate)

const supportedSchemas = new Set(['data:', 'http:', 'https:'])

const decompressPayload = async (rawPayload: Buffer, headers: Headers) => {
  if (rawPayload.length === 0) {
    return undefined
  }

  const codings =
    headers
      .get('content-encoding')
      ?.toLowerCase()
      .split(',')
      .map((x) => x.trim()) ?? []

  if (codings.length === 0) {
    return rawPayload
  }

  const decoders: Decoder[] = []

  const remainingCodings = codings
    .map((coding) => {
      if (/(x-)?gzip/.test(coding)) {
        decoders.push(async (value: Buffer) => await gunzip(value))
      } else if (/(x-)?deflate/.test(coding)) {
        decoders.push(async (value: Buffer) => await inflate(value))
      } else if (coding === 'br') {
        decoders.push(async (value: Buffer) => await brotliDecompress(value))
      } else {
        return coding
      }

      return undefined
    })
    .filter((value): value is string => value !== undefined)

  decoders.push(async (value) => await Promise.resolve(value))

  const payload = await decoders.reduce(
    (previousValue, currentValue): Decoder =>
      async (value: Buffer) =>
        await currentValue(await previousValue(value))
  )(rawPayload)

  if (remainingCodings.length === 0) {
    headers.delete('content-encoding')
  } else {
    headers.set('content-encoding', Array.from(remainingCodings).join(', '))
  }

  return payload
}

// eslint-disable-next-line @typescript-eslint/require-await
export const fastifyFetch = fp<Options>(async (app, options = {}) => {
  const hasMatchFunction = typeof options.match === 'function'

  app.decorate(
    'fetch',
    async (
      requestInfo: RequestInfo,
      requestInit?: RequestInit
    ): Promise<Response> => {
      const request = new Request(requestInfo, requestInit)

      const parsedURL = new URL(request.url)

      if (!supportedSchemas.has(parsedURL.protocol)) {
        throw new TypeError(
          `URL scheme "${parsedURL.protocol.replace(
            /:$/,
            ''
          )}" is not supported.`
        )
      }

      if (parsedURL.protocol === 'data:') {
        const data = dataUriToBuffer(request.url)

        return new Response(data, {
          headers: { 'Content-Type': data.typeFull }
        })
      }

      const method = request.method.toUpperCase()

      if (
        !['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(
          method
        )
      ) {
        throw new TypeError(`${method} is not supported.`)
      }

      if (
        !hasMatchFunction ||
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        (hasMatchFunction && options.match!(parsedURL, request))
      ) {
        const response = await app.inject({
          url: request.url,
          headers: toNodeHeaders(request.headers),
          payload: Buffer.from(await request.arrayBuffer()),
          method: method as
            | 'DELETE'
            | 'GET'
            | 'HEAD'
            | 'OPTIONS'
            | 'PATCH'
            | 'POST'
            | 'PUT'
        })

        const headers = fromNodeHeaders(response.headers)

        const statusText = response.statusMessage
        const status = response.statusCode
        const payload = await decompressPayload(response.rawPayload, headers)

        return new Response(payload, {
          headers,
          statusText,
          status
        })
      } else {
        return await (options.fetch ?? fetch)(request)
      }
    }
  )
})
