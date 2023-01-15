import dataUriToBuffer from 'data-uri-to-buffer'
import fp from 'fastify-plugin'
import {
  fetch,
  Headers,
  Request,
  RequestInfo,
  RequestInit,
  Response
} from 'undici'
import { promisify } from 'util'
import {
  brotliDecompress as _brotliDecompress,
  gunzip as _gunzip,
  inflate as _inflate
} from 'zlib'
import type { Options } from './types'

const gunzip = promisify(_gunzip)
const brotliDecompress = promisify(_brotliDecompress)
const inflate = promisify(_inflate)

const supportedSchemas = new Set(['data:', 'http:', 'https:'])

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
          headers: Object.fromEntries(request.headers.entries()),
          payload: await request.arrayBuffer(),
          method: method as
            | 'DELETE'
            | 'GET'
            | 'HEAD'
            | 'OPTIONS'
            | 'PATCH'
            | 'POST'
            | 'PUT'
        })

        const headers = new Headers(
          Object.entries(response.headers)
            .flatMap(([key, values]) =>
              values === undefined
                ? undefined
                : Array.isArray(values)
                ? values.map((value): [string, string] => [key, value])
                : [[key, values] as [string, string]]
            )
            .filter((value): value is [string, string] => value !== undefined)
        )

        const statusText = response.statusMessage
        const status = response.statusCode

        const codings =
          headers
            .get('content-encoding')
            ?.toLowerCase()
            .split(',')
            .map((x) => x.trim()) ?? []

        type InputType = Buffer
        type Decoder = (value: InputType) => Promise<Buffer>
        const decoders: Decoder[] = []

        let payload: Buffer | undefined = response.rawPayload

        if (payload.length === 0) {
          payload = undefined
        } else {
          for (const coding of codings) {
            if (/(x-)?gzip/.test(coding)) {
              decoders.push(async (value: InputType) => await gunzip(value))
            } else if (/(x-)?deflate/.test(coding)) {
              decoders.push(async (value: InputType) => await inflate(value))
            } else if (coding === 'br') {
              decoders.push(
                async (value: InputType) => await brotliDecompress(value)
              )
            } else {
              decoders.length = 0
              break
            }
          }

          if (decoders.length === 0) {
            decoders.push(async (value) => await Promise.resolve(value))
          }

          payload = await decoders.reduce(
            (previousValue, currentValue): Decoder =>
              async (value: InputType) =>
                await currentValue(await previousValue(value))
          )(payload)
        }

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
