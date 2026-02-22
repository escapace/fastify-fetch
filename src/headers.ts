/*
 * Third-party attribution and context (see NOTICE for full details):
 * - Next.js utility helpers (MIT):
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/utils.ts
 * - set-cookie-parser splitCookiesString adaptation (MIT):
 *   https://github.com/nfriedly/set-cookie-parser/blob/master/lib/set-cookie.js
 * - j2objc CookieSplitter basis (Apache-2.0):
 *   https://github.com/google/j2objc/commit/16820fdbc8f76ca0c33472810ce0cb03d20efe25
 *
 * Individual credit:
 * - Tom Ball (original CookieSplitter implementation in j2objc)
 * - Artur Chrusciel (JavaScript implementation in set-cookie-parser)
 *
 * Behavior context for splitCookiesString:
 * - Some platforms expose multiple Set-Cookie values as one comma-joined string.
 * - Commas inside Expires attributes are data and must not split cookie boundaries.
 * - Comma-joined Set-Cookie values are uncommon but historically permitted:
 *   https://tools.ietf.org/html/rfc2616#section-4.2
 * - Node.js special-cases set-cookie when normalizing incoming headers:
 *   https://github.com/nodejs/node/blob/d5e363b77ebaf1caf67cd7528224b651c86815c1/lib/_http_incoming.js#L128
 */

import type { OutgoingHttpHeaders } from 'node:http'
import { Headers } from 'undici'

/**
 * Splits a potentially comma-joined `set-cookie` header value into individual cookie values.
 *
 * @remarks
 * Commas inside cookie attributes such as `Expires` are preserved, so commas are treated as separators only when they begin a new cookie key-value pair.
 *
 * @param cookiesString - Raw `set-cookie` header value that may contain one or more cookies.
 * @returns Cookie header values in original order.
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

/**
 * Converts Node.js outgoing headers into a Fetch `Headers` instance.
 *
 * @remarks
 * Numeric values are stringified and `undefined` values are skipped.
 *
 * @param nodeHeaders - Node.js outgoing header object.
 * @returns Fetch headers containing all defined entries.
 */
export function fromNodeHeaders(nodeHeaders: OutgoingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(nodeHeaders)) {
    const values = Array.isArray(value) ? value : [value]
    for (let v of values) {
      if (v === undefined) continue
      if (typeof v === 'number') {
        v = v.toString()
      }

      headers.append(key, v)
    }
  }

  return headers
}

/**
 * Converts Fetch `Headers` into a Node.js outgoing header object.
 *
 * @remarks
 * `set-cookie` values are normalized to preserve multiple cookie entries when comma-joined values are encountered.
 *
 * @param headers - Fetch headers to convert.
 * @returns Node.js outgoing header object.
 */
export function toNodeHeaders(headers: Headers): OutgoingHttpHeaders {
  const nodeHeaders: OutgoingHttpHeaders = {}
  const cookies: string[] = []
  // eslint-disable-next-line typescript/strict-boolean-expressions
  if (headers) {
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        // We may have gotten a comma joined string of cookies, or multiple
        // set-cookie headers. We need to merge them into one header array
        // to represent all the cookies.
        cookies.push(...splitCookiesString(value))
        nodeHeaders[key] = cookies.length === 1 ? cookies[0] : cookies
      } else {
        nodeHeaders[key] = value
      }
    }
  }
  return nodeHeaders
}
