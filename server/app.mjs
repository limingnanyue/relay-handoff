import express from 'express'
import { resolve } from 'node:path'
import { CATEGORIES, ROLES, TEMPLATE } from '../shared/catalog.mjs'
import { addMetrics, createAI, modelGrade, scrub } from './ai.mjs'
import { seedDemo } from './demo.mjs'
import { addTime, gradeAttempt, id, newPosition, now, questionFor, requireThat, safeText } from './domain.mjs'
import { exportMark, markdown, pdf } from './exports.mjs'
import { collectSuggestions, parseMaterial } from './materials.mjs'
import { summarizeMonitoring } from './monitor.mjs'
import { createIdentity, hashPassword, mayApprove, mayRead, maySeeRestricted } from './security.mjs'
import { createStore } from './store.mjs'
import { closedBook, dashboardView, exportView, packEntries, positionView } from './views.mjs'
import { ACTIONS, applyAction, checkAction, prepareImage } from './workflow.mjs'

const EMPTY_WORKSPACE = { retentionMonths: 24, monthly: [] }
const staff = (actor) => ['owner', 'hr'].includes(actor.role)
const rolesForPosition = ['owner', 'leaver', 'successor']
const writable = (request) => request.body && typeof request.body === 'object' && !Array.isArray(request.body)
const tracesByAction = { material: 'parse', respond: 'interview', startExam: 'questions', finalizeExam: 'report' }
const traceActions = [...Object.keys(tracesByAction).map((action) => ACTIONS[action]), '自动评分', '处理异常']
const jobBatchSize = 5

