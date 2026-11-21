import { useDeferredValue, useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, BadgeCheck, BookOpen, CalendarDays, Check, ChevronRight, ClipboardCheck, FileCheck2, FileText, GitBranch, History, LockKeyhole, MessagesSquare, Plus, Search, ShieldAlert, ShieldCheck, Upload } from 'lucide-react'
import { CATEGORIES, COVERAGE_NOTICE, PRIVACY_NOTICE, ROLES, STAGES } from '../shared/catalog.mjs'
import { api, AuditPager, Badge, Button, Dialog, Empty, ErrorNote, fileBase64, Heading, navigate, positionPath, SearchInput, Skeleton, Sources, useAudit, useLoad, whenLabel } from './ui.jsx'
import { Interview, Exam } from './Verification.jsx'
import { Letter, Report } from './Results.jsx'

const icons = [GitBranch, MessagesSquare, BookOpen, ClipboardCheck, FileText, FileCheck2]
const detailFields = [['when', '何时用'], ['location', '位置'], ['contact', '找谁'], ['exception', '例外'], ['request', '申请方式']]
const materialTypes = ['岗位说明', '组织架构', '权限清单', '历史交接', '项目或工单', '手工记录']
const participants = ['owner', 'leaver', 'successor']

function ConsentDialog({ position, ai, onClose, act, busy, error }) {
  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (await act('consent', { privacy: form.has('privacy'), restricted: form.has('restricted'), model: form.has('model') }, '已保存授权。')) onClose()
  }
  return <Dialog title="交接告知与授权" detail="授权范围仅适用于当前岗位。" onClose={onClose} busy={busy}>
    <form onSubmit={submit} className="form-stack"><div className="notice notice--blue"><ShieldCheck size={19} /><p>{PRIVACY_NOTICE}</p></div>
      <label className="check-row"><input type="checkbox" name="privacy" required defaultChecked={position.consents?.privacy} />已阅读告知，同意处理本次交接所需信息。</label>
      <label className="check-row"><input type="checkbox" name="restricted" defaultChecked={position.consents?.restricted} />单独同意处理本次交接的受限信息及手写签名。</label>
      {ai && <label className="check-row"><input type="checkbox" name="model" defaultChecked={position.consents?.model} />同意将预处理后的公开级交接材料交由组织配置的模型服务处理。</label>}
    <ErrorNote message={error} /><div className="dialog-actions"><Button onClick={onClose} disabled={busy}>返回</Button><Button type="submit" kind="primary" busy={busy}>保存授权</Button></div>
    </form>
  </Dialog>
}

export function ExportDialog({ scope, position, act, busy, error, close }) {
  async function submit(event) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    if (await act('requestExport', { scope, format: values.get('format') ?? 'pdf', redacted: values.get('redacted') !== 'full' }, '申请已提交，可在设置查看审批进度。')) close()
  }
  return <Dialog title="申请导出" detail="审批后可下载带水印的当前版本。" onClose={close} busy={busy}>
    <form className="form-stack" onSubmit={submit}>
      <label>导出格式<select name="format"><option value="pdf">PDF 文件</option>{scope === 'pack' && <option value="md">Markdown</option>}</select></label>
      <label>数据范围<select name="redacted"><option value="redacted">脱敏件，适用于外部分享</option>{position.consents?.restricted && <option value="full">受限件，限授权人员</option>}</select></label>
      <ErrorNote message={error} /><div className="dialog-actions"><Button onClick={close} disabled={busy}>取消</Button><Button type="submit" kind="primary" busy={busy}>提交审批</Button></div>
    </form>
  </Dialog>
}

