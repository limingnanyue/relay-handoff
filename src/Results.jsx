import { useState } from 'react'
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, ClipboardCheck, Clock3, FileCheck2, FileText, Gauge, LockKeyhole, PenLine, ShieldAlert, TrendingUp } from 'lucide-react'
import { COVERAGE_NOTICE, ROLES, STATUS } from '../shared/catalog.mjs'
import { Badge, Button, currency, Dialog, Empty, ErrorNote, fileBase64, navigate, positionPath, Sources, whenLabel } from './ui.jsx'
import { ExportDialog } from './Workspace.jsx'

const scoreFields = [['coverage', '覆盖度', 30], ['exam', '验收通过率', 40], ['substitutes', '可替代性', 20], ['freshness', '时效性', 10]]
const resultLabel = { pass: ['green', '通过'], fail: ['red', '未通过'], review: ['amber', '待复核'] }
const teamRoles = ['leaver', 'successor', 'owner']

function RemediationDialog({ finding, onClose, act, busy, error }) {
  async function submit(event) {
    event.preventDefault()
    const payload = Object.fromEntries(new FormData(event.currentTarget))
    if (await act('remediate', { assetId: finding.assetId, ...payload }, '补交接已记录。')) onClose()
  }
  return <Dialog title={`补交接 · ${finding.title}`} detail="记录操作演示或补充材料的证据，接班人可按差距安排补考。" onClose={onClose} busy={busy}>
    <form className="form-stack" onSubmit={submit}>{finding.level !== 'S3' && <label>补交接说明<textarea name="note" rows={4} maxLength={900} required /></label>}
      <label>核查来源<input name="locator" maxLength={300} required placeholder="文件、页码或复核记录" /></label><label>证据链接<input type="url" name="link" placeholder="https://" /></label>
      <ErrorNote message={error} /><div className="dialog-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" kind="primary" busy={busy}>保存补交接</Button></div>
    </form>
  </Dialog>
}

function EstimateDialog({ position, act, busy, error, close }) {
  async function submit(event) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const input = Object.fromEntries(['incident', 'daily', 'riskyDays'].map((key) => [key, Number(values.get(key))]))
    if (await act('estimates', input, '风险金额估算已更新。')) close()
  }
  return <Dialog title="风险金额估算" detail="估算金额为单次事故成本与关键人不可用损失之和。" onClose={close} busy={busy}>
    <form className="form-stack" onSubmit={submit}><label>单次事故成本（元）<input type="number" name="incident" min="0" max="1000000000" step="0.01" defaultValue={position.estimate?.incident ?? 0} required /></label><label>关键人不可用日损失（元）<input type="number" name="daily" min="0" max="1000000000" step="0.01" defaultValue={position.estimate?.daily ?? 0} required /></label><label>预计影响（天）<input type="number" name="riskyDays" min="0" max="365" defaultValue={position.estimate?.riskyDays ?? 0} required /></label>
      <ErrorNote message={error} /><div className="dialog-actions"><Button onClick={close} disabled={busy}>取消</Button><Button type="submit" kind="primary" busy={busy}>保存估算</Button></div></form>
  </Dialog>
}

