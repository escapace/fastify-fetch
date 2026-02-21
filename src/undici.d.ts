declare module 'undici/lib/web/fetch/request.js' {
  import type { Request } from 'undici'

  export declare const getRequestState: (request: Request) => {
    body: { source: object | null } | null
  }
}

declare module 'undici/lib/web/fetch/response.js' {
  import type { Response } from 'undici'

  export declare const getResponseState: (response: Response) => { urlList: URL[] }
}
