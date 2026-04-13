import fastify from 'fastify'
import { assert, describe, expect, it } from 'vitest'
import { FETCH_FAILED_CAUSE_MESSAGES } from '../constants'
import {
  type FastifyFetchBoundaryPolicy,
  type FastifyFetchContract,
  type FastifyFetchTransport,
  fastifyFetch,
} from '../index'
import { expectFetchFailed } from '../test-support/expect-fetch-failed'

type MatrixTransport = Exclude<FastifyFetchTransport, 'reject'>

interface MatrixDimensions {
  readonly boundary: FastifyFetchBoundaryPolicy
  readonly contract: FastifyFetchContract
  readonly transport: MatrixTransport
}

interface MatrixScenario {
  readonly id: string
  readonly run: (dimensions: MatrixDimensions) => Promise<void>
  readonly unsupportedReason?: (dimensions: MatrixDimensions) => string | undefined
}

const runTransportContractScenario = async (dimensions: MatrixDimensions) => {
  const app = fastify()

  await app.register(fastifyFetch, {
    policy: {
      redirects: {
        onBoundary: dimensions.boundary,
      },
      route: () => ({
        contract: dimensions.contract,
        transport: dimensions.transport,
      }),
    },
    externalFetch: async () => await Promise.resolve(new Response('external', { status: 200 })),
  })

  app.get('/value', (_request, reply) => {
    void reply.send('internal')
  })

  try {
    const response = await app.fetch('https://example.com/value')
    const value = await response.text()

    if (dimensions.transport === 'external') {
      assert.equal(value, 'external')
    } else {
      assert.equal(value, 'internal')
    }
  } finally {
    await app.close()
  }
}

const runBoundaryScenario = async (dimensions: MatrixDimensions) => {
  const app = fastify()

  await app.register(fastifyFetch, {
    policy: {
      redirects: {
        onBoundary: dimensions.boundary,
      },
      route: ({ currentUrl }) => {
        if (currentUrl.hostname === 'example.com') {
          return {
            contract: dimensions.contract,
            transport: dimensions.transport,
          }
        }

        return 'external'
      },
    },
    externalFetch: async () => await Promise.resolve(new Response('external', { status: 200 })),
  })

  app.get('/start', (_request, reply) => {
    reply.raw.statusCode = 308
    reply.raw.setHeader('Location', 'https://other.example/path')
    reply.raw.end()
  })

  try {
    if (dimensions.boundary === 'delegate') {
      const response = await app.fetch('https://example.com/start')

      assert.equal(await response.text(), 'external')
      return
    }

    await expectFetchFailed(
      app.fetch('https://example.com/start'),
      FETCH_FAILED_CAUSE_MESSAGES.redirectBoundaryBlocked,
    )
  } finally {
    await app.close()
  }
}

describe('./src/__tests__/matrix-harness.spec.ts', () => {
  const transports: MatrixTransport[] = ['external', 'internal-buffered', 'internal-stream']
  const contracts: FastifyFetchContract[] = ['fetch', 'forward-safe', 'wire-stream']
  const boundaries: FastifyFetchBoundaryPolicy[] = ['delegate', 'reject']

  const scenarios: MatrixScenario[] = [
    {
      id: 'SCN_TRANSPORT_CONTRACT',
      run: runTransportContractScenario,
    },
    {
      id: 'SCN_BOUNDARY',
      run: runBoundaryScenario,
      unsupportedReason: (dimensions) => {
        if (dimensions.transport === 'external') {
          return 'boundary scenario requires an internal first hop before external handoff'
        }

        return
      },
    },
  ]

  for (const scenario of scenarios) {
    for (const transport of transports) {
      for (const contract of contracts) {
        for (const boundary of boundaries) {
          const dimensions: MatrixDimensions = {
            boundary,
            contract,
            transport,
          }

          const unsupportedReason = scenario.unsupportedReason?.(dimensions)

          if (unsupportedReason !== undefined) {
            it(`${scenario.id} marks unsupported transport=${transport} contract=${contract} boundary=${boundary}`, () => {
              assert.match(unsupportedReason, /\S/)
            })
            continue
          }

          it(`${scenario.id} transport=${transport} contract=${contract} boundary=${boundary}`, async () => {
            await scenario.run(dimensions)
          })
        }
      }
    }
  }

  it('includes reject transport behavior', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => 'reject',
      },
    })

    await expect(app.fetch('https://example.com/value')).rejects.toThrow(/fetch failed/i)
  })
})
