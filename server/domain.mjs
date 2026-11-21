import { createHash, randomUUID } from 'node:crypto'
import { CATEGORIES, COVERAGE_NOTICE, QUESTION_TYPES, ROUND_NAMES, TEMPLATE } from '../shared/catalog.mjs'

export const DAY = 86_400_000
const MAX_CRITICAL = 10
export const isEvidence = (asset) => asset.confirmed && Boolean(asset.sources.length) && !asset.conflict
export const id = () => randomUUID()
export const now = () => new Date().toISOString()
export const addTime = (value, milliseconds) => new Date(Date.parse(value) + milliseconds).toISOString()
export const localDay = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

export function requireThat(condition, message, status = 422) {
  if (!condition) throw Object.assign(new Error(message), { status })
}

const secretPatterns = [
  /-----\s*BEGIN\s+[\w ]*PRIVATE KEY/i,
  /(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[\w-]{10,}/i,
  /(?:密码|口令|私钥|访问密钥|密钥内容|password|passwd|api[ _-]?key|client[ _-]?secret|access[ _-]?token)\s*["'”’]?\s*[:=是为]\s*["'“‘]?\S+/iu,
  /(?:底价|最低价|成本底线)\s*(?:[:=是为]|最低)?\s*[¥￥$]?\s*\d/iu,
  /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s/]+:[^\s/@]+@/i,
  /\bBearer\s+[\w.~-]{12,}/i,
]

export function safeText(value = '', limit = 2000, required = false) {
  requireThat(typeof value === 'string', '请输入文字。')
  const text = value.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '').trim()
  requireThat(text.length <= limit && (!required || text.length > 0), `请填写有效内容，最多 ${limit} 字。`)
  requireThat(!secretPatterns.some((pattern) => pattern.test(text)), '检测到高危敏感内容，请删除原值，只填访问路径。')
  return text
}

export function safeLink(value) {
  const link = safeText(value, 1000)
  if (!link) return ''
  let parsed
  try { parsed = new URL(link) } catch { requireThat(false, '证据链接须为完整的 HTTP 或 HTTPS 地址。') }
  requireThat(['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password, '证据链接须为不含登录凭证的 HTTP 或 HTTPS 地址。')
  requireThat(![...parsed.searchParams.keys()].some((key) => /pass|secret|token|api.?key|credential|signature|authorization/i.test(key)), '请移除证据链接中的访问凭证。')
  return link
}

export function safeAssetInput(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), '条目字段无效。')
  const level = input.level ?? 'S1'
  requireThat(['S1', 'S2', 'S3'].includes(level), '请选择有效的敏感分级。')
  const fields = level === 'S3' ? ['location', 'contact', 'request'] : ['when', 'location', 'contact', 'exception']
  const disallowed = level === 'S3' ? ['when', 'exception', 'summary', 'excerpt', 'link', 'locator', 'sources', 'attachment', 'requestBody', 'password', 'secret', 'value'] : ['request']
  requireThat(!disallowed.some((field) => input[field]), level === 'S3' ? '高危条目只允许位置、持有人和申请方式。' : '访问申请仅用于高危条目。')
  return { level, detail: Object.fromEntries(fields.map((field) => [field, safeText(input[field], field === 'contact' ? 240 : 1200)])) }
}

export function sourceFor(input) {
  return { kind: 'manual', locator: safeText(input.locator, 300, true), link: safeLink(input.link), at: now() }
}

export function updatedAsset(input, previous, list, timestamp) {
  const { level, detail } = safeAssetInput(input)
  const title = safeText(input.title, 90, true)
  const category = input.category
  const critical = input.critical === true
  requireThat(CATEGORIES.includes(category), '请选择资产类别。')
  requireThat(list.filter((asset) => asset.id !== previous?.id && asset.critical).length + Number(critical) <= MAX_CRITICAL, '必考关键项最多 10 条。')
  requireThat(!list.some((asset) => asset.id !== previous?.id && asset.category === category && asset.title === title), '类别中已有同名条目，请更新原条目。', 409)
  const sources = level === 'S3' ? (detail.location && detail.contact && detail.request ? [{ kind: 'access', locator: '负责人确认的访问路径', at: timestamp }] : []) : [
    ...(previous?.level !== 'S3' ? previous?.sources ?? [] : []), ...(input.locator ? [sourceFor(input)] : []),
  ].slice(-12)
  const confirm = input.confirmed === true
  const conflict = Boolean(previous?.conflict && !input.resolveConflict)
  requireThat(!confirm || (sources.length && Object.values(detail).some(Boolean) && !conflict), '请先填写处置信息、补充可核查证据并解决矛盾。')
  return {
    id: previous?.id ?? id(), title, category, level, detail, critical,
    importance: critical ? '关键' : input.importance === '重要' ? '重要' : '一般',
    sources, confirmed: confirm, updatedAt: timestamp, conflict,
  }
}

