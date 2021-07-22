/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import dataUriToBuffer from 'data-uri-to-buffer'
import fastifyPlugin from 'fastify-plugin'
import { PassThrough, pipeline, Readable, Stream } from 'stream'
import { FetchError, Request, Response } from 'vendor/node-fetch/src/index'
import { getNodeRequestOptions } from 'vendor/node-fetch/src/request'
import { isBlob } from 'vendor/node-fetch/src/utils/is'
import zlib, { ZlibOptions } from 'zlib'
import type {
  // Blob,
  HTTPMethods,
  RequestInfo,
  RequestInit,
  RequestOptions,
  ResponseInit
} from './types'

const supportedSchemas = new Set(['data:', 'http:', 'https:'])

const normalizePayload = async (
  request: Request,
  reject: (error?: any) => void
): Promise<string | Buffer | Readable> => {
  const body: Buffer | Blob | string | Readable = request.body

  if (body === null || body === undefined) {
    return body
  }

  if (isBlob(body)) {
    return (body as Blob).arrayBuffer().then((value) => Buffer.from(value))
  }

  if (body instanceof Stream) {
    return pipeline(body, new PassThrough(), (error) => {
      if (error) {
        reject(error)
      }
    })
  }

  return request.buffer()
}

export const fastifyFetch = fastifyPlugin(async (app) => {
  app.decorate(
    'fetch',
    async (url: RequestInfo, options_?: RequestInit): Promise<Response> => {
      return new Promise((resolve, reject) => {
        // Build request object
        const request = new Request(url, options_)
        const options = getNodeRequestOptions(request) as RequestOptions

        if (
          options.protocol !== undefined &&
          options.protocol !== null &&
          !supportedSchemas.has(options.protocol)
        ) {
          throw new TypeError(
            `node-fetch cannot load ${
              request.url
            }. URL scheme "${options.protocol.replace(
              /:$/,
              ''
            )}" is not supported.`
          )
        }

        if (options.protocol === 'data:') {
          const data = dataUriToBuffer(request.url)
          const response = new Response(data, {
            headers: { 'Content-Type': data.typeFull }
          })

          resolve(response)

          return
        }

        let response: Response | null = null

        normalizePayload(request, reject)
          .then(async (payload) =>
            app
              .inject({
                url: request.url,
                headers: { ...options.headers, 'user-agent': 'fastify-fetch' },
                payload,
                // path: options.path ?? undefined,
                method: options.method as HTTPMethods | undefined
                // agent: options.agent
              })
              .then((response_) => {
                const headers = response_.headers
                const body = Readable.from(response_.rawPayload)

                const responseOptions: ResponseInit = {
                  url: request.url,
                  status: response_.statusCode,
                  statusText: response_.statusMessage,
                  size: request.size,
                  headers
                } as unknown as ResponseInit

                // HTTP-network fetch step 12.1.1.3
                const codings = headers['content-encoding']

                // HTTP-network fetch step 12.1.1.4: handle content codings

                // in following scenarios we ignore compression support
                // 1. compression support is disabled
                // 2. HEAD request
                // 3. no Content-Encoding header
                // 4. no content response (204)
                // 5. content not modified response (304)
                if (
                  request.method === 'HEAD' ||
                  codings === null ||
                  response_.statusCode === 204 ||
                  response_.statusCode === 304
                ) {
                  response = new Response(body, responseOptions)

                  resolve(response)

                  return
                }

                // For Node v6+
                // Be less strict when decoding compressed responses, since sometimes
                // servers send slightly invalid responses that are still accepted
                // by common browsers.
                // Always using Z_SYNC_FLUSH is what cURL does.
                const zlibOptions: ZlibOptions = {
                  flush: zlib.Z_SYNC_FLUSH,
                  finishFlush: zlib.Z_SYNC_FLUSH
                }

                // For gzip
                if (codings === 'gzip' || codings === 'x-gzip') {
                  response = new Response(
                    pipeline(body, zlib.createGunzip(zlibOptions), reject),
                    responseOptions
                  )

                  resolve(response)

                  return
                }

                // For deflate
                if (codings === 'deflate' || codings === 'x-deflate') {
                  // Handle the infamous raw deflate response from old servers
                  // a hack for old IIS and Apache servers
                  const raw = pipeline(
                    Readable.from(response_.rawPayload),
                    new PassThrough(),
                    reject
                  )

                  raw.once('data', (chunk) => {
                    // See http://stackoverflow.com/questions/37519828
                    const inflate =
                      (chunk[0] & 0x0f) === 0x08
                        ? zlib.createInflate
                        : zlib.createInflateRaw

                    response = new Response(
                      pipeline(body, inflate(), reject),
                      responseOptions
                    )

                    resolve(response)
                  })

                  return
                }

                // For br
                if (codings === 'br') {
                  response = new Response(
                    pipeline(body, zlib.createBrotliDecompress(), reject),
                    responseOptions
                  )

                  resolve(response)
                  return
                }

                // Otherwise, use response as-is
                response = new Response(
                  pipeline(body, new PassThrough(), reject),
                  responseOptions
                )

                resolve(response)
              })
          )
          .catch((error) => {
            reject(
              new FetchError(
                `request to ${request.url} failed, reason: ${error.message}`,
                'system',
                error
              )
            )
          })
      })
    }
  )
})
