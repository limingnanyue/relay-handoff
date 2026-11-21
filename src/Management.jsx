import { useEffect, useState } from 'react'
import { Activity, ArrowDownToLine, ArrowRight, BriefcaseBusiness, Check, ClipboardCheck, ClipboardList, Database, FileCheck2, FileText, GitBranch, Info, KeyRound, MessagesSquare, RefreshCw, Search, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { version } from '../package.json'
import { CATEGORIES, ROLES, TEMPLATE_NAME } from '../shared/catalog.mjs'
import { AccountSettings } from './Account.jsx'
import { api, AuditPager, Badge, Button, currency, Dialog, Empty, ErrorNote, Heading, SearchInput, Skeleton, useAudit, useLoad, whenLabel } from './ui.jsx'

export function Templates({ create }) {
  const templates = useLoad('/templates', [])
  const [selected, setSelected] = useState(CATEGORIES[0])
  return <>
    <Heading title="模板库" description="用已整理的岗位清单启动盘点。" />
    <ErrorNote message={templates.error} retry={templates.refresh} />
    {templates.loading ? <Skeleton /> : <><section className="card template-hero"><span className="tile-icon tone-blue"><BriefcaseBusiness size={25} /></span><div><Badge status="blue">试点模板</Badge><h2>{TEMPLATE_NAME}</h2><p>覆盖职责、权限、关系、例外与周期节点，可按交接范围调整。</p><div className="template-stats"><span><b>{templates.data.length}</b> 个资产条目</span><span><b>{CATEGORIES.length}</b> 个资产类别</span><span><b>{templates.data.filter((asset) => asset.critical).length}</b> 个必考候选</span></div></div>{create && <Button icon={ArrowRight} kind="primary" onClick={create}>使用模板</Button>}</section>
      <section className="card padded"><h2>盘点条目预览</h2><div className="chips-scroll">{CATEGORIES.map((name) => <button type="button" aria-pressed={selected === name} className={`filter-chip ${selected === name ? 'is-selected' : ''}`} key={name} onClick={() => setSelected(name)}>{name}</button>)}</div><ul className="template-list">{templates.data.filter((entry) => entry.category === selected).map((entry) => <li key={entry.id}><ClipboardList size={17} /><span>{entry.title}</span><Badge status={entry.critical ? 'red' : 'pending'}>{entry.importance}</Badge></li>)}</ul></section></>}
  </>
}

export function Audit() {
  const audit = useAudit()
  const [query, setQuery] = useState('')
  const events = audit.data.filter((entry) => `${entry.action} ${entry.actor} ${entry.subject}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <><Heading title="审计视图" description="追踪资产修改、人工复核、导出和签署归档。"><Button icon={ShieldCheck} onClick={audit.reload}>刷新日志</Button></Heading>
    <div className="notice notice--blue"><ShieldCheck size={19} />审计事件追加记录，按操作时间和业务版本追溯。</div><ErrorNote message={audit.error} retry={audit.refresh} />
    {audit.loading && !audit.data.length ? <Skeleton /> : <section className="card table-panel"><div className="panel-title"><h2>访问与变更记录</h2><span className="table-count">本页 {events.length} 项</span></div><div className="table-tools"><SearchInput icon={Search} value={query} onChange={setQuery} placeholder="筛选本页的操作、人员或对象" /></div>
      {events.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>时间</th><th>操作</th><th>操作人</th><th>对象</th><th>版本</th><th>网络</th></tr></thead><tbody>{events.map((entry) => <tr key={entry.id}>
        <td>{whenLabel(entry.at)}</td><td><b>{entry.action}</b></td><td>{entry.actorName || (entry.actor === 'system' ? '系统' : entry.actor)}</td><td>{entry.subject.length > 16 || entry.subject.startsWith('demo-') ? <a href={`#/position/${entry.subject}`} title={entry.subject}>{entry.subject.length > 16 ? `${entry.subject.slice(0, 12)}…` : entry.subject}</a> : entry.subject}</td><td>{entry.version ? `v${entry.version}` : '—'}</td><td>{entry.detail.network || '—'}</td>
      </tr>)}</tbody></table></div> : <Empty title="没有匹配的审计记录" />}<AuditPager audit={audit} /></section>}
  </>
}

