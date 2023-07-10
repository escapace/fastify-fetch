import { Headers } from 'undici'
import { toNodeHeaders } from './headers'
import { assert } from 'chai'

describe('toNodeHeaders', () => {
  it('should handle multiple set-cookie headers correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar')
    headers.append('set-cookie', 'bar=foo')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo']
    })
  })

  it('should handle a single set-cookie header correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': 'foo=bar'
    })
  })

  it('should handle a single set-cookie header with multiple cookies correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar, bar=foo')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo']
    })

    headers.append('set-cookie', 'baz=qux')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo', 'baz=qux']
    })
  })

  it('should handle mixed case set-cookie headers correctly', () => {
    const headers = new Headers()

    headers.append('set-cookie', 'foo=bar')
    headers.append('Set-Cookie', 'bar=foo')

    assert.deepEqual(toNodeHeaders(headers), {
      'set-cookie': ['foo=bar', 'bar=foo']
    })
  })
})
