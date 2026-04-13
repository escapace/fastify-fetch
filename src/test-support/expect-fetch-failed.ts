import { assert } from 'vitest'

export const expectFetchFailed = async (
  operation: Promise<unknown>,
  expectedCause?: string | RegExp,
) => {
  try {
    await operation
    assert.fail('expected operation to reject')
  } catch (error) {
    assert.instanceOf(error, TypeError)
    assert.match(error.message, /fetch failed/i)

    if (expectedCause !== undefined) {
      assert.instanceOf(error.cause, Error)

      if (typeof expectedCause === 'string') {
        assert.equal(error.cause.message, expectedCause)
      } else {
        assert.match(error.cause.message, expectedCause)
      }
    }
  }
}