const scopeLabel = { pack: '交接包', report: '可交接性报告', letter: '确认书', monthly: '岗位月报' }

function Monitor({ monitor, modelEnabled }) {
  const percent = (value) => value === null ? '暂无样本' : (value * 100).toFixed(1) + '%'
  const latency = (value) => value === null ? '暂无样本' : value + ' 毫秒'
  return <>
    {monitor.alerts.map((alert) => <div className="notice notice--amber" role="status" key={alert.label}>{alert.label}</div>)}
    <div className="report-detail-grid">
      <section className="card padded"><h2>产品看板</h2><p>截至 {whenLabel(monitor.checkedAt)} · 当前组织</p><dl className="setting-lines">
        <div><dt>本月验收通过且有独立替代者</dt><dd>{monitor.product.qualifiedThisMonth} 个岗位</dd></div>
        <div><dt>已开始访谈的完成率</dt><dd>{percent(monitor.product.interviewCompletionRate)}</dd></div>
        <div><dt>待处理后台任务</dt><dd>{monitor.backlog} 项</dd></div>
      </dl></section>
      <section className="card padded"><h2>模型成本看板</h2><p>最近 24 小时 · {modelEnabled ? '已连接模型服务' : '规则与人工模式'}</p><dl className="setting-lines">
        <div><dt>请求 / 重试</dt><dd>{monitor.model.requests} / {monitor.model.retries}</dd></div>
        <div><dt>令牌 / 估计成本</dt><dd>{monitor.model.tokens} / {currency(monitor.model.cost)}</dd></div>
        <div><dt>请求失败率 / 缓存命中率</dt><dd>{percent(monitor.model.failureRate)} / {percent(monitor.model.cacheHitRate)}</dd></div>
        <div><dt>模型调用 P95</dt><dd>{latency(monitor.model.p95Ms)}</dd></div>
      </dl></section>
    </div>
    <div className="report-detail-grid">
      <section className="card padded"><h2>质量看板</h2><dl className="setting-lines">
        <div><dt>首考通过率</dt><dd>{percent(monitor.quality.firstPassRate)}</dd></div>
        <div><dt>关键项已核验证据覆盖率</dt><dd>{percent(monitor.quality.evidenceRate)}</dd></div>
        <div><dt>抽检与复核的通过判定变化率</dt><dd>{percent(monitor.quality.reviewDisagreementRate)}</dd></div>
        <div><dt>近 24 小时出现系统异常的岗位占比</dt><dd>{percent(monitor.failureRate)}</dd></div>
      </dl></section>
      <section className="card padded"><h2>各阶段耗时</h2><p>最近 24 小时 · P95</p><dl className="setting-lines">{monitor.stages.map((stage) => <div key={stage.key}><dt>{stage.label} · {stage.samples} 次</dt><dd>{latency(stage.p95Ms)}</dd></div>)}</dl></section>
    </div>
  </>
}

const settingsCategories = [
  ['account', '账户与安全', UserRound], ['approvals', '导出审批', FileCheck2],
  ['data', '数据与权限', Database], ['monitor', '运行监控', Activity], ['about', '关于接棒', Info],
]

const aboutCapabilities = [
  ['资产地图', '沉淀岗位资产、证据和敏感等级。', GitBranch],
  ['访谈与交接包', '把关键经验整理成可复核的交接记录。', MessagesSquare],
  ['验收与报告', '用题目、证据和风险状态验证接班结果。', ClipboardCheck],
  ['审批与留痕', '导出、签署和操作记录按角色受控访问。', ShieldCheck],
]

function AboutSettings() {
  return <section className="card about-page" aria-labelledby="about-title">
    <div className="about-header"><img src="/relay-icon.svg" alt="" width="56" height="56" /><div><h2 id="about-title">接棒 Relay</h2><p>关键岗位交接与验收平台</p></div></div>
    <div className="about-details">
      <p>从岗位资产盘点、访谈和交接包，到接班人验收与签署归档，让每一步都有据可查。</p>
      <div className="about-capabilities" aria-label="产品能力">{aboutCapabilities.map(([title, detail, Icon]) => <div className="about-capability" key={title}><span className="tile-icon tone-blue"><Icon size={17} aria-hidden="true" /></span><div><strong>{title}</strong><p>{detail}</p></div></div>)}</div>
      <dl className="about-version"><dt>当前版本</dt><dd>{version}</dd></dl>
    </div>
  </section>
}