export async function createApp(options = {}) {
  const demo = options.demo ?? process.env.RELAY_DEMO !== '0'
  const origin = options.origin ?? process.env.RELAY_ORIGIN
  const secure = origin?.startsWith('https://') ?? false
  if (!demo && !secure && process.env.RELAY_ALLOW_HTTP !== '1') throw new Error('正式模式需要 HTTPS 的 RELAY_ORIGIN。')
  const directory = resolve(options.directory ?? process.env.RELAY_DATA ?? '.relay')
  const ai = createAI(options.ai ?? {
    endpoint: process.env.RELAY_AI_ENDPOINT, token: process.env.RELAY_AI_API_KEY, model: process.env.RELAY_AI_MODEL,
    jsonObject: process.env.RELAY_AI_JSON_OBJECT === '1', inputRate: process.env.RELAY_AI_INPUT_RATE, outputRate: process.env.RELAY_AI_OUTPUT_RATE,
  })
  const store = await createStore({ directory, demo, databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL, key: options.key ?? process.env.RELAY_KEY,
    s3: options.s3 ?? { bucket: process.env.RELAY_S3_BUCKET, region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.RELAY_S3_ENDPOINT },
  })
  let identity
  try {
    identity = await createIdentity(store, { demo, origin, secure, users: options.users ?? process.env.RELAY_USERS })
    if (demo && options.seed !== false) await seedDemo(store)
  } catch (error) {
    await store.close()
    throw error
  }
  const { organization } = identity
  const app = express()
  app.disable('x-powered-by')
  if (process.env.RELAY_TRUST_PROXY === '1') app.set('trust proxy', 1)
  app.use((request, response, next) => {
    response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'${options.development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'${options.development ? ' ws: wss:' : ''}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
    })
    if (secure) response.set('Strict-Transport-Security', 'max-age=31536000')
    next()
  })
  const api = express.Router()
  app.use('/api', api)
  api.use((request, response, next) => {
    response.set('Cache-Control', 'no-store')
    identity.csrf(request)
    next()
  })
  const small = express.json({ limit: '96kb' })
  const imageBody = express.json({ limit: '3mb' })
  const materialBody = express.json({ limit: '28mb' })
  const uploads = new Set()
  const pendingJobs = new Map()
  const paidTenants = new Set((process.env.RELAY_PAID_TENANTS ?? '').split(',').map((tenant) => tenant.trim()))
  const schedule = (tenant, record) => {
    const key = `${tenant}/${record.id}`
    const priority = record.purgeAfter ? 2 : Number(paidTenants.has(tenant))
    const existing = pendingJobs.get(key)
    if (!existing || existing.priority !== priority) pendingJobs.set(key, { tenant, id: record.id, priority, retryAt: 0 })
  }
  const orderedJobs = () => [...pendingJobs].sort(([, left], [, right]) => right.priority - left.priority)
  const view = (position, actor) => {
    const result = positionView(position, actor)
    const attempt = position.attempts.at(-1)
    if (attempt?.phase === 'scoring' && ['owner', 'successor'].includes(actor.role)) {
      const running = attempt.leaseUntil > now()
      const index = orderedJobs().findIndex(([key]) => key === `${actor.tenant}/${position.id}`)
      const batches = running ? 1 : Math.floor(Math.max(0, index) / jobBatchSize) + 1
      result.scoring = { running, expectedSeconds: batches * (ai.enabled ? 90 : 2) }
    }
    return result
  }
  const workspaceFor = async (tenant) => await store.get(tenant, 'workspace', 'settings') ?? structuredClone(EMPTY_WORKSPACE)
  const accessible = async (actor) => (await store.list(actor.tenant, 'position')).filter((position) => mayRead(position, actor))
  const accessEvent = (request, action, subject, detail = {}) => ({ tenant: request.actor.tenant, actor: request.actor.id, action, subject, ip: request.ip, detail })
  const access = async (request, action, subject, detail) => store.event(accessEvent(request, action, subject, detail))
  const guarded = async (request, identifier = request.params.position) => {
    const position = await store.get(request.actor.tenant, 'position', identifier)
    requireThat(mayRead(position, request.actor), '岗位不存在或未向你开放。', 404)
    return position
  }

  api.get('/health', async (_, response) => {
    await store.ping()
    response.json({ status: 'ok' })
  })
  api.get('/session', async (request, response) => {
    const account = await identity.read(request)
    response.json({ user: account ? identity.view(account) : null, demo, ai: ai.enabled })
  })
  api.post('/session/login', small, async (request, response) => {
    requireThat(writable(request), '请输入邮箱和密码。')
    response.json(await identity.login(request, response))
  })
  api.post('/session/demo', small, async (request, response) => {
    requireThat(writable(request), '请选择演示角色。')
    response.json(await identity.demoLogin(request, response))
  })
  api.post('/session/logout', async (request, response) => {
    await identity.logout(request, response)
    response.json({ ok: true })
  })
  api.post('/session/password', small, async (request, response) => {
    requireThat(writable(request), '请填写当前密码和新密码。')
    response.json(await identity.changePassword(request, response))
  })
  api.use(async (request, _, next) => {
    request.actor = await identity.read(request)
    requireThat(request.actor, '请先登录接棒。', 401)
    requireThat(!request.actor.mustChangePassword, '请先修改临时密码。', 403)
    next()
  })
  api.get('/positions', async (request, response) => {
    const overview = dashboardView(await accessible(request.actor), request.actor)
    await access(request, '访问岗位总览', 'overview')
    response.json(overview)
  })
  api.post('/positions', small, async (request, response) => {
    const { actor, body } = request
    requireThat(staff(actor), '仅业务负责人和人力资源可建立岗位体检。', 403)
    requireThat(writable(request), '请填写岗位信息。')
    const { people, departments } = await organization.directory(actor.tenant)
    const departmentId = body.departmentId ?? ''
    const department = departments.find(({ id }) => id === departmentId)
    requireThat(departmentId === '' || department, '请选择本组织的部门。')
    const actors = Object.fromEntries(rolesForPosition.map((role) => {
      const user = people.find(({ id }) => id === body[role])
      requireThat(user?.role === role && (role !== 'owner' || actor.role === 'hr' || user.id === actor.id), '请选择本组织对应角色的人员。')
      return [role, { id: user.id, name: user.name }]
    }))
    const position = newPosition(department ? { ...body, department: department.name } : body, actors)
    if (department) position.departmentId = department.id
    const saved = await store.change(accessEvent(request, '新建岗位体检', position.id), () => position)
    response.status(201).json(positionView(saved, actor))
  })
  api.get('/positions/:position', async (request, response) => {
    const position = await guarded(request)
    await access(request, '访问岗位工作台', position.id)
    response.json(view(position, request.actor))
  })
  api.get('/positions/:position/pack', async (request, response) => {
    const { actor } = request
    const position = await guarded(request)
    requireThat(position.packPublishedAt && rolesForPosition.includes(actor.role) && !closedBook(position, actor), '交接包尚未发布或当前为闭卷阶段。', 409)
    requireThat(position.consents[actor.id]?.privacy, '请先阅读交接告知。', 403)
    const query = safeText(typeof request.query.q === 'string' ? request.query.q : '', 120).toLowerCase()
    const entries = packEntries(position).filter((asset) => (asset.level === 'S1' || maySeeRestricted(position, actor)) && (!query || [asset.title, asset.category, ...Object.values(asset.detail)].join(' ').toLowerCase().includes(query)))
    await access(request, '访问交接包', position.id)
    response.json(entries)
  })
  api.get('/positions/:position/attachments/:attachment', async (request, response) => {
    const position = await guarded(request)
    const { actor } = request
    const blob = position.attachments.find((item) => item.id === request.params.attachment)
    requireThat(blob && !closedBook(position, actor) && maySeeRestricted(position, actor) && (blob.kind === 'signature' || blob.owner === actor.id || actor.role === 'owner' && (blob.kind === 'interview' || ['review', 'final'].includes(position.attempts.find((attempt) => Object.values(attempt.answers).some((answer) => answer.attachmentId === blob.id))?.phase))), '附件不存在或没有权限。', 404)
    const bytes = await store.getObject(actor.tenant, blob.id)
    await access(request, '访问附件', position.id, { attachmentId: blob.id })
    response.type('png').send(bytes)
  })
  api.get('/positions/:position/exports/:exportId', async (request, response) => {
    const position = await guarded(request)
    const { actor } = request
    const entry = position.exports.find((item) => item.id === request.params.exportId)
    requireThat(entry && entry.state === 'approved' && entry.requestedBy === actor.id && (entry.redacted || maySeeRestricted(position, actor))
      && !(actor.role === 'successor' && ['closed', 'open'].includes(position.attempts.at(-1)?.phase)), '审批完成且权限有效后才能下载。', 403)
    await sendExport(entry, request, response, position.id)
  })
  api.post('/positions/:position/:action', async (request, response, next) => {
    const position = await guarded(request)
    const action = request.params.action
    requireThat(Object.hasOwn(ACTIONS, action), '找不到此岗位操作。', 404)
    checkAction(position, request.actor, action)
    const parse = action === 'material' ? materialBody : ['sign', 'respond', 'answer'].includes(action) ? imageBody : small
    parse(request, response, (error) => {
      if (error) next(error)
      else perform(request, response, position, action).catch(next)
    })
  })

  api.get('/templates', async (request, response) => {
    await access(request, '访问模板库', 'template')
    response.json(TEMPLATE)
  })
  api.get('/directory', async (request, response) => {
    requireThat(staff(request.actor), '当前角色无权访问人员目录。', 403)
    await access(request, '访问角色目录', 'directory')
    const directory = await organization.directory(request.actor.tenant)
    response.json(request.query.departments === '1' ? directory : directory.people)
  })
  api.use('/organization', (request, _, next) => {
    requireThat(request.actor.role === 'hr', '仅人力资源可维护组织和员工。', 403)
    next()
  })
  api.get('/organization', async (request, response) => {
    await access(request, '访问组织与员工', 'directory')
    response.json(await organization.view(request.actor.tenant))
  })
  api.post('/organization/departments', small, async (request, response) => {
    requireThat(writable(request), '请填写部门信息。')
    const department = await organization.saveDepartment(request.actor, request.body, request.ip)
    response.status(request.body.id === undefined ? 201 : 200).json(department)
  })
  api.post('/organization/departments/:department/remove', async (request, response) => {
    await organization.removeDepartment(request.actor, request.params.department, request.ip)
    response.json({ ok: true })
  })
  api.post('/organization/employees', small, async (request, response) => {
    requireThat(writable(request), '请填写员工信息。')
    const { password } = request.body
    const passwordHash = password === undefined || password === '' ? undefined : await hashPassword(password)
    const employee = await organization.saveEmployee(request.actor, request.body, passwordHash, request.ip)
    response.status(request.body.id === undefined ? 201 : 200).json(employee)
  })
  api.get('/audit', async (request, response) => {
    const subject = typeof request.query.position === 'string' ? request.query.position : ''
    if (subject) await guarded(request, subject)
    else requireThat(['auditor', 'hr'].includes(request.actor.role), '全局审计只向人力资源和审计员开放。', 403)
    const offset = Number(request.query.offset ?? 0)
    const limit = Number(request.query.limit ?? 500)
    const until = request.query.until === undefined ? now() : request.query.until
    requireThat(Number.isSafeInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 500
      && typeof until === 'string' && Number.isFinite(Date.parse(until)), '审计分页参数无效。')
    await access(request, '访问审计日志', subject || 'audit')
    const [entries, { employees }] = await Promise.all([store.audit(request.actor.tenant, subject, { offset, limit, until: new Date(until).toISOString() }), organization.get(request.actor.tenant)])
    const names = new Map(employees.map(({ id, name }) => [id, name]))
    response.json(entries.map((entry) => ({ ...entry, actorName: names.get(entry.actor) })))
  })
  api.get('/settings', async (request, response) => {
    const { actor } = request
    const [settings, positions] = await Promise.all([workspaceFor(actor.tenant), accessible(actor)])
    await access(request, '访问设置与审批', 'settings')
    const exports = positions.flatMap((position) => position.exports.filter((entry) => entry.requestedBy === actor.id || mayApprove(position, actor))
      .map((entry) => ({ ...exportView(entry), positionId: position.id, positionTitle: position.title, canApprove: mayApprove(position, actor) && entry.requestedBy !== actor.id })))
    let monitor
    if (actor.role === 'hr') {
      const checkedAt = now()
      const traces = await store.traces(actor.tenant, addTime(checkedAt, -86_400_000), traceActions)
      const backlog = [...pendingJobs.values()].filter((job) => job.tenant === actor.tenant).length
      monitor = summarizeMonitoring(positions, traces, backlog, checkedAt)
    }
    response.json({ retentionMonths: settings.retentionMonths, demo, ai: ai.enabled, exports,
      monitor,
      monthly: settings.monthly.filter((entry) => entry.requestedBy === actor.id || staff(actor)).map((entry) => ({ ...exportView(entry), positionTitle: '岗位风险月报', canApprove: staff(actor) && entry.requestedBy !== actor.id })),
      deletions: positions.filter((position) => position.deletion && (actor.role === 'hr' || position.deletion.requester === actor.id)).map((position) => ({ id: position.id, title: position.title, ...position.deletion })),
      metrics: actor.role === 'hr' ? positions.reduce((totals, position) => {
        for (const key of Object.keys(totals)) totals[key] += position.model[key] ?? 0
        return totals
      }, { tokens: 0, cost: 0, requests: 0, failures: 0, duration: 0 }) : undefined,
    })
  })
  api.post('/settings/retention', small, async (request, response) => {
    requireThat(request.actor.role === 'hr', '仅人力资源可设置留存期限。', 403)
    const months = request.body?.months
    requireThat(Number.isInteger(months) && months >= 1 && months <= 60, '留存须为 1–60 个月。')
    await store.change({ ...accessEvent(request, '设置留存期限', 'settings', { months }), kind: 'workspace' }, (settings) => ({ ...(settings ?? EMPTY_WORKSPACE), retentionMonths: months }))
    response.json({ retentionMonths: months })
  })
  api.post('/settings/monthly', small, async (request, response) => {
    const actor = request.actor
    requireThat(staff(actor), '仅业务负责人和人力资源可申请月报。', 403)
    const { totals } = dashboardView(await accessible(actor), actor)
    const identifier = id()
    const settings = await store.change({ ...accessEvent(request, '申请月报导出', 'settings', { exportId: identifier }), kind: 'workspace' }, (workspace) => {
      workspace ??= structuredClone(EMPTY_WORKSPACE)
      requireThat(workspace.monthly.length < 100 && !workspace.monthly.some((entry) => entry.requestedBy === actor.id && entry.state === 'pending'), '已有月报待审批或已达到导出上限。', 409)
      const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7)
      workspace.monthly.push({ id: identifier, scope: 'monthly', format: 'pdf', redacted: true, requestedBy: actor.id, requesterName: actor.name, requestedAt: now(), state: 'pending',
        snapshot: { version: (workspace.version ?? 0) + 1, title: `${month} · 岗位风险月报`, lines: [{ kind: 'heading', text: '本月岗位体检概况' },
          { text: `共 ${totals.positions} 个岗位，${totals.departments} 个部门。平均指数 ${totals.average ?? '暂无'}。` },
          { text: `红灯 ${totals.red}，黄灯 ${totals.amber}，绿灯 ${totals.green}，待评估 ${totals.pending}。30 天内待交接 ${totals.upcoming}。` }] },
      })
      return workspace
    })
    response.json(exportView(settings.monthly.at(-1)))
  })
  api.post('/settings/monthly/:exportId', small, async (request, response) => {
    requireThat(staff(request.actor), '当前角色无权审批。', 403)
    const { approve, reason } = request.body ?? {}
    requireThat(typeof approve === 'boolean', '请选择审批结果。')
    await store.change({ ...accessEvent(request, '处理月报审批', 'settings', { exportId: request.params.exportId }), kind: 'workspace' }, (settings) => {
      const entry = settings?.monthly.find((item) => item.id === request.params.exportId)
      requireThat(entry && entry.requestedBy !== request.actor.id, '申请人不能审批自己的导出。', 403)
      requireThat(entry.state === 'pending', '该申请已处理。', 409)
      Object.assign(entry, { state: approve ? 'approved' : 'denied', reason: safeText(reason, 300, !approve), decidedAt: now(), decidedBy: request.actor.id })
      return settings
    })
    response.json({ ok: true })
  })
  api.get('/settings/monthly/:exportId', async (request, response) => {
    const entry = (await workspaceFor(request.actor.tenant)).monthly.find((item) => item.id === request.params.exportId)
    requireThat(entry && entry.state === 'approved' && entry.requestedBy === request.actor.id, '审批完成且权限有效后才能下载。', 403)
    await sendExport(entry, request, response, 'settings')
  })

  async function perform(request, response, position, action) {
    requireThat(writable(request), '请提交有效的操作数据。')
    const { body, actor } = request
    const prepared = {}
    const started = Date.now()
    const traceKey = tracesByAction[action]
    const detail = traceKey ? { trace: {} } : {}
    const written = []
    const key = `${actor.tenant}/${position.id}`
    const bulk = action === 'material' || action === 'respond'
    if (bulk) {
      requireThat(!uploads.has(key) && uploads.size < 5, '处理队列繁忙，请等当前材料或回答完成后重试。', 429)
      uploads.add(key)
    }
    try {
      if (action === 'material') {
        requireThat(body.level !== 'S2' || maySeeRestricted(position, actor), '请先授权处理受限材料。', 403)
        const { material, blocks } = await parseMaterial(body)
        detail.trace[material.total > 50 && material.type === 'pdf' ? 'parseLong' : 'parse'] = material.duration
        detail.status = material.status
        const extractStarted = Date.now()
        Object.assign(prepared, { material, ...await collectSuggestions(position, material, blocks, ai, position.consents[actor.id]?.model) })
        detail.trace.extract = Date.now() - extractStarted
        detail.model = prepared.metric
        detail.degraded = prepared.degraded
      }
      const image = action === 'sign' ? body.signature : ['respond', 'answer'].includes(action) ? body.attachment : null
      if (image) {
        requireThat(maySeeRestricted(position, actor), '请先授权处理受限图片。', 403)
        requireThat(action === 'sign' || body.redacted === true, '请确认截图已移除高危内容。')
        prepared.image = await prepareImage(image)
      }
      if (action === 'respond') {
        const round = position.rounds.find((item) => !item.completedAt)
        prepared.index = round?.entries.length
        const pending = round && questionFor(round, position.assets)
        const asset = position.assets.find((item) => item.id === pending?.assetId)
        if (round?.runningSince && (!asset || asset.level === 'S1') && position.consents[actor.id]?.model && body.refused !== true && ai.enabled) {
          const answer = safeText(body.answer, 3000, true)
          const evidence = (asset?.sources ?? []).slice(-5).map((source) => scrub(source.excerpt ?? source.locator, position))
          prepared.ai = await ai.call('interview', { categories: CATEGORIES, question: scrub(pending?.text, position), answer: scrub(answer, position), evidence }, position.model, 5000)
        }
      }
      if (prepared.ai) {
        detail.model = prepared.ai.metric
        detail.trace.firstToken = prepared.ai.metric.firstToken
        detail.degraded = prepared.ai.degraded
      }
      const updated = await store.change(accessEvent(request, ACTIONS[action], position.id, detail), async (current) => {
        requireThat(mayRead(current, actor), '岗位不存在或未向你开放。', 404)
        const changed = await applyAction(current, actor, action, body, prepared, async (objectId, bytes) => {
          written.push(objectId)
          await store.putObject(actor.tenant, objectId, bytes)
        })
        if (traceKey && action !== 'material') detail.trace[traceKey] = Date.now() - started
        return changed
      })
      written.length = 0
      if (['submitExam', 'approveDeletion'].includes(action)) schedule(actor.tenant, updated)
      response.json(view(updated, actor))
    } catch (error) {
      if (traceKey && (error.status ?? 500) >= 500) await access(request, '处理异常', position.id, { fault: traceKey, name: error.name }).catch(() => {})
      throw error
    } finally {
      if (bulk) uploads.delete(key)
      for (const object of written) await store.removeObject(actor.tenant, object).catch(() => {})
    }
  }

  async function sendExport(entry, request, response, subject) {
    const mark = exportMark(entry)
    const content = entry.format === 'pdf' ? await pdf(entry.snapshot, mark, (objectId) => store.getObject(request.actor.tenant, objectId)) : Buffer.from(markdown(entry.snapshot, mark))
    await access(request, '下载导出', subject, { exportId: entry.id, redacted: entry.redacted, format: entry.format })
    response.attachment(`relay-${entry.scope}-${entry.id.slice(0, 8)}.${entry.format}`).type(entry.format === 'pdf' ? 'application/pdf' : 'text/markdown').send(content)
  }

  api.use((_, response) => response.status(404).json({ error: '找不到此页面或操作。' }))
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error)
    const status = error.status ?? 500
    if (status >= 500) console.error(JSON.stringify({ event: '服务错误', name: error.name, path: request.path, code: error.code }))
    response.status(status).json({ error: status === 413 ? '材料或图片超过容量上限。' : status >= 500 ? '服务暂时不可用，请稍后重试。' : error.type === 'entity.parse.failed' ? '提交内容无效。' : error.message })
  })

  async function scoreQueued({ tenant, record }) {
    const timestamp = now()
    const attempt = record.attempts.at(-1)
    if (!attempt || attempt.phase !== 'scoring' || attempt.leaseUntil > timestamp || record.purgeAfter) return
    const leaseId = id()
    const claim = await store.change({ tenant, subject: record.id }, (position) => {
      const latest = position?.attempts.at(-1)
      if (latest?.id !== attempt.id || latest.phase !== 'scoring' || latest.leaseUntil > timestamp) return undefined
      latest.leaseUntil = addTime(timestamp, 180_000)
      latest.leaseId = leaseId
      return position
    })
    if (claim?.attempts.at(-1)?.leaseId !== leaseId) return
    const eligible = attempt.questions.filter((question) => question.level === 'S1' && question.evidence && attempt.answers[question.id]?.text)
    const allow = ai.enabled && claim.consents[claim.actors.successor.id]?.model && claim.consents[claim.actors.owner.id]?.model
    const inputs = allow ? eligible.map((question) => ({ id: question.id, answer: scrub(attempt.answers[question.id].text, claim), refs: question.terms.map((term) => scrub(term, claim)) })) : []
    const started = Date.now()
    const model = inputs.length ? await ai.call('grading', { questions: inputs }, claim.model, 80_000) : { items: [], metric: {}, degraded: true }
    const proposed = gradeAttempt(attempt)
    const overrides = Object.fromEntries(model.items.slice(0, 15).flatMap((entry) => {
      const question = eligible.find((item) => item.id === entry?.id)
      if (!question || proposed.find((item) => item.id === question.id)?.status === 'pass') return []
      const score = modelGrade(entry, question, inputs.find((item) => item.id === question.id).answer)
      return score ? [[question.id, score]] : []
    }))
    await store.change({ tenant, subject: record.id, actor: 'system', action: '自动评分', detail: { trace: { grade: Date.now() - started }, model: model.metric, degraded: model.degraded } }, (position) => {
      const latest = position?.attempts.at(-1)
      if (!latest || latest.leaseId !== leaseId || latest.phase !== 'scoring') return undefined
      latest.results = gradeAttempt(latest, overrides)
      latest.phase = 'review'
      latest.gradedAt = now()
      addMetrics(position, model.metric)
      position.notifications.push({ id: id(), roles: ['owner'], title: '验收自动评分完成，请抽检并完成复核。', stage: 'exam', at: now(), readBy: [] })
      return position
    })
  }

  let cycle = null
  let lastCleanup = 0
  let lastReconcile = 0
  let lastRetention = 0
  async function tick() {
    const timestamp = now()
    if (Date.now() - lastReconcile >= 60_000) {
      lastReconcile = Date.now()
      const checkRetention = Date.now() - lastRetention >= 60 * 60_000
      const retentionByTenant = new Map()
      for (const { tenant, record } of await store.scan('position')) {
        if (!record.purgeAfter && checkRetention && record.archivedAt) {
          if (!retentionByTenant.has(tenant)) retentionByTenant.set(tenant, (await workspaceFor(tenant)).retentionMonths)
          const date = new Date(record.archivedAt)
          date.setUTCMonth(date.getUTCMonth() + retentionByTenant.get(tenant))
          if (date <= new Date(timestamp)) {
            await store.change({ tenant, subject: record.id, actor: 'system', action: '留存到期' }, (position) => position && { ...position, purgeAfter: timestamp })
            schedule(tenant, record)
          }
        }
        if (record.purgeAfter || record.attempts.at(-1)?.phase === 'scoring') schedule(tenant, record)
      }
      if (checkRetention) lastRetention = Date.now()
    }
    const batch = orderedJobs().filter(([, job]) => job.retryAt <= Date.now()).slice(0, jobBatchSize)
    await Promise.all(batch.map(async ([key, job]) => {
      try {
        const record = await store.get(job.tenant, 'position', job.id)
        const attempt = record?.attempts.at(-1)
        if (record?.purgeAfter && record.purgeAfter <= timestamp) {
          await store.change({ tenant: job.tenant, subject: job.id, actor: 'system', action: '物理删除' }, async (position) => {
            if (!position?.purgeAfter) return undefined
            for (const attachment of position.attachments) await store.removeObject(job.tenant, attachment.id)
            return null
          })
          await store.checkpoint()
        } else if (attempt?.phase === 'scoring') {
          if (attempt.leaseUntil > timestamp) { job.retryAt = Date.parse(attempt.leaseUntil); return }
          await scoreQueued({ tenant: job.tenant, record })
          const remaining = (await store.get(job.tenant, 'position', job.id))?.attempts.at(-1)
          if (remaining?.phase === 'scoring') { job.retryAt = Date.parse(remaining.leaseUntil ?? timestamp) + 200; return }
        }
        if (pendingJobs.get(key) === job) pendingJobs.delete(key)
      } catch (error) {
        job.retryAt = Date.now() + 5000
        await store.event({ tenant: job.tenant, subject: job.id, actor: 'system', action: '处理异常', detail: { fault: job.priority === 2 ? 'purge' : 'grade', name: error.name } }).catch(() => {})
        console.error(JSON.stringify({ event: '后台任务待重试', error: error.name }))
      }
    }))
    if (Date.now() - lastCleanup >= 60 * 60_000) {
      lastCleanup = Date.now()
      for (const { tenant, key, record } of await store.scan('session')) if (record.expires <= timestamp) await store.change({ tenant, kind: 'session', subject: key }, () => null)
    }
  }
  const worker = setInterval(() => {
    if (!cycle) cycle = tick().catch((error) => console.error(JSON.stringify({ event: '后台任务待重试', error: error.name }))).finally(() => { cycle = null })
  }, options.interval ?? 750)
  worker.unref()

  return { app, store, demo, async close() { clearInterval(worker); await cycle; await store.close() } }
}
