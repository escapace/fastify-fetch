/* eslint-disable no-duplicate-imports */
import type {
  FastifyLoggerInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault
} from 'fastify'
import { fastifyFetch } from './fastify-fetch'
import type { Fetch } from './types'

declare module 'fastify/types/instance' {
  export interface FastifyInstance<
    RawServer extends RawServerBase = RawServerDefault,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    RawRequest extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    RawReply extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    Logger = FastifyLoggerInstance
  > {
    fetch: Fetch
  }
}

export { fetch } from './fetch'
export type { Fetch }
export { fastifyFetch }
export default fastifyFetch
