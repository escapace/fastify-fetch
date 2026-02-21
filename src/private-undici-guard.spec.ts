import fastify from 'fastify'
import { assert, describe, it } from 'vitest'
import { fastifyFetch } from './index'

describe('./src/private-undici-guard.spec.ts', () => {
  it('keeps response.url populated for internal responses', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/direct', (_request, reply) => {
      void reply.send('ok')
    })

    const response = await app.fetch('https://example.com/direct')

    assert.equal(response.url, 'https://example.com/direct')
    assert.notOk(response.redirected)
  })

  it('keeps redirected metadata coherent', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/start', (_request, reply) => {
      reply.raw.statusCode = 308
      reply.raw.setHeader('Location', '/end')
      reply.raw.end()
    })

    app.get('/end', (_request, reply) => {
      void reply.send('end')
    })

    const response = await app.fetch('https://example.com/start')

    assert.equal(response.url, 'https://example.com/end')
    assert.ok(response.redirected)
  })
})
