import fastify from 'fastify'
import fastifyFetch from './index'

const example = async () => {
  const app = fastify({
    logger: true
  })

  await app.register(fastifyFetch)

  // Declare a route
  app.get('/', (_, reply) => {
    void reply.send({ hello: 'world' })
  })

  const response = await app.fetch('https://github.com/')

  if (response.ok) {
    console.log(await response.text())
  }
}

void example()
