import fs from 'node:fs/promises'
import type * as http from 'node:http'
import path from 'node:path'
import { parse as urlParse } from 'node:url'
import { createFilter } from '@rollup/pluginutils'
import chokidar from 'chokidar'
import bodyParser from 'co-body'
import Debug from 'debug'
import { build } from 'esbuild'
import fastGlob from 'fast-glob'
import { match, pathToRegexp } from 'path-to-regexp'
import type { Connect, ResolvedConfig } from 'vite'
import type {
  Method,
  MockOptions,
  MockOptionsItem,
  MockServerPluginOptions,
  ResponseReq,
} from './types'
import { isArray, isFunction, sleep } from './utils'

const MOCK_TEMP = 'node_modules/.cache/.mock_server'

const debug = Debug('vite:plugin-mock-dev-server')

export async function mockServerMiddleware(
  httpServer: http.Server | null,
  config: ResolvedConfig,
  options: Required<MockServerPluginOptions>
): Promise<Connect.NextHandleFunction> {
  const include = isArray(options.include) ? options.include : [options.include]
  const fileFilter = createFilter(options.include, options.exclude, {
    resolve: false,
  })
  const includePaths = await fastGlob(include, { cwd: process.cwd() })
  const external = await getExternal(process.cwd())
  const modules: Record<string, MockOptions | MockOptionsItem> =
    Object.create(null)
  let mockList!: MockOptions

  for (const filepath of includePaths) {
    modules[filepath] = await loadModule(filepath, external)
  }

  setupMockList()

  debug(
    'start watcher: ',
    include,
    includePaths,
    includePaths.map((url) => `${url}: ${fileFilter(url)}`)
  )
  debug('watcher api length: ', mockList.length)

  const watcher = chokidar.watch(include.splice(0)[0], {
    ignoreInitial: true,
    cwd: process.cwd(),
  })
  include.length > 0 && include.forEach((item) => watcher.add(item))

  watcher.on('add', async (filepath) => {
    if (!fileFilter(filepath)) return
    debug('watcher add: ', filepath)
    modules[filepath] = await loadModule(filepath, external)
    setupMockList()
  })
  watcher.on('change', async (filepath) => {
    if (!fileFilter(filepath)) return
    debug('watcher change', filepath)
    modules[filepath] = await loadModule(filepath, external)
    setupMockList()
  })
  watcher.on('unlink', (filepath) => {
    debug('watcher unlink', filepath)
    delete modules[filepath]
    setupMockList()
  })

  function setupMockList() {
    mockList = []
    Object.keys(modules).forEach((key) => {
      const handle = modules[key]
      isArray(handle) ? mockList.push(...handle) : mockList.push(handle)
    })
    mockList = mockList.filter(
      (mock) => mock.enabled || typeof mock.enabled === 'undefined'
    )
  }

  httpServer?.on('close', () => watcher.close())

  const proxies: string[] = Object.keys(config.server.proxy || {})

  return async function (req, res, next) {
    if (
      proxies.length === 0 ||
      !proxies.some((context) => doesProxyContextMatchUrl(context, req.url!))
    ) {
      return next()
    }
    const method = req.method!.toUpperCase()
    const { query, pathname } = urlParse(req.url!, true)
    const reqBody = await parseReqBody(req)

    const currentMock = mockList.find((mock) => {
      if (!pathname || !mock || !mock.url) return false
      const methods: Method[] = mock.method
        ? isArray(mock.method)
          ? mock.method
          : [mock.method]
        : ['GET', 'POST']
      if (!methods.includes(req.method!.toUpperCase() as Method)) return false
      const hasMock = pathToRegexp(mock.url).test(pathname)

      if (hasMock && mock.validator) {
        const urlMatch = match(mock.url, { decode: decodeURIComponent })(
          pathname!
        ) || { params: {} }
        const params = urlMatch.params || {}
        const request = {
          query,
          params,
          body: reqBody,
          headers: req.headers,
        }
        if (isFunction(mock.validator)) {
          return mock.validator(request)
        } else {
          return validate(request, mock.validator)
        }
      }
      return hasMock
    })

    if (!currentMock) return next()

    debug('middleware: ', method, pathname)

    if (currentMock.delay && currentMock.delay > 0) {
      await sleep(currentMock.delay)
    }

    res.statusCode = currentMock.status || 200
    res.statusMessage = currentMock.statusText || 'OK'

    const urlMatch = match(currentMock.url, { decode: decodeURIComponent })(
      pathname!
    ) || { params: {} }
    const params = urlMatch.params || {}

    ;(req as any).body = reqBody
    ;(req as any).query = query
    ;(req as any).params = params

    res.setHeader('Content-Type', 'application/json')
    if (currentMock.headers) {
      const headers = isFunction(currentMock.headers)
        ? await currentMock.headers({
            query,
            body: reqBody,
            params,
            headers: req.headers,
          })
        : currentMock.headers
      Object.keys(headers).forEach((key) => {
        res.setHeader(key, headers[key])
      })
    }

    if (currentMock.body) {
      let body: any
      if (isFunction(currentMock.body)) {
        body = await currentMock.body({
          query,
          body: reqBody,
          params,
          headers: req.headers,
        })
      } else {
        body = currentMock.body
      }
      res.end(JSON.stringify(body))
      return
    }

    if (currentMock.response) {
      await currentMock.response(
        req as Connect.IncomingMessage & ResponseReq,
        res,
        next
      )
      return
    }

    res.end('')
  }
}

