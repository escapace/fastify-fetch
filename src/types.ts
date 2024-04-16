import type { fetch, Request } from 'undici'

export interface Options {
  fetch?: typeof fetch
  match?: (url: URL, request: Request) => boolean
}
