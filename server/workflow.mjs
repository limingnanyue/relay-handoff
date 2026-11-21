import { createHash, randomInt } from 'node:crypto'
import sharp from 'sharp'
import { CATEGORIES } from '../shared/catalog.mjs'
import { addMetrics } from './ai.mjs'
import { addTime, buildReport, id, isEvidence, makeQuestions, now, questionFor, requireThat, retakeDue, safeText, scoreAttempt, sourceFor, updatedAsset } from './domain.mjs'
import { createExportSnapshot } from './exports.mjs'
import { mayApprove, maySeeRestricted } from './security.mjs'

const ROUND_MS = 45 * 60_000
const INTERVIEW_MS = 3 * 60 * 60_000
const EXAM_MS = 30 * 60_000
const MAX_ATTACHMENTS = 200 * 1024 * 1024
const startedAttempt = (attempt) => attempt && ['closed', 'open'].includes(attempt.phase)
const requireStage = (condition, message) => requireThat(condition, message, 409)
const textFields = (asset) => Object.values(asset.detail).some(Boolean)
const consent = (position, actor, field = 'privacy') => requireThat(position.consents[actor.id]?.[field], field === 'privacy' ? '请先阅读告知并同意本次交接。' : '请先单独同意处理受限信息。', 403)

function pushNotice(position, roles, title, stage) {
  position.notifications.push({ id: id(), roles, title, stage, at: now(), readBy: [] })
  position.notifications = position.notifications.slice(-80)
}

export async function prepareImage(base64) {
  requireThat(typeof base64 === 'string' && base64.length <= 3 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64), '请上传不超过 2 MB 的 PNG 或 JPEG 图片。', 413)
  const input = Buffer.from(base64, 'base64')
  requireThat(input.length <= 2 * 1024 * 1024, '图片大小须小于 2 MB。', 413)
  try {
    const image = sharp(input, { limitInputPixels: 16_000_000, failOn: 'error' })
    const metadata = await image.metadata()
    requireThat(['png', 'jpeg'].includes(metadata.format) && (metadata.pages ?? 1) === 1, '仅支持单张 PNG 或 JPEG。')
    return await image.rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).flatten({ background: 'white' }).png().toBuffer()
  } catch (error) {
    if (error.status) throw error
    throw Object.assign(new Error('无法读取图片，请检查文件并重传。'), { status: 422 })
  }
}

export const ACTIONS = {
  consent: '交接告知授权', asset: '更新资产', material: '解析材料与证据', inventory: '确认资产地图',
  startRound: '开始访谈', pauseRound: '暂停访谈', finishRound: '完成访谈', respond: '记录访谈',
  publishPack: '发布交接包', startExam: '开始验收', answer: '保存作答', unlockExam: '进入开卷', submitExam: '提交验收',
  review: '人工复核', finalizeExam: '生成报告', remediate: '记录补交接', sign: '签署确认书',
  requestExport: '申请导出', decideExport: '处理导出审批', estimates: '更新风险估算',
  readNotice: '阅读通知', requestDeletion: '申请删除', approveDeletion: '批准删除',
}

const OWNER = ['owner']
const PARTICIPANTS = ['owner', 'leaver', 'successor']
const ROLES_FOR = {
  consent: PARTICIPANTS, asset: ['owner', 'leaver'], material: ['owner', 'leaver'], inventory: OWNER,
  startRound: ['leaver'], pauseRound: ['leaver'], finishRound: ['leaver'], respond: ['leaver'], publishPack: OWNER,
  startExam: ['successor'], answer: ['successor'], unlockExam: ['successor'], submitExam: ['successor'],
  review: OWNER, finalizeExam: OWNER, remediate: ['owner', 'leaver'], sign: PARTICIPANTS,
  requestExport: [...PARTICIPANTS, 'hr', 'auditor'], decideExport: ['owner', 'hr'], estimates: OWNER,
  readNotice: [...PARTICIPANTS, 'hr', 'auditor'], requestDeletion: PARTICIPANTS, approveDeletion: ['hr'],
}

