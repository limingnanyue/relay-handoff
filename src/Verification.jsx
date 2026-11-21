import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, Check, CircleHelp, ClipboardCheck, Clock3, FileCheck2, FileText, LockKeyhole, MessagesSquare, Pause, Play, Send, ShieldAlert, Sparkles, Timer } from 'lucide-react'
import { CATEGORIES } from '../shared/catalog.mjs'
import { Badge, Button, Dialog, Empty, ErrorNote, fileBase64, navigate, positionPath, Sources, whenLabel } from './ui.jsx'

function useClock(active) {
  const [time, setTime] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setTime(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return time
}

function timeText(seconds) {
  const total = Math.max(0, Math.ceil(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function InterviewReply({ round, act, busy, error, position, openConsent }) {
  const [withEvidence, setWithEvidence] = useState(false)
  const [local, setLocal] = useState('')
  const [reading, setReading] = useState(false)
  const restricted = round.question?.level !== 'S1'
  const s3 = round.question?.level === 'S3'
  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const file = form.get('file')
    setReading(true)
    setLocal('')
    try {
      const input = { answer: form.get('answer'), locator: form.get('locator') || undefined, link: form.get('link') || undefined, conflict: form.has('conflict'),
        title: form.get('title') || undefined, category: form.get('category') || undefined }
      if (file?.size) { input.attachment = await fileBase64(file); input.redacted = form.has('redacted') }
      await act('respond', input, '', false)
    } catch (failure) { setLocal(failure.message) } finally { setReading(false) }
  }
  return <form className="transcript-input" onSubmit={submit}>
    <ErrorNote message={local || error} />
    {s3 ? <div className="notice notice--amber"><LockKeyhole size={18} />高危条目请在资产地图核对访问路径。本题可转人工。</div> : restricted && !position.consents?.restricted ? <div className="notice notice--amber"><LockKeyhole size={18} />请授权受限信息或转人工处理。<Button onClick={openConsent}>查看授权</Button></div>
      : <>
        <label className="sr-only" htmlFor="interview-reply">访谈回答</label><textarea id="interview-reply" name="answer" rows={3} placeholder="说明实际处理方式、谁能确认，以及例外怎么处理。" required maxLength={3000} disabled={busy} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }} />
        {withEvidence && <div className="form-stack proof-fields"><div className="form-grid"><label>可核查的出处<input name="locator" placeholder="页码、路径或系统记录号" maxLength={300} /></label><label>证据链接<input name="link" type="url" placeholder="https://" /></label></div>
          <div className="form-grid"><label>新增资产名称<input name="title" maxLength={90} placeholder="可选，从回答中提取" /></label><label>类别<select name="category">{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label></div>
          <label className="check-row"><input type="checkbox" name="conflict" />回答与现有证据存在矛盾</label>
          {position.consents?.restricted && <><label>证据截图<input name="file" type="file" accept="image/png,image/jpeg" /></label><label className="check-row"><input type="checkbox" name="redacted" />截图已移除凭证和高危数据。</label></>}
        </div>}
      </>}
    <div className="transcript-actions"><div>{!s3 && (!restricted || position.consents?.restricted) && <Button icon={FileText} onClick={() => setWithEvidence(!withEvidence)}>{withEvidence ? '收起证据' : '添加证据'}</Button>}<Button kind="ghost" disabled={busy || reading} onClick={() => act('respond', { refused: true }, '已标记为人工补充。', false)}>转人工</Button></div>
      {!s3 && (!restricted || position.consents?.restricted) && <Button icon={Send} type="submit" kind="primary" busy={busy || reading}>发送</Button>}</div>
  </form>
}

export function Interview({ position, user, busy, act, error, openConsent, openDialog, closeDialog, dialog, ai }) {
  const round = position.rounds.find((item) => !item.completedAt)
  const [historyRound, setHistoryRound] = useState(1)
  const visible = position.rounds.find((item) => item.number === (round?.number ?? historyRound))
  const canReply = user.role === 'leaver' && position.stage === 'interview'
  const clock = useClock(round?.runningSince)
  const roundSeconds = round ? (45 * 60_000 - round.elapsed - (round.runningSince ? Math.max(0, clock - Date.parse(round.runningSince)) : 0)) / 1000 : 0
  const suggestions = visible?.entries.flatMap((entry) => entry.suggestions.map((item) => ({ ...item, entryId: entry.id, review: entry.needsReview }))) ?? []
  const begin = () => position.consents?.privacy ? act('startRound', {}, '访谈计时已启动。', false) : openConsent()
  const sideContent = <><div className="panel-title"><h2>本轮资产</h2><Sparkles size={18} /></div><div className="interview-side-body">
    {suggestions.length ? suggestions.slice(-8).reverse().map((item, index) => <a href={positionPath(position, 'assets')} key={`${item.entryId}/${index}`} className="asset-suggestion"><span>{item.title}</span><Badge status={item.review ? 'amber' : item.kind === 'new' ? 'green' : 'blue'}>{item.review ? '待复核' : item.kind === 'new' ? '新增' : '证据更新'}</Badge></a>) : <p className="muted">回答保存后，带出处的建议会显示在这里。</p>}
    <h3>证据缺口</h3>{position.interviewAssets.length ? position.interviewAssets.slice(0, 6).map((item) => <a key={item.id} href={positionPath(position, 'assets')} className="gap-link"><span className="legend-dot amber" />{item.title}</a>) : <p className="muted">暂无可见的关键证据缺口。</p>}
  </div></>
  return <>
    <div className="section-heading"><div><h2>岗位访谈</h2><p>核对证据、例外与关键人依赖。{ai ? '模型建议需负责人确认。' : '当前采用结构化访谈提纲。'}</p></div><div className="heading-actions">
      {canReply && round?.runningSince && <Button icon={Pause} onClick={() => act('pauseRound', {}, '进度已保存。', false)} busy={busy}>暂停</Button>}
      {canReply && round?.startedAt && (round.count >= 7 || roundSeconds <= 0) && <Button onClick={() => act('finishRound', {}, '本轮访谈已结束。')} busy={busy}>结束本轮</Button>}
      <Button className="mobile-assets-button" icon={Sparkles} onClick={() => openDialog('interviewAssets')}>本轮资产</Button>
    </div></div>
    <div className="round-steps">{position.rounds.map((item) => <button type="button" key={item.number} className={`card round-step ${item.number === visible?.number ? 'is-selected' : ''}`} disabled={Boolean(round) && item.number !== round.number} onClick={() => setHistoryRound(item.number)}><span className={`round-index ${item.completedAt ? 'complete' : ''}`}>{item.completedAt ? <Check size={17} /> : item.number}</span><div><strong>{item.title}</strong><small>{item.completedAt ? `已完成 · ${item.count}/8 问` : item.number === round?.number ? `第 ${item.count + 1} 问 / 8` : '待开始'}</small></div></button>)}</div>
    {position.stage === 'assets' ? <section className="card"><Empty icon={MessagesSquare} title="访谈等待资产地图确认" detail="负责人确认初始盘点后，交接人会收到开始通知。"><a className="button button--secondary" href={positionPath(position, 'assets')}>查看资产地图</a></Empty></section>
      : <div className="interview-grid"><section className="card transcript"><div className="panel-title"><div><h2>{visible?.title ?? '访谈记录'}</h2><p>{round ? `第 ${round.number} 轮 / 共 3 轮` : '三轮已结束'}</p></div>{round && <span className={`timer-pill ${roundSeconds <= 60 ? 'text-red' : ''}`}><Timer size={17} />{timeText(roundSeconds)}</span>}</div>
        <div className="transcript-body" aria-live="polite">
          {visible?.entries.map((entry) => <div className="exchange" key={entry.id}><div className="bubble bubble--question"><Sparkles size={15} /><p>{entry.text}</p></div><div className="bubble bubble--answer"><p>{entry.refused ? '已转人工补充。' : entry.answer}</p>{entry.locator && <Sources items={[{ locator: entry.locator, link: entry.link }]} />}{entry.attachmentId && <a className="fact-link" href={`/api/positions/${position.id}/attachments/${entry.attachmentId}`} target="_blank" rel="noreferrer">查看证据截图</a>}{entry.needsReview && <Badge status="amber">待复核</Badge>}</div></div>)}
          {round && !round.startedAt && <div className="interview-start"><span className="tile-icon tone-blue"><MessagesSquare size={22} /></span><h3>准备开始第 {round.number} 轮</h3><p>本轮共 8 问，预计 45 分钟。可随时暂停并继续。</p>{canReply && <Button kind="primary" icon={Play} busy={busy} onClick={begin}>开始本轮</Button>}</div>}
          {round?.startedAt && !round.runningSince && <div className="notice notice--blue"><Pause size={17} />访谈已暂停，已答 {round.count} 问。{canReply && <Button icon={Play} busy={busy} onClick={begin}>继续访谈</Button>}</div>}
          {round?.runningSince && roundSeconds > 0 && round.question && <div className="bubble bubble--question"><Sparkles size={15} /><p>{round.question.text}</p></div>}
          {round?.startedAt && roundSeconds <= 0 && <div className="notice notice--amber"><Clock3 size={17} />本轮时间结束，请结束本轮并补录未覆盖事项。</div>}
        </div>
        {canReply && round?.runningSince && roundSeconds > 0 && <InterviewReply key={`${round.number}/${round.count}`} round={round} act={act} busy={busy} error={error} position={position} openConsent={openConsent} />}
        {!round && <div className="transcript-actions"><a className="button button--primary" href={positionPath(position, 'pack')}>查看交接包 <ArrowRight size={16} /></a></div>}
      </section><aside className="card interview-side">{sideContent}</aside></div>}
    {dialog === 'interviewAssets' && <Dialog title="访谈资产与证据" onClose={closeDialog}>{sideContent}</Dialog>}
  </>
}

const resultBadge = { pass: ['green', '通过'], fail: ['red', '未通过'], review: ['amber', '待复核'] }

function AnswerForm({ question, answer, act, busy, expired, position, next }) {
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  async function submit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError('')
    setReading(true)
    try {
      const file = form.get('file')
      const input = { questionId: question.id, text: form.get('answer'), redacted: form.has('redacted') }
      if (file?.size) input.attachment = await fileBase64(file)
      if (await act('answer', input, '答案已保存。', false)) next()
    } catch (failure) { setError(failure.message) } finally { setReading(false) }
  }
  return <form onSubmit={submit} className="form-stack answer-form">
    <label>你的答案<textarea name="answer" maxLength={4000} rows={8} defaultValue={answer?.text ?? ''} disabled={expired} placeholder="说明操作步骤、判断依据或对应的资料路径。" /></label>
    {answer?.attachmentId ? <a href={`/api/positions/${position.id}/attachments/${answer.attachmentId}`} target="_blank" rel="noreferrer">查看已保存的截图</a>
      : !expired && question.level !== 'S3' && position.consents?.restricted && <details className="inline-details inline-details--plain"><summary>添加截图证据</summary><div className="form-stack"><label>PNG 或 JPEG<input type="file" name="file" accept="image/png,image/jpeg" /></label><label className="check-row"><input type="checkbox" name="redacted" />已移除截图上的高危数据。</label></div></details>}
    <ErrorNote message={error} /><div className="dialog-actions"><Button type="submit" kind="primary" busy={busy || reading} disabled={expired} icon={ArrowRight}>保存并继续</Button></div>
  </form>
}

function ReviewCard({ question, result, answer, act, busy, position, next, reviewable }) {
  const [tone, label] = result.needsReview ? resultBadge.review : resultBadge[result.status] ?? resultBadge.review
  async function submit(event) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    if (await act('review', { questionId: question.id, score: Number(values.get('score')), reason: values.get('reason') }, '人工复核已保存。', false)) next()
  }
  return <div className="review-body"><div className="notice notice--blue"><FileCheck2 size={19} /><div><b>{result.score} 分 · {label}</b><p>{result.reason}</p></div><Badge status={tone}>{result.needsReview ? result.sampled ? '人工抽检' : '待人工复核' : label}</Badge></div>
    <h3>已提交的答案</h3><p className="answer-preview">{answer?.text || '未提交文字答案。'}</p>{answer?.attachmentId && <a href={`/api/positions/${position.id}/attachments/${answer.attachmentId}`} target="_blank" rel="noreferrer">查看答题截图</a>}
    {reviewable && <><h3>评分依据</h3>{question.labels?.map((label, index) => <p className="rubric-line" key={label}><b>{label}</b> · {question.terms[index]}</p>)}<Sources items={question.sources} />
      <form className="form-stack review-form" onSubmit={submit}><div className="form-grid"><label>人工分数<input type="number" name="score" min="0" max="100" step="1" defaultValue={result.score} required /></label><label>核查理由<input name="reason" required maxLength={500} placeholder="填写比对的证据与理由" /></label></div><Button type="submit" kind="primary" busy={busy}>保存复核</Button></form>
    </>}
  </div>
}

