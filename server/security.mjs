import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ROLES } from '../shared/catalog.mjs'
import { addTime, id, now, requireThat, safeText } from './domain.mjs'
import { accountProfile, canSignIn, createOrganization, normalizeEmail, validEmail } from './organization.mjs'

const derive = promisify(scrypt)
const fallbackSalt = randomBytes(16).toString('hex')
const fallbackHash = scryptSync('invalid', fallbackSalt, 64)
const accountId = /^[a-z0-9-]{1,64}$/
const COOKIE = 'relay_session'
const AGE = 8 * 60 * 60 * 1000

export const DEMO_USERS = [
  { id: 'owner', name: '沈嘉宁', role: 'owner' }, { id: 'leaver', name: '李敏', role: 'leaver' },
  { id: 'successor', name: '赵宁', role: 'successor' }, { id: 'hr', name: '林知夏', role: 'hr' },
  { id: 'auditor', name: '陈明远', role: 'auditor' }, { id: 'other-owner', name: '顾安', role: 'owner' },
].map((account) => ({ ...account, tenant: 'demo', email: `${account.id}@relay.invalid` }))

export function loadUsers(demo, input) {
  if (demo) return DEMO_USERS
  const rows = typeof input === 'string' ? JSON.parse(input) : input
  requireThat(Array.isArray(rows) && rows.length, '正式模式需要配置 RELAY_USERS。')
  const emails = new Set()
  const identities = new Set()
  return rows.map((account) => {
    const { tenant, id, role, passwordHash } = account
    const email = normalizeEmail(account.email)
    const identity = `${tenant}/${id}`
    requireThat(typeof tenant === 'string' && accountId.test(tenant) && typeof id === 'string' && accountId.test(id) && typeof role === 'string' && Object.hasOwn(ROLES, role)
      && validEmail(email) && /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash ?? '') && !emails.has(email) && !identities.has(identity), '账户配置无效或重复。')
    emails.add(email)
    identities.add(identity)
    return { id, tenant, role, name: safeText(account.name, 60, true), email, passwordHash }
  })
}

