import { assert } from 'vitest'
import type { FastifyFetchInput } from '../types'

export type ObservedFetchRequest = Pick<Request, 'headers' | 'method' | 'signal' | 'text' | 'url'>

export const toObservedFetchRequest = (
  requestInfo: FastifyFetchInput,
  requestInit: RequestInit | undefined,
): ObservedFetchRequest => {
  if (requestInit !== undefined) {
    assert.fail(
      'expected external fetch to receive a request-like input object without a separate init',
    )
  }

  if (typeof requestInfo !== 'object' || requestInfo === null) {
    assert.fail('expected external fetch to receive a request-like input object')
  }

  for (const key of ['headers', 'method', 'signal', 'text', 'url'] as const) {
    if (!(key in requestInfo)) {
      assert.fail(`expected external fetch input to include request property: ${String(key)}`)
    }
  }

  return requestInfo as ObservedFetchRequest
}