function doesProxyContextMatchUrl(context: string, url: string): boolean {
  return (
    (context.startsWith('^') && new RegExp(context).test(url)) ||
    url.startsWith(context)
  )
}

async function parseReqBody(req: Connect.IncomingMessage): Promise<any> {
  const method = req.method!.toUpperCase()
  if (['GET', 'DELETE', 'HEAD'].includes(method)) return undefined
  const type = req.headers['content-type']
  if (type === 'application/json') {
    return await bodyParser.json(req)
  }
  if (type === 'application/x-www-form-urlencoded') {
    return await bodyParser.form(req)
  }
  if (type === 'text/plain') {
    return await bodyParser.text(req)
  }
  return await bodyParser(req)
}

async function loadModule(
  filepath: string,
  external: string[]
): Promise<MockOptions | MockOptionsItem> {
  try {
    const result = await build({
      entryPoints: [filepath],
      outfile: 'out.js',
      write: false,
      target: 'es2020',
      platform: 'node',
      bundle: true,
      external,
      metafile: true,
      format: 'esm',
    })

    const tempFile = path.join(
      process.cwd(),
      MOCK_TEMP,
      filepath.replace(/\.ts$/, '.mjs')
    )
    const tempBasename = path.dirname(tempFile)
    await fs.mkdir(tempBasename, { recursive: true })
    await fs.writeFile(tempFile, result.outputFiles[0].text, 'utf8')
    const handle = await import(`${tempFile}?${Date.now()}`)
    if (handle && handle.default)
      return handle.default as MockOptions | MockOptionsItem
    return Object.keys(handle || {}).map((key) => handle[key]) as MockOptions
  } catch (e) {
    console.error(e)
  }
  return { url: '' }
}

async function getExternal(cwd: string) {
  const filepath = path.resolve(cwd, 'package.json')
  const content = await fs.readFile(filepath, 'utf-8')
  const pkg = JSON.parse(content)
  const { dependencies = {}, devDependencies = {} } = pkg
  const external = [
    ...Object.keys(dependencies),
    ...Object.keys(devDependencies),
  ]
  return external
}

function validate(
  request: ResponseReq,
  validator: Partial<ResponseReq>
): boolean {
  return (
    equalObj(request.headers, validator.headers) &&
    equalObj(request.body, validator.body) &&
    equalObj(request.params, validator.params) &&
    equalObj(request.query, validator.query)
  )
}

function equalObj(
  left: Record<string, any>,
  right?: Record<string, any>
): boolean {
  if (!right) return true
  for (const key in right) {
    if (right[key] !== left[key]) return false
  }
  return true
}
