import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BriefcaseBusiness, CalendarDays, ChevronRight, CircleAlert, Clock3, Filter, Gauge, ListChecks, Plus, Search, ShieldCheck, TrendingUp } from 'lucide-react'
import { Avatar, Badge, Button, Empty, Heading, SearchInput, countLabel, currency, dayLabel, navigate, positionPath, stageLabel } from './ui.jsx'

const statusFilters = [['all', '全部状态'], ['red', '红灯'], ['amber', '黄灯'], ['green', '绿灯'], ['pending', '待评估']]
const statusText = { red: '高风险', amber: '待关注', green: '可交接', pending: '待评估' }
const workLabel = { assets: '核对资产', interview: '跟进访谈', pack: '核对交接包', exam: '查看验收', report: '查看报告', letter: '完成签署', archived: '查看归档' }

function Metric({ icon: Icon, tone, label, value, unit, foot, action }) {
  const element = <><div className="metric-top"><span className={`tile-icon tone-${tone}`}><Icon size={20} strokeWidth={1.8} /></span>{action && <ArrowUpRight className="metric-arrow" size={16} />}</div><div className="metric-label">{label}</div><div className="metric-value">{value}<span>{unit}</span></div><div className="metric-foot">{foot}</div></>
  return action ? <button className="card metric metric--click" onClick={action}>{element}</button> : <div className="card metric">{element}</div>
}

function Distribution({ totals }) {
  const colors = ['red', 'amber', 'green', 'pending']
  let cumulative = 0
  const segments = colors.map((color) => {
    const previous = cumulative
    cumulative += 100 * totals[color] / (totals.positions || 1)
    return `var(--chart-${color}) ${previous}% ${cumulative}%`
  })
  return <section className="card distribution"><div className="panel-title"><h2>风险分布</h2><Gauge size={17} /></div><div className="distribution-body">
    <div className="donut" aria-label={colors.map((color) => `${statusText[color]} ${totals[color]}`).join('，')} style={{ background: totals.positions ? `conic-gradient(${segments.join(',')})` : undefined }}><div><strong>{totals.positions}</strong><span>岗位</span></div></div>
    <div className="distribution-legend">{colors.map((color) => <div key={color}><span className={`legend-dot ${color}`} />{statusText[color]}<strong>{totals[color]}</strong></div>)}</div>
  </div></section>
}