export function Exam({ position, user, act, busy, openConsent, refresh }) {
  const attempt = position.attempts.at(-1)
  const clock = useClock(attempt && ['closed', 'open'].includes(attempt.phase))
  const [selection, setSelection] = useState('')
  const [manual, setManual] = useState(false)
  const isOwner = user.role === 'owner'
  const isSuccessor = user.role === 'successor'
  const active = attempt && ['closed', 'open'].includes(attempt.phase)
  const reviewing = attempt?.phase === 'review'
  const finalized = attempt?.phase === 'final'
  const questions = attempt?.questions ?? []
  const saved = Object.keys(attempt?.answers ?? {}).length
  const currentSet = questions.filter((question) => !active || question.openBook === (attempt.phase === 'open'))
  const pendingReview = attempt?.results.filter((result) => result.needsReview) ?? []
  const visible = currentSet.filter((question) => !manual || !reviewing || pendingReview.some((result) => result.id === question.id))
  const question = visible.find((item) => item.id === selection) ?? visible.find((item) => active && !attempt.answers[item.id] || reviewing && pendingReview.some((result) => result.id === item.id)) ?? visible[0]
  const remaining = attempt ? (Date.parse(attempt.endsAt) - clock) / 1000 : 0
  const expired = remaining <= 0
  const ready = saved === questions.length
  const canUnlock = currentSet.every((item) => attempt.answers[item.id])
  const report = position.reports.at(-1)
  const result = question && attempt?.results.find((item) => item.id === question.id)
  const previous = position.attempts.at(-2)
  const previousQuestion = question && previous?.questions.find((item) => item.assetId === question.assetId)
  const previousResult = previousQuestion && previous.results.find((item) => item.id === previousQuestion.id)
  const scoringDetail = position.scoring ? '预计 ' + Math.ceil(position.scoring.expectedSeconds) + ' 秒内进入人工复核。' : '自动评分结束后进入人工复核。'
  const start = () => position.consents?.privacy ? act('startExam', {}, '请先完成闭卷题。') : openConsent()
  const selectNext = () => { const next = visible[visible.indexOf(question) + 1]; if (next) setSelection(next.id); else setSelection('') }
  return <>
    <div className="section-heading"><div><h2>岗位验收考试</h2><p>五类题型 · 总分 80 分及格 · 必考关键项须全部通过。</p></div>{attempt && <Badge status={attempt.phase === 'final' ? attempt.passed ? 'green' : 'red' : reviewing ? 'amber' : 'blue'}>{attempt.phase === 'scoring' ? '自动评分中' : reviewing ? '待复核' : finalized ? attempt.passed ? '已通过' : '未通过' : `第 ${position.attempts.length} 次验收`}</Badge>}</div>
    {!attempt ? <section className="card exam-intro"><Empty title={position.stage === 'exam' ? '可以开始验收' : '等待交接包发布'} detail={position.stage === 'exam' ? '考试限时 30 分钟，先完成 60% 闭卷题，再解锁 40% 开卷题。' : '盘点和访谈结束并发布交接包后，接班人可以开始答题。'} icon={ClipboardCheck}>
      {position.stage === 'exam' && isSuccessor && <Button kind="primary" icon={ArrowRight} busy={busy} onClick={start}>开始验收</Button>}<a className="button button--secondary" href={positionPath(position, 'pack')}>查看交接包</a></Empty></section>
      : attempt.phase === 'scoring' ? <section className="card"><Empty title={position.scoring?.running ? '正在自动评分' : '验收已提交，等待评分'} detail={scoringDetail} icon={FileCheck2}><Button onClick={refresh}>刷新状态</Button></Empty></section>
      : !questions.length || active && !isSuccessor ? <section className="card"><Empty title={active ? '接班人正在答题' : '已记录验收状态'} detail="逐题作答与复核受角色权限控制。" icon={LockKeyhole}>{report && <a href={positionPath(position, 'report')} className="button button--primary">查看报告</a>}<Button onClick={refresh}>刷新状态</Button></Empty></section>
      : <div className="exam-grid"><section className="card exam-card">
        {question ? <><div className="panel-title"><div><div className="chip-row"><Badge status="blue">{question.type}</Badge>{question.critical && <Badge status="red">必考关键项</Badge>}</div><h2>{question.prompt}</h2></div><span className="question-number">{questions.indexOf(question) + 1} / {questions.length}</span></div>
        {active && <AnswerForm key={`${attempt.id}/${question.id}`} question={question} answer={attempt.answers[question.id]} act={act} busy={busy} expired={expired} position={position} next={selectNext} />}
        {result && <ReviewCard key={`${attempt.id}/${question.id}/${result.reviewedAt ?? ''}`} question={question} result={result} answer={attempt.answers[question.id]} act={act} busy={busy} position={position} next={selectNext} reviewable={isOwner && reviewing} />}
        {previousResult && result && <div className="difference">首考 {previousResult.score} 分 → 本次 {result.score} 分<span>{result.score >= previousResult.score ? '+' : ''}{result.score - previousResult.score} 分</span></div>}
        </> : <Empty icon={Check} title="当前筛选下没有待复核题" detail="可继续核查其他题目，或生成报告。" />}
      </section><aside className="card exam-progress"><div className="panel-title"><h2>{active ? '答题进度' : '题目与复核'}</h2>{active && <span className={`timer-pill ${remaining <= 120 ? 'text-red' : ''}`}><Clock3 size={16} />{timeText(remaining)}</span>}</div>
        <div className="exam-progress-body"><div className="progress-meta"><b>{active ? `${saved} / ${questions.length}` : `${pendingReview.length} 题待复核`}</b><span>{active ? attempt.phase === 'closed' ? '闭卷阶段' : '开卷阶段' : finalized ? `${attempt.score} 分` : '含 20% 抽检'}</span></div>
        <div className="progress-track"><div style={{ width: `${100 * (active ? saved : questions.length - pendingReview.length) / (questions.length || 1)}%` }} /></div>
        {isOwner && reviewing && <label className="check-row"><input type="checkbox" checked={manual} onChange={(event) => setManual(event.target.checked)} />只看待复核题</label>}
        <div className="question-grid">{visible.map((item) => {
          const done = active ? Boolean(attempt.answers[item.id]) : !pendingReview.some((review) => review.id === item.id)
          return <button type="button" key={item.id} aria-label={`第 ${questions.indexOf(item) + 1} 题${done ? '，已完成' : ''}`} aria-pressed={question?.id === item.id} className={`${question?.id === item.id ? 'is-selected' : ''} ${done ? 'is-done' : ''}`} onClick={() => setSelection(item.id)}>{questions.indexOf(item) + 1}</button>
        })}</div>
        {active && attempt.phase === 'closed' && !expired && <Button kind="primary" icon={BookOpen} busy={busy} disabled={!canUnlock} title={!canUnlock ? '完成全部闭卷题后解锁' : undefined} onClick={async () => { if (await act('unlockExam', {}, '已进入开卷阶段。')) setSelection('') }}>进入开卷</Button>}
        {active && attempt.phase === 'open' && <a href={positionPath(position, 'pack')} className="button button--secondary"><BookOpen size={16} />打开交接包</a>}
        {active && (attempt.phase === 'open' || expired) && <Button kind="primary" icon={Send} busy={busy} disabled={!ready && !expired} title={!ready && !expired ? `还有 ${questions.length - saved} 题未保存` : undefined} onClick={() => act('submitExam', {}, '已提交验收。')}>交卷</Button>}
        {reviewing && isOwner && <Button kind="primary" icon={FileText} busy={busy} disabled={Boolean(pendingReview.length)} title={pendingReview.length ? '请完成所有抽检和复核' : undefined} onClick={async () => { const next = await act('finalizeExam', {}, '报告已生成。'); if (next) navigate(positionPath(next, 'report')) }}>生成报告</Button>}
        {finalized && report && <a href={positionPath(position, 'report')} className="button button--primary">查看报告 <ArrowRight size={16} /></a>}
        {reviewing && isSuccessor && <div className="notice notice--amber"><CircleHelp size={16} />部分结果正在人工复核。</div>}
        </div>
      </aside></div>}
    {finalized && position.flags.due && <div className="stage-callout card"><div><strong><ShieldAlert size={16} /> 补考截至 {whenLabel(position.flags.due)}</strong><p>{position.flags.retake ? '差距项已完成补交接，可开始唯一一次补考。' : '请在报告中核对未通过项并记录补交接。'}</p></div>{isSuccessor && position.flags.retake ? <Button kind="primary" icon={ArrowRight} busy={busy} onClick={start}>开始补考</Button> : <a href={positionPath(position, 'report')} className="button button--secondary">查看差距</a>}</div>}
  </>
}
