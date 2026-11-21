import express from 'express'
import { resolve } from 'node:path'
import { createApp } from './app.mjs'

const development = process.argv.includes('--dev')
const relay = await createApp({ development })
const host = process.env.RELAY_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)
if (relay.demo && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('演示模式只能在本机监听。')
let vite
if (development) {
  vite = await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' })
  relay.app.use(vite.middlewares)
} else {
  relay.app.use('/assets', express.static(resolve('dist/assets'), { immutable: true, maxAge: '1y', fallthrough: false }))
  relay.app.use(express.static(resolve('dist'), { maxAge: 0 }))
  relay.app.get('/{*path}', (_, response) => response.sendFile(resolve('dist/index.html')))
}
const server = relay.app.listen(port, host, () => console.log(`接棒 Relay 已启动。http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`))
server.requestTimeout = 330_000
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close()
  await vite?.close()
  await relay.close()
})
