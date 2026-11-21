import assert from 'node:assert/strict'
import test from 'node:test'
import { CATEGORIES, TEMPLATE } from '../shared/catalog.mjs'
import { buildReport, evaluateAnswer, makeQuestions, questionFor, retakeDue, safeAssetInput, safeText } from '../server/domain.mjs'

const timestamp = '2026-11-21T02:00:00.000Z'
const source = { kind: 'manual', locator: '续费 SOP 第 2 节' }
const assets = TEMPLATE.map((asset) => ({ ...asset, confirmed: true, sources: [source], updatedAt: timestamp }))

test('销售运营模板覆盖 8 类且提供 10 个必考候选', () => {
  assert.equal(CATEGORIES.length, 8)
  assert.ok(TEMPLATE.length >= 40)
  assert.equal(TEMPLATE.filter((asset) => asset.critical).length, 10)
  assert.ok(CATEGORIES.every((category) => TEMPLATE.some((asset) => asset.category === category)))
})

test('15 题覆盖五类，开卷占 40%，关键项全部入卷', () => {
  const questions = makeQuestions(assets, '卷 A')
  assert.equal(questions.length, 15)
  assert.equal(new Set(questions.map((question) => question.type)).size, 5)
  assert.equal(questions.filter((question) => question.openBook).length, 6)
  assert.deepEqual(new Set(questions.filter((question) => question.critical).map((question) => question.assetId)),
    new Set(assets.filter((asset) => asset.critical).map((asset) => asset.id)))
  assert.deepEqual(makeQuestions(assets, '卷 A'), questions)
})

test('S3 只允许访问路径且拦截检测到的秘密', () => {
  const meta = { location: '企业密码管理器', contact: 'IT 服务台', request: '通过服务台审批申请' }
  assert.deepEqual(safeAssetInput({ level: 'S3', ...meta }).detail, meta)
  assert.throws(() => safeAssetInput({ level: 'S3', ...meta, exception: '直接交给接班人' }), /高危/)
  assert.throws(() => safeText('管理员密码：Example!234'), /敏感/)
  assert.throws(() => safeText('-----BEGIN PRIVATE KEY-----'), /敏感/)
  assert.throws(() => safeAssetInput({ level: 'S3', location: '最低价=39万元' }), /敏感/)
})

test('答案无来源或低置信只待复核', () => {
  const question = { terms: ['收入审批组'], labels: ['审批人'], evidence: true }
  assert.equal(evaluateAnswer(question, '由收入审批组处理').status, 'pass')
  assert.equal(evaluateAnswer({ ...question, evidence: false }, '由收入审批组处理').status, 'review')
  assert.equal(evaluateAnswer(question, '可能是销售副总').status, 'review')
})

test('未通过关键项压过高分，缺失关键资产在覆盖度中一票否决', () => {
  const questions = makeQuestions(assets, '卷 A')
  const firstCritical = questions.find((question) => question.critical)
  const results = questions.map(({ id }) => ({ id, score: id === firstCritical.id ? 0 : 100, status: id === firstCritical.id ? 'fail' : 'pass' }))
  const attempt = { questions, results, finalizedAt: timestamp }
  const report = buildReport({ assets, attempts: [attempt], backups: 2 }, timestamp)
  assert.ok(report.score >= 80)
  assert.equal(report.status, 'red')
  assert.equal(report.passed, false)
  assert.equal(report.failingCritical[0].assetId, firstCritical.assetId)
  const missing = assets.map((asset) => asset.id === firstCritical.assetId ? { ...asset, confirmed: false } : asset)
  assert.equal(buildReport({ assets: missing, attempts: [attempt], backups: 2 }, timestamp).components.coverage, 0)
  assert.equal(buildReport({ assets, attempts: [attempt], backups: 1 }, timestamp).components.substitutes, 60)
})

test('补考窗精确到 7 天且最多允许第二次提交', () => {
  const first = { finalizedAt: timestamp, passed: false }
  assert.equal(retakeDue([first], '2026-11-28T02:00:00.000Z'), '2026-11-28T02:00:00.000Z')
  assert.equal(retakeDue([first], '2026-11-28T02:00:00.001Z'), null)
  assert.equal(retakeDue([first, {}], timestamp), null)
  assert.equal(retakeDue([{ ...first, passed: true }], timestamp), null)
})

test('访谈沿已核验的回答追问，并保留原条目关联', () => {
  const round = { number: 2, entries: [{ assetId: 'so-01', locator: '审批记录第 3 条', followup: '当时为什么需要大区负责人批准？' }] }
  assert.deepEqual(questionFor(round, assets), { text: '当时为什么需要大区负责人批准？', assetId: 'so-01' })
})
