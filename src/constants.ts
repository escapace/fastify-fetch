export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export const FORWARD_SAFE_SANITIZED_HEADERS = ['content-encoding', 'content-length'] as const

export const FETCH_FAILED_CAUSE_MESSAGES = {
  redirectBoundaryBlocked: 'redirect boundary blocked by policy',
  redirectCountExceeded: 'redirect count exceeded',
  redirectTargetMustBeHttp: 'redirect target must be http(s)',
  requestBodyNotReplayable: 'request body is not replayable',
  requestPayloadExceeded: 'request payload exceeded max buffered size',
  requestRejectedByPolicy: 'request rejected by policy',
  responsePayloadExceeded: 'response payload exceeded max buffered size',
  unexpectedRedirect: 'unexpected redirect',
} as const
