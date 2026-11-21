import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { id, now, requireThat } from './domain.mjs'

const schema = `
CREATE TABLE IF NOT EXISTS relay_records (
  tenant TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (tenant, kind, key)
);
CREATE TABLE IF NOT EXISTS relay_audit (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, at TEXT NOT NULL, version INTEGER, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_login_emails (digest TEXT PRIMARY KEY, tenant TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS relay_audit_tenant ON relay_audit (tenant, at DESC);
CREATE INDEX IF NOT EXISTS relay_records_kind ON relay_records (kind, tenant);
`

export async function loadKey(directory, configured, demo) {
  if (configured) {
    if (!/^[0-9a-f]{64}$/i.test(configured)) throw new Error('RELAY_KEY 须为 64 位十六进制字符。')
    return Buffer.from(configured, 'hex')
  }
  if (!demo) throw new Error('正式模式需要配置 RELAY_KEY。')
  const file = join(directory, 'relay.key')
  try { await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const key = await readFile(file)
  if (key.byteLength !== 32) throw new Error('本地加密密钥损坏。')
  return key
}

function encryption(key) {
  function seal(bytes, context) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(context))
    const body = Buffer.concat([cipher.update(bytes), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), body])
  }
  function open(bytes, context) {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
  }
  return { seal, open }
}