function AssetEditor({ asset, category, position, user, act, onClose, busy, error }) {
  const [level, setLevel] = useState(asset.level ?? 'S1')
  const [importance, setImportance] = useState(asset.importance ?? '一般')
  const editable = position.flags.edit && !asset.masked && Boolean(position.consents?.privacy)
  const canMarkCritical = user.role === 'owner' && position.stage === 'assets'
  async function submit(event, confirmed) {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) return
    const values = Object.fromEntries(new FormData(event.currentTarget))
    const payload = { ...values, assetId: asset.id, critical: canMarkCritical ? importance === '关键' : Boolean(asset.critical), importance, level, confirmed,
      resolveConflict: Boolean(values.resolveConflict) }
    if (await act('asset', payload, confirmed ? '条目已确认。' : '条目草稿已保存。')) onClose()
  }
  return <Dialog title={asset.id ? asset.title : '新增资产条目'} detail="记录可执行的处置方式，并标明可核查的出处。" onClose={onClose} busy={busy} wide>
    <form className="form-stack" onSubmit={(event) => submit(event, event.nativeEvent.submitter?.value === 'confirm')}>
      <div className="form-grid"><label>资产名称<input name="title" defaultValue={asset.title ?? ''} maxLength={90} required disabled={!editable} autoFocus /></label><label>资产类别<select name="category" defaultValue={asset.category ?? category ?? CATEGORIES[0]} disabled={!editable}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <div className="form-grid"><label>重要性<select aria-label="重要性" value={importance} onChange={(event) => setImportance(event.target.value)} disabled={!editable || !canMarkCritical}><option>一般</option><option>重要</option><option>关键</option></select></label>
        <label>敏感等级<select aria-label="敏感等级" value={level} onChange={(event) => setLevel(event.target.value)} disabled={!editable}><option value="S1">S1 · 公开</option><option value="S2">S2 · 受限</option><option value="S3">S3 · 高危，仅记录访问路径</option></select></label></div>
      {level === 'S3' && <div className="notice notice--amber"><LockKeyhole size={18} /><div>请填写保存位置、持有人和申请方式。禁止填写凭证原值或上传图片。</div></div>}
      <div className="form-grid" key={level}>{detailFields.filter(([key]) => level === 'S3' ? ['location', 'contact', 'request'].includes(key) : key !== 'request').map(([key, label]) => <label key={key}>{key === 'contact' && level === 'S3' ? '持有人' : label}<textarea name={key} rows={2} defaultValue={asset.detail?.[key] ?? ''} disabled={!editable} maxLength={key === 'contact' ? 240 : 1200} /></label>)}</div>
      {level !== 'S3' && <><div className="form-grid"><label>补充来源<input name="locator" placeholder="文件名称与页码、系统记录位置" disabled={!editable} maxLength={300} /></label><label>证据链接<input name="link" type="url" placeholder="https://" disabled={!editable} maxLength={1000} /></label></div>
        {asset.conflict && user.role === 'owner' && <label className="check-row"><input type="checkbox" name="resolveConflict" />已核对新来源，解决证据矛盾。</label>}<Sources items={asset.sources} />
      </>}
      <ErrorNote message={error} /><div className="dialog-actions"><Button onClick={onClose} disabled={busy}>关闭</Button>{editable && <><Button type="submit" busy={busy} value="draft">保存草稿</Button>{user.role === 'owner' && <Button type="submit" busy={busy} value="confirm" kind="primary" icon={Check}>确认条目</Button>}</>}</div>
    </form>
  </Dialog>
}

function MaterialDialog({ close, act, busy, error }) {
  const [mode, setMode] = useState('file')
  const [local, setLocal] = useState('')
  const [reading, setReading] = useState(false)
  async function submit(event) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    setReading(true)
    setLocal('')
    try {
      const file = values.get('file')
      const input = { name: mode === 'file' ? file.name : values.get('name'), type: values.get('type'), level: values.get('level'), redacted: values.has('redacted') }
      if (mode === 'file') input.base64 = await fileBase64(file, 20 * 1024 * 1024)
      else input.text = values.get('text')
      if (await act('material', input, '已处理材料，请核对带出处的资产建议。')) close()
    } catch (failure) { setLocal(failure.message) } finally { setReading(false) }
  }
  return <Dialog title="导入盘点材料" detail="材料解析后保留核查所需片段。请移除高危原值。" onClose={close} busy={busy || reading}>
    <form onSubmit={submit} className="form-stack">
      <div className="segmented"><button type="button" aria-pressed={mode === 'file'} onClick={() => setMode('file')}>上传文件</button><button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>手工粘贴</button></div>
      <div className="form-grid"><label>材料类型<select name="type">{materialTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>敏感等级<select name="level"><option value="S1">S1 · 公开</option><option value="S2">S2 · 受限</option></select></label></div>
      {mode === 'file' ? <label className="upload-box"><Upload size={20} />选择 PDF、DOCX、TXT、MD 或 CSV<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.csv" required /><small>单件最多 20 MB。扫描件和加密文件可改为手工粘贴。</small></label>
        : <><label>材料名称<input name="name" required maxLength={150} /></label><label>材料正文<textarea name="text" required rows={7} maxLength={60000} placeholder="按段粘贴 JD、权限清单或历史交接内容。" /></label></>}
      <label className="check-row"><input type="checkbox" name="redacted" required />我已核对材料，移除了凭证和底价等高危信息。</label>
      {busy && <div className="notice notice--blue" role="status"><FileText size={17} />正在提取带页码或段号的建议。大文件预计需要几分钟。</div>}
      <ErrorNote message={local || error} /><div className="dialog-actions"><Button onClick={close} disabled={busy || reading}>关闭</Button><Button type="submit" kind="primary" busy={busy || reading}>提取资产建议</Button></div>
    </form>
  </Dialog>
}

