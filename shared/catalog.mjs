export const CATEGORIES = ['职责与流程', '系统与权限', '客户与关系', '供应商与外部', '文档与数据', '例外与风险', '时间节点', '未结事项']
export const QUESTION_TYPES = ['定位', '判断', '复现', '边界', '风险自述']
export const STAGES = [
  ['assets', '资产地图'], ['interview', '访谈'], ['pack', '交接包'],
  ['exam', '验收考试'], ['report', '报告'], ['letter', '确认书'],
]
export const ROLES = { owner: '业务负责人', leaver: '交接人', successor: '接班人', hr: '人力资源', auditor: '审计员' }
export const STATUS = { red: '红灯 · 高风险', amber: '黄灯 · 待关注', green: '绿灯 · 可交接', pending: '待评估' }
export const ROUND_NAMES = ['盘点与确认', '例外与风险', '证据与补齐']
export const TEMPLATE_NAME = 'SaaS / 互联网 · 销售运营'
export const COVERAGE_NOTICE = '报告仅覆盖所列条目、证据和验证时间段。结论需业务负责人和接班人确认，不保证交接后零风险。确认书记录交接事实，不替代离职证明，结果不得用于员工绩效评价。'
export const PRIVACY_NOTICE = '信息仅用于本次岗位交接和审计，按角色可见。请勿提交账号密码、私钥和底价等高危内容。受限信息与你的手写签名需另行同意。可在设置提交删除申请。'

const titles = [
  ['续费折扣审批', '合同盖章流程', '发票与开票申请', '报价审批流程', '销售线索分配', '回款对账流程'],
  ['CRM 管理权限', 'BI 报表访问权限', '返利系统权限', '合同审批系统', '财务台账读权限', '权限回收与申请'],
  ['重点客户对接路径', '客户决策与升级路径', '历史口头承诺', '客户接续沟通', '客户健康分层', '重点商机关系图'],
  ['数据服务商对接', '渠道代理对接', '外包团队协作', '服务商合同到期', '合作伙伴付款', '供应商故障升级'],
  ['季度返利计算表', '报价模板与版本', '季度复盘模板', '销售预测数据口径', '共享资料权限', '历史合同归档'],
  ['CRM 归属冲突', '超授权折扣处置', '返利异常补录', '续费风险预警', '客户投诉升级', '数据更正的边界'],
  ['月结操作清单', '季度返点出账', '年度合同审计', '旬度销售预测', '发票截止日', '重点客户续约提醒'],
  ['未决续费例外', '流转中审批与回款', '合同遗留变更', '迁移中的报表', '未交付的客户承诺', '本季度待复核事项'],
]
const critical = new Set([0, 1, 6, 7, 12, 14, 24, 30, 36, 42])
export const TEMPLATE = titles.flatMap((group, categoryIndex) => group.map((title, index) => {
  const number = categoryIndex * 6 + index
  return {
    id: `so-${String(number + 1).padStart(2, '0')}`,
    title, category: CATEGORIES[categoryIndex], critical: critical.has(number),
    importance: critical.has(number) ? '关键' : index < 3 ? '重要' : '一般',
    level: categoryIndex === 2 ? 'S2' : 'S1', detail: {}, sources: [], confirmed: false,
  }
}))
