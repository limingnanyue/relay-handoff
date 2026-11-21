import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CATEGORIES, QUESTION_TYPES, TEMPLATE } from '../shared/catalog.mjs'
import { evaluateAnswer, makeQuestions, newPosition } from '../server/domain.mjs'
import { collectSuggestions, parseMaterial } from '../server/materials.mjs'

const source = { kind: 'manual', locator: '合成材料 · 第 1 节' }
const fixture = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : TEMPLATE.filter((asset) => asset.critical).map((asset, index) => ({
  name: `合成验收材料 ${index + 1}`, text: `${asset.title}：进入内部知识库核对记录，再联系负责小组。`, expected: [asset.title],
  grading: [
    { terms: ['收入审批组', '审批工作台'], answer: '打开审批工作台，由收入审批组复核。', human: 'pass' },
    { terms: ['收入审批组', '审批工作台'], answer: '随意找个人问一下。', human: 'review' },
  ],
}))
assert.ok(Array.isArray(fixture) && fixture.length)
const position = newPosition({ title: '评测用岗位', department: '销售运营', due: '2027-01-01' }, {})
const grading = []
let expected = 0, found = 0, proposed = 0, ungrounded = 0
for (const example of fixture) {
  const { material, blocks } = await parseMaterial({ name: example.name, text: example.text })
  const result = await collectSuggestions(position, material, blocks, { enabled: false }, false)
  expected += example.expected.length
  found += example.expected.filter((title) => result.suggestions.some((item) => item.title === title)).length
  proposed += result.suggestions.length
  ungrounded += result.suggestions.filter((item) => !blocks.some((block) => block.text.includes(item.source.excerpt))).length
  for (const item of example.grading ?? []) grading.push({ human: item.human, model: evaluateAnswer({ evidence: true, terms: item.terms, labels: item.terms }, item.answer).status })
}
const verified = TEMPLATE.map((asset) => ({ ...asset, confirmed: true, sources: [source], detail: { contact: '收入审批组', location: '审批工作台' } }))
const questions = makeQuestions(verified, '发布检查')
const categories = QUESTION_TYPES.map((type) => questions.filter((item) => item.type === type).length)
const rate = (numerator, divisor) => divisor ? numerator / divisor : null
const observed = rate(grading.filter((item) => item.human === item.model).length, grading.length)
const labels = ['pass', 'review', 'fail']
const expectedAgreement = labels.reduce((total, label) => total + (rate(grading.filter((item) => item.human === label).length, grading.length) ?? 0)
  * (rate(grading.filter((item) => item.model === label).length, grading.length) ?? 0), 0)
const kappa = observed === null || expectedAgreement === 1 ? null : (observed - expectedAgreement) / (1 - expectedAgreement)
const output = {
  source: process.argv[2] ? '用户提供的脱敏评测数据' : '合成数据 · 规则管道回归', samples: fixture.length,
  assetCategories: CATEGORIES.length, expected, found, criticalRecall: rate(found, expected), ungroundedRate: rate(ungrounded, proposed),
  questionCount: questions.length, questionCategories: categories, openBookRate: rate(questions.filter((item) => item.openBook).length, questions.length), kappa,
}
console.log(JSON.stringify(output, null, 2))
assert.ok(output.criticalRecall >= 0.9)
assert.ok(output.ungroundedRate <= 0.02)
assert.ok(categories.every(Boolean) && output.openBookRate === 0.4)
if (kappa !== null) assert.ok(kappa >= 0.6)
