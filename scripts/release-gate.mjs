import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [currentPath, previousPath] = process.argv.slice(2)
assert.ok(currentPath && previousPath, '用法为 npm run gate -- 当前指标.json 基线指标.json')
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
const [current, previous] = await Promise.all([read(currentPath), read(previousPath)])
const fields = ['criticalRecall', 'ungroundedRate', 'questionUsability', 'kappa', 'p95Ms', 'cost', 'failureRate']
for (const field of fields) {
  assert.ok(Number.isFinite(current[field]) && Number.isFinite(previous[field]), `缺少可比较的指标 ${field}`)
  if (['criticalRecall', 'ungroundedRate', 'questionUsability', 'failureRate'].includes(field)) assert.ok([current[field], previous[field]].every((value) => value >= 0 && value <= 1), `${field} 须为 0–1`)
}
assert.ok([current, previous].every((metric) => metric.kappa >= -1 && metric.kappa <= 1 && metric.p95Ms > 0 && metric.cost >= 0), 'κ、耗时或成本范围无效。')
const checks = [
  ['关键资产召回', current.criticalRecall >= .9 && previous.criticalRecall - current.criticalRecall <= .0200001],
  ['编造条目比例', current.ungroundedRate <= .02],
  ['题目可用率', current.questionUsability >= .8],
  ['评分人机一致性', current.kappa >= .6],
  ['端到端时延', current.p95Ms <= 480_000 && current.p95Ms <= previous.p95Ms * 1.2],
  ['单岗位成本', current.cost <= 50 && current.cost <= previous.cost * 1.3],
  ['负载失败率', current.failureRate < .01],
]
for (const [label, passed] of checks) console.log(`${passed ? '通过' : '阻断'} · ${label}`)
process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1
