import { Worker } from 'node:worker_threads'
import { extname } from 'node:path'
import { CATEGORIES } from '../shared/catalog.mjs'
import { id, now, requireThat, safeText } from './domain.mjs'
import { scrub } from './ai.mjs'

export const MATERIAL_TYPES = ['岗位说明', '组织架构', '权限清单', '历史交接', '项目或工单', '手工记录']
const MAX_FILE = 20 * 1024 * 1024
const categoryTerms = [
  /流程|开票|回款|分配|审批/, /权限|管理员|账号|系统/, /客户|联系人|承诺/, /供应商|伙伴|外包|服务商|渠道/,
  /报表|文档|表格|字段|模板|数据/, /例外|风险|冲突|边界/, /截止|每月|月底|季度|月结|日历/, /未结|未完成|遗留|待办|待处理/,
]

function parseFile(bytes, extension) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), { workerData: { bytes, extension }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    const finish = (result) => {
      clearTimeout(timer)
      resolve(result)
      void worker.terminate()
    }
    const timer = setTimeout(() => finish({ failed: true }), bytes.length > 8 * 1024 * 1024 ? 295_000 : 118_000)
    worker.once('message', finish)
    worker.once('error', () => finish({ failed: true }))
    worker.once('exit', () => finish({ failed: true }))
  })
}

export async function parseMaterial(input) {
  const started = Date.now()
  const name = safeText(input.name, 150, true)
  const type = input.type ?? '手工记录'
  const level = input.level ?? 'S1'
  requireThat(MATERIAL_TYPES.includes(type) && ['S1', 'S2'].includes(level), '请选择材料类型和可录入的敏感等级。')
  requireThat(!input.base64 || input.redacted === true, '请确认材料已移除高危内容。')
  let result
  let bytes = 0
  if (input.base64) {
    requireThat(typeof input.base64 === 'string' && input.base64.length <= Math.ceil(MAX_FILE / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(input.base64), '材料格式无效或超过 20 MB。', 413)
    const file = Buffer.from(input.base64, 'base64')
    const extension = extname(name).toLowerCase().slice(1)
    bytes = file.length
    requireThat(bytes <= MAX_FILE && ['pdf', 'docx', 'txt', 'md', 'csv'].includes(extension), '请上传 PDF、DOCX、TXT、MD 或 CSV，单件不超过 20 MB。')
    const correctMagic = extension === 'pdf' ? file.subarray(0, 5).toString() === '%PDF-' : extension === 'docx' ? file.subarray(0, 2).toString() === 'PK' : true
    if (!correctMagic) result = { failed: true }
    else if (['pdf', 'docx'].includes(extension)) result = await parseFile(file, extension)
    else result = textBlocks(file.toString('utf8'))
  } else {
    requireThat(typeof input.text === 'string' && input.text.trim() && input.text.length <= 60_000, '请输入材料正文，最多 60,000 字。')
    bytes = Buffer.byteLength(input.text)
    result = textBlocks(input.text)
  }
  let blocked = 0
  const blocks = []
  for (const entry of result.blocks ?? []) {
    try {
      const clean = safeText(entry.text, 4000)
      if (clean) blocks.push({ ref: entry.ref, text: clean })
    } catch { blocked += 1 }
  }
  const status = result.failed || !blocks.length ? 'fallback' : result.limited || blocked ? 'partial' : 'parsed'
  return {
    material: { id: id(), name, type, level, bytes, status, blocked, total: result.total ?? 0, parsedAt: now(), duration: Date.now() - started,
      message: status === 'fallback' ? '未读取到可核查文字。请粘贴正文或手工补录并填写来源。' : status === 'partial' ? '已处理可读取正文。部分内容需要人工补录。' : '已提取带出处的材料片段。' },
    blocks,
  }
}

function textBlocks(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  return { total: lines.length, limited: lines.length > 2500, blocks: lines.slice(0, 2500).map((text, index) => ({ ref: `第 ${index + 1} 行`, text: text.slice(0, 4000) })) }
}

export async function collectSuggestions(position, material, blocks, ai, modelConsent) {
  const source = (entry, excerpt) => ({ kind: 'material', materialId: material.id, locator: `${material.name} · ${entry.ref}`, excerpt: excerpt.slice(0, 500), at: material.parsedAt })
  const suggestions = new Map()
  for (const asset of position.assets) {
    if (asset.level === 'S3') continue
    const entry = blocks.find((block) => block.text.includes(asset.title))
    if (entry) suggestions.set(asset.title, { title: asset.title, category: asset.category, level: material.level, source: source(entry, entry.text) })
  }
  for (const entry of blocks.slice(0, 45)) {
    const heading = entry.text.match(/^(?:\d+[.)、 ]+)?([^:。;\n]{4,32})[:：]\s*\S/)?.[1]?.trim()
    const index = categoryTerms.findIndex((pattern) => pattern.test(heading ?? ''))
    if (heading && index >= 0 && !suggestions.has(heading)) suggestions.set(heading, { title: heading, category: CATEGORIES[index], level: material.level, source: source(entry, entry.text) })
  }
  const model = material.level === 'S1' && blocks.length && modelConsent && ai.enabled
    ? await ai.call('inventory', { categories: CATEGORIES, blocks: blocks.slice(0, 40).map(({ ref, text }) => ({ ref, text: scrub(text.slice(0, 500), position) })) }, position.model, 25_000)
    : { items: [], metric: {}, degraded: true }
  for (const item of model.items.slice(0, 8)) {
    if (typeof item?.title !== 'string' || typeof item.evidence !== 'string' || item.title.length < 4 || item.title.length > 70 || !item.evidence.includes(item.title) || !CATEGORIES.includes(item.category)) continue
    const entry = blocks.find((block) => block.ref === item.ref && block.text.includes(item.evidence))
    if (entry && !suggestions.has(item.title)) suggestions.set(item.title, { title: item.title, category: item.category, level: material.level, source: source(entry, item.evidence) })
  }
  return { suggestions: [...suggestions.values()].slice(0, 48), metric: model.metric, degraded: model.degraded }
}
