import { addTime, buildReport, DAY, gradeAttempt, id, localDay, makeQuestions, newPosition, now, questionFor } from './domain.mjs'
import { DEMO_USERS } from './security.mjs'

const roles = ['owner', 'leaver', 'successor']
const team = Object.fromEntries(roles.map((role) => {
  const account = DEMO_USERS.find((item) => item.id === role)
  return [role, { id: account.id, name: account.name }]
}))

const samples = [
  { key: 'demo-east', title: '华东区销售运营', department: '区域销售部', days: 4, backups: 1, count: 46, stage: 'report', miss: true, leaver: '李敏', successor: '赵宁' },
  { key: 'demo-channel', title: '渠道销售运营', department: '渠道事业部', days: 7, backups: 1, count: 37, stage: 'report', leaver: '许闻远', successor: '宋晴', amber: true },
  { key: 'demo-enterprise', title: '大客户销售运营', department: '企业业务部', days: 12, backups: 2, count: 47, stage: 'archived', leaver: '唐禾', successor: '许闻远' },
  { key: 'demo-hq', title: '总部销售运营', department: '销售管理部', days: 3, backups: 0, count: 1, stage: 'assets', leaver: '邹楠', successor: '徐木' },
  { key: 'demo-cs', title: '客户成功运营', department: '客户成功部', days: 16, backups: 1, count: 28, stage: 'interview', leaver: '魏明杰', successor: '刘雨桐' },
  { key: 'demo-north', title: '华北区销售运营', department: '区域销售部', days: 38, backups: 0, count: 0, stage: 'assets', leaver: '陆安', successor: '叶宁' },
]

function samplePosition(sample, timestamp) {
  const teamActors = Object.fromEntries(roles.map((role) => [role, { ...team[role], name: sample[role] ?? team[role].name }]))
  const position = newPosition({ ...sample, due: localDay(addTime(timestamp, sample.days * DAY)) }, teamActors, addTime(timestamp, -18 * DAY))
  position.id = sample.key
  position.stage = sample.stage
  position.consents = Object.fromEntries(roles.map((role) => [role, { privacy: true, restricted: true, model: false, at: timestamp, version: '1.0' }]))
  const verified = new Set(position.assets.filter((asset) => asset.critical).slice(0, sample.count).map((asset) => asset.id))
  for (const asset of position.assets) if (verified.size < sample.count) verified.add(asset.id)
  position.assets = position.assets.map((asset, index) => {
    if (!verified.has(asset.id)) return asset
    const detail = asset.id === 'so-01' ? {
      when: '客户申请非标准续费折扣时', location: '销售运营知识库 / 续费审批 / 最新模板', contact: '收入审批组', exception: '超出常规折扣权限时转大区负责人和财务复核',
    } : { when: `处理${asset.title}时，先核对最近一次记录`, location: `销售运营知识库 / ${asset.category} / ${asset.title}`,
      contact: ['销售运营值班组', '收入审批组', '业务系统服务台'][index % 3], exception: '超出常规权限时转业务负责人复核' }
    const updatedAt = addTime(timestamp, -(sample.amber && index % 2 ? 100 : index % 9 + 1) * DAY)
    return { ...asset, detail, sources: [{ kind: 'manual', locator: `销售运营手册 · 第 ${index + 2} 节`, at: updatedAt }], confirmed: true, updatedAt }
  })
  if (sample.stage !== 'assets') position.inventoryAt = addTime(timestamp, -9 * DAY)
  if (sample.miss) {
    position.estimate = { incident: 120_000, daily: 15_000, riskyDays: 4, total: 180_000 }
    position.notifications.push({ id: id(), roles: ['owner', 'leaver'], title: '续费折扣审批暂未通过，请核对补交接。', stage: 'report', at: timestamp, readBy: [] })
  }
  if (sample.stage === 'interview' || sample.stage === 'report' || sample.stage === 'archived') {
    const complete = sample.stage === 'interview' ? 1 : 3
    for (const round of position.rounds.slice(0, complete)) {
      round.evidenceIndex = 3
      for (let index = 0; index < 8; index += 1) {
        const question = questionFor(round, position.assets)
        const asset = position.assets.find((item) => item.id === question?.assetId)
        round.entries.push({ id: id(), ...question, answer: asset ? `${asset.detail.when ?? '执行前核验来源'}。请联系${asset.detail.contact ?? '销售运营值班组'}。` : '按运营手册记录流程与升级联系人。',
          level: asset?.level ?? 'S1', locator: asset?.sources[0]?.locator, at: position.inventoryAt,
          suggestions: asset ? [{ id: asset.id, title: asset.title, kind: 'update' }] : [] })
      }
      Object.assign(round, { completion: 100, startedAt: position.inventoryAt, completedAt: addTime(timestamp, -8 * DAY), elapsed: 31 * 60_000 })
    }
  }
  if (sample.stage === 'report' || sample.stage === 'archived') {
    position.packPublishedAt = addTime(timestamp, -6 * DAY)
    const questions = makeQuestions(position.assets, sample.key)
    const answers = Object.fromEntries(questions.map((question) => [question.id, { text: question.terms.join('；'), at: position.packPublishedAt }]))
    const finalizedAt = addTime(timestamp, -2 * DAY)
    const attempt = { id: id(), questions, answers, phase: 'final', startedAt: position.packPublishedAt, endsAt: addTime(position.packPublishedAt, 30 * 60_000), finalizedAt }
    attempt.results = gradeAttempt(attempt).map((item) => ({ ...item, needsReview: false, reviewedAt: finalizedAt }))
    if (sample.miss) {
      const question = questions.find((item) => item.assetId === 'so-01')
      answers[question.id].text = '业务审批结束后直接发续约合同。'
      Object.assign(attempt.results.find((item) => item.id === question.id), { score: 40, status: 'fail', reason: '未说明超授权折扣需要经过大区负责人和财务复核。' })
    }
    if (sample.amber) {
      for (const question of questions.filter((item) => !item.critical).slice(0, 3)) Object.assign(attempt.results.find((item) => item.id === question.id), { score: 60, status: 'fail', reason: '还需要补充版本核查与时间节点。' })
    }
    position.attempts.push(attempt)
    const report = buildReport(position, finalizedAt)
    attempt.passed = report.passed
    attempt.score = report.examScore
    position.reports.push({ ...report, version: 1, attemptId: attempt.id, at: finalizedAt })
    if (sample.stage === 'archived') {
      position.archivedAt = addTime(timestamp, -DAY)
      position.signatures = roles.map((role) => ({ role, actor: teamActors[role].id, name: teamActors[role].name, at: position.archivedAt, reportVersion: 1, demo: true }))
    }
  }
  return position
}

export async function seedDemo(store) {
  const marker = await store.get('demo', 'workspace', 'seed')
  if (marker) return
  const timestamp = now()
  for (const sample of samples) await store.change({ tenant: 'demo', subject: sample.key, actor: 'system', action: '导入演示岗位' }, (position) => position ? undefined : samplePosition(sample, timestamp))
  await store.change({ tenant: 'demo', kind: 'workspace', subject: 'seed' }, () => ({ initialized: timestamp }))
}
