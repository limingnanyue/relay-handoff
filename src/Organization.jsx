import { useState } from 'react'
import { Building2, FolderTree, Pencil, Plus, Search, Trash2, UserPlus, UsersRound } from 'lucide-react'
import { ROLES } from '../shared/catalog.mjs'
import { api, Avatar, Badge, Button, Dialog, Empty, ErrorNote, Heading, SearchInput, Skeleton, useLoad } from './ui.jsx'

export function departmentPaths(departments) {
  const branches = new Map()
  for (const department of departments) {
    if (!branches.has(department.parentId)) branches.set(department.parentId, [])
    branches.get(department.parentId).push(department)
  }
  const paths = []
  function walk(parentId, path, ancestors) {
    const siblings = branches.get(parentId) ?? []
    siblings.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const department of siblings) {
      const label = path ? `${path} / ${department.name}` : department.name
      const lineage = [...ancestors, department.id]
      paths.push({ ...department, label, lineage })
      walk(department.id, label, lineage)
    }
  }
  walk('', '', [])
  return paths
}

const accountStatus = { active: ['green', '已启用'], pending: ['amber', '待开通'], disabled: ['pending', '已停用'] }

function DirectoryDialog({ edit, departments, selected, user, close, saved }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { type, record } = edit
  const isEmployee = type === 'employee'
  const remove = type === 'remove'
  const fixed = isEmployee && record && (record.id === user.id || record.demoAccount)
  async function submit(event) {
    event.preventDefault()
    const input = Object.fromEntries(new FormData(event.currentTarget))
    if (record) input.id = record.id
    if (isEmployee) {
      input.enabled = fixed ? record.enabled : input.enabled === 'on'
      if (fixed) input.role = record.role
    }
    setBusy(true)
    setError('')
    const path = remove ? `/organization/departments/${record.id}/remove` : isEmployee ? '/organization/employees' : '/organization/departments'
    try { saved(await api(path, input), type) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const title = remove ? '删除部门' : `${record ? '编辑' : '新增'}${isEmployee ? '员工' : '部门'}`
  return <Dialog title={title} onClose={close} busy={busy}><form className="form-stack" onSubmit={submit}>
    {remove ? <p>确定删除「{record.name}」？历史岗位中的部门名称将继续保留。</p> : isEmployee ? <>
      <div className="form-grid directory-form-grid"><label>员工姓名<input name="name" required maxLength={60} defaultValue={record?.name} autoFocus /></label><label>职务<input name="title" maxLength={60} defaultValue={record?.title} /></label></div>
      <label>工作邮箱<input name="email" type="email" maxLength={254} required readOnly={Boolean(fixed)} defaultValue={record?.email} /></label>
      <div className="form-grid directory-form-grid">
        <label>所属部门<select name="departmentId" defaultValue={record?.departmentId ?? selected?.id ?? ''}><option value="">未分配</option>{departments.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label>工作区角色<select name="role" defaultValue={record?.role ?? 'successor'} disabled={Boolean(fixed)}>{Object.entries(ROLES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <label className="check-row"><input type="checkbox" name="enabled" defaultChecked={record?.enabled ?? true} disabled={Boolean(fixed)} />允许账号登录</label>
      {fixed ? <p className="helper">{record.demoAccount ? '可维护演示角色的姓名、职务和部门。' : '在账户与安全中可修改自己的密码。'}</p> : <>
        <label>{record?.status === 'active' ? '重置临时密码（可选）' : '临时密码（可选）'}<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} placeholder="至少 12 个字符" /></label>
        <p className="helper">设置临时密码后，请通过安全渠道告知员工。员工登录后需改密。停用会结束该员工的已登录会话。</p>
      </>}
    </> : <>
      <label>部门名称<input name="name" required maxLength={60} defaultValue={record?.name} autoFocus /></label>
      <label>上级部门<select name="parentId" defaultValue={record?.parentId ?? selected?.id ?? ''}><option value="">无 · 一级部门</option>{departments.filter(({ lineage }) => !lineage.includes(record?.id)).map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
    </>}
    <ErrorNote message={error} /><div className="dialog-actions"><Button onClick={close} disabled={busy}>取消</Button><Button type="submit" kind={remove ? 'danger' : 'primary'} busy={busy}>{remove ? (busy ? '删除中…' : '确认删除') : (busy ? '保存中…' : '保存')}</Button></div>
  </form></Dialog>
}

export default function Organization({ user, setUser, toast }) {
  const directory = useLoad('/organization')
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [edit, setEdit] = useState(null)
  const departments = departmentPaths(directory.data?.departments ?? [])
  const employees = directory.data?.employees ?? []
  const byId = new Map(departments.map((department) => [department.id, department]))
  const selected = byId.get(selectedId)
  const unassigned = selectedId === 'unassigned'
  const unassignedCount = employees.filter(({ departmentId }) => !departmentId).length
  const counts = new Map()
  for (const employee of employees) {
    for (const identifier of byId.get(employee.departmentId)?.lineage ?? []) counts.set(identifier, (counts.get(identifier) ?? 0) + 1)
  }
  const term = query.trim().toLowerCase()
  const filtered = employees.filter((employee) => {
    if (selected && !byId.get(employee.departmentId)?.lineage.includes(selected.id) || unassigned && employee.departmentId) return false
    if (status && employee.status !== status) return false
    return `${employee.name} ${employee.email} ${employee.title} ${employee.department}`.toLowerCase().includes(term)
  }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  const choices = [
    { id: '', name: '全部员工', icon: UsersRound, count: employees.length },
    ...departments.map((department) => ({ ...department, icon: Building2, count: counts.get(department.id) ?? 0 })),
    { id: 'unassigned', name: '未分配部门', icon: FolderTree, count: unassignedCount },
  ]
  const occupied = selected && ((counts.get(selected.id) ?? 0) > 0 || departments.some(({ parentId }) => parentId === selected.id))
  function saved(result, type) {
    if (type === 'department') {
      setSelectedId(result.id)
      if (result.id === user.departmentId) setUser({ ...user, department: result.name })
    }
    if (type === 'remove') setSelectedId('')
    if (type === 'employee' && result.id === user.id) setUser({ ...user, name: result.name, department: result.department, departmentId: result.departmentId, title: result.title })
    directory.refresh()
    setEdit(null)
    toast(type === 'remove' ? '已删除部门。' : type === 'employee' ? '已保存员工。' : '已保存部门。')
  }
  return <>
    <Heading title="组织与员工" description="维护部门层级、员工角色和登录账号。"><Button icon={Plus} disabled={!directory.data} onClick={() => setEdit({ type: 'department' })}>新增部门</Button><Button icon={UserPlus} kind="primary" disabled={!directory.data} onClick={() => setEdit({ type: 'employee' })}>新增员工</Button></Heading>
    <ErrorNote message={directory.error} retry={directory.refresh} />
    {directory.loading && !directory.data ? <Skeleton /> : directory.data && <div className="organization-grid">
      <section className="card department-panel" aria-label="部门结构"><div className="panel-title"><h2><FolderTree size={18} aria-hidden="true" />部门结构</h2><span className="table-count">{departments.length} 个</span></div>
        <div className="department-list">{choices.map(({ id, name, label, icon: Icon, count, lineage }) => <button type="button" key={id} title={label ?? name}
          className="department-row" style={{ '--depth': Math.min(6, (lineage?.length ?? 1) - 1) }} aria-pressed={id === selectedId} onClick={() => setSelectedId(id)}>
          <Icon size={16} aria-hidden="true" /><span>{name}</span><small>{count}</small>
        </button>)}</div>
      </section>
      <section className="card table-panel employee-panel">
        <div className="panel-title employee-title"><div><h2>{selected?.name ?? (unassigned ? '未分配部门' : '员工目录')}</h2><p>{selected?.parentId ? selected.label : selected ? '包含下级部门的员工' : '按账号状态和员工资料查找'}</p></div>
          {selected && <div className="heading-actions"><Button icon={Pencil} onClick={() => setEdit({ type: 'department', record: selected })}>编辑部门</Button><Button icon={Trash2} disabled={occupied} title={occupied ? '请先迁移员工和下级部门' : undefined} onClick={() => setEdit({ type: 'remove', record: selected })}>删除部门</Button></div>}
        </div>
        <div className="table-tools employee-filters"><SearchInput icon={Search} value={query} onChange={setQuery} placeholder="搜索姓名、邮箱或职务" /><select aria-label="按账号状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部账号状态</option>{Object.entries(accountStatus).map(([key, [, label]]) => <option key={key} value={key}>{label}</option>)}</select><span className="table-count" role="status">{filtered.length} 人</span></div>
        {filtered.length ? <div className="table-scroll" tabIndex={0} aria-label="员工列表"><table className="data-table employee-table"><thead><tr><th>员工</th><th>部门与职务</th><th>角色</th><th>账号状态</th><th>操作</th></tr></thead><tbody>{filtered.map((employee) => {
          const [tone, label] = accountStatus[employee.status]
          return <tr key={employee.id}><td><div className="employee-name"><Avatar name={employee.name} size="small" /><div><b>{employee.name}</b><small className="row-detail">{employee.email}</small></div></div></td>
            <td>{employee.department || '未分配'}{employee.title && <small className="row-detail">{employee.title}</small>}</td><td>{ROLES[employee.role]}</td><td><Badge status={tone}>{label}</Badge></td>
            <td><button className="text-button" type="button" aria-label={`编辑${employee.name}`} onClick={() => setEdit({ type: 'employee', record: employee })}>编辑</button></td></tr>
        })}</tbody></table></div> : term || status ? <Empty title="没有匹配的员工" detail="可清除搜索和账号状态筛选，查看当前部门的员工。" icon={UsersRound}><Button onClick={() => { setQuery(''); setStatus('') }}>清除筛选</Button></Empty>
          : <Empty title="暂无员工" detail="可新增员工，或在员工资料中调整所属部门。" icon={UsersRound}><Button icon={UserPlus} kind="primary" onClick={() => setEdit({ type: 'employee' })}>新增员工</Button></Empty>}
      </section>
    </div>}
    {edit && <DirectoryDialog edit={edit} departments={departments} selected={selected} user={user} close={() => setEdit(null)} saved={saved} />}
  </>
}