export function checkAction(position, actor, name) {
  requireThat(ROLES_FOR[name]?.includes(actor.role), '当前角色无权执行此操作。', 403)
  const locked = ['consent', 'requestExport', 'decideExport', 'readNotice', 'requestDeletion', 'approveDeletion']
  requireStage(position.stage !== 'archived' || locked.includes(name), '岗位已归档，交接记录不可修改。')
  if (name === 'sign') requireStage(position.reports.at(-1)?.passed && !startedAttempt(position.attempts.at(-1)), '报告有未通过的验收项，暂不可签署。')
  if (name === 'material' || name === 'asset') {
    consent(position, actor)
    const attempt = position.attempts.at(-1)
    requireStage(!attempt || (attempt.phase === 'final' && !attempt.passed && position.attempts.length < 2), '当前验收已锁定关联材料。')
  }
}

const currentRound = (position) => position.rounds.find((round) => !round.completedAt)
const elapsed = (round, timestamp) => round.elapsed + (round.runningSince ? Math.max(0, Date.parse(timestamp) - Date.parse(round.runningSince)) : 0)
const elapsedOnly = (round, timestamp) => Math.min(elapsed(round, timestamp), ROUND_MS)

function finishRound(position, round, timestamp) {
  round.elapsed = elapsedOnly(round, timestamp)
  round.runningSince = null
  round.completedAt = timestamp
  round.completion = Math.round(100 * round.entries.length / 8)
  if (!currentRound(position)) {
    position.stage = 'pack'
    pushNotice(position, ['owner'], '三轮访谈已结束，请核对并发布交接包。', 'pack')
  }
}

function attachSource(asset, source) {
  if (!asset.sources.some((previous) => previous.locator === source.locator && previous.excerpt === source.excerpt)) asset.sources = [...asset.sources, source].slice(-12)
}

function recordInterview(position, round, input, prepared, timestamp) {
  const question = questionFor(round, position.assets)
  requireStage(round.entries.length === prepared.index, '本题已更新，请重新打开当前问题。')
  const refused = input.refused === true
  const answer = refused ? '' : safeText(input.answer, 3000, true)
  const proof = !refused && input.locator ? sourceFor(input) : null
  const asset = position.assets.find((item) => item.id === question.assetId)
  const entry = { id: id(), ...question, answer, refused, locator: proof?.locator, link: proof?.link, at: timestamp, level: asset?.level ?? 'S1', suggestions: [] }
  round.entries.push(entry)
  if (refused || answer.length < 9) {
    entry.needsReview = true
    return
  }
  addMetrics(position, prepared.ai?.metric)
  entry.followup = prepared.ai?.interview?.followup
  if (asset?.level === 'S3') return
  const source = { kind: 'interview', interviewId: entry.id, locator: `第 ${round.number} 轮 · 第 ${round.entries.length} 问${proof ? ` · ${proof.locator}` : ''}`, link: proof?.link, excerpt: answer.slice(0, 500), at: timestamp }
  if (asset) {
    attachSource(asset, source)
    entry.suggestions.push({ id: asset.id, title: asset.title, kind: 'update' })
    if (input.conflict === true || prepared.ai?.interview?.conflict) {
      asset.conflict = true
      asset.confirmed = false
      entry.needsReview = true
    }
  }
  const supplied = input.title ? { title: input.title, category: input.category, quote: answer } : null
  const firstClause = answer.match(/^([^:。；;\n]{5,28})[:：]/)?.[1]?.trim()
  const local = firstClause && !position.assets.some((item) => item.title === firstClause) ? { title: firstClause, category: asset?.category ?? '例外与风险', quote: answer } : null
  for (const candidate of [supplied, local, ...(prepared.ai?.items ?? []).slice(0, 2)]) {
    if (!candidate || typeof candidate.quote !== 'string' || candidate.quote.length < 4 || !answer.includes(candidate.quote) || !CATEGORIES.includes(candidate.category)) continue
    let title
    try { title = safeText(candidate.title, 90, true) } catch { continue }
    if (!supplied && !answer.includes(title)) continue
    const existing = position.assets.find((item) => item.title === title && item.category === candidate.category)
    if (existing) continue
    if (position.assets.length >= 250) break
    const suggestion = { id: id(), title, category: candidate.category, level: entry.level, importance: '一般', critical: false,
      confirmed: false, detail: { exception: candidate.quote.slice(0, 900) }, sources: [{ ...source, excerpt: candidate.quote.slice(0, 500) }], updatedAt: timestamp }
    position.assets.push(suggestion)
    entry.suggestions.push({ id: suggestion.id, title, kind: 'new' })
  }
}

