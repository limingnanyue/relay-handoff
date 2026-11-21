import { ROLES } from '../shared/catalog.mjs'
import { DAY, buildReport, isEvidence, localDay, now, questionFor, retakeDue } from './domain.mjs'
import { mayApprove, maySeeRestricted } from './security.mjs'

export const packEntries = (position) => position.assets.filter((asset) => isEvidence(asset) && Object.values(asset.detail).some(Boolean))
const canReadLevel = (level, restricted) => level === 'S1' || restricted
const strip = (asset) => ({ ...asset, title: '受限条目', detail: {}, sources: [], masked: true })
const activeAttempt = (position) => position.attempts.at(-1)
export const closedBook = (position, actor) => actor.role === 'successor' && activeAttempt(position)?.phase === 'closed'
const publicReport = (report, restricted, blocked = false) => {
  const conceal = (finding) => canReadLevel(finding.level, restricted) ? finding : { ...finding, title: '受限条目', sources: [], reason: '仅授权参与者可查阅依据。' }
  return { ...report, findings: blocked ? [] : report.findings.map(conceal), failingCritical: blocked ? [] : report.failingCritical.map(conceal), uncovered: blocked ? [] : report.uncovered.map(conceal),
    dependencies: blocked ? [] : (report.dependencies ?? []).filter((entry) => canReadLevel(entry.level, restricted)),
    coverage: { ...report.coverage, systems: blocked ? [] : report.coverage.systems.filter((system) => canReadLevel(system.level, restricted)) } }
}

export function positionSummary(position, actor) {
  const report = position.reports.at(-1)
  const restricted = maySeeRestricted(position, actor)
  const critical = position.assets.filter((asset) => asset.critical)
  const warning = critical.find((asset) => !isEvidence(asset))
  const failure = report?.failingCritical[0]
  const dueDays = (Date.parse(position.due) - Date.parse(localDay())) / DAY
  const risk = report?.status ?? (dueDays <= 5 && warning ? 'red' : position.stage !== 'assets' ? 'amber' : 'pending')
  return {
    id: position.id, title: position.title, department: position.department, departmentId: position.departmentId, due: position.due, dueDays, actors: position.actors,
    stage: position.stage, status: risk, score: report?.score ?? null, passed: report?.passed ?? false,
    criticalTotal: critical.length, criticalReady: report ? critical.length - report.failingCritical.length : critical.filter(isEvidence).length,
    riskReason: failure ? `${canReadLevel(failure.level, restricted) ? failure.title : '受限关键项'}未通过` : risk === 'red' && warning ? `${canReadLevel(warning.level, restricted) ? warning.title : '受限关键项'}缺少证据` : '',
    updatedAt: position.updatedAt, archivedAt: position.archivedAt, estimate: ['owner', 'hr'].includes(actor.role) ? position.estimate : undefined,
    assigned: position.actors[actor.role]?.id === actor.id, backups: position.backups,
  }
}

export function exportView(entry) {
  const { snapshot, ...fields } = entry
  return { ...fields, version: snapshot.version }
}

export function noticesFor(position, actor) {
  return position.notifications.filter((notice) => notice.roles.includes(actor.role)).map(({ readBy, roles, ...notice }) => ({ ...notice, positionId: position.id, positionTitle: position.title, unread: !readBy.includes(actor.id) }))
}

