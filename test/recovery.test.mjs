import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createApp } from '../server/app.mjs'
import { id, makeQuestions, newPosition, now } from '../server/domain.mjs'

test('恢复备份后读取加密附件，接续持久化评分并保持审计不可修改', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-'))
  const source = join(root, 'source')
  const restored = join(root, 'restored')
  const options = { demo: true, seed: false, databaseUrl: '', s3: {} }
  const before = await createApp({ ...options, directory: source, interval: 60_000 })
  const actorId = 'successor'
  const assetsProof = { locator: '备份恢复样本 · 第 1 节' }
  const marker = Buffer.from('本地恢复演练附件内容')
  const position = newPosition({ title: '备份恢复用例', department: '验证', due: '2027-01-01' }, { successor: { id: actorId }, owner: { id: 'owner' } })
  const object = id()
  position.assets = position.assets.map((asset) => ({ ...asset, confirmed: true, sources: [assetsProof], detail: { location: '应用工作台', contact: '审批值班组' }, updatedAt: now() }))
  const questions = makeQuestions(position.assets, '恢复测试')
  position.attempts = [{ id: id(), phase: 'scoring', questions, answers: Object.fromEntries(questions.map((question) => [question.id, { text: '应用工作台，审批值班组' }])) }]
  position.attachments = [{ id: object, kind: 'answer', owner: actorId, bytes: marker.length }]
  let after
  try {
    await before.store.change({ tenant: 'demo', subject: position.id, action: '保存测试评分', actor: actorId }, () => position)
    await before.store.putObject('demo', object, marker)
    const ciphertext = await readFile(join(source, 'objects', 'demo', `${object}.bin`))
    assert.equal(ciphertext.includes(marker), false)
    const backup = spawnSync(process.execPath, ['scripts/backup.mjs', restored], { encoding: 'utf8', env: { ...process.env, RELAY_DATA: source, DATABASE_URL: '', RELAY_KEY: '' }, windowsHide: true })
    assert.equal(backup.status, 0, backup.stderr)
    await before.close()
    after = await createApp({ ...options, directory: restored, interval: 70 })
    assert.deepEqual(await after.store.getObject('demo', object), marker)
    let scored
    for (let retry = 0; retry < 30; retry += 1) {
      scored = (await after.store.get('demo', 'position', position.id)).attempts.at(-1)
      if (scored.phase === 'review') break
      await delay(60)
    }
    assert.equal(scored.phase, 'review')
    assert.equal(scored.results.length, 15)
    assert.ok((await after.store.audit('demo', position.id)).some((event) => event.action === '自动评分'))
    const db = new DatabaseSync(join(restored, 'relay.sqlite'))
    try {
      assert.throws(() => db.exec("UPDATE relay_audit SET action='替换'"), /immutable audit/)
      assert.throws(() => db.exec('DELETE FROM relay_audit'), /immutable audit/)
    } finally { db.close() }
  } finally {
    if (after) await after.close()
    else await before.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