function assetState(asset) {
  if (asset.conflict) return ['amber', '证据矛盾']
  if (asset.masked) return ['pending', '受限']
  if (!asset.confirmed) return asset.sources.length ? ['amber', '待确认'] : ['pending', '缺少证据']
  if (Date.now() - Date.parse(asset.updatedAt) > 90 * 86400000) return ['amber', '证据过期']
  return ['green', '已确认']
}

function Assets({ position, user, busy, act, error, openConsent, openDialog, closeDialog, dialog }) {
  const [category, setCategory] = useState('')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const items = position.assets.filter((asset) => (!category || asset.category === category) && (filter === 'all' || filter === 'critical' && asset.critical || filter === 'pending' && !asset.confirmed || filter === 'conflict' && asset.conflict)
    && `${asset.title} ${asset.detail.contact ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const pending = position.assets.filter((asset) => asset.sources.length && !asset.confirmed).length
  const verified = position.assets.filter((asset) => asset.confirmed && !asset.conflict).length
  const panel = (asset) => { setSelected(asset); openDialog('asset') }
  function editGuard(next) { if (!position.consents?.privacy) openConsent(); else next() }
  return <>
    <div className="section-heading"><div><h2>岗位资产地图</h2><p>已确认 {verified} / {position.assets.length} 项 · {position.criticalTotal} 个必考关键项</p></div><div className="heading-actions">
      {position.flags.edit && <><Button icon={Upload} onClick={() => editGuard(() => openDialog('materials'))}>导入材料</Button><Button icon={Plus} kind="primary" onClick={() => editGuard(() => panel({}))}>新增条目</Button></>}
    </div></div>
    {pending > 0 && <div className="notice notice--amber"><ShieldAlert size={19} /><div><b>{pending} 条带证据的建议待确认。</b> 核对出处和处置方式后，将条目纳入可交接范围。</div><Button onClick={() => { setCategory(''); setFilter('pending'); setQuery('') }}>查看建议</Button></div>}
    {position.materials.length > 0 && <details className="card inline-details"><summary>材料解析记录 <span>{position.materials.length} 份</span></summary><div className="material-list">{position.materials.map((item) => <div key={item.id}><FileText size={17} /><div><b>{item.name}</b><p>{item.message}{item.blocked ? ` 已拦截 ${item.blocked} 段疑似高危片段。` : ''}</p></div><Badge status={item.status === 'parsed' ? 'green' : 'amber'}>{item.status === 'parsed' ? `${item.suggestions.length} 条建议` : '需人工补录'}</Badge></div>)}</div></details>}
    {position.assets.length ? <div className="asset-grid"><aside className="card category-list" aria-label="资产分类"><h3>资产类别</h3>{[['', '全部资产'], ...CATEGORIES.map((name) => [name, name])].map(([key, name]) => <button className={category === key ? 'is-selected' : ''} type="button" key={name} onClick={() => setCategory(key)} aria-pressed={category === key}><span>{name}</span><b>{key ? position.assets.filter((asset) => asset.category === key).length : position.assets.length}</b></button>)}</aside>
      <section className="card table-panel"><div className="table-tools"><SearchInput value={query} onChange={setQuery} icon={Search} placeholder="搜索条目或负责人" /><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="筛选资产"><option value="all">全部条目</option><option value="critical">关键项</option><option value="pending">待确认</option><option value="conflict">证据矛盾</option></select></div>
        {items.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>资产条目</th><th>重要性</th><th>证据状态</th><th>找谁</th><th>操作</th></tr></thead><tbody>{items.map((asset) => {
          const [status, label] = assetState(asset)
          return <tr key={asset.id}><td><button type="button" className="text-button table-name" onClick={() => panel(asset)}>{asset.title}</button><small className="row-detail">{asset.category} · {asset.level}</small></td><td>{asset.critical ? <Badge status="red">关键</Badge> : asset.importance}</td><td><Badge status={status}>{label}</Badge></td><td>{asset.detail.contact || '—'}</td><td><button type="button" className="text-button" onClick={() => panel(asset)}>{position.flags.edit && !asset.masked ? '维护' : '查看'}<ChevronRight size={14} /></button></td></tr>
        })}</tbody></table></div> : <Empty title="暂无符合条件的资产" detail="尝试更换资产类别或筛选条件。" />}
        <div className="table-footer"><span>{items.length} 个条目</span><span>证据有效期 90 天</span></div>
      </section></div> : <section className="card"><Empty icon={LockKeyhole} title="闭卷阶段已锁定资产" detail="完成闭卷题后，可在开卷阶段查阅交接包。" /></section>}
    {position.stage === 'assets' && user.role === 'owner' && <div className="stage-callout card"><div><strong>确认初始盘点后开始访谈</strong><p>访谈将优先核对证据缺口和关键事项。</p></div><Button kind="primary" icon={ArrowRight} busy={busy} disabled={!verified} title={!verified ? '请先确认至少一条资产' : undefined} onClick={async () => { const next = await act('inventory', {}, '已确认资产地图。'); if (next) navigate(positionPath(next, 'interview')) }}>确认盘点</Button></div>}
    {dialog === 'asset' && selected && <AssetEditor asset={selected} category={category} position={position} user={user} act={act} onClose={closeDialog} busy={busy} error={error} />}
    {dialog === 'materials' && <MaterialDialog close={closeDialog} act={act} busy={busy} error={error} />}
  </>
}

function PackCards({ assets, expanded }) {
  return <div className="pack-list">{assets.map((asset) => <details key={asset.id} className="card pack-entry" open={expanded ? true : undefined}><summary><div><b>{asset.title}</b><span>{asset.category} · {asset.level}{asset.detail.contact ? ` · 找 ${asset.detail.contact}` : ''}</span></div>{asset.critical && <Badge status="red">关键</Badge>}</summary><div className="pack-entry-body"><dl className="detail-grid">{detailFields.filter(([key]) => asset.detail[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{asset.detail[key]}</dd></div>)}</dl><h3>证据来源</h3><Sources items={asset.sources} /><small className="muted">更新于 {whenLabel(asset.updatedAt)}</small></div></details>)}</div>
}

function Pack({ position, user, busy, act, error, openDialog, closeDialog, dialog }) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const allowed = position.flags.pack && position.consents?.privacy
  const results = useLoad(allowed ? `/positions/${position.id}/pack?q=${encodeURIComponent(deferred.trim())}` : null, [])
  const [category, setCategory] = useState('')
  const visible = results.data.filter((asset) => !category || asset.category === category)
  return <>
    <div className="section-heading"><div><h2>接班人交接包</h2><p>查找事项的处置路径、责任人和证据。</p></div>{allowed && <Button icon={ArrowDownToLine} onClick={() => openDialog('exportPack')}>申请导出</Button>}</div>
    {!allowed ? <><section className="card"><Empty icon={BookOpen} title={position.stage === 'pack' ? '交接包草稿待发布' : '交接包暂不可见'} detail={position.stage === 'pack' ? `已整理 ${position.packPreview.length} 项可见条目，核对后可发布。` : '满足阶段和授权要求后，可查看已确认的处置路径。'}>
      {position.stage === 'pack' && user.role === 'owner' && <Button kind="primary" icon={BadgeCheck} busy={busy} onClick={() => act('publishPack', {}, '交接包已发布并通知接班人。')}>发布交接包</Button>}
      <a className="button button--secondary" href={positionPath(position, 'assets')}>核对资产地图</a></Empty></section><PackCards assets={position.packPreview} /></> : <>
      <section className="card pack-toolbar"><SearchInput value={query} onChange={setQuery} icon={Search} placeholder="搜索遇到什么事、找谁或去哪" /><select aria-label="按类别筛选交接包" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部类别</option>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></section>
      <ErrorNote message={results.error} retry={results.refresh} />{results.loading && !results.data.length ? <Skeleton /> : visible.length ? <PackCards assets={visible} expanded={query.trim() && visible.length <= 3} /> : <section className="card"><Empty title="没有找到匹配条目" detail="已确认的条目才会纳入交接包。" /></section>}
    </>}
    {dialog === 'exportPack' && <ExportDialog scope="pack" position={position} act={act} busy={busy} error={error} close={closeDialog} />}
  </>
}

function PositionHistory({ positionId, close }) {
  const events = useAudit(positionId)
  return <Dialog title="岗位操作记录" onClose={close}><ErrorNote message={events.error} retry={events.refresh} />
    {events.loading ? <Skeleton /> : <div className="dialog-list">{events.data.map((event) => <div className="list-link static-link" key={event.id}><History size={17} /><span><strong>{event.action}</strong><small>{event.actorName || event.actor} · {whenLabel(event.at)}{event.version ? ` · v${event.version}` : ''}</small></span></div>)}</div>}<AuditPager audit={events} />
  </Dialog>
}

export default function Workspace({ positionId, stage, user, ai, refresh, toast }) {
  const record = useLoad(`/positions/${encodeURIComponent(positionId)}`)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState('')
  const position = record.data
  const scoring = position?.attempts.at(-1)?.phase === 'scoring'
  const selectedStage = STAGES.some(([key]) => key === stage) ? stage : position?.stage === 'archived' ? 'letter' : position?.stage ?? 'assets'
  useEffect(() => { setError(''); setDialog('') }, [selectedStage])
  useEffect(() => {
    if (!scoring) return undefined
    const timer = setInterval(record.refresh, 1300)
    return () => clearInterval(timer)
  }, [scoring])
  async function act(name, payload = {}, message = '', refreshOverview = true) {
    setError('')
    setBusy(true)
    try {
      const result = await api(`/positions/${encodeURIComponent(positionId)}/${name}`, payload)
      record.setData(result)
      if (refreshOverview) refresh()
      if (message) toast(message)
      return result
    } catch (failure) { setError(failure.message); return null } finally { setBusy(false) }
  }
  function openDialog(name) { setError(''); setDialog(name) }
  function closeDialog() { setDialog(''); setError('') }
  if (record.error) return <ErrorNote message={record.error} retry={record.refresh} />
  if (!position) return <Skeleton />
  const currentIndex = position.stage === 'archived' ? 6 : STAGES.findIndex(([key]) => key === position.stage)
  const childProps = { position, user, ai, busy, act, error, openDialog, closeDialog, dialog, openConsent: () => openDialog('consent'), refresh: record.refresh }
  return <div className="workspace">
    <a className="back-link" href="#/positions"><ArrowLeft size={16} />岗位列表</a>
    <Heading title={position.title} description={`${position.department} · ${position.actors.leaver.name} → ${position.actors.successor.name}`}>
      <Button icon={History} onClick={() => openDialog('history')}>留痕</Button>{participants.includes(user.role) && <Button icon={ShieldCheck} onClick={() => openDialog('consent')}>授权</Button>}
    </Heading>
    <div className="workspace-meta"><Badge status={position.status} /><span><CalendarDays size={16} />{position.due} 交接</span><span>{ROLES.owner} · {position.actors.owner.name}</span><span className="version-label">记录 v{position.version}</span></div>
    <nav aria-label="交接步骤" className="stage-tabs">{STAGES.map(([key, label], index) => {
      const Icon = icons[index]
      return <a className={`${selectedStage === key ? 'stage-tab is-active' : 'stage-tab'} ${index < currentIndex ? 'is-complete' : ''}`} key={key} href={positionPath(position, key)} aria-current={selectedStage === key ? 'step' : undefined}><span>{index < currentIndex ? <Check size={16} /> : <Icon size={16} />}</span>{label}</a>
    })}</nav>
    {participants.includes(user.role) && !position.consents?.privacy && <div className="notice notice--blue"><LockKeyhole size={18} /><div>请先阅读本次交接的用途和可见范围。</div><Button onClick={() => openDialog('consent')}>阅读并授权</Button></div>}
    {!dialog && <ErrorNote message={error} />}
    {selectedStage === 'assets' ? <Assets {...childProps} /> : selectedStage === 'interview' ? <Interview {...childProps} /> : selectedStage === 'pack' ? <Pack {...childProps} /> : selectedStage === 'exam' ? <Exam {...childProps} /> : selectedStage === 'report' ? <Report {...childProps} /> : <Letter {...childProps} />}
    {selectedStage === 'report' && <p className="coverage-note">{COVERAGE_NOTICE}</p>}
    {dialog === 'consent' && <ConsentDialog {...childProps} onClose={closeDialog} />}
    {dialog === 'history' && <PositionHistory positionId={position.id} close={closeDialog} />}
  </div>
}
