import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../server/app.mjs'
import { localDay, newPosition, now } from '../server/domain.mjs'
import { DEMO_USERS } from '../server/security.mjs'

const concurrency = 20
const requestedSeconds = Number(process.env.RELAY_SMOKE_SECONDS ?? 0)
assert.ok(Number.isFinite(requestedSeconds) && requestedSeconds >= 0)
const directory = await mkdtemp(join(tmpdir(), 'relay-smoke-'))
const relay = await createApp({ directory, demo: true, seed: false, interval: 150, databaseUrl: process.env.RELAY_TEST_DATABASE_URL ?? '', s3: {} })
const server = relay.app.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const actors = Object.fromEntries(DEMO_USERS.slice(0, 3).map(({ id, name, role }) => [role, { id, name }]))
const cookies = new Map()
const times = { parse: [], interview: [], questions: [], grade: [], report: [], pipeline: [] }
let retries = 0, failed = 0, total = 0

async function http(role, path, input, retriesLeft = 35) {
  const response = await fetch(`${origin}/api${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { ...(input === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), Cookie: cookies.get(role) ?? '' },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(60_000),
  })
  if (path === '/session/demo') cookies.set(role, response.headers.get('set-cookie').split(';')[0])
  const result = await response.json()
  if (response.status === 429 && retriesLeft) {
    retries += 1
    await delay(60 + Math.random() * 110)
    return http(role, path, input, retriesLeft - 1)
  }
  assert.ok(response.ok, `${path} ${response.status} ${result.error}`)
  return result
}

async function timed(stage, action) {
  const started = performance.now()
  const result = await action()
  times[stage].push(performance.now() - started)
  return result
}

async function pipeline(index) {
  const started = performance.now()
  const position = newPosition({ title: `并发合成样本 ${index}`, department: '验收', due: localDay(), backups: 2 }, actors)
  const timestamp = now()
  const detail = { when: '月结第一个工作日', location: '手册审批路径', contact: '运营值班组', exception: '超权限转负责人复核' }
  position.assets = position.assets.map((asset) => ({ ...asset, detail, confirmed: true, sources: [{ locator: '合成记录第 1 节' }], updatedAt: timestamp }))
  position.consents = Object.fromEntries(Object.values(actors).map((actor) => [actor.id, { privacy: true, restricted: true }]))
  await relay.store.change({ tenant: 'demo', subject: position.id }, () => position)
  const path = `/positions/${position.id}`
  const command = (role, action, data = {}) => http(role, `${path}/${action}`, data)
  await timed('parse', () => command('owner', 'material', { name: '合成条目说明', text: '续费折扣审批：联系运营值班组' }))
  await command('owner', 'inventory')
  await timed('interview', async () => {
    for (let round = 0; round < 3; round += 1) {
      await command('leaver', 'startRound')
      for (let entry = 0; entry < 8; entry += 1) await command('leaver', 'respond', { answer: '核对手册后按处置流程联系运营值班组', locator: `合成访谈 · ${round}.${entry}` })
    }
  })
  await command('owner', 'publishPack')
  const exam = await timed('questions', async () => (await command('successor', 'startExam')).attempts.at(-1))
  for (const openBook of [false, true]) {
    if (openBook) await command('successor', 'unlockExam')
    for (const question of exam.questions.filter((item) => item.openBook === openBook)) await command('successor', 'answer', { questionId: question.id, text: Object.values(detail).join('，') })
  }
  const assessed = await timed('grade', async () => {
    await command('successor', 'submitExam')
    for (let retry = 0; retry < 60; retry += 1) {
      const attempt = (await http('owner', path)).attempts.at(-1)
      if (attempt.phase === 'review') return attempt
      await delay(80)
    }
    throw new Error('评分等待超时。')
  })
  for (const result of assessed.results.filter((item) => item.needsReview)) await command('owner', 'review', { questionId: result.id, score: 100, reason: '人工抽检合成来源与答案一致。' })
  const report = (await timed('report', () => command('owner', 'finalizeExam'))).reports.at(-1)
  assert.equal(report.passed, true)
  times.pipeline.push(performance.now() - started)
  await relay.store.change({ tenant: 'demo', subject: position.id }, () => null)
}

try {
  await Promise.all(Object.keys(actors).map((role) => http(role, '/session/demo', { role })))
  const deadline = Date.now() + requestedSeconds * 1000
  do {
    const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, offset) => pipeline(total + offset + 1)))
    total += concurrency
    for (const result of results) if (result.status === 'rejected') { failed += 1; console.error(result.reason.message) }
    if (requestedSeconds && Date.now() < deadline) await delay(300)
  } while (Date.now() < deadline)
  const p95 = (values) => values.length ? Math.round([...values].sort((left, right) => left - right)[Math.ceil(values.length * .95) - 1]) : null
  console.log(JSON.stringify({ mode: '合成材料与规则评分', concurrency, requestedSeconds, total, failed, retries, p95Ms: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, p95(values)])) }, null, 2))
  assert.equal(failed, 0)
} finally {
  await new Promise((resolve) => server.close(resolve))
  await relay.close()
  await rm(directory, { recursive: true, force: true })
}
