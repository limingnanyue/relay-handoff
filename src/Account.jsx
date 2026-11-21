import { useState } from 'react'
import { ArrowRight, BriefcaseBusiness, ClipboardCheck, Eye, EyeOff, FileStack, GitBranch, KeyRound, LogOut, ShieldCheck, UsersRound } from 'lucide-react'
import { ROLES } from '../shared/catalog.mjs'
import { api, Avatar, Badge, Button, Dialog, ErrorNote, IconButton, Skeleton } from './ui.jsx'

export function Brand() {
  return <a className="brand" href="#/overview" aria-label="接棒 Relay 总览"><img src="/relay-icon.svg" alt="" width="40" height="40" /><span><strong>接棒 <b>Relay</b></strong><small>交接验收平台</small></span></a>
}

function AccountLayout({ children }) {
  return <main className="login-page"><div className="login-layout">
    <aside className="login-aside"><Brand />
      <div className="login-journey"><p className="login-headline">关键岗位交接验收</p><p>从盘点岗位资产到签署确认书，每一步都可追溯。</p>
        <ol>{[[GitBranch, '盘点岗位资产'], [FileStack, '访谈与交接包'], [ClipboardCheck, '验收与签署']].map(([Icon, label]) => <li key={label}><span><Icon size={19} aria-hidden="true" /></span>{label}</li>)}</ol>
      </div>
      <p className="login-security"><ShieldCheck size={17} aria-hidden="true" />按角色授权 · 操作留痕</p>
    </aside>
    <section className="login-card">{children}</section>
  </div></main>
}

export function Login({ demo, onLogin, sessionError, loading, retry }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [visible, setVisible] = useState(false)
  async function signIn(path, input, method) {
    setBusy(method)
    setError('')
    try { onLogin(await api(path, input)) }
    catch (failure) { setError(failure.message) }
    finally { setBusy('') }
  }
  return <AccountLayout><h1>登录交接工作台</h1><p>使用人力资源分配的组织账号登录。</p>
    {loading ? <Skeleton /> : retry ? <ErrorNote message={sessionError} retry={retry} /> : <>
      <form className="form-stack login-form" onSubmit={(event) => {
        event.preventDefault()
        signIn('/session/login', Object.fromEntries(new FormData(event.currentTarget)), 'email')
      }}>
        <label>工作邮箱<input type="email" name="email" autoComplete="username" maxLength={254} placeholder="name@company.com" required /></label>
        <div className="password-control"><label htmlFor="login-password">密码</label><input id="login-password" type={visible ? 'text' : 'password'} name="password" autoComplete="current-password" maxLength={256} required />
          <IconButton icon={visible ? EyeOff : Eye} label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)} />
        </div>
        <ErrorNote message={error || sessionError} />
        <Button type="submit" icon={ArrowRight} kind="primary" busy={busy === 'email'} disabled={Boolean(busy)}>登录</Button>
        <p className="helper">忘记密码？联系人力资源重置。</p>
      </form>
      {demo && <section className="login-demo" aria-label="演示入口"><strong>体验演示工作区</strong><div>
        <Button icon={BriefcaseBusiness} busy={busy === 'owner'} disabled={Boolean(busy)} onClick={() => signIn('/session/demo', { role: 'owner' }, 'owner')}>业务演示</Button>
        <Button icon={UsersRound} busy={busy === 'hr'} disabled={Boolean(busy)} onClick={() => signIn('/session/demo', { role: 'hr' }, 'hr')}>管理演示</Button>
      </div></section>}
    </>}
  </AccountLayout>
}

function PasswordForm({ forced, onSaved, onCancel }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event) {
    event.preventDefault()
    const { currentPassword, newPassword, confirmation } = Object.fromEntries(new FormData(event.currentTarget))
    if (newPassword !== confirmation) { setError('两次输入的新密码不一致。'); return }
    setBusy(true)
    setError('')
    try { onSaved(await api('/session/password', { currentPassword, newPassword })) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const form = <form className="form-stack" onSubmit={submit}>
    <label>{forced ? '临时密码' : '当前密码'}<input name="currentPassword" type="password" autoComplete="current-password" maxLength={256} required /></label>
    <label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={256} required placeholder="至少 12 个字符" /></label>
    <label>确认新密码<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={256} required /></label>
    <ErrorNote message={error} /><div className={forced ? 'login-password-actions' : 'dialog-actions'}><Button onClick={onCancel} disabled={busy}>{forced ? '退出登录' : '取消'}</Button><Button type="submit" kind="primary" busy={busy}>{busy ? '保存中…' : '保存新密码'}</Button></div>
  </form>
  return forced ? form : <Dialog title="修改密码" detail="新密码至少 12 个字符。" busy={busy} onClose={onCancel}>{form}</Dialog>
}

export function FirstPassword({ user, onSaved, onLogout }) {
  const [error, setError] = useState('')
  async function logout() {
    try { await api('/session/logout', {}); onLogout() }
    catch (failure) { setError(failure.message) }
  }
  return <AccountLayout><h1>设置个人密码</h1><p>{user.email} 使用临时密码登录。请先设置个人密码，再进入工作台。</p>
    <ErrorNote message={error} /><PasswordForm forced onSaved={onSaved} onCancel={logout} />
  </AccountLayout>
}

export function AccountSettings({ user, onSaved, logout, toast }) {
  const [changing, setChanging] = useState(false)
  return <div className="report-detail-grid account-settings">
    <section className="card padded"><div className="account-identity"><Avatar name={user.name} /><div><h2>{user.name}</h2><p>{user.email}</p></div><Badge status="blue">{ROLES[user.role]}</Badge></div>
      <dl className="setting-lines"><div><dt>部门</dt><dd>{user.department || '未分配'}</dd></div><div><dt>职务</dt><dd>{user.title || '未填写'}</dd></div><div><dt>账号类型</dt><dd>{user.demoAccount ? '演示角色' : '组织账号'}</dd></div></dl>
      {user.role === 'hr' && <a className="row-action" href="#/organization">维护组织与员工<ArrowRight size={15} aria-hidden="true" /></a>}
    </section>
    <section className="card padded"><h2><KeyRound size={18} aria-hidden="true" />登录安全</h2><p>{user.demoAccount ? '此角色通过演示入口登录。' : '修改密码后，其他设备和浏览器中的会话将失效。'}</p>
      <div className="account-actions">{!user.demoAccount && <Button icon={KeyRound} kind="primary" onClick={() => setChanging(true)}>修改密码</Button>}<Button icon={LogOut} onClick={logout}>退出登录</Button></div>
    </section>
    {changing && <PasswordForm onSaved={(profile) => { onSaved(profile); setChanging(false); toast('密码已更新。') }} onCancel={() => setChanging(false)} />}
  </div>
}
