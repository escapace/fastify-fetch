import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Lang, parse } from '@ast-grep/napi'
import { resolvePath } from 'mlly'
import { Request, Response } from 'undici'

interface RequestState {
  body: { source: object | null } | null
}

interface ResponseState {
  urlList: URL[]
}

const rootDirectory = path.resolve(import.meta.dirname, '../')
process.chdir(rootDirectory)

const toRelativePath = (value: string) => path.relative(rootDirectory, value)

const createPatternAsserter = async (absolutePath: string) => {
  const source = await readFile(absolutePath, 'utf8')
  const root = parse(Lang.JavaScript, source).root()

  const assertPattern = (description: string, pattern: string) => {
    if (root.find(pattern) === null) {
      throw new Error(
        `Undici private API drift detected in ${toRelativePath(absolutePath)}: ${description}`,
      )
    }
  }

  const assertAnyPattern = (description: string, patterns: string[]) => {
    if (patterns.some((pattern) => root.find(pattern) !== null)) {
      return
    }

    throw new Error(
      `Undici private API drift detected in ${toRelativePath(absolutePath)}: ${description}`,
    )
  }

  return {
    assertAnyPattern,
    assertPattern,
  }
}

const resolveUndiciPrivatePath = async (subpath: string) => {
  try {
    return await resolvePath(`undici/${subpath}`, { url: import.meta.url })
  } catch (error) {
    throw new Error(`Unable to resolve undici private module "undici/${subpath}"`, { cause: error })
  }
}

const run = async () => {
  const requestModulePath = await resolveUndiciPrivatePath('lib/web/fetch/request.js')
  const responseModulePath = await resolveUndiciPrivatePath('lib/web/fetch/response.js')

  const requestAsserts = await createPatternAsserter(requestModulePath)
  requestAsserts.assertPattern(
    'missing static getRequestState(request) { return request.#state }',
    'class $CLASS { $$$PRE static getRequestState($REQUEST) { return $REQUEST.#state } $$$POST }',
  )
  requestAsserts.assertAnyPattern('module.exports no longer exposes getRequestState', [
    'module.exports = { $$$PRE, getRequestState }',
    'module.exports = { $$$PRE, getRequestState, $$$POST }',
  ])

  const responseAsserts = await createPatternAsserter(responseModulePath)
  responseAsserts.assertPattern(
    'missing static getResponseState(response) { return response.#state }',
    'class $CLASS { $$$PRE static getResponseState($RESPONSE) { return $RESPONSE.#state } $$$POST }',
  )
  responseAsserts.assertAnyPattern('module.exports no longer exposes getResponseState', [
    'module.exports = { $$$PRE, getResponseState }',
    'module.exports = { $$$PRE, getResponseState, $$$POST }',
  ])
  responseAsserts.assertPattern(
    'response state no longer provides urlList via getter path',
    'const $URL_LIST = this.#state.urlList',
  )
  responseAsserts.assertPattern(
    'response redirected semantics no longer reference urlList length',
    'this.#state.urlList.length > 1',
  )

  const requestModule = (await import(pathToFileURL(requestModulePath).href)) as {
    getRequestState?: (request: Request) => RequestState
  }
  const responseModule = (await import(pathToFileURL(responseModulePath).href)) as {
    getResponseState?: (response: Response) => ResponseState
  }

  const getRequestState = requestModule.getRequestState
  const getResponseState = responseModule.getResponseState

  if (typeof getRequestState !== 'function') {
    throw new TypeError('undici/lib/web/fetch/request.js does not export getRequestState')
  }

  if (typeof getResponseState !== 'function') {
    throw new TypeError('undici/lib/web/fetch/response.js does not export getResponseState')
  }

  const requestWithoutBody = getRequestState(new Request('https://example.com/'))
  assert.equal(
    requestWithoutBody.body,
    null,
    'Request state body shape changed for body-less requests',
  )

  const requestWithBody = getRequestState(
    new Request('https://example.com/', {
      body: 'payload',
      method: 'POST',
    }),
  )

  assert.notEqual(
    requestWithBody.body,
    null,
    'Request state body unexpectedly missing for request with body',
  )

  if (requestWithBody.body === null) {
    throw new Error('Request state body unexpectedly missing for request with body')
  }

  assert.ok('source' in requestWithBody.body, 'Request state body.source is no longer available')

  const responseState = getResponseState(new Response('ok'))
  assert.ok(Array.isArray(responseState.urlList), 'Response state urlList is no longer an array')

  const previousLength = responseState.urlList.length
  responseState.urlList.push(new URL('https://example.com/final'))
  assert.equal(
    responseState.urlList.length,
    previousLength + 1,
    'Response state urlList is no longer mutable as expected',
  )

  console.log('Undici private API drift guard passed')
}

try {
  await run()
} catch (error) {
  console.error('Undici private API drift guard failed')

  if (error instanceof Error) {
    console.error(error.message)

    if (error.cause instanceof Error) {
      console.error(`cause: ${error.cause.message}`)
    }
  } else {
    console.error(error)
  }

  process.exitCode = 1
}
