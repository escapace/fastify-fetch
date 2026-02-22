import { Headers } from 'undici'
import { fromNodeHeaders, splitCookiesString, toNodeHeaders } from '../headers'
import { assert, describe, it } from 'vitest'

describe('splitCookiesString', () => {
  it('should preserve commas inside Expires attributes', () => {
    const cookies = splitCookiesString(
      'session=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT, theme=dark; Path=/',
    )

    assert.deepEqual(cookies, [
      'session=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
      'theme=dark; Path=/',
    ])
  })

  it('should ignore separator whitespace before the next cookie', () => {
    const cookies = splitCookiesString('foo=bar,   bar=foo')

    assert.deepEqual(cookies, ['foo=bar', 'bar=foo'])
  })
})

describe('fromNodeHeaders', () => {
  it('should append array values for the same header key', () => {
    const headers = fromNodeHeaders({
      accept: ['application/json', 'text/plain'],
    })

    assert.equal(headers.get('accept'), 'application/json, text/plain')
  })

  it('should skip undefined values and stringify numeric values', () => {
    const headers = fromNodeHeaders({
      'x-empty': undefined,
      'x-number': 42,
    })

    assert.equal(headers.get('x-empty'), null)
    assert.equal(headers.get('x-number'), '42')
  })
})

describe('toNodeHeaders', () => {
  it('should handle multiple set-cookie headers correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar')
    headers.append('set-cookie', 'bar=foo')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo'],
    })
  })

  it('should handle a single set-cookie header correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': 'foo=bar',
    })
  })

  it('should handle a single set-cookie header with multiple cookies correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar, bar=foo')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo'],
    })

    headers.append('set-cookie', 'baz=qux')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo', 'baz=qux'],
    })
  })

  it('should handle mixed case set-cookie headers correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar')
    headers.append('Set-Cookie', 'bar=foo')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo'],
    })
  })
})
