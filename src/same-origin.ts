/**
 * Returns whether two URLs share the same origin.
 *
 * @remarks
 * The comparison matches scheme, host, and port for tuple origins and treats matching opaque origins (`origin === 'null'`) as same-origin.
 * This helper is commonly used in redirect policy decisions to distinguish same-origin transitions from cross-origin transitions.
 *
 * @param sourceUrl - Source URL in the comparison.
 * @param targetUrl - Target URL in the comparison.
 * @returns `true` when both URLs resolve to the same origin; otherwise `false`.
 */
export function sameOrigin(sourceUrl: URL, targetUrl: URL) {
  // 1. If sourceUrl and targetUrl are the same opaque origin, then return true.
  if (sourceUrl.origin === targetUrl.origin && sourceUrl.origin === 'null') {
    return true
  }

  // 2. If sourceUrl and targetUrl are both tuple origins and their schemes,
  //    hosts, and port are identical, then return true.
  if (
    sourceUrl.protocol === targetUrl.protocol &&
    sourceUrl.hostname === targetUrl.hostname &&
    sourceUrl.port === targetUrl.port
  ) {
    return true
  }

  // 3. Return false.
  return false
}
