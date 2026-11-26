import type { HttpBindings } from '@hono/node-server'
import type { Context } from 'hono'
import { errorCode } from './errors.js'
import { once } from 'node:events'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { RequestError } from './service.js'

type ServerEnv = { Bindings: HttpBindings }
type ServerContext = Context<ServerEnv>

const hostname = '127.0.0.1'
const devUiUrl = `http://${hostname}:5173`
const maxBodyBytes = 32 * 1024 * 1024
const uiRoot = fileURLToPath(new URL('../dist/ui', import.meta.url))
const uiExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.woff2'])
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
}

function localHosts(c: ServerContext) {
  const port = c.env.incoming.socket.localPort
  return [`${hostname}:${port}`, `localhost:${port}`]
}

async function readJson(c: ServerContext): Promise<unknown> {
  if (Number(c.req.header('content-length')) > maxBodyBytes)
    throw new RequestError('请求过大。', 413)
  const chunks: Uint8Array[] = []
  let size = 0
  const body = c.req.raw.body
  if (body) {
    // 超限时先返回 413，再由 Node 适配器清理未读的请求体。
    for await (const chunk of body.values({ preventCancel: true })) {
      size += chunk.byteLength
      if (size > maxBodyBytes) throw new RequestError('请求过大。', 413)
      chunks.push(chunk)
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch {
    throw new RequestError('请求的 JSON 格式有误。')
  }
}

export async function startServer(
  service: { run: (action: string, body: unknown) => Promise<unknown> },
  { port = 10107, dev = false } = {},
) {
  const app = new Hono<ServerEnv>()

  app.onError((error, c) => {
    c.header('Cache-Control', 'no-store')
    if (error instanceof RequestError)
      return c.json({ error: error.message }, error.status)
    if (errorCode(error) === 'ELOCKED')
      return c.json(
        { error: '另一个 AgentWeave 操作正在进行，请稍后重试。' },
        409,
      )
    return c.json({ error: error.message }, 400)
  })

  app.use('*', (c, next) => {
    for (const [name, value] of Object.entries(securityHeaders))
      c.header(name, value)
    if (!localHosts(c).includes(c.req.header('host') ?? ''))
      throw new RequestError('只接受本机请求。', 403)
    return next()
  })

  app.use('/api/*', (c, next) => {
    if (!new URL(c.req.url).pathname.startsWith('/api/')) return next()
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'POST')
      throw new RequestError('此接口需要 POST 请求。', 405)
    const origins = localHosts(c).map((host) => `http://${host}`)
    if (dev) origins.push(devUiUrl, 'http://localhost:5173')
    if (
      !origins.includes(c.req.header('origin') ?? '') ||
      c.req.header('sec-fetch-site') === 'cross-site'
    )
      throw new RequestError('请从 AgentWeave 本地界面操作。', 403)
    if (
      c.req.header('content-type')?.split(';')[0].trim() !== 'application/json'
    )
      throw new RequestError('请求需要使用 JSON 格式。', 415)
    return next()
  })

  app.post('/api/*', async (c) => {
    const { pathname } = new URL(c.req.url)
    if (!pathname.startsWith('/api/'))
      throw new RequestError('请求方法不受支持。', 405)
    const body = await readJson(c)
    const value = await service.run(pathname.slice('/api/'.length), body)
    return c.body(JSON.stringify(value ?? null), 200, {
      'Content-Type': 'application/json; charset=UTF-8',
    })
  })

  const serveUi = dev ? undefined : serveStatic({ root: uiRoot })
  app.get('*', async (c) => {
    const pathname = c.req.path
    if (dev && pathname === '/') return c.redirect(devUiUrl)
    if (!serveUi || (pathname !== '/' && !uiExtensions.has(extname(pathname))))
      throw new RequestError('页面不存在。', 404)
    c.header(
      'Cache-Control',
      pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    )
    const response = await serveUi(c, async () => {
      if (pathname === '/')
        throw new RequestError(
          '未找到 UI 构建产物，请先运行 npm run build。',
          503,
        )
      throw new RequestError('文件不存在。', 404)
    })
    return response ?? c.res
  })
  app.all('*', () => {
    throw new RequestError('请求方法不受支持。', 405)
  })

  const server = serve({
    fetch: app.fetch,
    port,
    hostname,
    overrideGlobalObjects: false,
  })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('无法读取本机监听端口。')
  return { server, url: `http://${hostname}:${address.port}` }
}
