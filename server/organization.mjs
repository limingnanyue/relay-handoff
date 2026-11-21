import { ROLES } from '../shared/catalog.mjs'
import { id, requireThat, safeText } from './domain.mjs'

export const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : ''
export const validEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
export const canSignIn = (account) => Boolean(account?.enabled && (account.demoAccount || account.passwordHash))

const sampleDepartments = [
  { id: 'demo-operations', name: '商业运营中心', parentId: '' },
  { id: 'demo-sales', name: '销售运营部', parentId: 'demo-operations' },
  { id: 'demo-people', name: '人力资源部', parentId: '' },
]

export function accountProfile(account, departments) {
  const { id, tenant, name, role, email, title, departmentId, demoAccount, mustChangePassword } = account
  return { id, tenant, name, role, email, title, departmentId, demoAccount: Boolean(demoAccount), mustChangePassword: Boolean(mustChangePassword),
    department: departments.find((entry) => entry.id === departmentId)?.name ?? '',
  }
}

function employeeView(account, departments) {
  return { ...accountProfile(account, departments), enabled: account.enabled, status: !account.enabled ? 'disabled' : canSignIn(account) ? 'active' : 'pending' }
}

export async function createOrganization(store, accounts, demo) {
  const tenants = new Set(accounts.map(({ tenant }) => tenant))
  const get = (tenant) => store.get(tenant, 'organization', 'directory')
  const change = (event, update) => store.change({ ...event, kind: 'organization', subject: 'directory' }, update)
  for (const tenant of tenants) {
    await change({ tenant }, (organization) => {
      requireThat(organization.demo === undefined || organization.demo === demo, '演示工作区与正式工作区需要独立的数据存储。', 409)
      const added = accounts.filter((account) => account.tenant === tenant && !organization.employees.some(({ id }) => id === account.id))
      if (organization.demo !== undefined && !added.length) return
      const employees = added.map((account) => ({ ...account, enabled: true, title: '', demoAccount: demo,
        departmentId: demo ? account.role === 'hr' ? 'demo-people' : account.role === 'auditor' ? 'demo-operations' : 'demo-sales' : '',
      }))
      return { demo, departments: demo && organization.demo === undefined ? sampleDepartments : organization.departments, employees: [...organization.employees, ...employees] }
    })
  }

  const changeAs = (actor, event, update) => change({ ...event, tenant: actor.tenant, actor: actor.id }, (organization) => {
    const account = organization.employees.find(({ id }) => id === actor.id)
    requireThat(canSignIn(account) && account.sessionStamp === actor.sessionStamp, '登录状态已变更，请重新登录。', 401)
    return update(organization, account)
  })

  return {
    get,
    changeAs,
    allows: (tenant) => tenants.has(tenant),
    async view(tenant) {
      const { departments, employees } = await get(tenant)
      return { departments, employees: employees.map((account) => employeeView(account, departments)) }
    },
    async directory(tenant) {
      const { departments, employees } = await get(tenant)
      return { departments, people: employees.filter(canSignIn).map(({ id, name, role, departmentId }) => ({ id, name, role, tenant, departmentId,
        department: departments.find((entry) => entry.id === departmentId)?.name ?? '',
      })) }
    },
    async saveDepartment(actor, body, ip) {
      const identifier = body.id ?? id()
      const name = safeText(body.name, 60, true)
      const parentId = body.parentId ?? ''
      const department = { id: identifier, name, parentId }
      await changeAs(actor, { ip, action: body.id === undefined ? '新增部门' : '更新部门', detail: { target: identifier } }, (organization) => {
        const { departments } = organization
        requireThat(body.id === undefined || departments.some(({ id }) => id === identifier), '找不到该部门。', 404)
        requireThat(parentId === '' || departments.some(({ id }) => id === parentId), '请选择本组织的上级部门。')
        const parents = new Map(departments.map(({ id, parentId }) => [id, parentId]))
        for (let ancestor = parentId; ancestor; ancestor = parents.get(ancestor)) {
          requireThat(ancestor !== identifier, '上级部门不能是当前部门或其下级。')
        }
        requireThat(!departments.some((entry) => entry.id !== identifier && entry.name === name && entry.parentId === parentId), '同一上级下已有同名部门。', 409)
        return { ...organization, departments: [...departments.filter(({ id }) => id !== identifier), department] }
      })
      return department
    },
    async removeDepartment(actor, identifier, ip) {
      await changeAs(actor, { ip, action: '删除空部门', detail: { target: identifier } }, (organization) => {
        const { departments, employees } = organization
        requireThat(departments.some(({ id }) => id === identifier), '找不到该部门。', 404)
        requireThat(!departments.some(({ parentId }) => parentId === identifier) && !employees.some(({ departmentId }) => departmentId === identifier), '请先迁移该部门的员工和下级部门。', 409)
        return { ...organization, departments: departments.filter(({ id }) => id !== identifier) }
      })
    },
    async saveEmployee(actor, body, passwordHash, ip) {
      const identifier = body.id ?? id()
      const { role, enabled, departmentId = '' } = body
      const email = normalizeEmail(body.email)
      const name = safeText(body.name, 60, true)
      const title = safeText(body.title, 60)
      requireThat(typeof role === 'string' && Object.hasOwn(ROLES, role) && typeof enabled === 'boolean' && validEmail(email), '请输入有效的邮箱、角色和账号状态。')
      const updated = await changeAs(actor, { ip, action: body.id === undefined ? '新增员工' : '更新员工', detail: { target: identifier, role, enabled, ...(passwordHash ? { resetPassword: true } : {}) } }, (organization, self) => {
        const previous = organization.employees.find(({ id }) => id === identifier)
        requireThat(body.id === undefined || previous, '找不到该员工。', 404)
        requireThat(departmentId === '' || organization.departments.some(({ id }) => id === departmentId), '请选择本组织的部门。')
        if (identifier === self.id) requireThat(enabled && role === self.role && email === self.email && !passwordHash, '请在账户设置修改自己的密码，不能停用或变更当前登录身份。', 409)
        if (previous?.demoAccount) requireThat(enabled && role === previous.role && email === previous.email && !passwordHash, '演示预置角色只能调整员工资料。', 409)
        const credentialsChanged = passwordHash || previous?.enabled !== enabled || previous?.email !== email || previous?.role !== role
        const employee = { ...previous, id: identifier, tenant: actor.tenant, name, title, email, role, enabled, departmentId,
          ...(passwordHash ? { passwordHash, mustChangePassword: true } : {}),
          ...(credentialsChanged ? { sessionStamp: id() } : {}),
        }
        return { ...organization, employees: [...organization.employees.filter(({ id }) => id !== identifier), employee] }
      })
      return employeeView(updated.employees.find(({ id }) => id === identifier), updated.departments)
    },
  }
}