export async function createStore({ directory, databaseUrl, key: configuredKey, demo, s3 }) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = await loadKey(directory, configuredKey, demo)
  const crypto = encryption(key)
  const isPostgres = Boolean(databaseUrl)
  const db = isPostgres ? new (await import('pg')).default.Pool({ connectionString: databaseUrl, max: 12 }) : new DatabaseSync(join(directory, 'relay.sqlite'))
  const dialect = (sql) => isPostgres ? sql.replace(/\?/g, (_, index) => `$${sql.slice(0, index).split('?').length}`) : sql
  const query = (client, sql, args = [], mode = 'all') => isPostgres
    ? client.query(dialect(sql), args).then((result) => mode === 'get' ? result.rows[0] : mode === 'run' ? result.rowCount : result.rows)
    : Promise.resolve(client.prepare(sql)[mode](...args))

  if (isPostgres) {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('relay-schema'));` + schema + `
      CREATE OR REPLACE FUNCTION relay_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'immutable audit'; END; $$;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relay_audit_no_update' AND tgrelid = 'relay_audit'::regclass) THEN
          CREATE TRIGGER relay_audit_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON relay_audit FOR EACH STATEMENT EXECUTE FUNCTION relay_audit_immutable();
        END IF;
      END $$;
    `)
  } else {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; ${schema}
      CREATE TRIGGER IF NOT EXISTS relay_audit_no_update BEFORE UPDATE ON relay_audit BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;
      CREATE TRIGGER IF NOT EXISTS relay_audit_no_delete BEFORE DELETE ON relay_audit BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;
    `)
  }

  let queue = Promise.resolve()
  function serial(callback) {
    if (isPostgres) return callback(db)
    const result = queue.then(() => callback(db))
    queue = result.catch(() => {})
    return result
  }
  function transaction(callback) {
    return serial(async () => {
      const client = isPostgres ? await db.connect() : db
      const exec = (sql) => isPostgres ? client.query(sql) : client.exec(sql)
      try {
        await exec(isPostgres ? 'BEGIN' : 'BEGIN IMMEDIATE')
        const result = await callback(client)
        await exec('COMMIT')
        return result
      } catch (error) {
        await exec('ROLLBACK')
        throw error
      } finally { if (isPostgres) client.release() }
    })
  }
  const encode = (value, context) => crypto.seal(Buffer.from(JSON.stringify(value)), context).toString('base64')
  const decode = (value, context) => JSON.parse(crypto.open(Buffer.from(value, 'base64'), context).toString('utf8'))
  const context = (tenant, kind, key) => `${tenant}/${kind}/${key}`
  const materialize = (row) => row && ({ ...decode(row.payload, context(row.tenant, row.kind, row.key)), version: row.version })
  const emailDigest = (email) => createHmac('sha256', key).update(`login:${demo ? 'demo' : 'formal'}:${email}`).digest('hex')

  async function indexEmails(client, tenant, previous, next) {
    const before = new Set(previous.employees.map(({ email }) => email))
    const after = new Set(next.employees.map(({ email }) => email))
    requireThat(after.size === next.employees.length, '此邮箱已登记。', 409)
    for (const email of before) if (!after.has(email)) {
      await query(client, 'DELETE FROM relay_login_emails WHERE digest=? AND tenant=?', [emailDigest(email), tenant], 'run')
    }
    for (const email of after) if (!before.has(email)) {
      const added = await query(client, 'INSERT INTO relay_login_emails (digest, tenant) VALUES (?,?) ON CONFLICT DO NOTHING', [emailDigest(email), tenant], 'run')
      requireThat(added.changes ?? added, '此邮箱已登记。', 409)
    }
  }

  async function auditEvent(client, event) {
    const eventId = id()
    await query(client, 'INSERT INTO relay_audit (id, tenant, subject, actor, action, at, version, detail) VALUES (?,?,?,?,?,?,?,?)', [
      eventId, event.tenant, event.subject, event.actor, event.action, event.at ?? now(), event.version ?? null,
      encode({ network: event.ip ? event.ip.replace(/(?:\d+)$|(?::[^:]*)$/, '*') : '', ...event.detail }, `audit/${event.tenant}/${eventId}`),
    ], 'run')
  }

  async function change(event, callback) {
    const { tenant, kind = 'position', subject } = event
    return transaction(async (client) => {
      if (kind === 'organization') {
        const empty = encode({ employees: [], departments: [] }, context(tenant, kind, subject))
        await query(client, 'INSERT INTO relay_records (tenant, kind, key, version, payload) VALUES (?,?,?,0,?) ON CONFLICT DO NOTHING', [tenant, kind, subject, empty], 'run')
      }
      const row = await query(client, `SELECT * FROM relay_records WHERE tenant=? AND kind=? AND key=?${isPostgres ? ' FOR UPDATE' : ''}`, [tenant, kind, subject], 'get')
      const previous = materialize(row)
      const previousStage = previous?.stage
      const next = await callback(previous)
      if (next === undefined) return previous
      if (kind === 'organization') await indexEmails(client, tenant, previous, next)
      if (next === null) {
        await query(client, 'DELETE FROM relay_records WHERE tenant=? AND kind=? AND key=?', [tenant, kind, subject], 'run')
      } else {
        const version = (row?.version ?? 0) + 1
        const payload = encode(next, context(tenant, kind, subject))
        if (row) await query(client, 'UPDATE relay_records SET version=?, payload=? WHERE tenant=? AND kind=? AND key=?', [version, payload, tenant, kind, subject], 'run')
        else await query(client, 'INSERT INTO relay_records (version, payload, tenant, kind, key) VALUES (?,?,?,?,?)', [version, payload, tenant, kind, subject], 'run')
        next.version = version
      }
      if (event.action) await auditEvent(client, { ...event, version: next?.version ?? row?.version })
      if (next?.stage === 'archived' && (previous && previousStage !== 'archived' || !previous && event.action === '签署确认书')) await auditEvent(client, { ...event, action: '归档', version: next.version })
      return next
    })
  }

  let objectClient
  if (s3?.bucket) {
    const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({ region: s3.region, endpoint: s3.endpoint, forcePathStyle: Boolean(s3.endpoint), maxAttempts: 2 })
    objectClient = {
      async put(key, body) { await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: body, ContentType: 'application/octet-stream' }), { abortSignal: AbortSignal.timeout(10000) }) },
      async get(key) { return Buffer.from(await (await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) })).Body.transformToByteArray()) },
      async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) }) },
      close() { client.destroy() },
    }
  }
  const objectRoot = resolve(directory, 'objects')
  function objectKey(tenant, object) {
    requireThat(/^[a-z0-9-]{1,64}$/.test(tenant) && /^[a-f0-9-]{36}$/.test(object), '附件编号无效。', 404)
    return `${tenant}/${object}.bin`
  }
  return {
    key,
    change,
    async tenantForEmail(email) {
      const row = await serial((client) => query(client, 'SELECT tenant FROM relay_login_emails WHERE digest=?', [emailDigest(email)], 'get'))
      return row?.tenant
    },
    async ping() { await serial((client) => query(client, 'SELECT 1 AS ready', [], 'get')) },
    async get(tenant, kind, key) { return serial(async (client) => materialize(await query(client, 'SELECT * FROM relay_records WHERE tenant=? AND kind=? AND key=?', [tenant, kind, key], 'get'))) },
    async list(tenant, kind) { return serial(async (client) => (await query(client, 'SELECT * FROM relay_records WHERE tenant=? AND kind=?', [tenant, kind])).map(materialize)) },
    async scan(kind) { return serial(async (client) => (await query(client, 'SELECT * FROM relay_records WHERE kind=?', [kind])).map((row) => ({ tenant: row.tenant, key: row.key, record: materialize(row) }))) },
    async event(event) { return serial((client) => auditEvent(client, event)) },
    async audit(tenant, subject, { until = now(), limit = 500, offset = 0 } = {}) {
      return serial(async (client) => (await query(client,
        `SELECT * FROM relay_audit WHERE tenant=? AND at<=?${subject ? ' AND subject=?' : ''} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
        subject ? [tenant, until, subject, limit, offset] : [tenant, until, limit, offset],
      )).map((entry) => ({ ...entry, detail: decode(entry.detail, `audit/${tenant}/${entry.id}`) })))
    },
    async traces(tenant, since, actions) {
      return serial(async (client) => (await query(client,
        'SELECT id, subject, detail FROM relay_audit WHERE tenant=? AND at>=? AND action IN (' + actions.map(() => '?').join(',') + ')',
        [tenant, since, ...actions],
      )).map((entry) => ({ subject: entry.subject, detail: decode(entry.detail, `audit/${tenant}/${entry.id}`) })))
    },
    async putObject(tenant, objectId, bytes) {
      const object = objectKey(tenant, objectId)
      const encrypted = crypto.seal(bytes, object)
      if (objectClient) await objectClient.put(`relay/${object}`, encrypted)
      else {
        await mkdir(join(objectRoot, tenant), { recursive: true, mode: 0o700 })
        await writeFile(join(objectRoot, object), encrypted, { flag: 'wx', mode: 0o600 })
      }
    },
    async getObject(tenant, objectId) {
      const object = objectKey(tenant, objectId)
      return crypto.open(objectClient ? await objectClient.get(`relay/${object}`) : await readFile(join(objectRoot, object)), object)
    },
    async removeObject(tenant, objectId) {
      const object = objectKey(tenant, objectId)
      if (objectClient) await objectClient.remove(`relay/${object}`)
      else await rm(join(objectRoot, object), { force: true })
    },
    async checkpoint() { if (!isPostgres) await serial(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)')) },
    async close() {
      objectClient?.close()
      await queue
      if (isPostgres) await db.end()
      else db.close()
    },
  }
}
