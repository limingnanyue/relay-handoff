import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { crc32 } from 'node:zlib'
import test from 'node:test'
import PDFDocument from 'pdfkit'
import { createAI } from '../server/ai.mjs'
import { newPosition } from '../server/domain.mjs'
import { createExportSnapshot, markdown, pdf } from '../server/exports.mjs'
import { collectSuggestions, parseMaterial } from '../server/materials.mjs'

function zip(entries) {
  const content = [], directory = []
  let offset = 0
  for (const [name, value] of Object.entries(entries)) {
    const path = Buffer.from(name), data = Buffer.from(value), checksum = crc32(data)
    const header = Buffer.alloc(30), index = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26)
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(checksum, 16)
    index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(path.length, 28); index.writeUInt32LE(offset, 42)
    content.push(header, path, data); directory.push(index, path)
    offset += header.length + path.length + data.length
  }
  const end = Buffer.alloc(22), count = directory.length / 2
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.reduce((sum, item) => sum + item.length, 0), 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...content, ...directory, end])
}

test('解析真实中文 DOCX 和 PDF，并返回段号、页码及扫描件降级', async () => {
  const document = zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>续费折扣审批：联系收入审批组</w:t></w:r></w:p><w:p><w:r><w:t>管理员密码：Test-Secret-DoNotStore</w:t></w:r></w:p></w:body></w:document>',
  })
  const docx = await parseMaterial({ name: '盘点材料.docx', base64: document.toString('base64'), redacted: true })
  assert.equal(docx.material.status, 'partial')
  assert.equal(docx.material.blocked, 1)
  assert.deepEqual(docx.blocks, [{ ref: '第 1 段', text: '续费折扣审批:联系收入审批组' }])
  const exported = await pdf({ title: '续费折扣审批', lines: [{ text: '处置方式 · 联系收入审批组。' }] }, '脱敏件 · abc123 · v2')
  const parsed = await parseMaterial({ name: '盘点材料.pdf', base64: exported.toString('base64'), redacted: true })
  assert.equal(parsed.material.status, 'parsed')
  assert.equal(parsed.material.total, 1)
  assert.ok(parsed.blocks.some((item) => item.ref.includes('第 1 页') && item.text.includes('续费折扣审批')))
  const blank = new PDFDocument()
  const buffers = []
  blank.on('data', (chunk) => buffers.push(chunk))
  blank.rect(10, 10, 50, 50).fill()
  blank.end()
  await once(blank, 'end')
  const fallback = await parseMaterial({ name: '扫描件.pdf', base64: Buffer.concat(buffers).toString('base64'), redacted: true })
  assert.equal(fallback.material.status, 'fallback')
  assert.match(fallback.material.message, /粘贴正文/)
})

test('模型暂时限流时重试，引用必须能在原材料逐字对照', async () => {
  let requests = 0
  const server = createServer(async (request, response) => {
    const buffers = []
    for await (const bytes of request) buffers.push(bytes)
    const body = JSON.parse(Buffer.concat(buffers))
    assert.equal(body.response_format.type, 'json_schema')
    requests += 1
    response.setHeader('Content-Type', 'application/json')
    if (requests === 1) { response.writeHead(429).end('{}'); return }
    response.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 10 } }, choices: [{ message: { content: JSON.stringify({ items: [
      { title: '年中校准流程', category: '职责与流程', ref: '第 1 行', evidence: '年中校准流程于内部工作台处理' },
      { title: '无依据审批记录', category: '职责与流程', ref: '第 2 行', evidence: '无依据审批记录并不存在于正文' },
    ] }) } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const ai = createAI({ endpoint: `http://127.0.0.1:${server.address().port}/chat`, token: 'local-test-auth', model: 'local-fixture' })
    const position = newPosition({ title: '测试', department: '销售', due: '2026-12-01' }, {})
    const { material, blocks } = await parseMaterial({ name: '盘点材料', text: '年中校准流程于内部工作台处理\n续费折扣审批：联系收入审批组' })
    const result = await collectSuggestions(position, material, blocks, ai, true)
    assert.equal(result.metric.requests, 2)
    assert.equal(result.metric.failures, 1)
    assert.equal(result.metric.tokens, 140)
    assert.equal(result.metric.cacheSamples, 1)
    assert.equal(result.metric.cacheHits, 1)
    assert.equal(result.degraded, false)
    assert.deepEqual(result.suggestions.map((item) => item.title), ['续费折扣审批', '年中校准流程'])
    const budget = await ai.call('inventory', {}, { cost: 50, tokens: 100 })
    assert.equal(budget.degraded, true)
    assert.equal(requests, 2)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('交接包 Markdown 转义 HTML，脱敏稿删除原值与岗位名', () => {
  const position = newPosition({ title: '内部岗位', department: '销售', due: '2026-12-01' }, {})
  position.packPublishedAt = '2026-11-21T00:00:00Z'
  position.assets[0] = { ...position.assets[0], confirmed: true, detail: { location: '<敏感位置>' }, sources: [{ locator: '内网资料' }], updatedAt: position.packPublishedAt }
  const redacted = markdown(createExportSnapshot(position, 'pack', true), '脱敏件 · abc123')
  assert.doesNotMatch(redacted, /敏感位置|内部岗位|内网资料/)
  assert.match(markdown(createExportSnapshot(position, 'pack', false), '受限件 · abc123'), /&lt;敏感位置&gt;/)
})

test('访谈模型流式拆包后验证追问与矛盾的逐字依据', async () => {
  const answer = '今年改由收入审批组负责。'
  const evidence = '上一版规定销售值班组负责。'
  const server = createServer(async (request, response) => {
    const buffers = []
    for await (const chunk of request) buffers.push(chunk)
    const input = JSON.parse(Buffer.concat(buffers))
    if (!input.stream) { response.writeHead(400).end('需要流式请求'); return }
    const json = JSON.stringify({ items: [], followup: '改由收入审批组的审批记录在哪里？', anchor: answer, priorConflict: evidence, answerConflict: answer })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const content of [json.slice(0, 30), json.slice(30)]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ usage: { prompt_tokens: 90, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const ai = createAI({ endpoint: `http://127.0.0.1:${server.address().port}/chat`, token: 'fixture', model: 'fixture' })
    const result = await ai.call('interview', { answer, evidence: [evidence] }, { tokens: 0, cost: 0 }, 5000)
    assert.equal(result.degraded, false)
    assert.equal(result.interview.conflict, true)
    assert.match(result.interview.followup, /收入审批组/)
    assert.ok(result.metric.firstToken >= 0)
    assert.equal(result.metric.tokens, 110)
    const disputed = await ai.call('interview', { answer, evidence: ['新登记证据'] }, { tokens: 0, cost: 0 }, 5000)
    assert.equal(disputed.interview.conflict, false)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
