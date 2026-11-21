import assert from 'node:assert/strict'
import { once } from 'node:events'
import PDFDocument from 'pdfkit'
import { getFont } from '../server/exports.mjs'
import { parseMaterial } from '../server/materials.mjs'

const roles = ['销售运营', '客户支持', '财务运营']
const formats = [
  { name: '50页', pages: 50, status: 'parsed', p95Limit: 60_000 },
  { name: '200页', pages: 200, status: 'parsed', p95Limit: 180_000 },
  { name: '扫描件模拟', pages: 5, status: 'fallback', p95Limit: 60_000 },
  { name: '复杂表格', pages: 12, status: 'parsed', p95Limit: 60_000 },
]

async function fixture(format, index) {
  const document = new PDFDocument({ autoFirstPage: false, size: 'A4', margin: 38 })
  const chunks = []
  document.on('data', (chunk) => chunks.push(chunk))
  const complete = once(document, 'end')
  const [font, face] = getFont()
  document.registerFont('relay', font, face)
  for (let page = 0; page < format.pages; page += 1) {
    document.addPage().font('relay').fontSize(10)
    if (format.status === 'fallback') {
      for (let line = 0; line < 30; line += 1) document.rect(40, 42 + line * 21, 130 + (line % 9) * 32, 7).fill('#475569')
    } else if (format.name === '复杂表格') {
      for (let row = 0; row < 28; row += 1) for (let column = 0; column < 6; column += 1) {
        const left = 38 + column * 86, top = 42 + row * 24
        document.rect(left, top, 86, 24).stroke('#94a3b8')
        document.text(`${roles[index % 3]}-${row}-${column}`, left + 3, top + 6, { width: 80, lineBreak: false })
      }
    } else {
      document.text(`${roles[index % 3]} · 交接材料 · 第 ${page + 1} 页`)
      for (let line = 0; line < 25; line += 1) document.text(`流程记录 ${line + 1} · 核对工作台、审批职责、复核周期和处置例外。`)
    }
  }
  document.end()
  await complete
  return Buffer.concat(chunks)
}

const results = []
for (const format of formats) {
  const durations = []
  for (let sample = 0; sample < 5; sample += 1) {
    const bytes = await fixture(format, sample)
    const start = performance.now()
    const { material, blocks } = await parseMaterial({ name: `${format.name}-${sample + 1}.pdf`, base64: bytes.toString('base64'), redacted: true })
    durations.push(Math.round(performance.now() - start))
    assert.equal(material.status, format.status, `${format.name} 第 ${sample + 1} 份`)
    assert.equal(material.total, format.pages)
    if (format.status === 'parsed') assert.ok(blocks.some((block) => block.ref === `第 ${format.pages} 页 · 第 1 行`))
  }
  durations.sort((left, right) => left - right)
  assert.ok(durations.at(-1) <= format.p95Limit)
  results.push({ format: format.name, pages: format.pages, samples: durations.length, medianMs: durations[2], p95Ms: durations.at(-1), expected: format.status })
}
console.log(JSON.stringify({ scope: '三类职能的本地合成 PDF', results }, null, 2))
