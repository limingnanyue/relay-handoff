import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight, CircleCheck, FileSearch, LoaderCircle, X } from 'lucide-react'
import { STAGES, STATUS } from '../shared/catalog.mjs'

export async function api(path, input, signal) {
  const response = await fetch(`/api${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: input === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input), signal,
  })
  const result = await response.json().catch(() => ({}))
  if (response.status === 401 && !signal?.aborted && !['/session/login', '/session/demo'].includes(path)) window.dispatchEvent(new Event('relay:session-expired'))
  if (!response.ok) throw Object.assign(new Error(result.error ?? '请求失败，请稍后重试。'), { status: response.status })
  return result
}

export function useLoad(path, initial = null) {
  const [data, setData] = useState(initial)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(path))
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!path) return undefined
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api(path, undefined, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result) }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [path, revision])
  return { data, setData, error, loading, refresh: () => setRevision((value) => value + 1) }
}

export function useAudit(position) {
  const [until, setUntil] = useState(() => new Date().toISOString())
  const [page, setPage] = useState(0)
  const limit = 100
  const audit = useLoad(`/audit?until=${encodeURIComponent(until)}&limit=${limit}&offset=${page * limit}${position ? `&position=${encodeURIComponent(position)}` : ''}`, [])
  return { ...audit, page, setPage, hasNext: audit.data.length === limit,
    reload() { setPage(0); setUntil(new Date().toISOString()); audit.refresh() },
  }
}

export function AuditPager({ audit }) {
  return <div className="table-footer"><span>第 {audit.page + 1} 页</span><div className="heading-actions">
    <Button disabled={!audit.page || audit.loading} onClick={() => audit.setPage(audit.page - 1)}>上一页</Button>
    <Button disabled={!audit.hasNext || audit.loading} onClick={() => audit.setPage(audit.page + 1)}>下一页</Button>
  </div></div>
}

export const navigate = (path) => { window.location.hash = path }
export const positionPath = (position, stage = position.stage) => `#/position/${encodeURIComponent(position.id)}/${stage === 'archived' ? 'letter' : stage}`
export const stageLabel = (stage) => stage === 'archived' ? '已归档' : STAGES.find(([key]) => key === stage)?.[1] ?? '岗位工作台'
export const dayLabel = (value) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(new Date(value)).replace('/', '-') : '—'
export const whenLabel = (value) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—'
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
export const countLabel = (value) => new Intl.NumberFormat('zh-CN').format(value)
export const currency = (value) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(value)

export function Button({ children, icon: Icon, kind = 'secondary', busy = false, className = '', ...props }) {
  return <button type="button" {...props} disabled={busy || props.disabled} className={`button button--${kind} ${className}`}>
    {busy ? <LoaderCircle className="spinner" size={17} aria-hidden="true" /> : Icon ? <Icon size={17} aria-hidden="true" /> : null}{children}
  </button>
}

export function IconButton({ icon: Icon, label, className = '', ...props }) {
  return <button type="button" {...props} className={`icon-button ${className}`} aria-label={label} title={label}><Icon size={19} aria-hidden="true" />{props.children}</button>
}

export function Badge({ status, children, subtle = false }) {
  return <span className={`badge badge--${status ?? 'pending'}${subtle ? ' badge--subtle' : ''}`}><span className="status-dot" aria-hidden="true" />{children || STATUS[status] || '待处理'}</span>
}

export function Avatar({ name, tone = 0, size = '' }) {
  return <span aria-hidden="true" className={`avatar avatar--${tone % 4} ${size && `avatar--${size}`}`}>{[...(name || '接')].slice(-2).join('')}</span>
}

export function Heading({ title, description, eyebrow, children }) {
  return <header className="page-heading">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {children && <div className="heading-actions">{children}</div>}
  </header>
}

export function Empty({ title = '暂无记录', detail, children, icon: Icon = FileSearch }) {
  return <div className="empty"><div className="tile-icon tone-blue"><Icon size={22} /></div><strong>{title}</strong>{detail && <p>{detail}</p>}{children}</div>
}

export function ErrorNote({ message, retry }) {
  return message && <div className="notice notice--red" role="alert"><AlertCircle size={18} /> <div>{message}</div>{retry && <Button onClick={retry}>重试</Button>}</div>
}

export function Skeleton() {
  return <div role="status" aria-label="正在加载" className="skeletons"><div className="placeholder skeleton-title" /><div className="skeleton-grid">{[1, 2, 3, 4].map((entry) => <div key={entry} className="placeholder" />)}</div><div className="placeholder skeleton-table" /></div>
}

export function Dialog({ title, detail, onClose, children, wide, busy = false }) {
  const ref = useRef(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog.open) dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])
  const dismiss = () => { if (!busy) onClose() }
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog--wide' : ''}`} onCancel={(event) => { event.preventDefault(); dismiss() }} onClick={(event) => { if (event.target === ref.current) dismiss() }} aria-label={title} aria-busy={busy || undefined}>
    <div className="dialog-content"><div className="dialog-header"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div><IconButton icon={X} label="关闭" onClick={dismiss} disabled={busy} /></div>{children}</div>
  </dialog>
}

export function SearchInput({ value, onChange, placeholder = '搜索', icon: Icon, label, ...props }) {
  return <label className="search-input">{Icon && <Icon size={17} aria-hidden="true" />}<input {...props} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label ?? placeholder} /></label>
}

export function Sources({ items }) {
  if (!items?.length) return <span className="muted">暂无可核查来源</span>
  return <ul className="sources">{items.map((source, index) => <li key={`${source.locator}-${index}`}><div>{source.link ? <a href={source.link} target="_blank" rel="noreferrer">{source.locator} <ArrowUpRight size={13} /></a> : source.locator}</div>{source.excerpt && <blockquote>{source.excerpt}</blockquote>}</li>)}</ul>
}

export function Toast({ message, clear }) {
  useEffect(() => {
    if (!message) return undefined
    const timer = setTimeout(clear, 3600)
    return () => clearTimeout(timer)
  }, [message, clear])
  return <div className="toast-region" role="status">{message && <div className="toast"><CircleCheck size={20} />{message}<IconButton icon={X} label="关闭提示" onClick={clear} /></div>}</div>
}

export function fileBase64(file, max = 2 * 1024 * 1024) {
  if (!file) return Promise.resolve('')
  if (file.size > max) return Promise.reject(new Error(`文件超过 ${Math.floor(max / 1024 / 1024)} MB。`))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('无法读取文件，请重选。'))
    reader.readAsDataURL(file)
  })
}