export function Report({ position, user, act, busy, error, openDialog, closeDialog, dialog }) {
  const [version, setVersion] = useState(null)
  const [finding, setFinding] = useState(null)
  const latest = position.reports.at(-1)
  const report = position.reports.find((item) => item.version === version) ?? latest
  const isLatest = latest?.version === report?.version
  const canFix = isLatest && position.flags.due && ['owner', 'leaver'].includes(user.role)
  const findings = report?.findings.filter((entry) => entry.critical || entry.status !== 'pass') ?? []
  const gaps = report?.findings.filter((entry) => entry.status !== 'pass') ?? []
  const impact = (entry) => entry.critical ? entry.status === 'pass' ? '关键路径已验证' : '阻断交接完成' : '建议主动补充'
  const remediationFor = (item) => position.remediations.filter((entry) => entry.assetId === item.assetId).at(-1)
  return <>
    <div className="section-heading"><div><h2>可交接性报告</h2><p>{report ? `报告第 ${report.version} 版 · ${whenLabel(report.at)} · ${report.confidence}` : '完成考试和抽检后生成报告。'}</p></div><div className="heading-actions">
      {position.reports.length > 1 && <select aria-label="报告版本" value={report?.version ?? ''} onChange={(event) => setVersion(Number(event.target.value))}>{[...position.reports].reverse().map((item) => <option key={item.version} value={item.version}>报告第 {item.version} 版</option>)}</select>}
      {user.role === 'owner' && position.stage !== 'archived' && <Button icon={TrendingUp} onClick={() => openDialog('estimate')}>风险估算</Button>}
      {isLatest && report && <Button icon={ArrowDownToLine} onClick={() => openDialog('exportReport')}>申请导出</Button>}
      {isLatest && report?.passed && <a className="button button--primary" href={positionPath(position, 'letter')}><PenLine size={17} />{position.stage === 'archived' ? '查看确认书' : '进入签署'}</a>}
    </div></div>
    {!report ? <section className="card"><Empty title="报告尚未生成" detail={position.riskReason || '验收和人工复核完成后，可查看指数、关键项和遗留风险。'} icon={Gauge}><a className="button button--secondary" href={positionPath(position, 'exam')}>查看验收进度</a></Empty></section> : <>
      <div className={`notice notice--${report.status}`}><CircleAlert size={21} /><div><strong>{report.failingCritical.length ? `一票否决 · ${report.failingCritical[0].title}未通过` : report.passed ? '验收通过，可由三方确认交接范围' : '当前验收未通过'}</strong><p>{report.failingCritical.length ? '关键项未通过时，报告判红并锁定签署。' : `验收 ${report.examScore} 分 · ${STATUS[report.status]}`}</p></div>{isLatest && position.flags.due && <a href={positionPath(position, 'exam')} className="button button--secondary">补考进度 <ArrowRight size={15} /></a>}</div>
      <section className="card report-hero"><div className="score-ring-panel"><div className={`score-ring score-ring--${report.status}`} style={{ '--ring-progress': `${report.score}%` }} role="img" aria-label={`可交接性指数 ${report.score} 分，${STATUS[report.status]}${report.failingCritical.length ? '，有关键项未通过' : ''}`}><div><strong>{report.score}</strong><small>可交接性指数</small></div></div><Badge status={report.status} /></div>
        <div className="subscores"><h3>指数分项</h3>{scoreFields.map(([key, label, weight]) => <div className="score-component" key={key}><span>{label}</span><div className="progress-track"><div style={{ width: `${report.components[key]}%` }} /></div><b>{report.components[key]}</b><small>权重 {weight}%</small></div>)}</div>
        <div className="report-scope"><h3><ShieldAlert size={17} />覆盖范围</h3><p>已验证 <b>{report.coverage.verified}</b> / {report.coverage.expected} 项</p><p>覆盖 {report.coverage.systems.length} 个可见系统或权限</p><p>{whenLabel(report.coverage.from)} — {whenLabel(report.coverage.to)}</p><small>{report.uncovered.length} 项未覆盖 · 独立替代者 {position.backups} 人</small></div>
      </section>
      <section className="card table-panel"><div className="panel-title"><div><h2>关键项与未通过项</h2><p>点击依据可查看文档位置、访谈记录和核查理由。</p></div><span className="table-count">{findings.length} 项</span></div><div className="table-scroll"><table className="data-table findings-table"><thead><tr><th>条目</th><th>结果</th><th className="numeric">分数</th><th>依据</th><th>影响</th>{canFix && <th>补交接</th>}</tr></thead><tbody>{findings.map((entry) => <tr key={entry.assetId}><td><b>{entry.title}</b>{entry.critical && <span className="row-detail">必考关键项</span>}</td><td><Badge status={resultLabel[entry.status][0]}>{resultLabel[entry.status][1]}</Badge></td><td className="numeric">{entry.score}</td><td><button type="button" className="text-button" onClick={() => { setFinding(entry); openDialog('finding') }}>查看依据</button></td><td>{impact(entry)}</td>{canFix && <td>{entry.status === 'pass' ? '—' : remediationFor(entry) ? <Badge status="green">已补交接</Badge> : <button type="button" className="text-button" onClick={() => { setFinding(entry); openDialog('remediate') }}>记录补交接</button>}</td>}</tr>)}</tbody></table></div></section>
      {report.dependencies.length > 0 && <details className="card inline-details"><summary>关键人依赖 <span>{report.dependencies.length} 项</span></summary><ul className="risk-bullets dependency-list">{report.dependencies.map((entry) => <li key={entry.assetId}><span className="legend-dot amber" /><div><b>{entry.title} · {entry.label}</b><Sources items={[entry.source]} /></div></li>)}</ul></details>}
      <div className="report-detail-grid"><section className="card padded"><h2>遗留风险</h2>{gaps.length ? <ul className="risk-bullets">{gaps.map((entry) => <li key={entry.assetId}><span className={`legend-dot ${entry.critical ? 'red' : 'amber'}`} /><div><b>{entry.title}</b><p>{entry.reason}</p>{remediationFor(entry)?.note && <p>补交接 · {remediationFor(entry).note}</p>}</div></li>)}</ul> : <p className="muted">本次考试没有未通过项。</p>}
        {report.uncovered.length > 0 && <details className="inline-details inline-details--plain"><summary>查看 {report.uncovered.length} 项未覆盖条目</summary><ul>{report.uncovered.map((item) => <li key={item.id}>{item.title}</li>)}</ul></details>}
      </section><section className="card padded"><h2>建议动作</h2><ul className="risk-bullets">
        {gaps.length > 0 && <li><ShieldAlert size={17} /><div><b>核对未通过的处置方式</b><p>补齐证据并演示一次，再按差距复核。</p></div></li>}
        {report.uncovered.length > 0 && <li><FileText size={17} /><div><b>确认覆盖缺口</b><p>将未覆盖条目的处置责任记录在确认书。</p></div></li>}
        <li><ClipboardCheck size={17} /><div><b>核对独立替代者</b><p>已登记 {position.backups} 人。确认他们能独立处理关键事项。</p></div></li>
      </ul>{position.estimate && <div className="estimate-inline"><span>风险金额估算</span><b>{currency(position.estimate.total)}</b></div>}</section></div>
    </>}
    {dialog === 'finding' && finding && <Dialog title={`证据 · ${finding.title}`} onClose={closeDialog}><p>{finding.reason}</p><Sources items={finding.sources} /></Dialog>}
    {dialog === 'remediate' && finding && <RemediationDialog finding={finding} onClose={closeDialog} act={act} busy={busy} error={error} />}
    {dialog === 'estimate' && <EstimateDialog position={position} act={act} busy={busy} error={error} close={closeDialog} />}
    {dialog === 'exportReport' && <ExportDialog scope="report" position={position} act={act} busy={busy} error={error} close={closeDialog} />}
  </>
}