export function positionView(position, actor) {
  const restricted = maySeeRestricted(position, actor)
  const blocked = closedBook(position, actor)
  const team = ['owner', 'leaver', 'successor'].includes(actor.role)
  const attempt = activeAttempt(position)
  const latestRound = position.rounds.find((round) => !round.completedAt)
  const isInterviewer = ['owner', 'leaver'].includes(actor.role)
  const examReader = ['owner', 'successor'].includes(actor.role)
  const personalConsent = position.consents[actor.id]
  const report = position.reports.at(-1)
  const gaps = report?.findings.filter((entry) => entry.status !== 'pass') ?? []
  const deadline = retakeDue(position.attempts)
  const afterExamLock = attempt && !(attempt.phase === 'final' && !attempt.passed && position.attempts.length === 1)
  const visibleAsset = (asset) => canReadLevel(asset.level, restricted) ? asset : strip(asset)
  const presentReports = position.reports.map((item) => publicReport(item, restricted, blocked))
  const interviewAssets = position.assets.filter((asset) => canReadLevel(asset.level, restricted))
  const prompt = latestRound && !latestRound.completedAt ? questionFor(latestRound, position.assets) : null
  const promptAsset = position.assets.find((asset) => asset.id === prompt?.assetId)
  return {
    ...positionSummary(position, actor), version: position.version, createdAt: position.createdAt,
    assets: blocked ? [] : position.assets.map((asset) => team ? visibleAsset(asset) : { ...strip(asset), title: asset.level === 'S1' ? asset.title : '受限条目', masked: asset.level !== 'S1' }),
    materials: isInterviewer ? position.materials.map((material) => canReadLevel(material.level, restricted) ? material : { ...material, name: '受限材料', suggestions: [] }) : [],
    rounds: position.rounds.map((round) => ({ ...round, question: isInterviewer && latestRound === round && prompt
      ? { ...prompt, text: canReadLevel(promptAsset?.level ?? 'S1', restricted) ? prompt.text : '请先授权，或将受限问题转人工处理。', level: promptAsset?.level ?? 'S1' } : null,
    entries: isInterviewer ? round.entries.map((entry) => canReadLevel(entry.level, restricted) ? entry : { id: entry.id, text: '受限问题', answer: '受限回答', at: entry.at, suggestions: [] }) : [], count: round.entries.length })),
    interviewAssets: isInterviewer ? interviewAssets.filter((asset) => asset.critical && !isEvidence(asset)).map(({ id, title }) => ({ id, title })) : [],
    packPublishedAt: position.packPublishedAt,
    packPreview: position.stage === 'pack' && isInterviewer && personalConsent?.privacy ? packEntries(position).filter((asset) => canReadLevel(asset.level, restricted)) : [],
    attempts: position.attempts.map(({ questions, answers, results, leaseUntil, leaseId, ...item }) => ({ ...item,
      questions: examReader && (!blocked || item.id === attempt.id) ? questions.map((question) => ({
        id: question.id, type: question.type, openBook: question.openBook, critical: question.critical, level: question.level,
        assetId: question.assetId, prompt: canReadLevel(question.level, restricted) ? question.prompt : '受限题目', title: canReadLevel(question.level, restricted) ? question.title : '受限题目',
        ...(actor.role === 'owner' && ['review', 'final'].includes(item.phase) && canReadLevel(question.level, restricted) ? { sources: question.sources, labels: question.labels, terms: question.terms } : {}),
      })) : [],
      answers: examReader && (!blocked || item.id === attempt.id) && (actor.role === 'successor' || ['review', 'final'].includes(item.phase)) ? Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key,
        restricted ? answer : { text: answer.text && (actor.role === 'successor' ? '[重新授权后查看]' : '受限回答'), at: answer.at }])) : {},
      results: examReader && !blocked ? results.map((result) => restricted ? result : { ...result, reason: '重新授权后查看详细理由。' }) : [],
    })),
    reports: presentReports, preview: report ? undefined : publicReport(buildReport(position), restricted),
    remediations: blocked ? [] : position.remediations.map((item) => team && canReadLevel(item.level, restricted) ? item : { id: item.id, assetId: item.assetId, at: item.at }),
    signatures: position.signatures.map(({ attachmentId, ...signature }) => ({ ...signature, attachmentId: restricted ? attachmentId : undefined })),
    consents: personalConsent ?? null,
    exports: position.exports.filter((item) => item.requestedBy === actor.id || mayApprove(position, actor)).map(exportView),
    deletion: position.deletion ? { ...position.deletion, reason: actor.role === 'hr' || position.deletion.requester === actor.id ? position.deletion.reason : undefined } : null,
    flags: {
      edit: ['owner', 'leaver'].includes(actor.role) && position.stage !== 'archived' && !afterExamLock,
      pack: Boolean(position.packPublishedAt) && !blocked && team,
      due: deadline,
      retake: Boolean(deadline && (gaps.length ? gaps.every((gap) => position.remediations.some((item) => item.assetId === gap.assetId && item.at >= attempt.finalizedAt)) : position.remediations.some((item) => item.at >= attempt.finalizedAt))),
      sign: Boolean(team && report?.passed && !position.signatures.some((entry) => entry.role === actor.role)),
    },
  }
}

export function dashboardView(positions, actor) {
  const summaries = positions.map((position) => positionSummary(position, actor))
  const order = { red: 0, amber: 1, pending: 2, green: 3 }
  summaries.sort((left, right) => order[left.status] - order[right.status] || left.due.localeCompare(right.due))
  const notices = positions.flatMap((position) => noticesFor(position, actor)).sort((left, right) => right.at.localeCompare(left.at))
  const scored = summaries.filter((position) => position.score !== null)
  const active = summaries.filter((position) => position.stage !== 'archived')
  return {
    positions: summaries, notifications: notices.slice(0, 40),
    totals: { positions: summaries.length, red: summaries.filter((item) => item.status === 'red').length, amber: summaries.filter((item) => item.status === 'amber').length,
      green: summaries.filter((item) => item.status === 'green').length, pending: summaries.filter((item) => item.status === 'pending').length,
      average: scored.length ? Math.round(10 * scored.reduce((total, item) => total + item.score, 0) / scored.length) / 10 : null,
      upcoming: active.filter((item) => item.dueDays <= 30).length, departments: new Set(summaries.map((item) => item.department)).size,
      computedAt: now() },
  }
}

export const roleName = (role) => ROLES[role] ?? '系统'
