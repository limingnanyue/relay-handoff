import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../server/app.mjs'
import { hashPassword } from '../server/security.mjs'

test('正式组织目录维护、账号开通、停用和跨租户隔离', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-org-'))
  const origin = 'https://relay.example.test'
  const suffix = randomUUID().slice(0, 8)
  const north = `north-${suffix}`
  const south = `south-${suffix}`
  const initialPassword = 'Relay-Initial-2026'
  const temporaryPassword = 'Relay-Temporary-2026'
  const chosenPassword = 'Relay-Personal-2026'
  const passwordHash = await hashPassword(initialPassword)
  const users = [[north, 'hr', 'hr'], [north, 'owner', 'owner'], [north, 'leaver', 'leaver'], [south, 'hr', 'hr']].map(([tenant, identifier, role]) => ({
    tenant, id: identifier, role, name: `${tenant} ${identifier}`, email: `${identifier}@${tenant}.example`, passwordHash,
  }))
  const options = { directory, origin, demo: false, key: '69'.repeat(32), users, databaseUrl: process.env.RELAY_TEST_DATABASE_URL ?? '', s3: {} }
  let service, listener, base
  async function start() {
    service = await createApp(options)
    listener = service.app.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    base = `http://127.0.0.1:${listener.address().port}/api`
  }
  async function stop() {
    if (listener) await new Promise((resolve) => listener.close(resolve))
    listener = null
    await service?.close()
    service = null
  }
  context.after(async () => {
    await stop()
    await rm(directory, { recursive: true, force: true })
  })
  async function request(path, cookie, input, expected = 200) {
    const writing = input !== undefined
    const response = await fetch(`${base}${path}`, { method: writing ? 'POST' : 'GET',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(writing ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
      body: writing ? JSON.stringify(input) : undefined,
    })
    const data = await response.json()
    if (expected) assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`)
    return { data, status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = (email, password = initialPassword, status = 200) => request('/session/login', '', { email, password }, status)

  await start()
  const { cookie: hr } = await login(`hr@${north}.example`)
  const { cookie: external } = await login(`hr@${south}.example`)
  const { cookie: owner } = await login(`owner@${north}.example`)
  await request('/organization', '', undefined, 401)
  await request('/organization', owner, undefined, 403)
  await request('/organization/departments', owner, { name: '运营中心' }, 403)
  const { data: root } = await request('/organization/departments', hr, { name: '运营中心' }, 201)
  const { data: child } = await request('/organization/departments', hr, { name: '区域运营', parentId: root.id }, 201)
  await request('/organization/departments', hr, { id: root.id, name: root.name, parentId: child.id }, 422)
  await request('/organization/departments', hr, { name: child.name, parentId: root.id }, 409)
  await request('/organization/departments', external, { id: root.id, name: '跨租户修改' }, 404)
  await request('/organization/departments', external, { name: '跨租户添加', parentId: root.id }, 422)
  await request(`/organization/departments/${root.id}/remove`, hr, {}, 409)
  assert.deepEqual((await request('/organization', external)).data.departments, [])

  const employee = { name: '周晓', title: '销售运营', role: 'successor', departmentId: child.id, email: `zhou@${north}.example`, enabled: true }
  const { data: created } = await request('/organization/employees', hr, employee, 201)
  assert.equal(created.status, 'pending')
  await login(employee.email, temporaryPassword, 401)
  await request('/organization/employees', external, { ...employee, id: created.id, departmentId: '' }, 404)
  await request(`/organization/departments/${child.id}/remove`, hr, {}, 409)
  await request('/organization/employees', hr, { ...employee, id: 'hr', role: 'owner' }, 409)

  const raceEmail = `duplicate@${suffix}.example`
  const claims = await Promise.all([hr, external].map((cookie) => request('/organization/employees', cookie,
    { ...employee, departmentId: '', email: raceEmail }, null)))
  assert.deepEqual(claims.map(({ status }) => status).sort(), [201, 409])
  const profile = { ...employee, id: created.id }
  const { data: opened } = await request('/organization/employees', hr, { ...profile, password: temporaryPassword })
  assert.equal(opened.status, 'active')
  assert.equal(opened.passwordHash, undefined)
  const { data: first, cookie: temporary } = await login(employee.email.toUpperCase(), temporaryPassword)
  assert.equal(first.mustChangePassword, true)
  assert.equal(first.department, child.name)
  await request('/positions', temporary, undefined, 403)
  await request('/session/password', temporary, { currentPassword: 'incorrect', newPassword: chosenPassword }, 422)
  const { data: updated, cookie: personal } = await request('/session/password', temporary, { currentPassword: temporaryPassword, newPassword: chosenPassword })
  assert.equal(updated.mustChangePassword, false)
  await request('/positions', temporary, undefined, 401)
  await request('/positions', personal)
  await login(employee.email, temporaryPassword, 401)

  const { data: directoryView } = await request('/directory?departments=1', owner)
  assert.equal(directoryView.departments.length, 2)
  assert.equal(directoryView.people.find(({ id }) => id === created.id).email, undefined)
  const positionInput = { title: '新增员工交接', departmentId: child.id, due: '2027-06-01', owner: 'owner', leaver: 'leaver', successor: created.id }
  const { data: position } = await request('/positions', owner, positionInput, 201)
  assert.equal(position.department, child.name)
  assert.equal(position.departmentId, child.id)
  await request(`/positions/${position.id}`, personal)

  await request('/organization/employees', hr, { ...profile, enabled: false })
  await request('/positions', personal, undefined, 401)
  await login(employee.email, chosenPassword, 401)
  await request('/positions', owner, positionInput, 422)
  await request('/organization/employees', hr, profile)
  await request('/positions', personal, undefined, 401)
  const { cookie: restored } = await login(employee.email, chosenPassword)
  await request('/organization/employees', hr, { ...profile, password: temporaryPassword })
  await request('/positions', restored, undefined, 401)
  await request('/organization/departments', hr, { ...child, name: '华北运营' })
  await stop()
  await start()
  const { data: reopened } = await request('/organization', hr)
  assert.ok(reopened.employees.some(({ id }) => id === created.id))
  assert.ok(reopened.departments.some(({ name }) => name === '华北运营'))
  assert.equal((await request(`/positions/${position.id}`, owner)).data.department, child.name)
  assert.equal((await login(employee.email, temporaryPassword)).data.mustChangePassword, true)
  const { data: audit } = await request('/audit', hr)
  assert.ok(audit.some(({ action }) => action === '更新员工'))
  assert.doesNotMatch(JSON.stringify(audit), /Relay-(Temporary|Personal)-2026|passwordHash/)
})