export default function Dashboard({ data, staff, create, monthly, listOnly, busy }) {
  const { totals, positions } = data
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState('')
  const [sort, setSort] = useState('risk')
  const departments = useMemo(() => [...new Set(positions.map((position) => position.department))], [positions])
  const results = useMemo(() => positions.filter((position) => (filter === 'all' || position.status === filter) && (!department || position.department === department)
    && `${position.title} ${position.department} ${position.actors.owner.name} ${position.actors.leaver.name} ${position.actors.successor.name}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => sort === 'date' ? left.due.localeCompare(right.due) : 0), [positions, filter, query, department, sort])
  const priority = positions.find((position) => position.status === 'red' && position.score !== null) ?? positions.find((position) => position.status === 'red')
  const todo = positions.filter((position) => position.stage !== 'archived' && (position.status === 'red' || ['interview', 'exam', 'letter', 'pack'].includes(position.stage))).slice(0, 3)
  const month = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(data.totals.computedAt))
  const estimated = positions.filter((position) => position.estimate).reduce((total, position) => total + position.estimate.total, 0)
  return <>
    <Heading title={listOnly ? '岗位工作台' : '关键岗位总览'} eyebrow={<><CalendarDays size={14} />{month}</>} description={listOnly ? '查看岗位体检进度、负责人和下一步动作。' : `跟踪 ${totals.positions} 个关键岗位 · 覆盖 ${totals.departments} 个部门`}>
      {staff && <><Button icon={ArrowDownToLine} busy={busy} onClick={monthly}>导出月报</Button><Button icon={Plus} kind="primary" onClick={create}>新建体检</Button></>}
    </Heading>
    {!positions.length ? <section className="card"><Empty title={staff ? '先建一个岗位体检' : '暂无可查看的岗位'} detail={staff ? '选择销售运营模板，从核对岗位资产开始。' : '有权查看的岗位会显示在这里。'} icon={BriefcaseBusiness}>
      {staff && <><Button kind="primary" icon={Plus} onClick={create}>新建体检</Button><Button onClick={() => navigate('/templates')}>查看模板</Button></>}
    </Empty></section> : <>
      {!listOnly && <>
        <div className="kpi-grid">
          <Metric icon={BriefcaseBusiness} tone="blue" label="关键岗位" value={countLabel(totals.positions)} unit="个" foot={<>覆盖 <b>{totals.departments}</b> 个部门</>} />
          <Metric icon={CircleAlert} tone="red" label="红灯岗位" value={totals.red} unit="个" foot={<><span className="legend-dot red" />需要优先处置</>} action={() => { setFilter(filter === 'red' ? 'all' : 'red'); document.getElementById('risk-table')?.focus() }} />
          <Metric icon={Gauge} tone="teal" label="平均可交接性" value={totals.average ?? '—'} unit="分" foot={<><TrendingUp size={14} />基于已生成报告</>} />
          <Metric icon={Clock3} tone="amber" label="30 天内待交接" value={totals.upcoming} unit="个" foot="截至本次统计，归档除外" />
        </div>
        {priority && <section className="priority-banner" aria-label="优先处理风险"><div className="priority-symbol"><ShieldCheck size={25} strokeWidth={1.8} /></div><div className="priority-copy"><div><span className="priority-label"><span />优先处理</span><strong>{priority.title}</strong></div><p>{priority.riskReason || '有关键风险需要核对'}{priority.dueDays < 0 ? '，已超过交接日期' : `，距交接 ${priority.dueDays} 天`}。</p></div><a className="button button--on-dark" href={positionPath(priority)}>{priority.score === null ? '补齐证据' : '查看风险报告'}<ArrowRight size={17} /></a></section>}
      </>}
      <div className={listOnly ? 'dashboard-grid dashboard-grid--list' : 'dashboard-grid'}>
        <section className="card table-panel" id="risk-table" tabIndex={-1} aria-label="岗位风险列表">
          <div className="panel-title table-title"><div><h2>{listOnly ? '岗位列表' : '岗位风险列表'}</h2><p>优先显示风险较高的岗位</p></div><span className="table-count">{results.length} 个岗位</span></div>
          <div className="table-tools"><SearchInput icon={Search} value={query} onChange={setQuery} placeholder="搜索岗位、部门或人员" /><label className="filter-control"><Filter size={15} /><select aria-label="筛选状态" value={filter} onChange={(event) => setFilter(event.target.value)}>{statusFilters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{listOnly && <><select aria-label="筛选部门" value={department} onChange={(event) => setDepartment(event.target.value)}><option value="">全部部门</option>{departments.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="risk">按风险排序</option><option value="date">按交接日期</option></select></>}</div>
          {results.length ? <div className="table-scroll"><table className="risk-table"><thead><tr><th>岗位 / 部门</th><th>负责人</th><th className="numeric">指数</th><th>风险状态</th><th className="numeric">关键项</th><th>下一步</th></tr></thead>
            <tbody>{results.map((position, index) => <tr key={position.id}>
              <td><a className="table-name" href={positionPath(position)}>{position.title}</a><span className="row-detail">{position.department}</span></td>
              <td><span className="person"><Avatar name={position.actors.owner.name} tone={index} size="small" />{position.actors.owner.name}</span></td>
              <td className="numeric"><span className={`table-score text-${position.status}`}>{position.score ?? '—'}</span></td>
              <td><Badge status={position.status}>{statusText[position.status]}</Badge></td>
              <td className="numeric"><b>{position.criticalReady}</b><span className="muted"> / {position.criticalTotal}</span></td>
              <td><a className="row-action" href={positionPath(position)}>{workLabel[position.stage]}<ChevronRight size={14} /></a></td>
            </tr>)}</tbody></table></div> : <Empty title="没有匹配的岗位" detail="调整筛选条件或清除搜索。"><Button onClick={() => { setQuery(''); setFilter('all'); setDepartment('') }}>清除筛选</Button></Empty>}
          <div className="table-footer"><span>显示 {results.length} / {positions.length} 项</span><span>更新于 {dayLabel(totals.computedAt)}</span></div>
        </section>
        {!listOnly && <aside className="dashboard-side">
          <section className="card todo-panel"><div className="panel-title"><h2><ListChecks size={19} />今日待办</h2><span className="table-count">{todo.length} 项</span></div>
            {todo.length ? <div className="todo-list">{todo.map((position) => <a className="todo-item" key={position.id} href={positionPath(position)}><span className={`todo-icon tone-${position.status === 'red' ? 'red' : 'blue'}`}><span className={`legend-dot ${position.status}`} /></span><div><strong>{workLabel[position.stage]} · {position.title}</strong><small>{position.riskReason || `${stageLabel(position.stage)} · ${dayLabel(position.due)} 截止`}</small></div><ChevronRight size={16} /></a>)}</div> : <p className="side-empty">今天没有待跟进的交接。</p>}
            <a className="side-link" href="#/positions">查看全部岗位 <ArrowRight size={15} /></a>
          </section>
          <Distribution totals={totals} />
          <section className="card estimate-panel"><div className="panel-title"><h2>风险金额估算</h2><TrendingUp size={17} /></div><div className="estimate-number">{estimated ? currency(estimated) : '—'}</div><p>基于业务负责人填写的事故成本与不可用损失。</p>{priority && <a href={positionPath(priority, 'report')}>查看岗位估算 <ArrowRight size={14} /></a>}</section>
        </aside>}
      </div>
    </>}
  </>
}
