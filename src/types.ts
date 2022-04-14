import { fetch, Request } from 'undici'

export interface Options {
  match?: (url: URL, request: Request) => boolean
  fetch?: typeof fetch
}
