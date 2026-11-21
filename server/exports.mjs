import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import PDFDocument from 'pdfkit'
import { CATEGORIES, COVERAGE_NOTICE, ROLES, STATUS } from '../shared/catalog.mjs'
import { isEvidence, requireThat } from './domain.mjs'
import { redact } from './security.mjs'

const detailLabels = { when: '何时用', location: '位置', contact: '找谁', exception: '例外', request: '申请方式' }
const fmt = (date) => date ? new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'

export function createExportSnapshot(position, scope, redacted) {
  const report = position.reports.at(-1)
  const title = redacted ? '关键岗位' : position.title
  const header = { title: `${scope === 'pack' ? '岗位交接包' : scope === 'report' ? '可交接性报告' : '岗位交接确认书'} · ${title}`, version: position.version, lines: [] }
  const lines = header.lines
  if (scope === 'pack') {
    requireThat(position.packPublishedAt, '交接包发布后可申请导出。', 409)
    for (const category of CATEGORIES) {
      const entries = position.assets.filter((asset) => asset.category === category && isEvidence(asset) && Object.values(asset.detail).some(Boolean))
      if (!entries.length) continue
      lines.push({ kind: 'heading', text: category })
      if (redacted) { lines.push({ text: `已确认 ${entries.length} 项。详细操作与来源受控。` }); continue }
      for (const asset of entries) {
        lines.push({ kind: 'heading', text: `${asset.critical ? '必考 · ' : ''}${asset.title} (${asset.level})` })
        for (const [field, value] of Object.entries(asset.detail)) if (value) lines.push({ text: `${detailLabels[field]} · ${value}` })
        for (const source of asset.sources) lines.push({ text: `来源 · ${source.locator}${source.link ? ` (${source.link})` : ''}` })
        lines.push({ text: `更新 · ${fmt(asset.updatedAt)}` })
      }
    }
  } else {
    requireThat(report, '复核完毕后可申请导出。', 409)
    if (scope === 'letter') requireThat(position.signatures.length === 3, '三方签署齐全后可导出确认书。', 409)
    lines.push({ kind: 'heading', text: `${STATUS[report.status]} · 指数 ${report.score} / 100 · 验收 ${report.examScore} 分` })
    lines.push({ text: `覆盖度 ${report.components.coverage} · 验收通过率 ${report.components.exam} · 可替代性 ${report.components.substitutes} · 时效性 ${report.components.freshness}` })
    lines.push({ text: `覆盖范围 · ${report.coverage.verified}/${report.coverage.expected} 项，${fmt(report.coverage.from)} 至 ${fmt(report.coverage.to)}` })
    lines.push({ text: `${report.confidence}。未覆盖 ${report.uncovered.length} 项。接班人之外的独立替代者 ${position.backups} 人。` })
    lines.push({ kind: 'heading', text: '关键项、未通过项与遗留风险' })
    for (const [index, finding] of report.findings.filter((item) => item.critical || item.status !== 'pass').entries()) {
      lines.push({ text: `${redacted ? `条目 ${index + 1}` : finding.title} · ${finding.status === 'pass' ? '通过' : finding.status === 'review' ? '待复核' : '未通过'} · ${finding.score} 分` })
      if (!redacted) {
        lines.push({ text: finding.reason })
        for (const source of finding.sources) lines.push({ text: `依据 · ${source.locator}${source.link ? ` (${source.link})` : ''}` })
      }
    }
    if (report.failingCritical.length) lines.push({ text: '建议 · 补齐关键项证据和操作演示，安排复核或补考。' })
    if (report.uncovered.length) lines.push({ text: `建议 · 核对剩余 ${report.uncovered.length} 项的处置路径与证据。` })
    if (report.dependencies?.length) {
      lines.push({ kind: 'heading', text: '关键人依赖' })
      if (redacted) lines.push({ text: `${report.dependencies.length} 个已识别的关键事项依赖。` })
      else for (const entry of report.dependencies) lines.push({ text: `${entry.title} · ${entry.label} · ${entry.source.locator}` })
    }
    if (scope === 'letter') {
      lines.push({ kind: 'heading', text: '责任与三方签署' })
      lines.push({ text: '交接人确认已如实交付所列事项，接班人确认验收记录，业务负责人确认遗留事项的处理责任。' })
      for (const entry of position.signatures) lines.push({
        text: `${ROLES[entry.role]}${redacted ? '' : ` · ${entry.name}`} · ${fmt(entry.at)} · 报告第 ${entry.reportVersion} 版`, image: redacted ? undefined : entry.attachmentId,
      })
    }
  }
  lines.push({ kind: 'heading', text: '覆盖声明' }, { text: COVERAGE_NOTICE })
  return header
}

