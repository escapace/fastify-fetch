import type { RequestInfo, RequestInit, Response } from 'node-fetch'
import _fetch from 'vendor/node-fetch/src/index'

export const fetch = _fetch as unknown as (
  url: RequestInfo,
  init?: RequestInit
) => Promise<Response>
