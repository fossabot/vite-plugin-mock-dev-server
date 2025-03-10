import type * as http from 'node:http'
import type { Connect, ResolvedConfig, WebSocketServer } from 'vite'
import { baseMiddleware } from './baseMiddleware'
import { MockLoader } from './MockLoader'
import type { MockServerPluginOptions } from './types'
import { ensureArray, ensureProxies } from './utils'

export async function mockServerMiddleware(
  config: ResolvedConfig,
  options: Required<MockServerPluginOptions>,
  httpServer: http.Server | null,
  ws?: WebSocketServer,
): Promise<Connect.NextHandleFunction> {
  const include = ensureArray(options.include)
  const exclude = ensureArray(options.exclude)

  const define: ResolvedConfig['define'] = {}
  if (config.define) {
    for (const key in config.define) {
      const val = config.define[key]
      define[key] = typeof val === 'string' ? val : JSON.stringify(val)
    }
  }

  const loader = new MockLoader({
    include,
    exclude,
    define,
  })

  await loader.load()
  httpServer?.on('close', () => loader.close())
  loader.on('mock:update-end', () => {
    if (options.reload) {
      ws?.send({ type: 'full-reload' })
    }
  })

  /**
   * 获取 服务代理配置中，配置的 请求前缀，
   * 作为判断接口是否需要mock的首要条件。
   *
   * 在一般开发场景中，我们也只需要对通过 vite server 进行代理的请求 进行 mock
   */
  const proxies: string[] = ensureProxies(config.server.proxy || {})
  /**
   * 保留直接通过 plugin option 直接配置 路径匹配规则，
   * 但在大多数场景下，共用 `server.proxy` 以足够
   */
  const prefix = ensureArray(options.prefix)

  return baseMiddleware(loader, {
    formidableOptions: options.formidableOptions,
    proxies: [...prefix, ...proxies],
  })
}
