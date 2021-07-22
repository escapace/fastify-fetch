import type { RequestInfo, RequestInit, Response } from 'node-fetch'
export type { HTTPMethods } from 'fastify'
export type { RequestOptions } from 'http'
export type {
  Blob,
  Request as NodeFetchRequest,
  RequestInfo,
  RequestInit,
  Response,
  ResponseInit
} from 'node-fetch'

export type Fetch = (
  url: RequestInfo,
  options_?: RequestInit
) => Promise<Response>