export async function applyAction(position, actor, name, input, prepared, putImage) {
  checkAction(position, actor, name)
  const timestamp = now()
  const attempt = position.attempts.at(-1)
  const round = currentRound(position)
  switch (name) {
    case 'consent': {
      requireThat(input.privacy === true, '需要确认已阅读交接告知。')
      position.consents[actor.id] = { privacy: true, restricted: input.restricted === true, model: input.model === true, at: timestamp, version: '1.0' }
      break
    }
    case 'asset': {
      if (input.level !== 'S1' && input.level !== undefined) consent(position, actor, 'restricted')
      const previous = position.assets.find((asset) => asset.id === input.assetId)
      if (input.assetId) requireThat(previous, '未找到资产条目。', 404)
      if (previous?.level !== 'S1' && previous) consent(position, actor, 'restricted')
      requireThat(actor.role === 'owner' || !input.confirmed, '条目仅可由业务负责人确认。', 403)
      requireThat(actor.role === 'owner' && position.stage === 'assets' || Boolean(previous?.critical) === (input.critical === true), '必考项只能在盘点确认前由负责人调整。', 403)
      requireThat(!input.resolveConflict || (actor.role === 'owner' && input.locator), '解决矛盾须由负责人提供核查来源。')
      requireThat(previous || position.assets.length < 250, '此岗位最多 250 个资产条目。')
      const updated = updatedAsset(input, previous, position.assets, timestamp)
      if (previous) position.assets[position.assets.indexOf(previous)] = updated
      else position.assets.push(updated)
      break
    }
    case 'material': {
      const { material, suggestions, metric, degraded } = prepared
      if (material.level === 'S2') consent(position, actor, 'restricted')
      requireThat(position.materials.length < 30 && position.materials.reduce((size, item) => size + item.bytes, 0) + material.bytes <= MAX_ATTACHMENTS, '岗位的材料容量已达上限。', 413)
      const accepted = []
      for (const item of suggestions) {
        const entry = position.assets.find((asset) => asset.title === item.title && asset.category === item.category)
        if (entry?.level === 'S3' || (entry?.confirmed && entry.level === 'S1' && item.level === 'S2')) continue
        if (entry) {
          attachSource(entry, item.source)
          if (item.level === 'S2') entry.level = 'S2'
          accepted.push(entry.id)
        } else if (position.assets.length < 250) {
          const draft = { id: id(), title: item.title, category: item.category, level: item.level, critical: false, importance: '一般', confirmed: false,
            sources: [item.source], detail: {}, updatedAt: timestamp }
          position.assets.push(draft)
          accepted.push(draft.id)
        }
      }
      position.materials.push({ ...material, suggestions: accepted, degraded })
      addMetrics(position, metric)
      break
    }
    case 'inventory':
      consent(position, actor)
      requireStage(position.stage === 'assets' && position.assets.some(isEvidence), '请先确认至少一条有证据的资产。')
      requireThat(position.assets.some((asset) => asset.critical), '请选择至少一条关键项。')
      position.stage = 'interview'
      position.inventoryAt = timestamp
      pushNotice(position, ['leaver'], '资产地图已确认，可以开始第一轮访谈。', 'interview')
      break
    case 'startRound':
      requireStage(position.stage === 'interview' && round && !round.runningSince, '请先确认资产地图，或恢复尚未完成的轮次。')
      consent(position, actor)
      requireStage(position.rounds.reduce((sum, item) => sum + item.elapsed, 0) < INTERVIEW_MS && round.elapsed < ROUND_MS, '本轮时长已用完，请结束本轮并安排人工补充。')
      round.startedAt ??= timestamp
      round.runningSince = timestamp
      round.evidenceIndex ??= randomInt(10000)
      break
    case 'pauseRound':
      requireStage(round?.runningSince, '当前没有进行中的访谈。')
      round.elapsed = elapsedOnly(round, timestamp)
      round.runningSince = null
      break
    case 'finishRound':
      requireStage(round?.startedAt && (round.entries.length >= 7 || elapsed(round, timestamp) >= ROUND_MS), '每轮至少需处理 7 道问题，或等本轮时间结束。')
      finishRound(position, round, timestamp)
      break
    case 'respond': {
      requireStage(round?.runningSince && elapsed(round, timestamp) < ROUND_MS, '请先恢复访谈，或结束已到时的轮次。')
      consent(position, actor)
      const prompt = questionFor(round, position.assets)
      const level = position.assets.find((asset) => asset.id === prompt?.assetId)?.level ?? 'S1'
      if (level !== 'S1' && input.refused !== true || prepared.image) consent(position, actor, 'restricted')
      requireThat(level !== 'S3' || input.refused === true, '高危事项请在资产地图中填写访问路径，本轮可转人工。')
      recordInterview(position, round, input, prepared, timestamp)
      if (prepared.image) round.entries.at(-1).attachmentId = await addAttachment(position, actor, prepared.image, 'interview', putImage)
      if (round.entries.length === 8) finishRound(position, round, timestamp)
      break
    }
    case 'publishPack':
      requireStage(position.stage === 'pack' && position.assets.some((asset) => isEvidence(asset) && textFields(asset)), '三轮访谈完成且至少有一条有证据的可用资产后才能发布。')
      position.packPublishedAt = timestamp
      position.stage = 'exam'
      pushNotice(position, ['successor'], '交接包已发布，可以开始 30 分钟验收。', 'exam')
      break
    case 'startExam': {
      consent(position, actor)
      requireStage(position.packPublishedAt && (position.stage === 'exam' && !attempt || attempt?.phase === 'final' && retakeDue(position.attempts, timestamp)), '验收尚未开放、已完成或补考期限已过。')
      if (attempt) {
        const gaps = position.reports.at(-1).findings.filter((finding) => finding.status !== 'pass')
        requireStage(gaps.length ? gaps.every((gap) => position.remediations.some((item) => item.assetId === gap.assetId && item.at >= attempt.finalizedAt)) : position.remediations.some((item) => item.at >= attempt.finalizedAt), '请先完成报告所列的补交接。')
      }
      const identifier = id()
      const questions = makeQuestions(position.assets, identifier, attempt?.questions)
      requireStage(questions.length >= 5, '请补充至少五项有处置信息的资产后开始。')
      if (questions.some((question) => question.level !== 'S1')) consent(position, actor, 'restricted')
      position.attempts.push({ id: identifier, questions, answers: {}, results: [], phase: 'closed', startedAt: timestamp, endsAt: addTime(timestamp, EXAM_MS) })
      position.stage = 'exam'
      break
    }
    case 'answer': {
      requireStage(startedAttempt(attempt) && timestamp <= attempt.endsAt, '考试已结束，不能再修改答案。')
      const question = attempt.questions.find((item) => item.id === input.questionId)
      requireStage(question && question.openBook === (attempt.phase === 'open'), '此题不在当前答题阶段。')
      requireThat(question.level !== 'S3' || !prepared.image, '高危事项不可上传截图。')
      if (prepared.image) consent(position, actor, 'restricted')
      const text = safeText(input.text, 4000)
      const previous = attempt.answers[question.id]
      if (previous?.attachmentId && prepared.image) requireThat(false, '本题已上传附件。可保留附件并修改文字。', 409)
      const attachmentId = prepared.image ? await addAttachment(position, actor, prepared.image, 'answer', putImage) : previous?.attachmentId
      requireThat(text || attachmentId, '请填写答案或上传可核查的附件。')
      attempt.answers[question.id] = { text, attachmentId, at: timestamp }
      break
    }
    case 'unlockExam':
      requireStage(attempt?.phase === 'closed' && timestamp <= attempt.endsAt && attempt.questions.filter((item) => !item.openBook).every((item) => attempt.answers[item.id]), '请完成闭卷题后再开始开卷。')
      attempt.phase = 'open'
      break
    case 'submitExam':
      requireStage(startedAttempt(attempt) && (timestamp > attempt.endsAt || attempt.questions.every((item) => attempt.answers[item.id])), '请先完成全部题目。')
      attempt.phase = 'scoring'
      attempt.submittedAt = timestamp
      break
    case 'review': {
      requireStage(attempt?.phase === 'review', '等待自动评分完成后再复核。')
      const result = attempt.results.find((item) => item.id === input.questionId)
      const question = attempt.questions.find((item) => item.id === input.questionId)
      requireThat(result, '未找到题目。', 404)
      requireThat(Number.isInteger(input.score) && input.score >= 0 && input.score <= 100, '人工评分须为 0–100 的整数。')
      requireThat(input.score < 80 || question.evidence && (attempt.answers[question.id]?.text || attempt.answers[question.id]?.attachmentId), '无证据或未作答的条目不能复核为通过。')
      result.autoScore ??= result.score
      Object.assign(result, { score: input.score, status: input.score >= 80 ? 'pass' : 'fail', reason: safeText(input.reason, 500, true), needsReview: false, reviewedAt: timestamp, reviewer: actor.id })
      break
    }
    case 'finalizeExam': {
      requireStage(attempt?.phase === 'review' && attempt.results.every((item) => !item.needsReview), '请先完成抽检与所有待复核题。')
      attempt.phase = 'final'
      attempt.finalizedAt = timestamp
      const report = buildReport(position, timestamp)
      Object.assign(attempt, scoreAttempt(attempt), { passed: report.passed })
      position.reports.push({ ...report, version: position.reports.length + 1, attemptId: attempt.id, at: timestamp })
      position.stage = 'report'
      pushNotice(position, PARTICIPANTS, report.passed ? '验收已通过，请阅读报告并签署确认书。' : '报告已有结论，请处理未通过项并安排补考。', 'report')
      break
    }
    case 'remediate': {
      requireStage(attempt?.phase === 'final' && retakeDue(position.attempts, timestamp), '当前没有可处理的首考差距项。')
      const asset = position.assets.find((item) => item.id === input.assetId)
      requireThat(asset, '未找到关联条目。', 404)
      if (asset.level !== 'S1') consent(position, actor, 'restricted')
      requireThat(asset.level !== 'S3' || !input.note, '高危事项请填访问路径核对来源，不得记录内容。')
      position.remediations.push({ id: id(), assetId: asset.id, level: asset.level, note: safeText(input.note, 900, asset.level !== 'S3'), source: sourceFor(input), actor: actor.id, at: timestamp })
      break
    }
    case 'sign': {
      consent(position, actor, 'restricted')
      requireThat(input.acknowledge === true && prepared.image, '请确认责任范围并上传手写签名。')
      requireStage(!position.signatures.some((record) => record.role === actor.role), '你已签署本版确认书。')
      const attachmentId = await addAttachment(position, actor, prepared.image, 'signature', putImage)
      position.signatures.push({ role: actor.role, actor: actor.id, name: actor.name, attachmentId, at: timestamp,
        reportVersion: position.reports.at(-1).version, digest: createHash('sha256').update(prepared.image).digest('hex') })
      position.stage = position.signatures.length === 3 ? 'archived' : 'letter'
      if (position.stage === 'archived') {
        position.archivedAt = timestamp
        pushNotice(position, PARTICIPANTS, '三方已签署，岗位交接归档。', 'letter')
      }
      break
    }
    case 'requestExport': {
      requireThat(['pack', 'report', 'letter'].includes(input.scope) && (input.format === 'pdf' || input.scope === 'pack' && input.format === 'md'), '不支持该导出范围或格式。')
      const redacted = input.redacted !== false
      requireThat(redacted || maySeeRestricted(position, actor), '当前角色仅可申请脱敏导出。', 403)
      requireStage(!startedAttempt(attempt) || actor.role !== 'successor', '答题阶段不能申请导出。')
      requireThat(position.exports.length < 100, '导出申请已达上限，请联系管理员。')
      requireStage(!position.exports.some((entry) => entry.state === 'pending' && entry.requestedBy === actor.id && entry.scope === input.scope && entry.format === input.format && entry.redacted === redacted), '已有相同的导出申请等待审批。')
      position.exports.push({ id: id(), scope: input.scope, format: input.format, redacted, requestedBy: actor.id, requesterName: actor.name,
        requestedAt: timestamp, state: 'pending', snapshot: createExportSnapshot(position, input.scope, redacted) })
      pushNotice(position, ['owner', 'hr'], '有一项导出申请等待审批。', 'settings')
      break
    }
    case 'decideExport': {
      const entry = position.exports.find((item) => item.id === input.exportId)
      requireThat(entry && mayApprove(position, actor) && entry.requestedBy !== actor.id, '申请人不能审批自己的导出。', 403)
      requireStage(entry.state === 'pending', '该申请已处理。')
      requireThat(typeof input.approve === 'boolean', '请选择审批结果。')
      entry.state = input.approve ? 'approved' : 'denied'
      entry.decidedAt = timestamp
      entry.decidedBy = actor.id
      entry.reason = safeText(input.reason, 300, !input.approve)
      const role = Object.keys(position.actors).find((role) => position.actors[role].id === entry.requestedBy)
      pushNotice(position, role ? [role] : ['hr', 'auditor'], input.approve ? '导出申请已批准，可以下载有水印的文件。' : '导出申请未获批准。', 'settings')
      break
    }
    case 'estimates': {
      const { incident, daily, riskyDays } = input
      requireThat([incident, daily, riskyDays].every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) && Number.isInteger(riskyDays) && riskyDays <= 365, '请填写非负成本与 0–365 天的影响期。')
      position.estimate = { incident, daily, riskyDays, total: incident + daily * riskyDays }
      break
    }
    case 'readNotice': {
      const notice = position.notifications.find((item) => item.id === input.noticeId && item.roles.includes(actor.role))
      requireThat(notice, '通知已失效。', 404)
      if (!notice.readBy.includes(actor.id)) notice.readBy.push(actor.id)
      break
    }
    case 'requestDeletion':
      requireStage(!position.deletion, '已存在一个删除申请。')
      position.deletion = { at: timestamp, requester: actor.id, reason: safeText(input.reason, 350, true) }
      pushNotice(position, ['hr'], '收到一项岗位数据删除申请。', 'settings')
      break
    case 'approveDeletion':
      requireStage(position.deletion && !position.purgeAfter, '无可处理的删除申请。')
      requireThat(input.acknowledge === true, '请确认已核对留存义务。')
      position.purgeAfter = timestamp
      position.deletion.approvedAt = timestamp
      break
  }
  position.updatedAt = timestamp
  return position
}

async function addAttachment(position, actor, bytes, kind, putImage) {
  requireThat(position.attachments.reduce((total, item) => item.bytes + total, 0) + bytes.length <= MAX_ATTACHMENTS, '岗位的附件容量已达上限。', 413)
  const attachment = { id: id(), owner: actor.id, bytes: bytes.length, kind, at: now() }
  await putImage(attachment.id, bytes)
  position.attachments.push(attachment)
  return attachment.id
}
