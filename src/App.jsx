import { useCallback, useEffect, useState } from 'react'
import { Bell, BriefcaseBusiness, ChevronDown, ChevronRight, ClipboardCheck, FileStack, GitBranch, LayoutDashboard, LibraryBig, LogOut, Menu, MessagesSquare, Plus, Search, Settings2, ShieldCheck, UsersRound } from 'lucide-react'
import { ROLES, TEMPLATE_NAME } from '../shared/catalog.mjs'
import { Brand, FirstPassword, Login } from './Account.jsx'
import Dashboard from './Dashboard.jsx'
import Workspace from './Workspace.jsx'
import { Audit, Settings, Templates } from './Management.jsx'
import Organization, { departmentPaths } from './Organization.jsx'
import { api, Avatar, Badge, Button, Dialog, Empty, ErrorNote, Heading, IconButton, navigate, positionPath, SearchInput, Skeleton, stageLabel, today, Toast, useLoad, whenLabel } from './ui.jsx'

const navigation = [
  ['overview', '总览', LayoutDashboard], ['positions', '岗位', BriefcaseBusiness], ['assets', '资产地图', GitBranch],
  ['interview', '访谈', MessagesSquare], ['exam', '验收', ClipboardCheck],
  ['templates', '模板库', LibraryBig], ['organization', '组织与员工', UsersRound], ['audit', '审计视图', ShieldCheck], ['settings', '设置', Settings2],
]
const staff = (user) => ['owner', 'hr'].includes(user.role)
const parseRoute = () => location.hash.slice(1).split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part) } catch { return part } })

