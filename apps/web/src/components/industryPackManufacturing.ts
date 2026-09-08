import type { IndustryTemplatePack } from "./industryTemplatePackTypes";
import type { PackPageSampleSpec } from "./industryPackSampleApply";

/** 首个行业深度包：制造设备运行（S3-C 首包，页面复用既有模板布局）。 */
export const MANUFACTURING_ASSET_OPS_PACK: IndustryTemplatePack = {
  id: "manufacturing-asset-ops",
  revision: 1,
  titleZh: "制造设备运行包",
  titleEn: "Manufacturing asset operations pack",
  categoryZh: "工业生产",
  categoryEn: "Manufacturing",
  summaryZh: "产线总览→设备健康→告警处置→质量分析→维护计划，示例讲述 A 线稳定、B 线质量损失、C 线设备老化的完整处置故事。",
  summaryEn: "Line overview → asset health → alarm response → quality analysis → maintenance plan; sample tells a coherent story of line A stability, line B quality loss and line C aging alarms.",
  pages: [
    { templateId: "production", nameZh: "生产总览", nameEn: "Production overview" },
    { templateId: "maintenance-asset", nameZh: "设备健康", nameEn: "Asset health" },
    { templateId: "production-risk", nameZh: "告警处置", nameEn: "Alarm response" },
    { templateId: "production-quality", nameZh: "质量分析", nameEn: "Quality analysis" },
    { templateId: "maintenance-operations", nameZh: "维护计划", nameEn: "Maintenance plan" },
  ],
  entryTemplateId: "production",
  linkageParameterKey: "pack:manufacturing-asset-ops:line",
  linkageFieldZh: "产线",
  linkageFieldEn: "Line",
  workflows: [
    { from: "production", actionZh: "查看产线设备", actionEn: "Inspect line assets", to: "maintenance-asset", linkageParameterKey: "pack:manufacturing-asset-ops:line" },
    { from: "maintenance-asset", actionZh: "追踪告警来源", actionEn: "Trace alarm sources", to: "production-risk", linkageParameterKey: "pack:manufacturing-asset-ops:line" },
    { from: "production-risk", actionZh: "关联质量损失", actionEn: "Relate quality loss", to: "production-quality", linkageParameterKey: "pack:manufacturing-asset-ops:line" },
    { from: "production-quality", actionZh: "安排维护工单", actionEn: "Schedule work orders", to: "maintenance-operations", linkageParameterKey: "pack:manufacturing-asset-ops:line" },
    { from: "maintenance-operations", actionZh: "回到全局视角", actionEn: "Back to overview", to: "production", linkageParameterKey: "pack:manufacturing-asset-ops:line" },
  ],
  guideZh: "导入后用产线筛选并沿页面动作切页；数据页签可整组编辑示例，再保存、刷新和发布验证。示例口径：OEE 为等权平均；质量页为批次平均良率，总览良率按产量加权；验收达标阈值为 96.5%；告警含历史记录，工时为已投入或计划工时，不代表结单时长。",
  guideEn: "Filter by line and follow page actions; edit grouped samples in Data, then save, reload and publish. Demo definitions: OEE is an unweighted mean; quality shows mean batch yield, while overview yield is output-weighted; batch acceptance threshold is 96.5%. Alarm records include history; labor hours represent effort or plans, not resolution duration.",
};

const LINE = { key: "产线", type: "string" } as const;
const lineChart = (type: PackPageSampleSpec["primary"]["type"], measureField: string, titleZh: string, titleEn: string, unit?: string): PackPageSampleSpec["primary"] =>
  ({ type, dimensionField: "产线", measureField, titleZh, titleEn, ...(unit ? { unit,
    unitEn: unit === "件" ? "pcs" : unit === "条" ? "alerts" : unit === "小时" ? "h" : unit } : {}) });

/** 页1 生产总览：产线汇总三行，与包故事一致（B 线 OEE 低、C 线告警多）。 */
const productionOverview: PackPageSampleSpec = {
  templateId: "production",
  titleZh: "制造设备运行包 · 生产总览",
  titleEn: "Manufacturing pack · Production overview",
  filterKey: "pack:manufacturing-asset-ops:line",
  filterOptions: ["全部", "A", "B", "C"],
  metrics: [
    { field: "产量", aggregation: "sum", titleZh: "总产量", titleEn: "Total output", unit: "件", unitEn: "pcs" },
    { field: "OEE", aggregation: "average", titleZh: "产线平均 OEE", titleEn: "Mean line OEE", unit: "%" },
    { field: "告警", aggregation: "sum", titleZh: "活动告警", titleEn: "Active alerts", unit: "条", unitEn: "alerts" },
    { field: "准时交付", aggregation: "average", titleZh: "产线平均准时交付率", titleEn: "Mean line on-time delivery", unit: "%" },
  ],
  primary: lineChart("bar", "产量", "各产线产量", "Output by line", "件"),
  secondary: lineChart("pie", "产量", "产量占比", "Output share", "件"),
  detailTitleZh: "产线汇总明细",
  detailTitleEn: "Line summary detail",
  columns: [LINE, { key: "产量", type: "number" }, { key: "OEE", type: "number" }, { key: "告警", type: "number" }, { key: "准时交付", type: "number" }, { key: "良率", type: "number" }],
  rowValues: [
    ["A", 1080, 91, 0, 99, 98.5],
    ["B", 920, 82, 2, 96, 95.1],
    ["C", 600, 86, 5, 93, 96.8],
  ],
};

