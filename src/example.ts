import fastify from 'fastify'
import fastifyFetch from './index'

const example = async () => {
  const app = fastify({
    logger: true,
  })

  await app.register(fastifyFetch, {
    policy: {
      defaultContract: 'fetch',
      defaultTransport: 'internal-buffered',
      route: ({ currentUrl }) => {
        if (currentUrl.pathname.startsWith('/downloads/')) {
          return {
            contract: 'wire-stream',
            transport: 'internal-stream',
          }
        }

        return 'internal-buffered'
      },
    },
  })

  app.get('/', (_request, reply) => {
    void reply.send({ hello: 'world' })
  })

  const response = await app.fetch('https://example.com/')

  if (response.ok) {
    console.log(await response.text())
  }
}

void example()