export function Settings({ category, user, setUser, toast, refresh, positions, logout }) {
  const categories = settingsCategories.filter(([key]) => key !== 'monitor' || user.role === 'hr')
  const active = categories.some(([key]) => key === category) ? category : 'account'
  const workspaceActive = active !== 'account' && active !== 'about'
  const [workspaceEnabled, setWorkspaceEnabled] = useState(workspaceActive)
  useEffect(() => { if (workspaceActive) setWorkspaceEnabled(true) }, [workspaceActive])
  const settings = useLoad(workspaceEnabled ? '/settings' : null)
  return <>
    <Heading title="设置" description="管理账户、导出审批和数据留存，查看产品信息。">
      {workspaceActive && settings.data && <Button icon={RefreshCw} busy={settings.loading} onClick={settings.refresh}>{settings.loading ? '刷新中…' : '刷新数据'}</Button>}
    </Heading>
    <nav className="settings-nav" aria-label="设置分类">{categories.map(([key, label, Icon]) => <a key={key} href={`#/settings/${key}`} aria-current={key === active ? 'page' : undefined}><Icon size={17} aria-hidden="true" />{label}</a>)}</nav>
    {active === 'account' ? <AccountSettings user={user} onSaved={setUser} toast={toast} logout={logout} />
      : active === 'about' ? <AboutSettings />
      : <WorkspaceSettings key={active} category={active} settings={settings} user={user} toast={toast} refresh={refresh} positions={positions} />}
  </>
}