/** 页2 设备健康：九台设备台账，C 线老机告警集中。 */
const assetHealth: PackPageSampleSpec = {
  templateId: "maintenance-asset",
  titleZh: "制造设备运行包 · 设备健康",
  titleEn: "Manufacturing pack · Asset health",
  filterKey: "pack:manufacturing-asset-ops:line",
  filterOptions: ["全部", "A", "B", "C"],
  metrics: [
    { field: "在线", aggregation: "sum", titleZh: "在线设备", titleEn: "Online assets", unit: "台", unitEn: "assets" },
    { field: "OEE", aggregation: "average", titleZh: "设备平均 OEE", titleEn: "Mean asset OEE", unit: "%" },
    { field: "告警", aggregation: "sum", titleZh: "活动告警", titleEn: "Active alerts", unit: "条", unitEn: "alerts" },
    { field: "计划维护", aggregation: "sum", titleZh: "计划维护设备", titleEn: "Planned maintenance assets", unit: "台", unitEn: "assets" },
  ],
  primary: lineChart("bar", "告警", "各产线活动告警", "Alerts by line", "条"),
  secondary: lineChart("pie", "告警", "告警分布", "Alert share", "条"),
  detailTitleZh: "设备台账",
  detailTitleEn: "Asset ledger",
  columns: [LINE, { key: "设备", type: "string" }, { key: "OEE", type: "number" }, { key: "告警", type: "number" }, { key: "在线", type: "number" }, { key: "计划维护", type: "number" }, { key: "连续运行", type: "number" }],
  rowValues: [
    ["A", "设备A1", 93, 0, 1, 0, 412],
    ["A", "设备A2", 90, 0, 1, 0, 388],
    ["A", "设备A3", 89, 0, 0, 0, 0],
    ["B", "设备B1", 84, 1, 1, 0, 456],
    ["B", "设备B2", 81, 1, 1, 0, 402],
    ["B", "设备B3", 80, 0, 0, 1, 0],
    ["C", "设备C1", 87, 2, 1, 0, 611],
    ["C", "设备C2", 85, 2, 1, 0, 589],
    ["C", "设备C3", 86, 1, 0, 1, 0],
  ],
};

/** 页3 告警处置：七条活动告警与两条历史记录，活动量与设备台账一致。 */
const alarmResponse: PackPageSampleSpec = {
  templateId: "production-risk",
  titleZh: "制造设备运行包 · 告警处置",
  titleEn: "Manufacturing pack · Alarm response",
  filterKey: "pack:manufacturing-asset-ops:line",
  filterOptions: ["全部", "A", "B", "C"],
  metrics: [
    { field: "未确认", aggregation: "sum", titleZh: "待确认告警", titleEn: "Unacknowledged alerts", unit: "条", unitEn: "alerts" },
    { field: "重大", aggregation: "sum", titleZh: "重大告警", titleEn: "Critical alerts", unit: "条", unitEn: "alerts" },
    { field: "已确认", aggregation: "sum", titleZh: "已确认告警", titleEn: "Acknowledged alerts", unit: "条", unitEn: "alerts" },
    { field: "处置小时", aggregation: "average", titleZh: "平均已投入工时", titleEn: "Mean handling effort", unit: "h" },
  ],
  primary: lineChart("bar", "未确认", "各产线待确认告警", "Unacknowledged alerts by line", "条"),
  secondary: lineChart("pie", "处置小时", "已投入工时占比", "Handling effort share", "小时"),
  detailTitleZh: "告警记录（含历史）",
  detailTitleEn: "Alarm records (including history)",
  columns: [LINE, { key: "设备", type: "string" }, { key: "内容", type: "string" }, { key: "重大", type: "number" }, { key: "未确认", type: "number" }, { key: "已确认", type: "number" }, { key: "处置小时", type: "number" }, { key: "活动", type: "number" }],
  rowValues: [
    ["C", "设备C1", "主轴温度高", 1, 1, 0, 2.5, 1],
    ["C", "设备C1", "振动异常", 0, 0, 1, 1.0, 1],
    ["C", "设备C2", "液压油位低", 0, 1, 0, 0.5, 1],
    ["C", "设备C2", "液压压力波动", 0, 0, 1, 0.5, 1],
    ["C", "设备C3", "伺服驱动故障", 1, 1, 0, 6.0, 1],
    ["B", "设备B1", "质量检测超差", 0, 0, 1, 1.5, 1],
    ["B", "设备B2", "供料延迟", 0, 1, 0, 3.0, 1],
    ["A", "设备A2", "刀具磨损预警", 0, 0, 1, 0.8, 0],
    ["A", "设备A1", "计划换型提醒", 0, 0, 1, 0.3, 0],
  ],
};