export function markdown(snapshot, watermark) {
  const escape = (text) => String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
  return `# ${escape(snapshot.title)}\n\n> ${watermark}\n\n${snapshot.lines.map(({ kind, text }) => `${kind === 'heading' ? '## ' : ''}${escape(text)}`).join('\n\n')}\n`
}

export function getFont() {
  if (process.env.RELAY_PDF_FONT) return [process.env.RELAY_PDF_FONT, process.env.RELAY_PDF_FONT_FACE || undefined]
  if (platform() === 'win32') return [`${process.env.WINDIR ?? 'C:/Windows'}/Fonts/msyh.ttc`, 'MicrosoftYaHei']
  const noto = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
  const wqy = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
  if (existsSync(noto)) return [noto, 'NotoSansCJKsc-Regular']
  if (existsSync(wqy)) return [wqy, 'WenQuanYiZenHei']
  throw new Error('缺少中文 PDF 字体，请配置 RELAY_PDF_FONT。')
}

export async function pdf(snapshot, watermark, loadImage) {
  const font = getFont()
  const doc = new PDFDocument({ size: 'A4', margin: 48, autoFirstPage: false, bufferPages: true, info: { Title: snapshot.title, Author: '接棒 Relay' } })
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  const done = once(doc, 'end')
  doc.registerFont('relay', font[0], font[1])
  doc.addPage().font('relay')
  doc.fontSize(10).fillColor('#1E40AF').text('接棒 Relay  /  交接验收', { characterSpacing: 0.4 })
  doc.moveDown(0.6).fillColor('#0F172A').fontSize(21).text(snapshot.title)
  doc.moveDown(0.4).fillColor('#475569').fontSize(9).text(watermark).moveDown(1.4)
  for (const line of snapshot.lines) {
    if (!line.text) continue
    if (line.kind === 'heading') {
      if (doc.y > 740) doc.addPage()
      doc.moveDown(0.4).fontSize(13).fillColor('#1E40AF').text(line.text, { lineGap: 3 }).moveDown(0.2)
    } else doc.fontSize(10).fillColor('#0F172A').text(line.text, { lineGap: 4 }).moveDown(0.2)
    if (line.image && loadImage) {
      const bytes = await loadImage(line.image)
      if (doc.y > 700) doc.addPage()
      doc.image(bytes, doc.x, doc.y, { fit: [154, 55] })
      doc.y += 60
    }
  }
  const { count } = doc.bufferedPageRange()
  for (let index = 0; index < count; index += 1) {
    doc.switchToPage(index)
    doc.save().rotate(-28, { origin: [297, 420] }).fillColor('#1E40AF', 0.10).fontSize(22).text(watermark, 52, 410, { width: 490, align: 'center', lineBreak: false }).restore()
    doc.fillColor('#475569', 1).fontSize(8).text(`接棒 Relay   ·   ${index + 1} / ${count}`, 48, 779, { width: 499, align: 'right', lineBreak: false })
  }
  doc.end()
  await done
  return Buffer.concat(chunks)
}

export const exportMark = (entry) => `${entry.redacted ? '脱敏件' : `受限件 · ${redact(entry.requesterName)}`} · ${entry.id.slice(0, 8)} · v${entry.snapshot.version}`
