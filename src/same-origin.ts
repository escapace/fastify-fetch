export function sameOrigin(A: URL, B: URL) {
  // 1. If A and B are the same opaque origin, then return true.
  if (A.origin === B.origin && A.origin === 'null') {
    return true
  }

  // 2. If A and B are both tuple origins and their schemes,
  //    hosts, and port are identical, then return true.
  if (
    A.protocol === B.protocol &&
    A.hostname === B.hostname &&
    A.port === B.port
  ) {
    return true
  }

  // 3. Return false.
  return false
}