/** 页4 质量分析：批次良率；此演示的批次验收阈值固定为 96.5%，不代表客户标准。 */
const qualityAnalysis: PackPageSampleSpec = {
  templateId: "production-quality",
  titleZh: "制造设备运行包 · 质量分析",
  titleEn: "Manufacturing pack · Quality analysis",
  filterKey: "pack:manufacturing-asset-ops:line",
  filterOptions: ["全部", "A", "B", "C"],
  metrics: [
    { field: "产量", aggregation: "sum", titleZh: "总产量", titleEn: "Total output", unit: "件", unitEn: "pcs" },
    { field: "良率", aggregation: "average", titleZh: "批次平均良率", titleEn: "Mean batch yield", unit: "%" },
    { field: "不良数", aggregation: "sum", titleZh: "不良总数", titleEn: "Total defects", unit: "件", unitEn: "pcs" },
    { field: "验收达标", aggregation: "sum", titleZh: "验收达标批次", titleEn: "Accepted batches", unit: "批", unitEn: "batches" },
  ],
  primary: lineChart("bar", "不良数", "各产线不良数", "Defects by line", "件"),
  secondary: { ...lineChart("bar", "良率", "批次良率对比", "Batch yield comparison", "%"), dimensionField: "批次", aggregation: "average" },
  detailTitleZh: "批次明细",
  detailTitleEn: "Batch detail",
  columns: [LINE, { key: "批次", type: "string" }, { key: "产量", type: "number" }, { key: "不良数", type: "number" }, { key: "良率", type: "number" }, { key: "验收达标", type: "number" }],
  rowValues: [
    ["A", "批次A-0901", 360, 5, 98.6, 1],
    ["A", "批次A-0902", 360, 6, 98.3, 1],
    ["A", "批次A-0903", 360, 5, 98.6, 1],
    ["B", "批次B-0901", 300, 12, 96.0, 0],
    ["B", "批次B-0902", 310, 18, 94.2, 0],
    ["B", "批次B-0903", 310, 15, 95.2, 0],
    ["C", "批次C-0901", 200, 6, 97.0, 1],
    ["C", "批次C-0902", 200, 7, 96.5, 1],
    ["C", "批次C-0903", 200, 6, 97.0, 1],
  ],
};

/** 页5 维护计划：工单台账，C 线抢修与逾期集中。 */
const maintenancePlan: PackPageSampleSpec = {
  templateId: "maintenance-operations",
  titleZh: "制造设备运行包 · 维护计划",
  titleEn: "Manufacturing pack · Maintenance plan",
  filterKey: "pack:manufacturing-asset-ops:line",
  filterOptions: ["全部", "A", "B", "C"],
  metrics: [
    { field: "待执行", aggregation: "sum", titleZh: "待执行工单", titleEn: "Open work orders", unit: "单", unitEn: "orders" },
    { field: "工时", aggregation: "average", titleZh: "平均计划工时", titleEn: "Mean planned labor", unit: "h" },
    { field: "逾期", aggregation: "sum", titleZh: "逾期工单", titleEn: "Overdue orders", unit: "单", unitEn: "orders" },
    { field: "已完成", aggregation: "sum", titleZh: "已完成工单", titleEn: "Completed orders", unit: "单", unitEn: "orders" },
  ],
  primary: lineChart("bar", "工时", "各产线计划工时", "Planned hours by line", "小时"),
  secondary: { ...lineChart("pie", "工时", "工单类型计划工时", "Planned hours by order type", "小时"), dimensionField: "类型" },
  detailTitleZh: "工单台账",
  detailTitleEn: "Work order ledger",
  columns: [LINE, { key: "设备", type: "string" }, { key: "工单", type: "string" }, { key: "类型", type: "string" }, { key: "待执行", type: "number" }, { key: "已完成", type: "number" }, { key: "工时", type: "number" }, { key: "逾期", type: "number" }],
  rowValues: [
    ["C", "设备C1", "WO-101", "抢修", 1, 0, 6, 0],
    ["C", "设备C3", "WO-102", "抢修", 1, 0, 8, 1],
    ["B", "设备B3", "WO-103", "检修", 1, 0, 4, 0],
    ["B", "设备B1", "WO-104", "保养", 1, 0, 2, 0],
    ["B", "设备B2", "WO-105", "保养", 1, 0, 2, 1],
    ["A", "设备A1", "WO-106", "保养", 0, 1, 1.5, 0],
    ["A", "设备A3", "WO-107", "保养", 0, 1, 1, 0],
    ["A", "设备A2", "WO-108", "检修", 0, 1, 3, 0],
  ],
};

/** 首包页面示例；键为模板 ID，导入时按页匹配。 */
export const MANUFACTURING_PACK_SAMPLES: Readonly<Record<string, PackPageSampleSpec>> = {
  production: productionOverview,
  "maintenance-asset": assetHealth,
  "production-risk": alarmResponse,
  "production-quality": qualityAnalysis,
  "maintenance-operations": maintenancePlan,
};
