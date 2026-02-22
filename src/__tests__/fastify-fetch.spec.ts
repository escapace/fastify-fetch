import fastify, { type LightMyRequestResponse } from 'fastify'
import type { InjectOptions } from 'light-my-request'
import zlib from 'node:zlib'
import { Request } from 'undici'
import { assert, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  FETCH_FAILED_CAUSE_MESSAGES,
  FORWARD_SAFE_SANITIZED_HEADERS,
  fastifyFetch,
} from '../index'

const expectFetchFailed = async (operation: Promise<unknown>, expectedCause?: string) => {
  try {
    await operation
    assert.fail('expected operation to reject')
  } catch (error) {
    assert.instanceOf(error, TypeError)
    assert.match(error.message, /fetch failed/i)

    if (expectedCause !== undefined) {
      assert.instanceOf(error.cause, Error)
      assert.equal(error.cause.message, expectedCause)
    }
  }
}

describe('./src/__tests__/fastify-fetch.spec.ts', () => {
  it('rejects on redirect mode error', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/end')
      reply.raw.end()
    })

    await expectFetchFailed(
      app.fetch('https://example.com/start', {
        redirect: 'error',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.unexpectedRedirect,
    )
  })

  it('rejects on pre-aborted signal', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const controller = new AbortController()
    controller.abort()

    await expect(
      app.fetch('https://example.com/', {
        signal: controller.signal,
      }),
    ).rejects.toThrowError(/aborted/i)
  })

  it('rejects when aborted during redirect processing', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/wait')
      reply.raw.end()
    })

    app.get('/wait', async (_request, reply) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })

      void reply.send('ok')
    })

    const controller = new AbortController()
    const operation = app.fetch('https://example.com/start', {
      signal: controller.signal,
    })

    setTimeout(() => {
      controller.abort()
    }, 10)

    await expect(operation).rejects.toThrowError(/aborted/i)
  })

  it('rewrites 303 POST to GET', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.post('/start', (_request, reply) => {
      reply.raw.statusCode = 303
      reply.raw.setHeader('Location', '/target')
      reply.raw.end()
    })

    app.all('/target', (request, reply) => {
      void reply.send(request.method)
    })

    const response = await app.fetch('https://example.com/start', {
      body: 'value=1',
      method: 'POST',
    })

    assert.equal(await response.text(), 'GET')
  })

  it('rewrites 301 POST to GET', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.post('/start', (_request, reply) => {
      reply.raw.statusCode = 301
      reply.raw.setHeader('Location', '/target')
      reply.raw.end()
    })

    app.all('/target', (request, reply) => {
      void reply.send(request.method)
    })

    const response = await app.fetch('https://example.com/start', {
      body: 'value=1',
      method: 'POST',
    })

    assert.equal(await response.text(), 'GET')
  })

  it('keeps method and body for 307 redirects when body is replayable', async () => {
    const app = fastify()

    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await app.register(fastifyFetch)

    app.post('/start', (_request, reply) => {
      reply.raw.statusCode = 307
      reply.raw.setHeader('Location', '/target')
      reply.raw.end()
    })

    app.post('/target', (request, reply) => {
      void reply.send(`${request.method}:${String(request.body)}`)
    })

    const response = await app.fetch('https://example.com/start', {
      body: 'value=1',
      headers: {
        'content-type': 'text/plain',
      },
      method: 'POST',
    })

    assert.equal(await response.text(), 'POST:value=1')
  })

  it('strips sensitive headers on cross-origin redirect', async () => {
    const app = fastify()
    const calls: string[] = []

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

        calls.push(request.headers.get('authorization') ?? 'none')

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'https://other.example/path')
      reply.raw.end()
    })

    const response = await app.fetch('https://example.com/start', {
      headers: {
        authorization: 'Bearer token',
      },
    })

    assert.equal(await response.text(), 'external')
    assert.deepEqual(calls, ['none'])
  })

  it('uses configurable redirect max hops', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        redirects: {
          maxHops: 1,
        },
      },
    })

    app.get('/0', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/1')
      reply.raw.end()
    })

    app.get('/1', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/2')
      reply.raw.end()
    })

    app.get('/2', (_request, reply) => {
      void reply.send('done')
    })

    await expectFetchFailed(
      app.fetch('https://example.com/0'),
      FETCH_FAILED_CAUSE_MESSAGES.redirectCountExceeded,
    )
  })

  it('populates response.url for non-redirect and redirect responses', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/direct', (_request, reply) => {
      void reply.send('ok')
    })

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/end')
      reply.raw.end()
    })

    app.get('/end', (_request, reply) => {
      void reply.send('end')
    })

    const direct = await app.fetch('https://example.com/direct')
    assert.equal(direct.url, 'https://example.com/direct')
    assert.notOk(direct.redirected)

    const redirected = await app.fetch('https://example.com/start')
    assert.equal(redirected.url, 'https://example.com/end')
    assert.ok(redirected.redirected)
  })

  it('allows custom methods accepted by Request', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const response = await app.fetch('https://example.com/custom', {
      method: 'PURGE',
    })

    assert.equal(response.status, 404)
  })

  it('still rejects forbidden methods from Request rules', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    await expect(
      app.fetch('https://example.com/custom', {
        method: 'CONNECT',
      }),
    ).rejects.toThrowError(/unsupported/i)
  })

  it('rejects redirects to non-http schemes', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'data:text/plain,hello')
      reply.raw.end()
    })

    await expectFetchFailed(
      app.fetch('https://example.com/start'),
      FETCH_FAILED_CAUSE_MESSAGES.redirectTargetMustBeHttp,
    )
  })

  it('delegates data URLs to external fetch', async () => {
    const app = fastify()
    const calls: string[] = []

    await app.register(fastifyFetch, {
      externalFetch: async (requestInfo, requestInit) => {
        const request = new Request(requestInfo, requestInit)

        calls.push(request.url)

        return await Promise.resolve(new Response('delegated', { status: 200 }))
      },
    })

    const response = await app.fetch('data:text/plain,hello')

    assert.equal(await response.text(), 'delegated')
    assert.deepEqual(calls, ['data:text/plain,hello'])
  })

  it('delegates non-http schemes to external fetch', async () => {
    const app = fastify()
    const calls: string[] = []

    await app.register(fastifyFetch, {
      externalFetch: async (requestInfo, requestInit) => {
        const request = new Request(requestInfo, requestInit)

        calls.push(request.url)

        return await Promise.resolve(new Response('delegated', { status: 200 }))
      },
    })

    const response = await app.fetch('file:///tmp/example.txt')

    assert.equal(await response.text(), 'delegated')
    assert.deepEqual(calls, ['file:///tmp/example.txt'])
  })

  it('keeps server semantics for manual redirects', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/end')
      reply.raw.end()
    })

    const response = await app.fetch('https://example.com/start', {
      redirect: 'manual',
    })

    assert.equal(response.status, 308)
    assert.equal(response.headers.get('location'), '/end')
  })

  it('does not follow non-fetch redirect status codes', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 300
      reply.raw.setHeader('Location', '/end')
      reply.raw.end('multiple choices')
    })

    app.get('/end', (_request, reply) => {
      void reply.send('end')
    })

    const response = await app.fetch('https://example.com/start')

    assert.equal(response.status, 300)
    assert.equal(await response.text(), 'multiple choices')
  })

  it('normalizes null-body status responses', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/bad204', (_request, reply) => {
      reply.raw.statusCode = 204
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end('invalid-body')
    })

    const response = await app.fetch('https://example.com/bad204')

    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
  })

  it('rejects redirect follow for non-replayable bodies', async () => {
    const app = fastify()

    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await app.register(fastifyFetch)

    app.post('/start', (_request, reply) => {
      reply.raw.statusCode = 307
      reply.raw.setHeader('Location', '/target')
      reply.raw.end()
    })

    app.post('/target', (_request, reply) => {
      void reply.send('target')
    })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        controller.close()
      },
    })

    await expectFetchFailed(
      app.fetch('https://example.com/start', {
        body: stream,
        duplex: 'half',
        headers: {
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestBodyNotReplayable,
    )
  })

  it('keeps fetch-mode decoded body with original encoding headers', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const rawPayload = zlib.gzipSync('hello world')

    app.get('/gzip', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Length', rawPayload.byteLength.toString())
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/gzip')

    assert.equal(await response.text(), 'hello world')
    assert.equal(response.headers.get('content-encoding'), 'gzip')
    assert.equal(response.headers.get('content-length'), rawPayload.byteLength.toString())
  })

  it('uses forward-safe contract to normalize decoded headers', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: ({ currentUrl }) => {
          if (currentUrl.pathname === '/forward-safe') {
            return {
              contract: 'forward-safe',
              transport: 'internal-buffered',
            }
          }

          return 'internal-buffered'
        },
      },
    })

    const rawPayload = zlib.gzipSync('hello world')

    app.get('/forward-safe', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Length', rawPayload.byteLength.toString())
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.setHeader('x-extra', 'kept')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/forward-safe')

    assert.deepEqual(FORWARD_SAFE_SANITIZED_HEADERS, ['content-encoding', 'content-length'])
    assert.equal(await response.text(), 'hello world')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-length'), '11')
    assert.equal(response.headers.get('x-extra'), 'kept')
  })

  it('uses wire-stream contract without decoding', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: ({ currentUrl }) => {
          if (currentUrl.pathname === '/wire') {
            return {
              contract: 'wire-stream',
              transport: 'internal-stream',
            }
          }

          return 'internal-buffered'
        },
      },
    })

    const rawPayload = zlib.gzipSync('hello world')

    app.get('/wire', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/wire')
    const payload = Buffer.from(await response.arrayBuffer())

    assert.equal(response.headers.get('content-encoding'), 'gzip')
    assert.notEqual(payload.toString(), 'hello world')
    assert.equal(zlib.gunzipSync(payload).toString(), 'hello world')
  })

  it('keeps wire-stream contract encoded payload on internal-buffered transport', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: ({ currentUrl }) => {
          if (currentUrl.pathname === '/wire-buffered') {
            return {
              contract: 'wire-stream',
              transport: 'internal-buffered',
            }
          }

          return 'internal-buffered'
        },
      },
    })

    const rawPayload = zlib.gzipSync('hello world')

    app.get('/wire-buffered', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip')
      reply.raw.setHeader('Content-Length', rawPayload.byteLength.toString())
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(rawPayload)
    })

    const response = await app.fetch('https://example.com/wire-buffered')
    const payload = Buffer.from(await response.arrayBuffer())

    assert.equal(response.headers.get('content-encoding'), 'gzip')
    assert.equal(response.headers.get('content-length'), rawPayload.byteLength.toString())
    assert.notEqual(payload.toString(), 'hello world')
    assert.equal(zlib.gunzipSync(payload).toString(), 'hello world')
  })

  it('delegates on boundary by default and can reject by policy', async () => {
    const delegatedApp = fastify()
    const delegatedCalls: string[] = []

    await delegatedApp.register(fastifyFetch, {
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

        delegatedCalls.push(request.url)

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    delegatedApp.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'https://other.example/path')
      reply.raw.end()
    })

    const delegated = await delegatedApp.fetch('https://example.com/start')

    assert.equal(await delegated.text(), 'external')
    assert.equal(delegatedCalls.length, 1)

    const rejectedApp = fastify()

    await rejectedApp.register(fastifyFetch, {
      policy: {
        redirects: {
          onBoundary: 'reject',
        },
        route: ({ currentUrl }) => {
          if (currentUrl.hostname === 'example.com') {
            return 'internal-buffered'
          }

          return 'external'
        },
      },
      externalFetch: async () => await Promise.resolve(new Response('external', { status: 200 })),
    })

    rejectedApp.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'https://other.example/path')
      reply.raw.end()
    })

    await expectFetchFailed(
      rejectedApp.fetch('https://example.com/start'),
      FETCH_FAILED_CAUSE_MESSAGES.redirectBoundaryBlocked,
    )
  })

  it('supports explicit per-call overrides only when enabled', async () => {
    const disabledApp = fastify()
    let disabledExternalCalls = 0

    await disabledApp.register(fastifyFetch, {
      policy: {
        route: () => 'external',
      },
      externalFetch: async () => {
        disabledExternalCalls += 1

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    disabledApp.get('/internal', (_request, reply) => {
      void reply.send('internal')
    })

    const disabledResult = await disabledApp.fetch('https://example.com/internal', {
      fastifyFetch: {
        transport: 'internal-buffered',
      },
    })

    assert.equal(await disabledResult.text(), 'external')
    assert.equal(disabledExternalCalls, 1)

    const enabledApp = fastify()
    const enabledExternalCalls: string[] = []

    await enabledApp.register(fastifyFetch, {
      allowPerCallOverrides: true,
      policy: {
        route: () => 'external',
      },
      externalFetch: async (requestInfo, requestInit) => {
        const request = new Request(requestInfo, requestInit)

        enabledExternalCalls.push(request.url)

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    enabledApp.get('/internal', (_request, reply) => {
      void reply.send('internal')
    })

    const enabledResult = await enabledApp.fetch('https://example.com/internal', {
      fastifyFetch: {
        transport: 'internal-buffered',
      },
    })

    assert.equal(await enabledResult.text(), 'internal')
    assert.equal(enabledExternalCalls.length, 0)

    const forcedInternalDataResult = await enabledApp.fetch('data:text/plain,hello', {
      fastifyFetch: {
        transport: 'internal-buffered',
      },
    })

    assert.equal(await forcedInternalDataResult.text(), 'external')
    assert.deepEqual(enabledExternalCalls, ['data:text/plain,hello'])
  })

  it('supports request overflow fallback and reject policies', async () => {
    const fallbackApp = fastify()

    fallbackApp.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await fallbackApp.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'fallback',
        },
      },
    })

    fallbackApp.post('/echo', (request, reply) => {
      void reply.send(String(request.body))
    })

    const fallbackResponse = await fallbackApp.fetch('https://example.com/echo', {
      body: 'hello',
      headers: {
        'content-type': 'text/plain',
      },
      method: 'POST',
    })

    assert.equal(await fallbackResponse.text(), 'hello')

    const rejectApp = fastify()

    rejectApp.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await rejectApp.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'reject',
        },
      },
    })

    rejectApp.post('/echo', (request, reply) => {
      void reply.send(String(request.body))
    })

    await expectFetchFailed(
      rejectApp.fetch('https://example.com/echo', {
        body: 'hello',
        headers: {
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )
  })

  it('applies default request-size limit when maxRequestBytes is not configured', async () => {
    const app = fastify()

    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          onOverflow: 'reject',
        },
      },
    })

    app.post('/echo', (request, reply) => {
      void reply.send(String(request.body))
    })

    await expectFetchFailed(
      app.fetch('https://example.com/echo', {
        body: 'x'.repeat(DEFAULT_MAX_REQUEST_BYTES + 1),
        headers: {
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )
  })

  it('rejects overflow for non-replayable request bodies when reject policy is configured', async () => {
    const app = fastify()

    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 3,
          onOverflow: 'reject',
        },
      },
    })

    app.post('/echo', (request, reply) => {
      void reply.send(String(request.body))
    })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        controller.close()
      },
    })

    await expectFetchFailed(
      app.fetch('https://example.com/echo', {
        body: stream,
        duplex: 'half',
        headers: {
          'content-type': 'text/plain',
        },
        method: 'POST',
      }),
      FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
    )
  })

  it('applies default response-size limit when maxResponseBytes is not configured', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          onOverflow: 'reject',
        },
      },
    })

    app.get('/large', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-type', 'application/octet-stream')
      reply.raw.end(Buffer.alloc(DEFAULT_MAX_RESPONSE_BYTES + 1, 7))
    })

    await expectFetchFailed(
      app.fetch('https://example.com/large'),
      FETCH_FAILED_CAUSE_MESSAGES.responsePayloadExceeded,
    )
  })

  it('falls back to internal stream on response overflow for safe methods', async () => {
    const app = fastify()
    let calls = 0

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxResponseBytes: 8,
          onOverflow: 'fallback',
        },
      },
    })

    app.get('/large', (_request, reply) => {
      calls += 1
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-type', 'text/plain')
      reply.raw.end('0123456789abcdef')
    })

    const response = await app.fetch('https://example.com/large')

    assert.equal(await response.text(), '0123456789abcdef')
    assert.equal(calls, 2)
  })

  it('uses payloadAsStream and avoids rawPayload buffering in internal-stream mode', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        route: () => ({
          contract: 'wire-stream',
          transport: 'internal-stream',
        }),
      },
    })

    app.get('/download', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-type', 'application/octet-stream')
      reply.raw.end(Buffer.alloc(128 * 1024, 1))
    })

    type PromiseInject = (options: string | InjectOptions) => Promise<LightMyRequestResponse>

    const originalInject = app.inject.bind(app) as PromiseInject
    const observations: Array<{ payloadAsStream: boolean; rawPayloadUndefined: boolean }> = []

    ;(app as { inject: PromiseInject }).inject = async (options) => {
      const response = await originalInject(options)

      if (typeof options === 'object' && options !== null) {
        observations.push({
          payloadAsStream: options.payloadAsStream === true,
          rawPayloadUndefined: response.rawPayload === undefined,
        })
      }

      return response
    }

    const response = await app.fetch('https://example.com/download')
    const payload = Buffer.from(await response.arrayBuffer())

    assert.equal(payload.byteLength, 128 * 1024)
    assert.ok(observations.some((value) => value.payloadAsStream))
    assert.ok(observations.some((value) => value.payloadAsStream && value.rawPayloadUndefined))
  })

  it('builds route context with redirect metadata', async () => {
    const app = fastify()
    const snapshots: Array<{ isRedirect: boolean; redirectCount: number; sameOrigin: boolean }> = []

    await app.register(fastifyFetch, {
      policy: {
        route: (context) => {
          snapshots.push({
            isRedirect: context.isRedirect,
            redirectCount: context.redirectCount,
            sameOrigin: !context.isCrossOriginRedirect(),
          })

          return 'internal-buffered'
        },
      },
    })

    app.get('/a', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/b')
      reply.raw.end()
    })

    app.get('/b', (_request, reply) => {
      void reply.send('ok')
    })

    const response = await app.fetch('https://example.com/a')
    assert.equal(await response.text(), 'ok')
    assert.deepEqual(snapshots, [
      { isRedirect: false, redirectCount: 0, sameOrigin: true },
      { isRedirect: true, redirectCount: 1, sameOrigin: true },
    ])
  })

  it('does not partially decode unsupported mixed content-encoding chains', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    const payload = zlib.brotliCompressSync('hello world')

    app.get('/mixed', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('Content-Encoding', 'gzip, asd, br')
      reply.raw.setHeader('Content-Type', 'text/plain')
      reply.raw.end(payload)
    })

    const response = await app.fetch('https://example.com/mixed')
    const value = Buffer.from(await response.arrayBuffer())

    assert.equal(response.headers.get('content-encoding'), 'gzip, asd, br')
    assert.notEqual(value.toString(), 'hello world')
  })

  it('normalizes internal transport errors to fetch-style TypeError', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/boom', (_request, reply) => {
      reply.raw.destroy(new Error('kaboom'))
    })

    await expectFetchFailed(app.fetch('https://example.com/boom'), 'kaboom')
  })
})
