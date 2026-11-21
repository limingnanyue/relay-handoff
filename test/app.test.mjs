import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { once } from 'node:events'
import sharp from 'sharp'
import { createApp } from '../server/app.mjs'
import { hashPassword } from '../server/security.mjs'

let service, server, origin, directory
const cookies = {}
const signature = (await sharp({ create: { width: 96, height: 48, channels: 3, background: '#142c58' } }).png().toBuffer()).toString('base64')
const actors = { owner: 'owner', leaver: 'leaver', successor: 'successor' }

async function api(role, path, input, expected = 200) {
  const response = await fetch(`${origin}/api${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(cookies[role] ? { Cookie: cookies[role] } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  const result = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result).slice(0, 600)}`)
  return { result, response }
}

async function login(role) {
  const { response } = await api(null, '/session/demo', { role })
  cookies[role] = response.headers.get('set-cookie').split(';')[0]
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'relay-test-'))
  service = await createApp({ directory, demo: true, seed: false, databaseUrl: process.env.RELAY_TEST_DATABASE_URL })
  server = service.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
  await Promise.all(['owner', 'leaver', 'successor', 'hr', 'auditor'].map(login))
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  await service?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('按真实会话完成失败首考、一次补考、审批导出与签署归档', async () => {
  await api(null, '/positions', undefined, 401)
  await api('auditor', '/positions', { title: '越权请求' }, 403)
  const { result: position } = await api('owner', '/positions', { title: '验收测试岗位', department: '销售部', due: '2027-06-01', backups: 2, ...actors }, 201)
  const route = `/positions/${position.id}`
  const action = async (role, name, input = {}, expected = 200) => (await api(role, `${route}/${name}`, input, expected)).result
  await action('successor', 'asset', { title: '越权请求' }, 403)
  await action('leaver', 'startRound', {}, 409)
  for (const role of ['owner', 'leaver', 'successor']) await action(role, 'consent', { privacy: true, restricted: true })
  await action('owner', 'material', { name: '销售运营交接说明', text: '续费折扣审批：由收入审批组核对运营手册。' })
  const publicSession = (await api('owner', '/session')).result
  assert.equal(publicSession.user.token, undefined)
  const visible = (await api('owner', route)).result.assets
  const first = visible[0]
  await action('owner', 'asset', { ...first, level: 'S3', location: '私钥=ExamplePrivateKey', detail: undefined }, 422)
  await action('owner', 'asset', { title: '第 11 个关键项', category: first.category, critical: true }, 422)
  const base = visible.slice(0, 30).filter((asset) => asset.critical || asset.level === 'S1')
  const selected = [...new Map([...base, ...visible.filter((asset) => asset.critical)].map((asset) => [asset.id, asset])).values()]
  for (const asset of selected) {
    await action('owner', 'asset', {
      ...asset, assetId: asset.id, when: '每月第一个工作日', location: '运营手册的审批路径', contact: '收入审批组',
      exception: '超出常规权限转风险委员会', locator: '运营手册第 3 节', confirmed: true,
    })
  }
  const auditView = (await api('auditor', route)).result
  assert.equal(auditView.assets.find((asset) => asset.level === 'S2').detail.contact, undefined)
  await action('owner', 'inventory')
  for (let round = 0; round < 3; round += 1) {
    await action('leaver', 'startRound')
    for (let reply = 0; reply < 8; reply += 1) {
      await action('leaver', 'respond', { answer: `演练流程第 ${round * 8 + reply + 1} 项请核对，出现异常联系收入审批组。`, locator: `流程复核记录 ${round + 1}.${reply + 1}` })
    }
  }
  const draft = (await api('owner', route)).result
  assert.ok(draft.packPreview.some((entry) => entry.title === '续费折扣审批'))
  assert.equal((await api('successor', route)).result.packPreview.length, 0)
  await action('owner', 'publishPack')
  const evidence = (await api('successor', `${route}/pack?q=${encodeURIComponent('续费折扣')}`)).result
  assert.equal(evidence[0].detail.contact, '收入审批组')
  let failedAssetId
  async function runAttempt({ fail }) {
    const current = await action('successor', 'startExam')
    const attempt = current.attempts.at(-1)
    assert.equal(attempt.questions[0].terms, undefined)
    assert.equal(attempt.questions[0].sources, undefined)
    await api('successor', `${route}/pack`, undefined, 409)
    if (!fail) assert.equal(current.reports[0].findings.length, 0)
    const answer = '每月第一个工作日，运营手册的审批路径，收入审批组，超出常规权限转风险委员会。'
    const target = attempt.questions.find((question) => question.critical)
    if (fail) failedAssetId = target.assetId
    for (const openBook of [false, true]) {
      if (openBook) {
        await action('successor', 'unlockExam')
        await api('successor', `${route}/pack`)
      }
      for (const question of attempt.questions.filter((item) => item.openBook === openBook)) {
        await action('successor', 'answer', { questionId: question.id, text: fail && question.id === target.id ? '请交给未知负责人' : answer })
      }
    }
    const submitted = await action('successor', 'submitExam')
    assert.equal(submitted.attempts.at(-1).phase, 'scoring')
    assert.ok(submitted.scoring.expectedSeconds >= 1)
    let forReview
    for (let retry = 0; retry < 30; retry += 1) {
      forReview = (await api('owner', route)).result.attempts.at(-1)
      if (forReview.phase === 'review') break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.equal(forReview.phase, 'review')
    await action('owner', 'finalizeExam', {}, 409)
    assert.equal(forReview.results.filter((result) => result.sampled).length, 3)
    for (const result of forReview.results.filter((item) => item.needsReview)) {
      await action('owner', 'review', { questionId: result.id, score: fail && result.id === target.id ? 20 : 100, reason: '已核对运营手册审批路径。' })
    }
    return (await action('owner', 'finalizeExam')).reports.at(-1)
  }
  const firstReport = await runAttempt({ fail: true })
  assert.equal(firstReport.status, 'red')
  assert.ok(firstReport.score >= 80)
  assert.ok(firstReport.dependencies.some((item) => item.label === '收入审批组'))
  await action('successor', 'startExam', {}, 409)
  await action('owner', 'sign', { signature, acknowledge: true }, 409)
  await action('owner', 'remediate', { assetId: failedAssetId, note: '已现场演示正确审批路径并复核。', locator: '补交接记录第 1 节' })
  const finalReport = await runAttempt({ fail: false })
  assert.equal(finalReport.status, 'green')
  assert.equal(finalReport.passed, true)
  await action('successor', 'startExam', {}, 409)

  const request = await action('owner', 'requestExport', { scope: 'report', format: 'pdf', redacted: true })
  const exportId = request.exports.at(-1).id
  await api('owner', `${route}/exports/${exportId}`, undefined, 403)
  await action('owner', 'decideExport', { exportId, approve: true }, 403)
  await action('hr', 'decideExport', { exportId, approve: true })
  await api('auditor', `${route}/exports/${exportId}`, undefined, 403)
  const { result: bytes, response } = await api('owner', `${route}/exports/${exportId}`)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF')

  for (const role of ['leaver', 'successor', 'owner']) await action(role, 'sign', { signature, acknowledge: true })
  const archived = (await api('auditor', route)).result
  assert.equal(archived.stage, 'archived')
  assert.equal(archived.signatures.length, 3)
  assert.ok(archived.signatures.every((record) => !record.attachmentId))
  await action('owner', 'asset', { assetId: first.id }, 409)
  const { result: events } = await api('auditor', '/audit')
  assert.ok(events.some((event) => event.action === '归档'))
  assert.ok(events.some((event) => event.action === '下载导出'))
  const monitor = (await api('hr', '/settings')).result.monitor
  assert.equal(monitor.product.qualifiedThisMonth, 1)
  assert.equal(monitor.quality.firstPassRate, 0)
  assert.equal(monitor.stages.find((stage) => stage.key === 'parse').samples, 1)
  assert.equal(monitor.stages.find((stage) => stage.key === 'extract').samples, 1)
  assert.equal(monitor.stages.find((stage) => stage.key === 'interview').samples, 24)
  assert.equal(monitor.stages.find((stage) => stage.key === 'questions').samples, 2)
  assert.equal(monitor.stages.find((stage) => stage.key === 'grade').samples, 2)
  assert.equal(monitor.stages.find((stage) => stage.key === 'report').samples, 2)
  assert.ok(monitor.stages.filter((stage) => stage.samples > 0).every((stage) => Number.isFinite(stage.p95Ms)))
  await service.store.event({ tenant: 'demo', subject: position.id, actor: 'system', action: '处理异常', detail: { fault: 'grade' } })
  assert.ok((await api('hr', '/settings')).result.monitor.alerts.some((alert) => alert.key === 'failure'))
  assert.deepEqual(monitor.alerts.filter((item) => item.key !== 'latency'), [])
  assert.equal((await api('successor', '/settings')).result.monitor, undefined)
  const anchor = encodeURIComponent(new Date(Date.now() - 1).toISOString())
  const pageOne = (await api('auditor', `/audit?limit=1&until=${anchor}`)).result
  const pageTwo = (await api('auditor', `/audit?offset=1&limit=1&until=${anchor}`)).result
  assert.equal(pageOne.length, 1)
  assert.equal(pageTwo.length, 1)
  assert.notEqual(pageOne[0].id, pageTwo[0].id)
  if (!process.env.RELAY_TEST_DATABASE_URL) {
    const database = await readFile(join(directory, 'relay.sqlite-wal'))
    assert.equal(database.includes(Buffer.from('请交给未知负责人')), false)
  }
  assert.equal((await action('owner', 'requestDeletion', { reason: '按测试要求清除岗位资料。' })).deletion.requester, 'owner')
  const signedAttachments = (await api('owner', route)).result.signatures.map((signature) => signature.attachmentId)
  assert.equal(signedAttachments.length, 3)
  for (const attachmentId of signedAttachments) assert.ok((await service.store.getObject('demo', attachmentId)).length > 0)
  await action('owner', 'approveDeletion', { acknowledge: true }, 403)
  await action('hr', 'approveDeletion', { acknowledge: true })
  await api('owner', route, undefined, 404)
  for (let retry = 0; retry < 25 && await service.store.get('demo', 'position', position.id); retry += 1) await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(await service.store.get('demo', 'position', position.id), undefined)
  for (const attachmentId of signedAttachments) await assert.rejects(service.store.getObject('demo', attachmentId), { code: 'ENOENT' })
  assert.ok((await service.store.audit('demo', position.id)).some((entry) => entry.action === '物理删除'))
})

test('正式登录校验、退出撤销、跨租户隔离和同租户岗位授权', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'relay-identity-'))
  const password = 'RelayTests-Account-2026'
  const passwordHash = await hashPassword(password)
  const externalOrigin = 'https://relay.example.test'
  const users = [
    ['north', 'manager', 'owner'], ['north', 'peer', 'owner'], ['north', 'leave', 'leaver'], ['north', 'take', 'successor'], ['south', 'manager', 'owner'],
  ].map(([tenant, identifier, role]) => ({ id: identifier, tenant, role, name: `${tenant} ${identifier}`, email: `${identifier}@${tenant}.example`, passwordHash }))
  const formal = await createApp({ directory: localDir, demo: false, origin: externalOrigin, key: '13'.repeat(32), users })
  const listener = formal.app.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = `http://127.0.0.1:${listener.address().port}/api`
  async function formalRequest(path, input, cookie, origin = externalOrigin) {
    return fetch(`${address}${path}`, { method: input ? 'POST' : 'GET', headers: { ...(input ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: input && JSON.stringify(input) })
  }
  try {
    assert.equal((await formalRequest('/session/demo', { role: 'owner' })).status, 404)
    assert.equal((await formalRequest('/session/login', { email: 'manager@north.example', password: 'incorrect' })).status, 401)
    assert.equal((await formalRequest('/session/login', { email: 'manager@north.example', password }, '', 'https://other.example')).status, 403)
    const signIn = async (email) => {
      const response = await formalRequest('/session/login', { email, password })
      assert.equal(response.status, 200)
      const attributes = response.headers.get('set-cookie')
      assert.match(attributes, /HttpOnly.*Secure.*SameSite=Strict/)
      return attributes.split(';')[0]
    }
    const north = await signIn('manager@north.example')
    const peer = await signIn('peer@north.example')
    const south = await signIn('manager@south.example')
    const created = await formalRequest('/positions', { title: '仅北区可访', department: '销售', due: '2027-06-02', owner: 'manager', leaver: 'leave', successor: 'take' }, north)
    assert.equal(created.status, 201)
    const position = await created.json()
    for (const cookie of [south, peer]) {
      assert.equal((await formalRequest(`/positions/${position.id}`, undefined, cookie)).status, 404)
      assert.equal((await (await formalRequest('/positions', undefined, cookie)).json()).positions.length, 0)
    }
    assert.equal((await formalRequest('/session/logout', {}, north)).status, 200)
    assert.equal((await formalRequest('/positions', undefined, north)).status, 401)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await formal.close()
    await rm(localDir, { recursive: true, force: true })
  }
})
