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

type Decoder = (value: Buffer) => Promise<Buffer>

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

        const headers = new Headers()

        for (const [key, values] of Object.entries(response.headers)) {
          if (values === undefined) {
            continue
          } else if (Array.isArray(values)) {
            for (const value of values) {
              headers.set(key, value)
            }
          } else {
            headers.set(key, `${values}`)
          }
        }

        const statusText = response.statusMessage
        const status = response.statusCode

        let payload: Buffer | undefined = response.rawPayload

        if (payload.length === 0) {
          payload = undefined
        } else {
          const codings = new Set(
            headers
              .get('content-encoding')
              ?.toLowerCase()
              .split(',')
              .map((x) => x.trim()) ?? []
          )

          const decoders: Decoder[] = []

          for (const coding of codings) {
            if (/(x-)?gzip/.test(coding)) {
              decoders.push(async (value: Buffer) => await gunzip(value))

              codings.delete(coding)
            } else if (/(x-)?deflate/.test(coding)) {
              decoders.push(async (value: Buffer) => await inflate(value))

              codings.delete(coding)
            } else if (coding === 'br') {
              decoders.push(
                async (value: Buffer) => await brotliDecompress(value)
              )

              codings.delete(coding)
            }
          }

          decoders.push(async (value) => await Promise.resolve(value))

          payload = await decoders.reduce(
            (previousValue, currentValue): Decoder =>
              async (value: Buffer) =>
                await currentValue(await previousValue(value))
          )(payload)

          if (codings.size === 0) {
            headers.delete('content-encoding')
          } else {
            headers.set('content-encoding', Array.from(codings).join(', '))
          }
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
