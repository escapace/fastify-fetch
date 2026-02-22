import fastify from 'fastify'
import zlib from 'node:zlib'
import { Headers, Request } from 'undici'
import { assert, describe, expect, it } from 'vitest'
import { FETCH_FAILED_CAUSE_MESSAGES } from '../constants'
import { fromNodeHeaders, sameOrigin, toNodeHeaders } from '../index'
import { fastifyFetch } from '../index'

const expectFetchFailed = async (operation: Promise<unknown>, expectedCause?: string | RegExp) => {
  try {
    await operation
    assert.fail('expected operation to reject')
  } catch (error) {
    assert.instanceOf(error, TypeError)
    assert.match(error.message, /fetch failed/i)

    if (expectedCause !== undefined) {
      assert.instanceOf(error.cause, Error)

      if (typeof expectedCause === 'string') {
        assert.equal(error.cause.message, expectedCause)
      } else {
        assert.match(error.cause.message, expectedCause)
      }
    }
  }
}

describe('./src/__tests__/testing-gaps.spec.ts', () => {
  it('[FF-001] normalizes custom abort reasons to AbortError', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const controller = new AbortController()
    controller.abort('custom abort reason')

    await expect(
      app.fetch('https://example.com/', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('[FF-002] keeps payload encoded when content-encoding chain is unsupported', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const rawPayload = zlib.gzipSync('hello world')

    app.get('/mixed-chain', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip, unsupported')
      reply.raw.setHeader('Content-Type', 'application/octet-stream')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/mixed-chain')
    const payload = Buffer.from(await response.arrayBuffer())

    assert.equal(response.headers.get('content-encoding'), 'gzip, unsupported')
    assert.deepEqual(payload, rawPayload)
  })

  it('[FF-002b] treats empty content-encoding token lists as no decode', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/empty-coding-list', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', ', ,  ,')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end('plain-text')
    })

    const response = await app.fetch('https://example.com/empty-coding-list')

    assert.equal(await response.text(), 'plain-text')
  })

  it('[FF-003] short-circuits buffered decode for empty payloads', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/empty-gzip', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.end(Buffer.alloc(0))
    })

    const response = await app.fetch('https://example.com/empty-gzip')

    assert.equal(await response.text(), '')
  })

  it('[FF-004a] decodes deflate payloads on internal-buffered transport', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const rawPayload = zlib.deflateSync('hello deflate')

    app.get('/deflate-buffered', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'deflate')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/deflate-buffered')

    assert.equal(await response.text(), 'hello deflate')
  })

  it('[FF-004b] decodes brotli payloads on internal-buffered transport', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const rawPayload = zlib.brotliCompressSync('hello brotli')

    app.get('/brotli-buffered', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'br')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/brotli-buffered')

    assert.equal(await response.text(), 'hello brotli')
  })

  it.todo(
    '[FF-005] stream decode no-op with empty codings requires a direct helper seam (currently unreachable through public plugin flow)',
  )

  it('[FF-006a] decodes gzip payloads on internal-stream transport', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => ({
          contract: 'fetch',
          transport: 'internal-stream',
        }),
      },
    })

    const rawPayload = zlib.gzipSync('hello stream gzip')

    app.get('/stream-gzip', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/stream-gzip')

    assert.equal(await response.text(), 'hello stream gzip')
  })

  it('[FF-006b] decodes deflate payloads on internal-stream transport', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => ({
          contract: 'fetch',
          transport: 'internal-stream',
        }),
      },
    })

    const rawPayload = zlib.deflateSync('hello stream deflate')

    app.get('/stream-deflate', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'deflate')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/stream-deflate')

    assert.equal(await response.text(), 'hello stream deflate')
  })

  it('[FF-006c] decodes brotli payloads on internal-stream transport', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => ({
          contract: 'fetch',
          transport: 'internal-stream',
        }),
      },
    })

    const rawPayload = zlib.brotliCompressSync('hello stream brotli')

    app.get('/stream-br', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'br')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/stream-br')

    assert.equal(await response.text(), 'hello stream brotli')
  })

  it('[FF-007/FF-009] applies numeric content-length to request overflow decisions', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'reject',
        },
      },
    })

    app.post('/echo', (_request, reply) => {
      void reply.send('ok')
    })

    await expectFetchFailed(
      app.fetch('https://example.com/echo', {
        body: 'hello',
        headers: {
          'content-length': '5',
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )
  })

  it('[FF-008] ignores invalid content-length values', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'reject',
        },
      },
    })

    app.post('/echo', (_request, reply) => {
      void reply.send('ok')
    })

    await expectFetchFailed(
      app.fetch('https://example.com/echo', {
        body: 'hello',
        headers: {
          'content-length': 'abc',
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )

    await expectFetchFailed(
      app.fetch('https://example.com/echo', {
        body: 'hello',
        headers: {
          'content-length': '-1',
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )
  })

  it('[FF-010] delegates buffered request body for unsafe methods after internal redirect', async () => {
    const app = fastify()
    const delegatedBodies: string[] = []

    await app.register(fastifyFetch, {
      policy: {
        route: ({ currentUrl }) => {
          if (currentUrl.hostname === 'example.com') {
            return 'internal-buffered'
          }

          return 'external'
        },
      },
      externalFetch: async (requestInfo, requestInit) => {
        const request = new Request(requestInfo, requestInit)

        delegatedBodies.push(await request.text())

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    app.post('/start', (_request, reply) => {
      reply.raw.statusCode = 307
      reply.raw.setHeader('Location', 'https://other.example/target')
      reply.raw.end()
    })

    const response = await app.fetch('https://example.com/start', {
      body: 'delegated-body',
      headers: {
        'content-type': 'text/plain',
      },
      method: 'POST',
    })

    assert.equal(await response.text(), 'external')
    assert.deepEqual(delegatedBodies, ['delegated-body'])
  })

  it.todo(
    '[FF-010-stream] delegateExternal stream-body branch is blocked by redirect replay safety invariant and needs a direct seam',
  )

  it('[FF-011] decodes internal-stream response before Response creation in fetch contract', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => ({
          contract: 'fetch',
          transport: 'internal-stream',
        }),
      },
    })

    const payload = zlib.gzipSync('stream decode target')

    app.get('/decode-fetch-stream', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(payload)
    })

    const response = await app.fetch('https://example.com/decode-fetch-stream')

    assert.equal(await response.text(), 'stream decode target')
  })

  it('[FF-012] forward-safe stream decode sanitizes relay-sensitive headers', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => ({
          contract: 'forward-safe',
          transport: 'internal-stream',
        }),
      },
    })

    const payload = zlib.gzipSync('forward safe stream')

    app.get('/decode-forward-safe-stream', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Length', payload.byteLength.toString())
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(payload)
    })

    const response = await app.fetch('https://example.com/decode-forward-safe-stream')

    assert.equal(await response.text(), 'forward safe stream')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-length'), null)
  })

  it('[FF-013] normalizes Response constructor failures from invalid internal status', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/invalid-status', (_request, reply) => {
      reply.raw.statusCode = 700
      reply.raw.end('invalid status for Response constructor')
    })

    await expectFetchFailed(app.fetch('https://example.com/invalid-status'), /range of 200 to 599/i)
  })

  it('[FF-014] rejects post-buffer request overflow when fallback is disabled', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'reject',
        },
      },
    })

    app.post('/post-buffer-overflow', (_request, reply) => {
      void reply.send('ok')
    })

    await expectFetchFailed(
      app.fetch('https://example.com/post-buffer-overflow', {
        body: 'hello',
        headers: {
          'content-length': 'abc',
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )
  })

  it('[FF-014b] falls back to internal-stream using declared content-length when fallback policy is enabled', async () => {
    const app = fastify()

    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'fallback',
        },
      },
    })

    app.post('/declared-length-fallback', (request, reply) => {
      void reply.send(String(request.body))
    })

    const response = await app.fetch('https://example.com/declared-length-fallback', {
      body: 'hello',
      headers: {
        'content-length': '5',
        'content-type': 'text/plain',
      },
      method: 'POST',
    })

    assert.equal(await response.text(), 'hello')
  })

  it('[FF-014c] falls back to internal-stream when post-buffer overflow occurs with fallback policy', async () => {
    const app = fastify()

    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'fallback',
        },
      },
    })

    app.post('/post-buffer-overflow-fallback', (request, reply) => {
      void reply.send(String(request.body))
    })

    const response = await app.fetch('https://example.com/post-buffer-overflow-fallback', {
      body: 'hello',
      headers: {
        'content-length': 'abc',
        'content-type': 'text/plain',
      },
      method: 'POST',
    })

    assert.equal(await response.text(), 'hello')
  })

  it('[FF-015/FF-016] applies response overflow policy for redirect status without location', async () => {
    const app = fastify()
    let calls = 0

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxResponseBytes: 2,
          onOverflow: 'fallback',
        },
      },
    })

    app.get('/redirect-without-location', (_request, reply) => {
      calls += 1
      reply.raw.statusCode = 308
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end('hello')
    })

    const response = await app.fetch('https://example.com/redirect-without-location')

    assert.equal(response.status, 308)
    assert.equal(await response.text(), 'hello')
    assert.equal(calls, 2)
  })

  it('[FF-017] normalizes malformed redirect location parse failures', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/bad-location', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'http://[::1')
      reply.raw.end()
    })

    await expectFetchFailed(app.fetch('https://example.com/bad-location'), /invalid url/i)
  })

  it('[HD-001] preserves commas inside Expires attributes while splitting set-cookie values', () => {
    const headers = new Headers()

    headers.append(
      'set-cookie',
      'session=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT, theme=dark; Path=/',
    )

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['session=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT', 'theme=dark; Path=/'],
    })
  })

  it('[HD-002] skips undefined node header values in fromNodeHeaders', () => {
    const headers = fromNodeHeaders({
      'x-empty': undefined,
    })

    assert.equal(headers.get('x-empty'), null)
  })

  it('[HD-003] stringifies numeric node header values in fromNodeHeaders', () => {
    const headers = fromNodeHeaders({
      'x-number': 42,
    })

    assert.equal(headers.get('x-number'), '42')
  })

  it('[SO-001] treats same opaque origins as same-origin', () => {
    const A = new URL('data:text/plain,first')
    const B = new URL('data:text/plain,second')

    assert.ok(sameOrigin(A, B))
  })
})