const prompts = [
  ['常规工作按什么节奏执行？', '哪些系统和权限确实在用？上次是什么时候？', '需要接班人优先认识谁？', '哪些外部伙伴会影响交付？', '关键文件的最新版在哪里？', '本月有哪些不能错过的节点？', '当前有哪些未办结事项？', '哪件事现在只有你能做？'],
  ['最近一次不按流程走是什么时候？谁批准的？', '超授权时怎么判断，找谁升级？', '有哪些没写进系统的历史承诺？', '流程走错最坏的后果是什么？', '哪些表格有隐藏逻辑或特殊口径？', '系统记录冲突时以哪个为准？', '遇到人员或系统不可用时，如何兜底？', '最近三个月最难处理的情况是什么？'],
  ['关键流程的最新版和审批记录在哪里？', '有关系统权限的申请入口和持有人是谁？', '客户承诺可以用哪条记录核对？', '复核一项外部依赖，能提供证据吗？', '请提供一条能验证数据口径的来源。', '谁能在你不在时独立处理关键事项？', '哪些到期时间还没有被验证？', '这周最需要接班人确认哪三项？'],
]

export function questionFor(round, assets) {
  const index = round.entries.length
  const reminder = prompts[round.number - 1]?.[index]
  if (!reminder) return null
  const previous = round.entries.at(-1)
  if (previous?.followup && !(round.number === 3 && index === 3)) return { text: previous.followup, assetId: previous.assetId }
  const asset = round.number === 3 && index === 3
    ? assets.filter(isEvidence)[round.evidenceIndex % (assets.filter(isEvidence).length || 1)]
    : [...assets.filter((item) => item.critical && !isEvidence(item)), ...assets.filter((item) => item.critical && isEvidence(item))][(index + (round.number - 1) * 3) % MAX_CRITICAL]
  if (previous && !previous.refused && !previous.locator && index % 3 === 2) return { text: `上一条说明的来源可以怎样核验？请补一个文件位置、页码或记录链接。${reminder}`, assetId: previous.assetId }
  return { text: asset ? `围绕「${asset.title}」，${reminder}` : reminder, assetId: asset?.id }
}

const rubricFields = [['location', '位置'], ['contact', '负责人'], ['when', '触发与步骤'], ['exception', '例外与影响'], ['request', '申请方式']]
const fieldOrder = [[0, 1], [1, 3], [2, 0], [3, 1], [3, 2]]
const questionCopy = [
  ['在哪里找到最新版？请写出位置以及核验路径。', '怎样确认自己找到的是正确版本？请给出位置和核验人。'],
  ['遇到例外时由谁判断，什么情况下需要升级？请说明原因。', '标准流程无法适用时，谁有最终处理权？为什么？'],
  ['请复现处理步骤，并写出使用的材料或入口。', '假如今天必须独立完成，请写出触发条件、步骤和验证方法。'],
  ['这个事项的处理边界是什么？出现冲突时找谁？', '遇到超出授权范围的请求时，你怎么处理并防止误判？'],
  ['最可能发生什么遗留风险？具体怎样预防？', '如果交接后一周出现问题，最早的信号和处置方式是什么？'],
]
const digest = (text) => createHash('sha256').update(text).digest('hex')
const roundOne = (value) => Math.round(value * 10) / 10
const normalize = (text) => text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')

