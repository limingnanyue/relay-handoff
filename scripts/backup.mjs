import { access, cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

const source = resolve(process.env.RELAY_DATA ?? '.relay')
const destination = resolve(process.argv[2] ?? join(source, 'backups', new Date().toISOString().replaceAll(':', '-')))
if (process.env.DATABASE_URL) throw new Error('Postgres 请使用部署手册中的 pg_dump 或托管快照。')
if (destination === source || destination.startsWith(join(source, 'objects') + '\\') || destination.startsWith(join(source, 'objects') + '/')) throw new Error('请选择独立的备份目录。')
await access(join(source, 'relay.sqlite'))
await mkdir(destination, { recursive: false, mode: 0o700 }).catch(async (error) => {
  if (error.code !== 'ENOENT') throw error
  await mkdir(destination, { recursive: true, mode: 0o700 })
})
const database = new DatabaseSync(join(source, 'relay.sqlite'), { readOnly: true })
try { await backup(database, join(destination, 'relay.sqlite')) } finally { database.close() }
for (const entry of ['objects', 'relay.key']) {
  if (entry === 'relay.key' && process.env.RELAY_KEY) continue
  try { await access(join(source, entry)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
  await cp(join(source, entry), join(destination, entry), { recursive: entry === 'objects', errorOnExist: true, force: false })
}
console.log(`已写入备份 ${destination}`)
