import fastify, { type LightMyRequestResponse } from 'fastify'
import type { InjectOptions } from 'light-my-request'
import zlib from 'node:zlib'
import { Request } from 'undici'
import { assert, describe, it } from 'vitest'
import { FETCH_FAILED_CAUSE_MESSAGES } from '../constants'
import { fastifyFetch, sameOrigin } from '../index'

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

describe('./src/__tests__/readme-policy-examples.spec.ts', () => {
  it('[README-001] local orchestration with selective external calls', async () => {
    const app = fastify()
    const externalCalls: string[] = []

    await app.register(fastifyFetch, {
      policy: {
        defaultTransport: 'external',
        route: ({ currentUrl }) =>
          currentUrl.hostname === 'api.internal.local' ? 'internal-buffered' : 'external',
      },
      externalFetch: async (requestInfo, requestInit) => {
        const request = new Request(requestInfo, requestInit)

        externalCalls.push(request.url)

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    app.get('/local', (_request, reply) => {
      void reply.send('internal')
    })

    try {
      const internalResponse = await app.fetch('https://api.internal.local/local')
      assert.equal(await internalResponse.text(), 'internal')

      const externalResponse = await app.fetch('https://third-party.example/resource')
      assert.equal(await externalResponse.text(), 'external')
      assert.deepEqual(externalCalls, ['https://third-party.example/resource'])
    } finally {
      await app.close()
    }
  })

  it('[README-002] explicit deny rules for restricted paths', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        defaultTransport: 'internal-buffered',
        route: ({ currentUrl }) =>
          currentUrl.pathname.startsWith('/admin/') ? 'reject' : 'internal-buffered',
      },
    })

    app.get('/public', (_request, reply) => {
      void reply.send('public')
    })

    try {
      const publicResponse = await app.fetch('https://api.internal.local/public')
      assert.equal(await publicResponse.text(), 'public')

      await expectFetchFailed(
        app.fetch('https://api.internal.local/admin/report'),
        FETCH_FAILED_CAUSE_MESSAGES.requestRejectedByPolicy,
      )
    } finally {
      await app.close()
    }
  })

  it('[README-003] redirect delegation with hop control', async () => {
    const app = fastify()
    const externalCalls: string[] = []

    await app.register(fastifyFetch, {
      policy: {
        redirects: {
          maxHops: 10,
          onBoundary: 'delegate',
        },
        route: ({ currentUrl, isRedirect, previousUrl }) => {
          if (isRedirect && previousUrl !== undefined && !sameOrigin(previousUrl, currentUrl)) {
            return 'external'
          }

          return 'internal-buffered'
        },
      },
      externalFetch: async (requestInfo, requestInit) => {
        const request = new Request(requestInfo, requestInit)

        externalCalls.push(request.url)

        return await Promise.resolve(new Response('external', { status: 200 }))
      },
    })

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/mid')
      reply.raw.end()
    })

    app.get('/mid', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'https://other.example/final')
      reply.raw.end()
    })

    app.get('/hop/:index', (request, reply) => {
      const parameters = request.params as { index: string }
      const index = Number(parameters.index)

      if (index >= 11) {
        void reply.send('done')
        return
      }

      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', `/hop/${index + 1}`)
      reply.raw.end()
    })

    try {
      const delegatedResponse = await app.fetch('https://api.internal.local/start')
      assert.equal(await delegatedResponse.text(), 'external')
      assert.deepEqual(externalCalls, ['https://other.example/final'])

      await expectFetchFailed(
        app.fetch('https://api.internal.local/hop/0'),
        FETCH_FAILED_CAUSE_MESSAGES.redirectCountExceeded,
      )
    } finally {
      await app.close()
    }
  })

  it('[README-004] redirect hard-boundary enforcement', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        redirects: {
          maxHops: 10,
          onBoundary: 'reject',
        },
        route: ({ currentUrl }) =>
          currentUrl.hostname === 'api.internal.local' ? 'internal-buffered' : 'external',
      },
      externalFetch: async () => await Promise.resolve(new Response('external', { status: 200 })),
    })

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', 'https://other.example/final')
      reply.raw.end()
    })

    try {
      await expectFetchFailed(
        app.fetch('https://api.internal.local/start'),
        FETCH_FAILED_CAUSE_MESSAGES.redirectBoundaryBlocked,
      )
    } finally {
      await app.close()
    }
  })

  it('[README-005] large payload path with fallback streaming', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 1024 * 1024,
          maxResponseBytes: 8 * 1024 * 1024,
          onOverflow: 'fallback',
        },
        route: ({ currentUrl }) =>
          currentUrl.pathname.startsWith('/downloads/')
            ? { contract: 'wire-stream', transport: 'internal-stream' }
            : 'internal-buffered',
      },
    })

    app.get('/status', (_request, reply) => {
      void reply.send('ok')
    })

    const compressedDownload = zlib.gzipSync('download-body')

    app.get('/downloads/file', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-encoding', 'gzip')
      reply.raw.setHeader('content-type', 'application/octet-stream')
      reply.raw.end(compressedDownload)
    })

    type PromiseInject = (options: string | InjectOptions) => Promise<LightMyRequestResponse>

    const originalInject = app.inject.bind(app) as PromiseInject
    const payloadAsStreamFlags: boolean[] = []

    ;(app as { inject: PromiseInject }).inject = async (options) => {
      if (typeof options === 'object' && options !== null) {
        payloadAsStreamFlags.push(options.payloadAsStream === true)
      }

      return await originalInject(options)
    }

    try {
      const statusResponse = await app.fetch('https://api.internal.local/status')
      assert.equal(await statusResponse.text(), 'ok')

      const downloadResponse = await app.fetch('https://api.internal.local/downloads/file')
      const payload = Buffer.from(await downloadResponse.arrayBuffer())

      assert.equal(downloadResponse.headers.get('content-encoding'), 'gzip')
      assert.equal(zlib.gunzipSync(payload).toString(), 'download-body')
      assert.ok(payloadAsStreamFlags.includes(false))
      assert.ok(payloadAsStreamFlags.includes(true))
    } finally {
      await app.close()
    }
  })

  it('[README-006] strict capacity rejection', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        buffering: {
          maxRequestBytes: 512 * 1024,
          maxResponseBytes: 2 * 1024 * 1024,
          onOverflow: 'reject',
        },
      },
    })

    app.post('/echo', (_request, reply) => {
      void reply.send('ok')
    })

    app.get('/large', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-type', 'application/octet-stream')
      reply.raw.end(Buffer.alloc(2 * 1024 * 1024 + 1, 1))
    })

    try {
      await expectFetchFailed(
        app.fetch('https://api.internal.local/echo', {
          body: 'x'.repeat(512 * 1024 + 1),
          headers: {
            'content-type': 'text/plain',
          },
          method: 'POST',
        }),
        FETCH_FAILED_CAUSE_MESSAGES.requestPayloadExceeded,
      )

      await expectFetchFailed(
        app.fetch('https://api.internal.local/large'),
        FETCH_FAILED_CAUSE_MESSAGES.responsePayloadExceeded,
      )
    } finally {
      await app.close()
    }
  })

  it('[README-007] forward-safe default for relay-heavy services', async () => {
    const app = fastify()

    await app.register(fastifyFetch, {
      policy: {
        defaultContract: 'forward-safe',
        route: ({ currentUrl }) =>
          currentUrl.pathname.startsWith('/client/')
            ? { contract: 'fetch', transport: 'internal-buffered' }
            : 'internal-buffered',
      },
    })

    const relayPayload = zlib.gzipSync('relay')
    const clientPayload = zlib.gzipSync('client')

    app.get('/relay/value', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-encoding', 'gzip')
      reply.raw.setHeader('content-length', relayPayload.byteLength.toString())
      reply.raw.setHeader('content-type', 'text/plain')
      reply.raw.end(relayPayload)
    })

    app.get('/client/value', (_request, reply) => {
      reply.raw.statusCode = 200
      reply.raw.setHeader('content-encoding', 'gzip')
      reply.raw.setHeader('content-length', clientPayload.byteLength.toString())
      reply.raw.setHeader('content-type', 'text/plain')
      reply.raw.end(clientPayload)
    })

    try {
      const relayResponse = await app.fetch('https://api.internal.local/relay/value')
      assert.equal(await relayResponse.text(), 'relay')
      assert.equal(relayResponse.headers.get('content-encoding'), null)
      assert.equal(relayResponse.headers.get('content-length'), '5')

      const clientResponse = await app.fetch('https://api.internal.local/client/value')
      assert.equal(await clientResponse.text(), 'client')
      assert.equal(clientResponse.headers.get('content-encoding'), 'gzip')
      assert.equal(
        clientResponse.headers.get('content-length'),
        clientPayload.byteLength.toString(),
      )
    } finally {
      await app.close()
    }
  })
})
