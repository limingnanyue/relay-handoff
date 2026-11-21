import { isEvidence, localDay } from './domain.mjs'

const STAGES = [
  ['parse', '解析 · 50 页内', 60_000], ['parseLong', '解析 · 50 页以上', 180_000],
  ['extract', '资产抽取', 90_000], ['firstToken', '访谈首字', 2000], ['interview', '单问响应', 3000],
  ['questions', '出题', 60_000], ['grade', '评分', 90_000], ['report', '报告', 180_000],
]
const ratio = (count, total) => total ? count / total : null
const p95 = (times) => times.sort((left, right) => left - right)[Math.ceil(times.length * .95) - 1] ?? null

export function summarizeMonitoring(positions, traces, backlog, checkedAt) {
  const month = localDay(new Date(checkedAt)).slice(0, 7)
  const attempts = positions.map((position) => position.attempts[0]).filter((attempt) => attempt?.finalizedAt)
  const rounds = positions.flatMap((position) => position.rounds).filter((round) => round.startedAt)
  const reviews = positions.flatMap((position) => position.attempts.flatMap((attempt) => attempt.results)).filter((result) => result.autoScore !== undefined)
  const critical = positions.flatMap((position) => position.assets).filter((asset) => asset.critical)
  const product = {
    qualifiedThisMonth: positions.filter((position) => position.backups > 0 && position.reports.some((report) => report.passed && report.at && localDay(new Date(report.at)).startsWith(month))).length,
    interviewCompletionRate: ratio(rounds.filter((round) => round.completedAt).length, rounds.length),
  }
  const quality = {
    firstPassRate: ratio(attempts.filter((attempt) => attempt.passed).length, attempts.length),
    evidenceRate: ratio(critical.filter(isEvidence).length, critical.length),
    reviewDisagreementRate: ratio(reviews.filter((result) => (result.autoScore >= 80) !== (result.score >= 80)).length, reviews.length),
  }
  const checked = traces.filter(({ detail }) => detail.trace || detail.fault)
  const affected = new Set(checked.filter(({ detail }) => detail.fault).map(({ subject }) => subject))
  const failureRate = ratio(affected.size, new Set(checked.map(({ subject }) => subject)).size)
  const modelRuns = checked.map(({ detail }) => detail.model).filter((metric) => metric?.requests)
  const sum = (field) => modelRuns.reduce((total, metric) => total + (metric[field] ?? 0), 0)
  const model = {
    requests: sum('requests'), tokens: sum('tokens'), cost: sum('cost'), retries: sum('requests') - modelRuns.length,
    failureRate: ratio(sum('failures'), sum('requests')), cacheHitRate: ratio(sum('cacheHits'), sum('cacheSamples')),
    p95Ms: p95(modelRuns.map((metric) => metric.duration).filter(Number.isFinite)),
  }
  const stages = STAGES.map(([key, label, sloMs]) => {
    const durations = checked.map(({ detail }) => detail.trace?.[key]).filter(Number.isFinite)
    return { key, label, sloMs, samples: durations.length, p95Ms: p95(durations) }
  })
  const alerts = stages.filter((stage) => stage.p95Ms > stage.sloMs * 1.2).map((stage) => ({ key: 'latency', label: stage.label + ' P95 已超过目标 20%' }))
  if (failureRate > .02) alerts.push({ key: 'failure', label: '近 24 小时出现系统异常的岗位超过 2%' })
  if (positions.some((position) => position.model.cost > 80)) alerts.push({ key: 'cost', label: '有岗位的估计模型成本超过 80 元' })
  if (backlog > 50) alerts.push({ key: 'backlog', label: '本组织后台任务积压超过 50 项' })
  return { checkedAt, product, quality, model, stages, alerts, backlog, failureRate }
}