export async function hashPassword(password) {
  requireThat(typeof password === 'string' && password.length >= 12 && password.length <= 256, '密码长度须为 12–256 字符。')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await derive(password, salt, 64)).toString('hex')}`
}

async function passwordMatches(password, hash) {
  const [salt, expected] = hash?.split(':') ?? [fallbackSalt, fallbackHash.toString('hex')]
  return timingSafeEqual(Buffer.from(expected, 'hex'), await derive(password, salt, 64)) && Boolean(hash)
}

export async function createIdentity(store, { demo, users, origin, secure }) {
  const organization = await createOrganization(store, loadUsers(demo, users), demo)
  const limits = new Map()
  const sign = (token) => createHmac('sha256', store.key).update(`session:${token}`).digest('base64url')
  const fingerprint = (account) => sign(account.sessionStamp ?? account.passwordHash ?? account.id)
  const view = ({ token, sessionStamp, ...profile }) => profile
  const attributes = { maxAge: AGE, httpOnly: true, sameSite: 'strict', secure, path: '/' }

  async function read(request) {
    const raw = request.headers.cookie?.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    const [tenant, token, mac] = raw?.split('.') ?? []
    if (!organization.allows(tenant) || !/^[a-f0-9]{64}$/.test(token ?? '') || !/^[\w-]{43}$/.test(mac ?? '')) return null
    if (!timingSafeEqual(Buffer.from(sign(`${tenant}.${token}`)), Buffer.from(mac))) return null
    const session = await store.get(tenant, 'session', token)
    if (!session || session.expires <= now()) return null
    const { departments, employees } = await organization.get(tenant)
    const account = employees.find(({ id }) => id === session.userId)
    if (canSignIn(account) && session.fingerprint === fingerprint(account)) return { ...accountProfile(account, departments), token, sessionStamp: account.sessionStamp }
    return null
  }
  async function session(account, departments, request, response) {
    const existing = await read(request)
    if (existing) await end(existing)
    const token = randomBytes(32).toString('hex')
    const body = `${account.tenant}.${token}`
    await store.change({ tenant: account.tenant, kind: 'session', subject: token }, () => ({ userId: account.id, expires: addTime(now(), AGE), fingerprint: fingerprint(account) }))
    await store.event({ tenant: account.tenant, actor: account.id, subject: 'session', action: '登录', ip: request.ip })
    response.cookie(COOKIE, `${body}.${sign(body)}`, attributes)
    return accountProfile(account, departments)
  }
  async function end(account) {
    if (account) await store.change({ tenant: account.tenant, kind: 'session', subject: account.token }, () => null)
  }
  return {
    read, view, organization,
    csrf(request) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
      const expected = origin || `${request.protocol}://${request.get('host')}`
      requireThat(request.get('sec-fetch-site') !== 'cross-site' && (!request.get('origin') || request.get('origin') === expected), '请从接棒页面发起此操作。', 403)
      requireThat(Boolean(request.is('application/json')), '请使用 JSON 提交操作。', 415)
    },
    async login(request, response) {
      const { email, password } = request.body
      requireThat(typeof email === 'string' && email.length <= 254 && typeof password === 'string' && password.length <= 256, '请输入邮箱和密码。')
      const timestamp = Date.now()
      for (const [address, limit] of limits) if (limit.until <= timestamp) limits.delete(address)
      const limit = limits.get(request.ip) ?? { hits: 0, until: timestamp + 5 * 60_000 }
      requireThat(limit.hits < 15, '登录尝试过多，请稍后重试。', 429)
      limit.hits += 1
      limits.set(request.ip, limit)
      const normalized = normalizeEmail(email)
      const tenant = await store.tenantForEmail(normalized)
      const data = organization.allows(tenant) ? await organization.get(tenant) : null
      const account = data?.employees.find((user) => user.email === normalized)
      requireThat(await passwordMatches(password, account?.enabled ? account.passwordHash : undefined), '邮箱或密码不正确。', 401)
      limits.delete(request.ip)
      return session(account, data.departments, request, response)
    },
    async demoLogin(request, response) {
      requireThat(demo, '演示登录未启用。', 404)
      const { departments, employees } = await organization.get('demo')
      const account = employees.find((user) => user.demoAccount && user.enabled && user.id === request.body.role)
      requireThat(account, '请选择演示角色。')
      return session(account, departments, request, response)
    },
    async changePassword(request, response) {
      const actor = await read(request)
      requireThat(actor, '请先登录接棒。', 401)
      requireThat(!actor.demoAccount, '演示角色没有个人密码。', 403)
      const { currentPassword, newPassword } = request.body
      requireThat(typeof currentPassword === 'string' && currentPassword.length <= 256, '请输入当前密码。')
      requireThat(newPassword !== currentPassword, '新密码不能与当前密码相同。')
      const { employees } = await organization.get(actor.tenant)
      const account = employees.find(({ id }) => id === actor.id)
      requireThat(await passwordMatches(currentPassword, account.passwordHash), '当前密码不正确。')
      const passwordHash = await hashPassword(newPassword)
      const saved = await organization.changeAs(actor, { ip: request.ip, action: '修改账号密码', detail: { target: actor.id } }, (data, current) => {
        const updated = { ...current, passwordHash, mustChangePassword: false, sessionStamp: id() }
        return { ...data, employees: data.employees.map((employee) => employee.id === actor.id ? updated : employee) }
      })
      await end(actor)
      return session(saved.employees.find(({ id }) => id === actor.id), saved.departments, request, response)
    },
    async logout(request, response) {
      await end(await read(request))
      response.clearCookie(COOKIE, { ...attributes, maxAge: undefined })
    },
  }
}

export function mayRead(position, account) {
  return Boolean(position && !position.purgeAfter && (['hr', 'auditor'].includes(account.role) || position.actors[account.role]?.id === account.id))
}

export const maySeeRestricted = (position, account) => position.actors[account.role]?.id === account.id && Boolean(position.consents[account.id]?.restricted)
export const mayApprove = (position, account) => account.role === 'hr' || position.actors.owner.id === account.id

export function redact(text) {
  return String(text ?? '').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已脱敏]').replace(/(?:\+?86[ -]?)?1[3-9]\d{9}/g, '[电话已脱敏]').replace(/\b\d{17}[\dX]\b/gi, '[号码已脱敏]')
}
