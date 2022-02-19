/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { InjectPayload } from '.pnpm/light-my-request@4.8.0/node_modules/light-my-request'
import dataUriToBuffer from 'data-uri-to-buffer'
import { HTTPMethods } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { PassThrough, pipeline, Readable, Stream } from 'stream'
import type {
  Request,
  RequestInfo,
  RequestInit,
  Response
} from 'vendor/node-fetch/@types/index.d'
import {
  FetchError as NodeFetchError,
  Request as NodeFetchRequest,
  Response as NodeFetchResponse
} from 'vendor/node-fetch/src/index'
import { getNodeRequestOptions } from 'vendor/node-fetch/src/request'
// import { isBlob } from 'vendor/node-fetch/src/utils/is'
import zlib, { ZlibOptions } from 'zlib'

const supportedSchemas = new Set(['data:', 'http:', 'https:'])

const normalizePayload = async (
  request: Request,
  reject: (error?: any) => void
): Promise<InjectPayload | undefined> => {
  const body = request.body

  if (body === null || body === undefined) {
    return undefined
  }

  // if (isBlob(body)) {
  //   return (body as Blob).arrayBuffer() //.then((value) => Buffer.from(value))
  // }

  if (body instanceof Stream) {
    return pipeline(body, new PassThrough(), (error) => {
      if (error != null) {
        reject(error)
      }
    })
  }

  return await request.arrayBuffer()
}

export const fastifyFetch = fastifyPlugin(async (app) => {
  app.decorate(
    'fetch',
    async (url: RequestInfo, options_?: RequestInit): Promise<Response> => {
      return await new Promise((resolve, reject) => {
        // Build request object
        const request = new NodeFetchRequest(url, options_) as Request
        const { parsedURL, options } = getNodeRequestOptions(request as any)

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
          const response: Response = new (NodeFetchResponse as any)(data, {
            headers: { 'Content-Type': data.typeFull }
          })

          resolve(response)

          return
        }

        let response: Response

        normalizePayload(request, reject)
          .then(
            async (payload) =>
              await app.inject({
                url: request.url,
                headers: { ...options.headers, 'user-agent': 'fastify-fetch' },
                payload,
                // path: options.path ?? undefined,
                method: options.method as HTTPMethods | undefined
                // agent: options.agent
              })
          )
          .then((response_) => {
            const headers = response_.headers
            const body = Readable.from(response_.rawPayload)

            const responseOptions = {
              url: request.url,
              status: response_.statusCode,
              statusText: response_.statusMessage,
              size: request.size,
              headers
            }

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
              response = new (NodeFetchResponse as any)(body, responseOptions)

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
              response = new (NodeFetchResponse as any)(
                pipeline(body, zlib.createGunzip(zlibOptions), reject),
                responseOptions
              ) as Response

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

                response = new (NodeFetchResponse as any)(
                  pipeline(body, inflate(), reject),
                  responseOptions
                )

                resolve(response)
              })

              return
            }

            // For br
            if (codings === 'br') {
              response = new (NodeFetchResponse as any)(
                pipeline(body, zlib.createBrotliDecompress(), reject),
                responseOptions
              )

              resolve(response)
              return
            }

            response = new (NodeFetchResponse as any)(
              pipeline(body, new PassThrough(), reject),
              responseOptions
            )

            resolve(response)
          })
          .catch((error) => {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            reject(new NodeFetchError(`${error.message}`, 'system', error))
          })
      })
    }
  )
})
