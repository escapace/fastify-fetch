import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import fastify from 'fastify'
import { range, rangeRight } from 'lodash-es'
import { URL } from 'url'
import zlib from 'zlib'
import { fastifyFetch } from './index'

chai.use(chaiAsPromised)

const { assert } = chai

describe('./src/index.spec.ts', () => {
  it('wrong url', async function () {
    this.timeout(4000)

    const app = fastify()
    await app.register(fastifyFetch, {
      match: (url, request) => {
        assert.equal(url.hostname, 'example.com')
        assert.equal(request.url, url.toString())

        return true
      }
    })

    app.get('/hello', (_req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end('hello')
    })

    const res = await app.fetch('https://example.com:8080/world', {
      method: 'GET'
    })

    assert.notOk(res.ok)
    assert.deepEqual(res.status, 404)
  })

  it('basic async await', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/hello', (_req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end('hello')
    })

    const res = await app.fetch('https://example.com:8080/hello', {
      method: 'GET'
    })

    assert.ok(res.ok)
    assert.deepEqual(await res.text(), 'hello')
  })

  it('cookies', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/hello', (req, res) => {
      assert.equal(req.headers.cookie, 'name=value; name2=value2; name=value3')

      res.raw.setHeader('Set-Cookie', [
        'id=a3fWa; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
        'id=a3fWb; ; Domain=somecompany.co.uk; Expires=Wed, 21 Oct 2015 07:28:00 GMT'
      ])
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end('hello')
    })

    const res = await app.fetch('https://example.com:8080/hello', {
      credentials: 'same-origin',
      headers: {
        cookie: ['name=value; name2=value2; name=value3']
      },
      method: 'GET'
    })

    assert.ok(res.ok)
    assert.deepEqual(await res.text(), 'hello')
    assert.deepEqual(
      res.headers.get('set-cookie'),
      'id=a3fWa; Expires=Wed, 21 Oct 2015 07:28:00 GMT, id=a3fWb; ; Domain=somecompany.co.uk; Expires=Wed, 21 Oct 2015 07:28:00 GMT'
    )
  })

  it('basic async await (errored)', async () => {
    const app = fastify()
    await app.register(fastifyFetch)

    app.get('/hello', (_req, res) => {
      res.raw.destroy(new Error('kaboom'))
      // .connection.destroy()
    })

    await assert.isRejected(
      app.fetch('https://example.com:8080/hello', {
        method: 'GET'
      }),
      /kaboom/i
    )
  })

  it('returns non-chunked payload', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const output = 'example.com:8080|/hello'

    app.get('/hello', (req, res) => {
      res.raw.statusMessage = 'Super'
      res.raw.setHeader('x-extra', 'hello')
      res.raw.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': output.length
      })

      res.raw.end(`${req.raw.headers.host ?? ''}|${req.url}`)
    })

    const response = await app.fetch('https://example.com:8080/hello')

    assert.equal(response.status, 200)
    assert.equal(response.statusText, 'Super')
    assert.deepEqual(Object.fromEntries(response.headers.entries()), {
      date: `${response.headers.get('date') as string}`,
      connection: 'keep-alive',
      'x-extra': 'hello',
      'content-type': 'text/plain',
      'content-length': `${output.length}`
    })

    const textDecoder = new TextDecoder()

    assert.equal(
      textDecoder.decode(await response.clone().arrayBuffer()),
      output
    )

    assert.equal(await response.clone().text(), output)
  })

  it('should throw on unknown HTTP method', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    await assert.isRejected(
      app.fetch('http://example.com:8080/hello', {
        method: 'UNKNOWN_METHOD'
      }),
      /UNKNOWN_METHOD/
    )
  })

  it('passes host option as host header', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/hello', (req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end(req.headers.host)
    })

    const response = await app.fetch('https://example.com/hello', {
      method: 'GET',
      headers: { host: 'test.example.com' }
    })

    assert.ok(response.ok)
    assert.equal(await response.text(), 'test.example.com')
  })

  it('accepts an URL', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const output = 'example.com:8080|/hello?test=1234'

    app.get('/hello', (req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end(`${req.raw.headers.host ?? ''}|${req.raw.url ?? ''}`)
    })

    const response = await app.fetch(
      new URL('https://example.com:8080/hello?test=1234'),
      {
        method: 'GET'
      }
    )

    assert.ok(response.ok)
    assert.equal(await response.text(), output)
  })

  it('cookie', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const output = 'yummy_cookie=choco; tasty_cookie=strawberry'

    app.get('/hello', (req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end(req.headers.cookie)
    })

    const response = await app.fetch(
      new URL('https://example.com:8080/hello'),
      {
        method: 'GET',
        headers: {
          Cookie: output
        }
      }
    )

    assert.ok(response.ok)
    assert.equal(await response.text(), output)
  })

  it('returns single buffer payload', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/hello', (req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end(`${req.headers.host ?? '|'}|${req.url}`)
    })

    const response = await app.fetch('https://example.com:8080/hello')

    assert.ok(response.headers.get('date'))
    assert.ok(response.headers.get('connection'))
    assert.equal(response.headers.get('transfer-encoding'), 'chunked')
  })

  it('accept base64-encoded gif data uri', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const response = await app.fetch(
      'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs='
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'image/gif')
    assert.instanceOf(await response.arrayBuffer(), ArrayBuffer)
  })

  it('rejected on unsupported url scheme', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    await assert.isRejected(
      app.fetch('gopher://example.com'),
      /is not supported/
    )
  })

  it('should handle no content response with gzip encoding', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/no-content-gzip', (_req, res) => {
      res.raw.statusCode = 204
      res.raw.setHeader('Content-Encoding', 'gzip')
      res.raw.end()
    })

    const response = await app.fetch('https://example.com/no-content-gzip')

    assert.ok(response.ok)
    assert.equal(response.headers.get('content-encoding'), 'gzip')
    assert.equal(response.statusText, 'No Content')
  })

  it('should decompress gzip response', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/gzip', (_req, res) => {
      res.raw.statusCode = 200
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'gzip')
      zlib.gzip('hello world', (err, buffer) => {
        if (err != null) {
          throw err
        }

        res.raw.end(buffer)
      })
    })

    const response = await app.fetch('https://example.com/gzip')
    assert.ok(response.ok)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(await response.text(), 'hello world')
  })

  it('should decompress deflate response', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/deflate', (_req, res) => {
      res.raw.statusCode = 200
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'deflate')

      zlib.deflate('hello world', (err, buffer) => {
        if (err != null) {
          throw err
        }

        res.raw.end(buffer)
      })
    })

    const response = await app.fetch('https://example.com/deflate')
    assert.ok(response.ok)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(await response.text(), 'hello world')
  })

  it('same name cookie', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const output = 'yummy_cookie=choco; yummy_cookie=strawberry'

    app.get('/hello', (req, res) => {
      res.raw.writeHead(200, { 'Content-Type': 'text/plain' })
      res.raw.end(req.headers.cookie)
    })

    const response = await app.fetch(
      new URL('https://example.com:8080/hello'),
      {
        method: 'GET',
        headers: {
          Cookie: output
        }
      }
    )

    assert.ok(response.ok)
    assert.equal(await response.text(), output)
  })

  // it('should decompress deflate raw response', async () => {
  //   const app = fastify()
  //
  //   await app.register(fastifyFetch)
  //
  //   app.get('/deflate', (_req, res) => {
  //     res.raw.statusCode = 200
  //     res.raw.setHeader('Content-Type', 'text/plain')
  //     res.raw.setHeader('Content-Encoding', 'deflate')
  //
  //     zlib.deflateRaw('hello world', (err, buffer) => {
  //       if (err != null) {
  //         throw err
  //       }
  //
  //       res.raw.end(buffer)
  //     })
  //   })
  //
  //   const response = await app.fetch('https://example.com/deflate')
  //   assert.ok(response.ok)
  //   assert.equal(response.headers.get('content-type'), 'text/plain')
  //   assert.equal(response.headers.get('content-encoding'), 'deflate')
  //   assert.equal(await response.text(), 'hello world')
  // })

  it('should decompress brotli response', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/brotli', (_req, res) => {
      res.raw.statusCode = 200
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'br')

      zlib.brotliCompress('hello world', (err, buffer) => {
        if (err != null) {
          throw err
        }

        res.raw.end(buffer)
      })
    })

    const response = await app.fetch('https://example.com/brotli')
    assert.ok(response.ok)
    assert.notOk(response.redirected)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(await response.text(), 'hello world')
  })

  it('should decompress redirected brotli response', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const number = 5

    rangeRight(number).forEach((i) => {
      app.get(`/${i}`, (_req, res) => {
        res.raw.statusCode = 308
        res.raw.setHeader('Location', `/${i === 1 ? 'brotli' : i - 1}`)
        res.raw.end()
      })
    })

    app.get('/brotli', (_req, res) => {
      res.raw.statusCode = 200
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'br')

      zlib.brotliCompress('hello world', (err, buffer) => {
        if (err != null) {
          throw err
        }

        res.raw.end(buffer)
      })
    })

    const response = await app.fetch(`https://example.com/${number - 1}`)

    assert.ok(response.ok)
    assert.ok(response.redirected)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(await response.text(), 'hello world')
  })

  it('should error on too many redirects', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const number = 10

    rangeRight(number).forEach((i) => {
      app.get(`/${i}`, (_req, res) => {
        res.raw.statusCode = 308
        res.raw.setHeader('Location', `/${i === 1 ? 'brotli' : i - 1}`)
        res.raw.end()
      })
    })

    const response = await app.fetch(`https://example.com/${number - 1}`)

    assert.notOk(response.ok)
  })

  it('should error on redirects', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const number = 2

    rangeRight(number).forEach((i) => {
      app.get(`/${i}`, (_req, res) => {
        res.raw.statusCode = 308
        res.raw.setHeader('Location', `/${i === 1 ? 'brotli' : i - 1}`)
        res.raw.end()
      })
    })

    const response = await app.fetch(`https://example.com/${number - 1}`, {
      redirect: 'error'
    })

    assert.notOk(response.ok)
  })

  it('should return response on manual redirects', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    const number = 4

    range(number).forEach((i) => {
      app.get(`/${i}`, (_req, res) => {
        res.raw.statusCode = 308
        res.raw.setHeader('Location', `/${i === 1 ? 'brotli' : i + 1}`)
        res.raw.end()
      })
    })

    const response = await app.fetch(`https://example.com/0`, {
      redirect: 'manual'
    })

    assert.equal(response.status, 308)
    assert.equal(response.headers.get('location'), '/1')
    assert.notOk(response.ok)
  })

  it('should return response on no location redirects', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/redirect', (_req, res) => {
      res.raw.statusCode = 303
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'br')

      zlib.brotliCompress('hello world', (err, buffer) => {
        if (err != null) {
          throw err
        }

        res.raw.end(buffer)
      })
    })

    const response = await app.fetch('https://example.com/redirect')

    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), undefined)
    // assert.equal(response.headers.get('content-encoding'), 'qwe')
    assert.equal(await response.text(), 'hello world')
    assert.notOk(response.ok)
  })

  it('should decompress brotli, gzip response', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/compressed', (_req, res) => {
      res.raw.statusCode = 200
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'br, gzip')

      res.raw.end(zlib.gzipSync(zlib.brotliCompressSync('hello world')))
    })

    const response = await app.fetch('https://example.com/compressed')
    assert.ok(response.ok)
    assert.notOk(response.redirected)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(await response.text(), 'hello world')
  })

  it('should partially decompress brotli, asd, gzip response', async () => {
    const app = fastify()

    await app.register(fastifyFetch)

    app.get('/compressed', (_req, res) => {
      res.raw.statusCode = 200
      res.raw.setHeader('Content-Type', 'text/plain')
      res.raw.setHeader('Content-Encoding', 'gzip, asd, br')

      res.raw.end(zlib.brotliCompressSync('hello world'))
    })

    const response = await app.fetch('https://example.com/compressed')
    assert.ok(response.ok)
    assert.notOk(response.redirected)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('content-encoding'), 'gzip,asd')
    assert.equal(await response.text(), 'hello world')
  })

  // it('form-data should be handled correctly', async () => {
  //   const app = fastify()
  //   // await app.register(fastifyMultipart)
  //   await app.register(fastifyFetch)
  //
  //   app.post('/hello', (request, reply) => {
  //     console.log('f request header', request.headers)
  //     console.log('f request body', request.body)
  //
  //     reply.send(request.body)
  //   })
  //
  //   const form = new FormData()
  //
  //   form.append('my_field', new Blob(['asd1']))
  //
  //   const response = await app.fetch('http://example.com:8080/hello', {
  //     method: 'POST',
  //     body: form as any
  //   })
  //
  //   assert.ok(response.ok)
  //   assert.equal(response.status, 200)
  //
  //   assert.ok(
  //     /Content-Disposition: form-data; name="my_field"/im.test(
  //       await response.text()
  //     )
  //   )
  // })

  // it('should allow POST request with blob body with type', async () => {
  //   const app = fastify()
  //
  //   await app.register(fastifyFetch)
  //
  //   app.post('/inspect', async (req, res) => {
  //     res.raw.statusCode = 200
  //     res.raw.setHeader('Content-Type', 'application/json')
  //
  //     await res.send({
  //       method: req.raw.method,
  //       url: req.raw.url,
  //       headers: req.raw.headers,
  //       body: req.body
  //     })
  //   })
  //
  //   const response = await app.fetch('https://example.com/inspect', {
  //     method: 'POST',
  //     body: new Blob(['a=1'], {
  //       type: 'text/plain;charset=UTF-8'
  //     })
  //   })
  //
  //   assert.ok(response.ok)
  //   const json = await response.json()
  //
  //   assert.equal(json.headers['transfer-encoding'], undefined)
  //   assert.equal(json.headers['content-type'], 'text/plain;charset=UTF-8')
  //   assert.equal(json.headers['content-length'], '3')
  // })

  // it('should allow POST request with form-data using stream as body', async function () {
  //   const app = fastify()

  //   // this.timeoutgcc(10000)

  //   await app.register(fastifyMultipart)
  //   await app.register(fastifyFetch)

  //   app.post('/multipart', async function (req, res) {
  //     const data = await req.file()

  //     console.log(data)

  //     const buf = await data.toBuffer()

  //     res.send({
  //       method: req.raw.method,
  //       url: req.raw.url,
  //       headers: req.raw.headers,
  //       body: buf.toString()
  //     })
  //   })

  //   const form = new FormData()
  //   const filePath = path.resolve(__dirname, '../../package.json')
  //   const content = (await fse.readFile(filePath)).toString()

  //   form.append('my_field', content, 'package.json')

  //   const response = await app.fetch('https://example.com/multipart', {
  //     method: 'POST',
  //     body: form
  //   })

  //   assert.ok(response.ok)
  //   const json = await response.json()

  //   // assert.equal(json.headers['transfer-encoding'], undefined)
  //   // assert.equal(json.body, 'Hello, world!\n')
  //   assert.ok(
  //     /^multipart\/form-data;boundary=/.test(json.headers['content-type'])
  //   )
  // })

  // it('should allow POST request with string body', async () => {
  //   const app = fastify()
  //
  //   await app.register(fastifyFetch)
  //
  //   app.post('/inspect', async (req, res) => {
  //     res.raw.statusCode = 200
  //     res.raw.setHeader('Content-Type', 'application/json')
  //
  //     await res.send({
  //       method: req.raw.method,
  //       url: req.raw.url,
  //       headers: req.raw.headers,
  //       body: req.body
  //     })
  //   })
  //
  //   const response = await app.fetch('https://example.com/inspect', {
  //     method: 'POST',
  //     body: new URLSearchParams('a=1')
  //   })
  //
  //   assert.ok(response.ok)
  //   const json = await response.json()
  //
  //   assert.equal(json.body, 'a=1')
  //   assert.equal(json.headers['transfer-encoding'], undefined)
  //   assert.equal(json.headers['content-type'], 'text/plain;charset=UTF-8')
  //   assert.equal(json.headers['content-length'], '3')
  //   assert.equal(json.headers['user-agent'], 'fastify-fetch')
  // })
})
