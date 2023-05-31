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

type Decoder = (value: Buffer) => Promise<Buffer>

const gunzip = promisify(_gunzip)
const brotliDecompress = promisify(_brotliDecompress)
const inflate = promisify(_inflate)

const supportedSchemas = new Set(['data:', 'http:', 'https:'])

export interface NodeHeaders {
  [header: string]: string | number | string[] | undefined
}

// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/utils.ts

/*
  Set-Cookie header field-values are sometimes comma joined in one string. This splits them without choking on commas
  that are within a single set-cookie field-value, such as in the Expires portion.
  This is uncommon, but explicitly allowed - see https://tools.ietf.org/html/rfc2616#section-4.2
  Node.js does this for every header *except* set-cookie - see https://github.com/nodejs/node/blob/d5e363b77ebaf1caf67cd7528224b651c86815c1/lib/_http_incoming.js#L128
  React Native's fetch does this for *every* header, including set-cookie.

  Based on: https://github.com/google/j2objc/commit/16820fdbc8f76ca0c33472810ce0cb03d20efe25
  Credits to: https://github.com/tomball for original and https://github.com/chrusart for JavaScript implementation
*/
export function splitCookiesString(cookiesString: string) {
  const cookiesStrings = []
  let pos = 0
  let start
  let ch
  let lastComma
  let nextStart
  let cookiesSeparatorFound

  function skipWhitespace() {
    while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) {
      pos += 1
    }
    return pos < cookiesString.length
  }

  function notSpecialChar() {
    ch = cookiesString.charAt(pos)

    return ch !== '=' && ch !== ';' && ch !== ','
  }

  while (pos < cookiesString.length) {
    start = pos
    cookiesSeparatorFound = false

    while (skipWhitespace()) {
      ch = cookiesString.charAt(pos)
      if (ch === ',') {
        // ',' is a cookie separator if we have later first '=', not ';' or ','
        lastComma = pos
        pos += 1

        skipWhitespace()
        nextStart = pos

        while (pos < cookiesString.length && notSpecialChar()) {
          pos += 1
        }

        // currently special character
        if (pos < cookiesString.length && cookiesString.charAt(pos) === '=') {
          // we found cookies separator
          cookiesSeparatorFound = true
          // pos is inside the next cookie, so back up and return it.
          pos = nextStart
          cookiesStrings.push(cookiesString.substring(start, lastComma))
          start = pos
        } else {
          // in param ',' or param separator ';',
          // we continue from that comma
          pos = lastComma + 1
        }
      } else {
        pos += 1
      }
    }

    if (!cookiesSeparatorFound || pos >= cookiesString.length) {
      cookiesStrings.push(cookiesString.substring(start, cookiesString.length))
    }
  }

  return cookiesStrings
}

export function fromNodeHeaders(object: NodeHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(object)) {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      if (v !== undefined) {
        headers.append(key, `${v}`)
      }
    }
  }

  return headers
}

export function toNodeHeaders(headers?: Headers): NodeHeaders {
  const result: NodeHeaders = {}
  if (headers != null) {
    for (const [key, value] of headers.entries()) {
      result[key] = value
      if (key.toLowerCase() === 'set-cookie') {
        result[key] = splitCookiesString(value)
      }
    }
  }

  return result
}

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