export function makeQuestions(assets, seed, previous = []) {
  const shuffle = (list) => [...list].sort((left, right) => digest(seed + left.id).localeCompare(digest(seed + right.id)))
  const critical = shuffle(assets.filter((asset) => asset.critical))
  const others = shuffle(assets.filter((asset) => !asset.critical && isEvidence(asset)))
  const selected = previous.length
    ? previous.map((question) => assets.find((asset) => asset.id === question.assetId) ?? { id: question.assetId, title: question.title, critical: question.critical, level: question.level, detail: {}, sources: [] })
    : [...critical, ...others].slice(0, 15)
  const ordered = shuffle(selected)
  const openCount = Math.round(ordered.length * 0.4)
  return ordered.map((asset, index) => {
    const prior = previous.find((question) => question.assetId === asset.id)
    const typeIndex = prior ? QUESTION_TYPES.indexOf(prior.type) : index % QUESTION_TYPES.length
    const fields = [...new Set([...fieldOrder[typeIndex], 4, 0, 1, 2, 3])].map((field) => rubricFields[field])
    const fieldsPresent = fields.filter(([field]) => asset.detail[field]).slice(0, 2)
    const openBook = prior?.openBook ?? index < openCount
    const variant = prior ? 1 - prior.variant : Number.parseInt(digest(seed + asset.id).slice(-1), 16) % 2
    return {
      id: digest(seed + asset.id).slice(0, 24), assetId: asset.id, title: asset.title,
      prompt: `关于「${asset.title}」，${asset.level === 'S3' ? '请说明保存位置、持有人和申请方式，不要写出凭证内容。' : questionCopy[typeIndex][variant]}`,
      variant, type: QUESTION_TYPES[typeIndex], openBook, critical: prior?.critical ?? asset.critical, level: asset.level,
      evidence: isEvidence(asset), sources: asset.sources, terms: fieldsPresent.map(([field]) => asset.detail[field]), labels: fieldsPresent.map(([, label]) => label),
    }
  }).sort((left, right) => Number(left.openBook) - Number(right.openBook))
}

export function evaluateAnswer(question, answer) {
  if (!question.evidence || !question.terms.length) return { score: 0, status: 'review', reason: '条目缺少可核查依据，需人工复核。' }
  if (!answer?.trim()) return { score: 0, status: 'fail', reason: '未提交答案。' }
  const matched = question.terms.map((term) => {
    const clean = normalize(answer)
    const reference = normalize(term)
    const offset = clean.indexOf(reference)
    return reference.length >= 2 && offset >= 0 && !/(?:不是|无需|无须|不用|不走|并非|跳过|不要|不找)$/.test(clean.slice(Math.max(0, offset - 4), offset))
  })
  const score = Math.round(100 * matched.filter(Boolean).length / matched.length)
  return score >= 80
    ? { score, status: 'pass', reason: `答案覆盖了证据中的${question.labels.join('、')}。` }
    : { score, status: 'review', reason: `请复核${question.labels.filter((_, index) => !matched[index]).join('、')}与答题依据。` }
}

export function gradeAttempt(attempt, overrides = {}) {
  const results = attempt.questions.map((question) => {
    const answer = attempt.answers[question.id]
    return { id: question.id, ...(overrides[question.id] ?? evaluateAnswer(question, answer?.text)) }
  })
  const sampleCount = Math.ceil(results.length * 0.2)
  const sample = [...results].sort((left, right) => digest(left.id + 'review').localeCompare(digest(right.id + 'review'))).slice(0, sampleCount)
  const sampleIds = new Set(sample.map((result) => result.id))
  return results.map((result) => ({ ...result, sampled: sampleIds.has(result.id), needsReview: result.status === 'review' || sampleIds.has(result.id) }))
}

export function scoreAttempt(attempt) {
  const scores = new Map(attempt.results.map((result) => [result.id, result]))
  const points = attempt.questions.reduce((sum, question) => sum + (question.critical ? 2 : 1), 0)
  const score = points ? roundOne(attempt.questions.reduce((sum, question) => sum + (scores.get(question.id)?.score || 0) * (question.critical ? 2 : 1), 0) / points) : 0
  const passed = score >= 80 && attempt.questions.every((question) => !question.critical || scores.get(question.id)?.status === 'pass')
  return { score, passed }
}