function CreatePosition({ user, onClose, onCreate }) {
  const directory = useLoad('/directory?departments=1')
  const [departmentId, setDepartmentId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const departments = departmentPaths(directory.data?.departments ?? [])
  const roles = ['owner', 'leaver', 'successor']
  const people = directory.data?.people ?? []
  const missing = roles.filter((role) => !(role === 'owner' && user.role === 'owner') && !people.some((person) => person.role === role))
  async function submit(event) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    setBusy(true)
    setError('')
    try { onCreate(await api('/positions', { ...values, backups: Number(values.backups), owner: user.role === 'owner' ? user.id : values.owner })) }
    catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <Dialog title="新建岗位体检" detail="确认交接范围与参与人后，系统会生成销售运营资产地图。" onClose={onClose} busy={busy}>
    {directory.error ? <ErrorNote message={directory.error} retry={directory.refresh} />
      : !directory.data ? <p className="notice notice--blue" role="status">正在加载部门和可选员工…</p>
      : <form onSubmit={submit} className="form-stack">
      <div className="selection-card"><div className="tile-icon tone-blue"><LibraryBig size={20} /></div><div><strong>{TEMPLATE_NAME}</strong><p>8 类资产 · 48 个盘点条目 · 10 个必考候选</p></div></div>
      <div className="form-grid directory-form-grid"><label>岗位名称<input name="title" required maxLength={80} placeholder="例如 华南区销售运营" autoFocus /></label>
        {departments.length > 0 ? <label>所属部门<select name="departmentId" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">手动填写部门</option>{departments.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
          : <label>所属部门<input name="department" required maxLength={60} placeholder="例如 区域销售部" /></label>}
      </div>
      {departments.length > 0 && !departmentId && <label>部门名称<input name="department" required maxLength={60} placeholder="例如 区域销售部" /></label>}
      <div className="form-grid directory-form-grid"><label>交接截止日期<input type="date" name="due" required defaultValue={today()} /></label><label>接班人之外的独立替代者<input type="number" min="0" max="99" name="backups" defaultValue="0" required /></label></div>
      <div className="form-grid form-grid--three directory-form-grid">{roles.map((role) => <label key={role}>{ROLES[role]}
        {role === 'owner' && user.role === 'owner' ? <input value={user.name} disabled /> : <select name={role} required defaultValue=""><option value="" disabled>请选择</option>{people.filter((person) => person.role === role).map((person) => <option key={person.id} value={person.id}>{person.name}{person.department ? ` · ${person.department}` : ''}</option>)}</select>}</label>)}</div>
      {missing.length > 0 && <p className="helper">{missing.map((role) => ROLES[role]).join('、')}缺少可用账号。{user.role === 'hr' ? <a href="#/organization" onClick={onClose}>前往组织与员工开通</a> : '请联系人力资源开通。'}</p>}
      <ErrorNote message={error} />
      <div className="dialog-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" icon={Plus} kind="primary" busy={busy} disabled={missing.length > 0}>{busy ? '创建中…' : '创建体检'}</Button></div>
    </form>}
  </Dialog>
}

function Navigation({ active, choose, user, demo, mobile }) {
  const items = navigation.filter(([key]) => (key !== 'audit' || ['hr', 'auditor'].includes(user.role)) && (key !== 'organization' || user.role === 'hr'))
  return <div className={mobile ? 'mobile-nav-items' : 'sidebar-inner'}>
    {!mobile && <Brand />}
    <nav aria-label="主导航"><span className="nav-section">交接工作区</span>{items.map(([key, label, Icon], index) => <div key={key}>
      {index === 5 && <span className="nav-section nav-section--secondary">组织管理</span>}
      <button type="button" onClick={() => choose(key)} className={`nav-link ${active === key ? 'nav-link--active' : ''}`} aria-current={active === key ? 'page' : undefined} title={label}><Icon size={19} strokeWidth={1.8} /><span>{label}</span>{active === key && <ChevronRight size={15} className="nav-current" />}</button>
    </div>)}</nav>
    {!mobile && <div className="sidebar-foot"><div className="side-shield"><ShieldCheck size={19} /></div><div><strong>{demo ? '演示工作区' : '组织工作区'}</strong><small>权限与审计已启用</small></div></div>}
  </div>
}

function GlobalSearch({ positions, close }) {
  const [query, setQuery] = useState('')
  const results = positions.filter((position) => `${position.title} ${position.department} ${position.actors.owner.name} ${position.actors.leaver.name} ${position.actors.successor.name}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <Dialog title="搜索岗位" onClose={close}><SearchInput icon={Search} value={query} onChange={setQuery} placeholder="输入岗位、部门或人员" autoFocus />
    <div className="dialog-list">{results.length ? results.slice(0, 10).map((position) => <a className="list-link" key={position.id} href={positionPath(position)} onClick={close}><span className="tile-icon tone-blue"><BriefcaseBusiness size={17} /></span><span><strong>{position.title}</strong><small>{position.department} · {stageLabel(position.stage)}</small></span><ChevronRight size={17} /></a>) : <Empty title="没有匹配的岗位" />}</div>
  </Dialog>
}

function Notifications({ entries, close, refresh, toast }) {
  const [error, setError] = useState('')
  async function read(entry) {
    try {
      if (entry.unread) await api(`/positions/${entry.positionId}/readNotice`, { noticeId: entry.id })
      refresh()
      navigate(entry.stage === 'settings' ? '/settings/approvals' : positionPath({ id: entry.positionId }, entry.stage))
      close()
    } catch (failure) { setError(failure.message) }
  }
  return <Dialog title="站内通知" detail="查看访谈、验收、签署和导出提醒。" onClose={close}><ErrorNote message={error} />
    <div className="dialog-list">{entries.length ? entries.map((entry) => <button className="list-link" key={entry.id} type="button" onClick={() => read(entry)}><span className={`tile-icon tone-${entry.unread ? 'blue' : 'slate'}`}><Bell size={17} /></span><span><strong>{entry.title}</strong><small>{entry.positionTitle} · {whenLabel(entry.at)}</small></span>{entry.unread && <Badge status="blue">未读</Badge>}</button>) : <Empty title="暂无站内通知" detail="需要你处理的交接事项将出现在这里。" icon={Bell} />}</div>
    <Button onClick={() => { close(); toast('已返回工作台。') }}>关闭</Button>
  </Dialog>
}

function AccountDialog({ user, demo, close, switchRole, logout }) {
  return <Dialog title="账户与角色" onClose={close}>
    <div className="selection-card"><Avatar name={user.name} /><div><strong>{user.name}</strong><p>{[ROLES[user.role], user.department].filter(Boolean).join(' · ')}</p></div></div>
    {demo && user.demoAccount && <><p className="helper">切换演示角色</p><div className="role-grid">{Object.entries(ROLES).map(([role, label]) => <Button kind={role === user.role ? 'primary' : 'secondary'} key={role} disabled={role === user.role} onClick={() => switchRole(role)}>{label}</Button>)}</div></>}
    <div className="dialog-actions"><Button icon={LogOut} onClick={logout}>退出登录</Button><Button icon={Settings2} kind="primary" onClick={() => { close(); navigate('/settings/account') }}>账户设置</Button></div>
  </Dialog>
}

function Shell({ user, demo, ai, setUser }) {
  const [route, setRoute] = useState(parseRoute)
  const [dialog, setDialog] = useState('')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const overview = useLoad('/positions')
  const positions = overview.data?.positions ?? []
  const clear = useCallback(() => setToast(''), [])
  const closeDialog = useCallback(() => setDialog(''), [])
  useEffect(() => {
    function handleHash() { setRoute(parseRoute()); setDialog(''); window.scrollTo({ top: 0 }) }
    function handleKeys(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDialog('search') }
    }
    window.addEventListener('hashchange', handleHash)
    window.addEventListener('keydown', handleKeys)
    return () => { window.removeEventListener('hashchange', handleHash); window.removeEventListener('keydown', handleKeys) }
  }, [])
  const page = route[0] || 'overview'
  const selected = page === 'position' ? positions.find((position) => position.id === route[1]) : null
  const active = page === 'position' ? ['assets', 'interview', 'exam'].includes(route[2]) ? route[2] : 'positions' : page
  const unread = overview.data?.notifications.filter((entry) => entry.unread).length ?? 0
  const pageLabel = navigation.find(([key]) => key === active)?.[1] ?? '岗位'

  function choose(key) {
    closeDialog()
    if (['assets', 'interview', 'exam'].includes(key)) {
      const candidate = selected ?? positions.find((position) => position.stage === key) ?? positions[0]
      if (candidate) { navigate(positionPath(candidate, key)); return }
    }
    navigate(`/${key}`)
  }
  async function switchRole(role) {
    try { setUser(await api('/session/demo', { role })); closeDialog() }
    catch (failure) { setError(failure.message); closeDialog() }
  }
  async function logout() {
    try { await api('/session/logout', {}); setUser(null); navigate('/overview') } catch (failure) { setError(failure.message); closeDialog() }
  }
  async function monthly() {
    setBusy(true)
    setError('')
    try { await api('/settings/monthly', {}); setToast('已提交月报导出申请。'); navigate('/settings/approvals') }
    catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }

  return <div className="application">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>跳转到主内容</a>
    <aside className="sidebar"><Navigation active={active} choose={choose} user={user} demo={demo} /></aside>
    <div className="app-content">
      <header className="topbar"><div className="topbar-left"><IconButton icon={Menu} label="打开导航" className="mobile-menu" onClick={() => setDialog('menu')} />
        <div className="breadcrumb"><span className="workspace-icon"><FileStack size={15} /></span><a href="#/overview">工作区</a><ChevronRight size={13} /><span>{selected?.title ?? pageLabel}</span>{selected && route[2] && <><ChevronRight size={13} className="extra-crumb" /><span className="extra-crumb">{stageLabel(route[2])}</span></>}</div>
      </div><div className="topbar-actions">
        <button type="button" className="top-search" aria-label="搜索岗位" onClick={() => setDialog('search')}><Search size={17} /><span>搜索岗位</span><kbd>Ctrl K</kbd></button>
        <IconButton icon={Bell} label={unread ? `通知，${unread} 项未读` : '通知'} className="notification-button" onClick={() => setDialog('notifications')}>{unread > 0 && <i />}</IconButton>
        <span className="topbar-divider" />
        <button type="button" className="profile-button" onClick={() => setDialog('account')} aria-label={`${user.name}，${ROLES[user.role]}，账户设置`}><Avatar name={user.name} size="small" /><span><strong>{user.name}</strong><small>{ROLES[user.role]}</small></span><ChevronDown size={14} /></button>
      </div></header>
      <main id="main-content" tabIndex={-1} className="content">
        <ErrorNote message={error} />
        {page === 'position' && route[1] ? <Workspace key={`${user.id}/${route[1]}`} positionId={route[1]} stage={route[2]} user={user} ai={ai} refresh={overview.refresh} toast={setToast} />
          : page === 'templates' ? <Templates create={staff(user) ? () => setDialog('create') : null} />
          : page === 'organization' ? user.role === 'hr' ? <Organization user={user} setUser={setUser} toast={setToast} /> : <section className="card"><Empty title="仅人力资源可管理组织与员工" icon={UsersRound}><Button onClick={() => choose('overview')}>返回总览</Button></Empty></section>
          : page === 'audit' ? <Audit />
          : page === 'settings' ? <Settings category={route[1]} user={user} setUser={setUser} logout={logout} toast={setToast} refresh={overview.refresh} positions={positions} />
          : overview.error ? <ErrorNote message={overview.error} retry={overview.refresh} />
          : !overview.data ? <Skeleton />
          : ['overview', 'positions'].includes(page) ? <Dashboard key={page} staff={staff(user)} data={overview.data} listOnly={page === 'positions'} busy={busy} monthly={monthly} create={() => setDialog('create')} />
          : <><Heading title={pageLabel} /><section className="card"><Empty title="先建立一个岗位体检" detail="选定岗位后打开资产、访谈或验收页面。">{staff(user) && <Button icon={Plus} kind="primary" onClick={() => setDialog('create')}>新建体检</Button>}<Button onClick={() => choose('positions')}>返回岗位</Button></Empty></section></>}
        <footer className="footer"><span>接棒 Relay</span><span><ShieldCheck size={14} />岗位交接记录受控访问</span></footer>
      </main>
    </div>
    {dialog === 'create' && <CreatePosition user={user} onClose={closeDialog} onCreate={(position) => { closeDialog(); overview.refresh(); setToast('已建立岗位体检。'); navigate(positionPath(position, 'assets')) }} />}
    {dialog === 'search' && <GlobalSearch positions={positions} close={closeDialog} />}
    {dialog === 'notifications' && <Notifications entries={overview.data?.notifications ?? []} refresh={overview.refresh} close={closeDialog} toast={setToast} />}
    {dialog === 'account' && <AccountDialog user={user} demo={demo} close={closeDialog} switchRole={switchRole} logout={logout} />}
    {dialog === 'menu' && <Dialog title="工作区导航" onClose={closeDialog}><Navigation active={active} choose={choose} user={user} demo={demo} mobile /></Dialog>}
    <Toast message={toast} clear={clear} />
  </div>
}

export default function App() {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setError('')
    api('/session').then((session) => { if (live) setState(session) }).catch((failure) => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [retry])
  useEffect(() => {
    function expired() {
      setNotice('会话已结束，请重新登录。')
      setState((session) => session ? { ...session, user: null } : session)
    }
    window.addEventListener('relay:session-expired', expired)
    return () => window.removeEventListener('relay:session-expired', expired)
  }, [])
  const login = (user) => { setNotice(''); setState((session) => ({ ...session, user })) }
  if (error) return <Login sessionError={error} retry={() => setRetry((value) => value + 1)} />
  if (!state) return <Login loading />
  if (!state.user) return <Login demo={state.demo} onLogin={login} sessionError={notice} />
  if (state.user.mustChangePassword) return <FirstPassword user={state.user} onSaved={login} onLogout={() => login(null)} />
  return <Shell key={`${state.user.tenant}/${state.user.id}`} user={state.user} demo={state.demo} ai={state.ai} setUser={login} />
}
