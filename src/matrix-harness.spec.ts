import fastify from 'fastify'
import { assert, describe, expect, it } from 'vitest'
import { type FastifyFetchContract, type FastifyFetchTransport, fastifyFetch } from './index'

const runCase = async (transport: FastifyFetchTransport, contract: FastifyFetchContract) => {
  const app = fastify()

  await app.register(fastifyFetch, {
    policy: {
      route: () => ({ contract, transport }),
    },
    externalFetch: async () => await Promise.resolve(new Response('external', { status: 200 })),
  })

  app.get('/value', (_request, reply) => {
    void reply.send('internal')
  })

  const response = await app.fetch('https://example.com/value')
  const value = await response.text()

  await app.close()

  if (transport === 'external') {
    assert.equal(value, 'external')
  } else if (transport === 'reject') {
    assert.fail('reject case should be handled in caller')
  } else {
    assert.equal(value, 'internal')
  }
}

describe('./src/matrix-harness.spec.ts', () => {
  const transports: FastifyFetchTransport[] = ['external', 'internal-buffered', 'internal-stream']
  const contracts: FastifyFetchContract[] = ['fetch', 'forward-safe', 'wire-stream']

  for (const transport of transports) {
    for (const contract of contracts) {
      it(`runs matrix scenario transport=${transport} contract=${contract}`, async () => {
        await runCase(transport, contract)
      })
    }
  }

  it('includes reject transport behavior', async () => {
    const app = fastify()
    await app.register(fastifyFetch, {
      policy: {
        route: () => 'reject',
      },
    })

    await expect(app.fetch('https://example.com/value')).rejects.toThrowError(/fetch failed/i)
  })
})
