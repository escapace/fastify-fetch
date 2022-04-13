import { fetch, RequestInfo, RequestInit } from 'undici'

export interface Options {
  match?: (requestInfo: RequestInfo, requestInit?: RequestInit) => boolean
  fetch?: typeof fetch
}