function WorkspaceSettings({ category, settings, user, toast, refresh, positions }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [decision, setDecision] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const entries = [...(settings.data?.exports ?? []), ...(settings.data?.monthly ?? [])].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
  async function run(path, data, message) {
    setBusy(true)
    setError('')
    try { await api(path, data); settings.refresh(); refresh(); toast(message); return true }
    catch (failure) { setError(failure.message); return false } finally { setBusy(false) }
  }
  const doRetention = async (event) => { event.preventDefault(); await run('/settings/retention', { months: Number(new FormData(event.currentTarget).get('months')) }, '留存期限已更新。') }
  const exportPath = (entry) => entry.positionId ? `/positions/${entry.positionId}/exports/${entry.id}` : `/settings/monthly/${entry.id}`
  return <>
    {!decision && !deleting && !confirmDelete && <ErrorNote message={error || settings.error} retry={settings.error ? settings.refresh : undefined} />}
    {!settings.data ? !settings.error && <Skeleton /> : <>
      {category === 'approvals' && <section className="card table-panel"><div className="panel-title"><div><h2><FileCheck2 size={19} />导出审批</h2><p>审批通过后，申请人可下载加水印的文件。</p></div><span className="table-count">{entries.filter((entry) => entry.state === 'pending').length} 项待审批</span></div>
        {entries.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>导出内容</th><th>范围</th><th>申请人</th><th>状态</th><th>操作</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}>
          <td><b>{entry.positionTitle}</b><small className="row-detail">{scopeLabel[entry.scope]} · {entry.format.toUpperCase()} · v{entry.version}</small></td><td>{entry.redacted ? '脱敏件' : '受限件'}</td><td>{entry.requesterName}<small className="row-detail">{whenLabel(entry.requestedAt)}</small></td><td><Badge status={entry.state === 'approved' ? 'green' : entry.state === 'denied' ? 'red' : 'amber'}>{entry.state === 'approved' ? '已批准' : entry.state === 'denied' ? '已拒绝' : '待审批'}</Badge>{entry.reason && <small className="row-detail">{entry.reason}</small>}</td>
          <td>{entry.state === 'pending' && entry.canApprove ? <button type="button" className="text-button" onClick={() => { setError(''); setDecision(entry) }}>处理申请</button> : entry.state === 'approved' && entry.requestedBy === user.id ? <a className="row-action" href={`/api${exportPath(entry)}`} download><ArrowDownToLine size={16} />下载文件</a> : '—'}</td>
        </tr>)}</tbody></table></div> : <Empty title="暂无导出申请" detail="可从交接包、报告、确认书或总览提交申请。" icon={FileCheck2} />}
      </section>}
      {category === 'data' && <div className="report-detail-grid settings-data"><section className="card padded"><h2><KeyRound size={18} />敏感分级与角色</h2><dl className="setting-lines"><div><dt>S1 · 公开</dt><dd>按岗位和角色分配可见范围</dd></div><div><dt>S2 · 受限</dt><dd>受限授权、审批及导出水印</dd></div><div><dt>S3 · 高危</dt><dd>仅保存访问路径、持有人、申请方式</dd></div><div><dt>当前角色</dt><dd>{ROLES[user.role]}</dd></div></dl></section>
      <section className="card padded"><h2><Database size={18} />数据留存</h2><p>岗位归档后按组织配置保留 {settings.data.retentionMonths} 个月。</p>
        {user.role === 'hr' && <form onSubmit={doRetention} className="form-inline"><label>期限（月）<input name="months" type="number" min="1" max="60" key={settings.data.retentionMonths} defaultValue={settings.data.retentionMonths} required /></label><Button type="submit" kind="primary" busy={busy}>保存期限</Button></form>}
        {['owner', 'leaver', 'successor'].includes(user.role) && <Button icon={Trash2} onClick={() => { setError(''); setDeleting(true) }} disabled={!positions.length}>申请删除岗位数据</Button>}
        {settings.data.deletions.map((item) => <div className="deletion-row" key={item.id}><div><b>{item.title}</b><small>{item.reason} · {whenLabel(item.at)}</small></div>{user.role === 'hr' ? <Button kind="danger" onClick={() => { setError(''); setConfirmDelete(item) }}>核对并批准</Button> : <Badge status="amber">待审核</Badge>}</div>)}
      </section></div>}
      {category === 'monitor' && settings.data.monitor && <Monitor monitor={settings.data.monitor} modelEnabled={settings.data.ai} />}
    </>}
    {decision && <Dialog title="处理导出申请" detail={`${decision.requesterName} · ${decision.positionTitle} · ${decision.redacted ? '脱敏件' : '受限件'}`} busy={busy} onClose={() => setDecision(null)}><form className="form-stack" onSubmit={async (event) => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      const approve = event.nativeEvent.submitter?.value !== 'deny'
      if (await run(decision.positionId ? `/positions/${decision.positionId}/decideExport` : exportPath(decision), { exportId: decision.id, approve, reason: form.get('reason') }, approve ? '已批准导出。' : '已拒绝导出申请。')) setDecision(null)
    }}><label>审批说明<input name="reason" maxLength={300} placeholder="拒绝申请时须填写原因" /></label><ErrorNote message={error} /><div className="dialog-actions"><Button type="submit" kind="danger" value="deny" busy={busy}>拒绝</Button><Button type="submit" icon={Check} kind="primary" value="approve" busy={busy}>批准下载</Button></div></form></Dialog>}
    {deleting && <Dialog title="申请删除岗位数据" detail="人力资源处理申请前会核对数据保留义务。" busy={busy} onClose={() => setDeleting(false)}><form className="form-stack" onSubmit={async (event) => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      if (await run(`/positions/${form.get('position')}/requestDeletion`, { reason: form.get('reason') }, '已提交数据删除申请。')) setDeleting(false)
    }}><label>岗位<select name="position" required>{positions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>申请原因<textarea name="reason" rows={3} required maxLength={350} /></label><ErrorNote message={error} /><div className="dialog-actions"><Button type="submit" kind="primary" busy={busy}>提交删除申请</Button></div></form></Dialog>}
    {confirmDelete && <Dialog title="批准删除岗位数据" detail={confirmDelete.title} busy={busy} onClose={() => setConfirmDelete(null)}><form className="form-stack" onSubmit={async (event) => {
      event.preventDefault()
      if (await run(`/positions/${confirmDelete.id}/approveDeletion`, { acknowledge: true }, '岗位已停止访问，删除任务已提交。')) setConfirmDelete(null)
    }}><div className="notice notice--red"><Trash2 size={18} />批准后岗位将停止访问，后台清除条目、报告及附件。</div><label className="check-row"><input type="checkbox" required />已核对本岗位的数据留存义务。</label><ErrorNote message={error} /><div className="dialog-actions"><Button type="submit" kind="danger" busy={busy}>批准删除</Button></div></form></Dialog>}
  </>
}