function SignatureDialog({ act, busy, error, close }) {
  const [local, setLocal] = useState('')
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState('')
  async function submit(event) {
    event.preventDefault()
    setReading(true)
    try {
      const values = new FormData(event.currentTarget)
      if (await act('sign', { signature: await fileBase64(values.get('file')), acknowledge: values.has('acknowledge') }, '签署记录已保存。')) close()
    } catch (failure) { setLocal(failure.message) } finally { setReading(false) }
  }
  return <Dialog title="上传手写签名" detail="签署完成后将记录签署时间、角色和对应报告版本。" onClose={close} busy={busy || reading}><form className="form-stack" onSubmit={submit}>
    <label className="upload-box"><PenLine size={20} />手写签名图片<input name="file" type="file" accept="image/png,image/jpeg" required onChange={async (event) => {
      const file = event.target.files[0]
      try { setLocal(''); setPreview(file ? `data:${file.type};base64,${await fileBase64(file)}` : '') } catch (failure) { setLocal(failure.message); setPreview('') }
    }} /><small>PNG 或 JPEG，最多 2 MB。</small></label>
    {preview && <img className="signature-preview" src={preview} alt="待上传的手写签名" />}
    <label className="check-row"><input type="checkbox" name="acknowledge" required />已阅读交接范围、验收结论和遗留风险，确认以本角色签署。</label>
    <ErrorNote message={local || error} /><div className="dialog-actions"><Button onClick={close} disabled={busy || reading}>取消</Button><Button type="submit" icon={Check} kind="primary" busy={busy || reading}>确认签署</Button></div>
  </form></Dialog>
}