export function buildReport(position, timestamp = now()) {
  const { assets, attempts, backups } = position
  const attempt = attempts.filter((item) => item.finalizedAt).at(-1)
  const results = new Map(attempt?.results.map((result) => [result.id, result]))
  const activeAssets = assets.filter(isEvidence)
  const missing = assets.filter((asset) => asset.critical && !isEvidence(asset))
  const findings = (attempt?.questions ?? []).map((question) => ({
    assetId: question.assetId, title: question.title, level: question.level, critical: question.critical,
    sources: question.sources, status: results.get(question.id)?.status ?? 'review',
    score: results.get(question.id)?.score ?? 0, reason: results.get(question.id)?.reason ?? '',
  }))
  for (const asset of missing) {
    const finding = findings.find((item) => item.assetId === asset.id)
    if (finding) Object.assign(finding, { status: 'review', reason: '必考资产来源尚未确认或有证据矛盾。' })
    else findings.push({ assetId: asset.id, title: asset.title, level: asset.level, sources: [], critical: true, status: 'review', score: 0, reason: '关键资产缺少已确认的证据。' })
  }
  const failingCritical = findings.filter((item) => item.critical && item.status !== 'pass')
  const weights = findings.filter((item) => item.status === 'pass').reduce((sum, item) => sum + (item.critical ? 2 : 1), 0)
  const allWeights = findings.reduce((sum, item) => sum + (item.critical ? 2 : 1), 0)
  const components = {
    coverage: missing.length ? 0 : roundOne(100 * activeAssets.length / (assets.length || 1)),
    exam: roundOne(100 * weights / (allWeights || 1)),
    substitutes: backups >= 2 ? 100 : backups === 1 ? 60 : 0,
    freshness: roundOne(100 * activeAssets.filter((asset) => Date.parse(timestamp) - Date.parse(asset.updatedAt) <= 90 * DAY).length / (activeAssets.length || 1)),
  }
  const score = attempt ? roundOne(components.coverage * 0.3 + components.exam * 0.4 + components.substitutes * 0.2 + components.freshness * 0.1) : null
  const status = !attempt ? 'pending' : failingCritical.length || score < 60 ? 'red' : score >= 80 ? 'green' : 'amber'
  const total = attempt ? scoreAttempt(attempt) : { score: null, passed: false }
  const dependencies = activeAssets.filter((asset) => asset.critical && asset.detail.contact).map((asset) => ({
    assetId: asset.id, title: asset.title, label: asset.detail.contact, level: asset.level, source: asset.sources[0],
  }))
  return {
    score, status, components, examScore: total.score, passed: total.passed && status !== 'red', failingCritical,
    findings, dependencies, uncovered: assets.filter((asset) => !isEvidence(asset)).map(({ id, title, level }) => ({ id, title, level })),
    confidence: !attempt ? '尚未完成验收' : missing.length || findings.some((item) => item.status === 'review') ? '有证据待复核' : '已按列示证据复核',
    coverage: { expected: assets.length, verified: activeAssets.length, systems: activeAssets.filter((asset) => asset.category === CATEGORIES[1]).map(({ title, level }) => ({ title, level })), from: position.createdAt, to: timestamp },
    notice: COVERAGE_NOTICE,
  }
}

export function retakeDue(attempts, timestamp = now()) {
  if (attempts.length !== 1 || !attempts[0].finalizedAt || attempts[0].passed) return null
  const deadline = addTime(attempts[0].finalizedAt, 7 * DAY)
  return timestamp <= deadline ? deadline : null
}

export function newPosition(input, actors, timestamp = now()) {
  const due = input.due
  requireThat(typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due) && Number.isFinite(Date.parse(due)) && new Date(due).toISOString().slice(0, 10) === due, '请选择有效的交接日期。')
  const backups = input.backups ?? 0
  requireThat(Number.isInteger(backups) && backups >= 0 && backups <= 99, '替代人数须为 0–99 的整数。')
  return {
    id: id(), title: safeText(input.title, 80, true), department: safeText(input.department, 60, true), due,
    actors, backups, createdAt: timestamp, updatedAt: timestamp, stage: 'assets',
    assets: structuredClone(TEMPLATE), materials: [], rounds: ROUND_NAMES.map((title, index) => ({ number: index + 1, title, entries: [], elapsed: 0 })),
    attempts: [], reports: [], remediations: [], signatures: [], consents: {}, notifications: [], exports: [], attachments: [],
    model: { tokens: 0, cost: 0, requests: 0, failures: 0, duration: 0 },
  }
}
