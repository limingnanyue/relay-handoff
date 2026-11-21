import express from 'express'
import { resolve } from 'node:path'
import { createApp } from '../server/app.mjs'

const app = express()
const relay = await createApp({ demo: true, directory: '.relay/qa/layout', databaseUrl: '', s3: {} })
app.get('/layout-check', (_, response) => response.sendFile(resolve('scripts/layout-check.html')))
app.use(express.static(resolve('dist')))
app.use(relay.app)
const port = Number(process.argv[2] ?? 3010)
app.listen(port, '127.0.0.1', () => console.log(`布局回归 http://localhost:${port}/layout-check`))