export function Letter({ position, user, act, busy, error, openDialog, closeDialog, dialog, openConsent }) {
  const report = position.reports.at(-1)
  const signed = position.signatures.length
  const archived = position.stage === 'archived'
  return <>
    <div className="section-heading"><div><h2>岗位交接确认书</h2><p>确认交接范围与遗留事项责任，记录三方签署。</p></div><div className="heading-actions">
      {archived && <Button icon={ArrowDownToLine} onClick={() => openDialog('exportLetter')}>申请下载</Button>}
      {position.flags.sign && <Button icon={PenLine} kind="primary" onClick={() => position.consents?.restricted ? openDialog('signature') : openConsent()}>上传手写签名</Button>}
    </div></div>
    {!report?.passed ? <section className="card"><Empty title="确认书等待验收通过" detail="关键项通过且报告完成复核后，交接人、接班人和业务负责人分别签署。" icon={LockKeyhole}><a className="button button--secondary" href={positionPath(position, 'report')}>查看报告</a></Empty></section>
      : <article className="card letter"><div className="letter-title"><span className="tile-icon tone-blue"><FileCheck2 size={24} /></span><h2>{position.title} · 交接确认书</h2><p>报告第 {report.version} 版 · {position.department}</p><Badge status={archived ? 'green' : 'amber'}>{archived ? '三方签署完成，已归档' : `待签署 · ${signed}/3`}</Badge></div>
        <section><h3>交接范围与验收结论</h3><p>本次交接验证 {report.coverage.verified} / {report.coverage.expected} 个资产条目。可交接性指数 {report.score} 分，验收 {report.examScore} 分。</p><a href={positionPath(position, 'report')}>查看验收依据 <ArrowRight size={15} /></a></section>
        <section><h3>遗留事项</h3><p>{report.uncovered.length ? `有 ${report.uncovered.length} 项未覆盖，由业务负责人安排补齐，并向接班人说明跟进责任。` : '已覆盖所列资产。'} {report.findings.filter((item) => item.status !== 'pass').length} 项未通过事项的依据与应对措施见报告。</p></section>
        <section><h3>三方责任</h3><p>交接人确认已如实交付所列事项。接班人确认验收记录和支持路径。业务负责人确认遗留事项的处理范围与责任。</p></section>
        <section><h3>签署记录</h3><div className="signature-grid">{teamRoles.map((role) => {
          const signature = position.signatures.find((item) => item.role === role)
          return <div className="signature-block" key={role}><span>{ROLES[role]}</span><b>{position.actors[role].name}</b>{signature?.attachmentId && <img src={`/api/positions/${position.id}/attachments/${signature.attachmentId}`} alt={`${ROLES[role]}的手写签名`} />}{signature ? <small><Check size={14} />{whenLabel(signature.at)} 已签署{signature.demo && '（演示）'}</small> : <small><Clock3 size={14} />待签署</small>}</div>
        })}</div></section><p className="coverage-note">{COVERAGE_NOTICE}</p>
      </article>}
    {dialog === 'signature' && <SignatureDialog act={act} busy={busy} error={error} close={closeDialog} />}
    {dialog === 'exportLetter' && <ExportDialog scope="letter" position={position} act={act} busy={busy} error={error} close={closeDialog} />}
  </>
}
