import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const { bytes, extension } = workerData
const grouping = (text) => text.split(/(?:\r?\n)+/).map((entry) => entry.trim()).filter(Boolean).slice(0, 2500)

async function parse() {
  if (extension === 'docx') {
    const { default: mammoth } = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    const lines = grouping(result.value)
    return { total: lines.length, blocks: lines.map((text, index) => ({ ref: `第 ${index + 1} 段`, text: text.slice(0, 4000) })) }
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const base = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')
  const loading = getDocument({ data: new Uint8Array(bytes), cMapUrl: `${base}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}/standard_fonts/`, isEvalSupported: false })
  const document = await loading.promise
  try {
    const blocks = []
    for (let pageNumber = 1; pageNumber <= Math.min(200, document.numPages); pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`).join('')
      const paragraphs = grouping(text)
      for (const [index, paragraph] of paragraphs.slice(0, 200).entries()) blocks.push({ ref: `第 ${pageNumber} 页 · 第 ${index + 1} 行`, text: paragraph.slice(0, 4000) })
      page.cleanup()
    }
    return { total: document.numPages, limited: document.numPages > 200, blocks }
  } finally { await loading.destroy() }
}

try { parentPort.postMessage(await parse()) } catch { parentPort.postMessage({ failed: true }) }
