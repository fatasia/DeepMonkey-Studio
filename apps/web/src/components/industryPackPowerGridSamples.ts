import type { PackPageSampleSpec, PackSampleChart, PackSampleColumn } from "./industryPackSampleApply";

const substation: PackSampleColumn = { key: "变电站", type: "string" };
const text = (key: string): PackSampleColumn => ({ key, type: "string" });
const number = (key: string): PackSampleColumn => ({ key, type: "number" });
const metric = (field: string, titleEn: string, unit: string, unitEn: string, aggregation: "sum" | "average" = "sum"): PackPageSampleSpec["metrics"][number] =>
  ({ field, aggregation, titleZh: field, titleEn, unit, unitEn });
const chart = (type: PackSampleChart["type"], field: string, dimension: string, titleZh: string, titleEn: string, unit: string, unitEn: string, aggregation: "sum" | "average" = "sum"): PackSampleChart =>
  ({ type, measureField: field, dimensionField: dimension, titleZh, titleEn, unit, unitEn, aggregation });
const common = { filterKey: "pack:power-grid-operations:substation", filterOptions: ["全部", "1#中心站", "2#工业园站", "3#光伏枢纽站"] };

/** 独立业务快照；计数与逐条台账一致，不从制造/仓储包改名生成。求和列取整数避免浮点显示歧义。 */
const overview: PackPageSampleSpec = {
  ...common, templateId: "energy", titleZh: "电力能源 · 能源总览", titleEn: "Power grid · Energy overview",
  metrics: [metric("供能量", "Energy supplied", "MWh", "MWh"), metric("供能效率", "Supply efficiency", "%", "%", "average"),
    metric("峰值告警", "Peak alerts", "条", "alerts"), metric("供能服务率", "Service level", "%", "%", "average")],
  primary: chart("bar", "供能量", "变电站", "各站供能量", "Energy supplied by substation", "MWh", "MWh"),
  secondary: chart("bar", "峰值告警", "变电站", "各站峰值告警", "Peak alerts by substation", "条", "alerts"),
  detailTitleZh: "变电站运行快照", detailTitleEn: "Substation snapshot",
  columns: [substation, number("供能量"), number("供能效率"), number("峰值告警"), number("在线回路"), number("供能服务率")],
  rowValues: [["1#中心站", 42, 96.2, 0, 24, 99.9], ["2#工业园站", 38, 91.5, 2, 22, 99.2], ["3#光伏枢纽站", 22, 88.7, 1, 18, 98.4]],
};

const consumption: PackPageSampleSpec = {
  ...common, templateId: "energy-energy", titleZh: "电力能源 · 能耗与成本", titleEn: "Power grid · Consumption and cost",
  metrics: [metric("综合能耗", "Total consumption", "tce", "tce"), metric("能源成本", "Energy cost", "万元", "CNY 10k"),
    metric("供能效率", "Supply efficiency", "%", "%", "average"), metric("碳排放", "Carbon emissions", "tCO₂e", "tCO₂e")],
  primary: chart("bar", "综合能耗", "介质", "各介质综合能耗", "Consumption by medium", "tce", "tce"),
  secondary: chart("bar", "能源成本", "介质", "各介质能源成本", "Cost by medium", "万元", "CNY 10k"),
  detailTitleZh: "介质能耗台账", detailTitleEn: "Medium consumption ledger",
  columns: [substation, text("介质"), number("综合能耗"), number("能源成本"), number("供能效率"), number("碳排放")],
  rowValues: [["1#中心站", "电力", 96, 61, 96.2, 312], ["1#中心站", "蒸汽", 18, 10, 96.0, 46],
    ["2#工业园站", "电力", 88, 58, 91.5, 296], ["2#工业园站", "压缩空气", 22, 13, 91.2, 42],
    ["3#光伏枢纽站", "电力", 41, 19, 88.7, 92], ["3#光伏枢纽站", "水", 7, 2, 99.0, 0]],
};

const operation: PackPageSampleSpec = {
  ...common, templateId: "energy-operations", titleZh: "电力能源 · 供配电运行", titleEn: "Power grid · Distribution operation",
  metrics: [metric("峰值负载", "Peak load", "MW", "MW"), metric("负载率", "Load rate", "%", "%", "average"),
    metric("峰值告警", "Peak alerts", "条", "alerts"), metric("重载回路", "Overloaded circuits", "条", "circuits")],
  primary: chart("bar", "负载率", "回路", "回路负载率", "Load rate by circuit", "%", "%", "average"),
  secondary: chart("bar", "峰值负载", "回路", "回路峰值负载", "Peak load by circuit", "MW", "MW"),
  detailTitleZh: "回路运行台账", detailTitleEn: "Circuit operation ledger",
  columns: [substation, text("回路"), text("状态"), number("峰值负载"), number("负载率"), number("重载回路"), number("峰值告警")],
  rowValues: [["1#中心站", "1#进线", "运行", 8, 68.3, 0, 0], ["1#中心站", "2#进线", "运行", 8, 65.8, 0, 0],
    ["2#工业园站", "1#进线", "运行", 10, 80.0, 0, 0], ["2#工业园站", "2#变压器", "重载", 11, 95.0, 1, 2],
    ["3#光伏枢纽站", "光伏出线", "波动", 6, 52.5, 0, 1], ["3#光伏枢纽站", "储能支路", "运行", 4, 34.2, 0, 0]],
};

const alerts: PackPageSampleSpec = {
  ...common, templateId: "energy-risk", titleZh: "电力能源 · 告警处置", titleEn: "Power grid · Alert resolution",
  metrics: [metric("峰值告警", "Peak alerts", "条", "alerts"), metric("高优先级", "High priority alerts", "条", "alerts"),
    metric("已处置告警", "Resolved alerts", "条", "alerts"), metric("平均处置时长", "Avg resolution time", "h", "h", "average")],
  primary: chart("bar", "峰值告警", "告警类型", "各类型峰值告警", "Peak alerts by type", "条", "alerts"),
  secondary: chart("bar", "平均处置时长", "告警编号", "逐条处置时长", "Resolution time by alert", "h", "h", "average"),
  detailTitleZh: "告警处置记录", detailTitleEn: "Alert resolution ledger",
  columns: [substation, text("告警编号"), text("告警类型"), text("关联回路"), text("下一步"), number("峰值告警"), number("高优先级"), number("已处置告警"), number("平均处置时长")],
  rowValues: [["1#中心站", "AL-1011", "电压暂降", "1#进线", "已复核恢复", 0, 0, 1, 0.4],
    ["2#工业园站", "AL-2021", "变压器重载", "2#变压器", "负荷转供方案审核", 1, 1, 0, 1.6],
    ["2#工业园站", "AL-2022", "谐波超标", "2#变压器", "加装滤波器评估", 1, 0, 0, 0.8],
    ["3#光伏枢纽站", "AL-3031", "消纳率下降", "光伏出线", "调整储能充放策略", 1, 0, 0, 1.2]],
};

const assets: PackPageSampleSpec = {
  ...common, templateId: "energy-asset", titleZh: "电力能源 · 资产健康", titleEn: "Power grid · Asset health",
  metrics: [metric("变压器台数", "Transformers", "台", "units"), metric("负载率", "Load rate", "%", "%", "average"),
    metric("健康评分", "Health score", "分", "pts", "average"), metric("未闭缺陷", "Open defects", "项", "items")],
  primary: chart("bar", "健康评分", "设备", "设备健康评分", "Health score by asset", "分", "pts", "average"),
  secondary: chart("bar", "负载率", "设备", "设备负载率", "Load rate by asset", "%", "%", "average"),
  detailTitleZh: "变压器健康台账", detailTitleEn: "Transformer health ledger",
  columns: [substation, text("设备"), text("上次检修"), number("负载率"), number("健康评分"), number("变压器台数"), number("未闭缺陷")],
  rowValues: [["1#中心站", "1#主变", "2026-06-12", 71.4, 96, 1, 0], ["1#中心站", "2#主变", "2026-06-12", 69.8, 95, 1, 0],
    ["2#工业园站", "1#变压器", "2026-03-04", 80.0, 88, 1, 1], ["2#工业园站", "2#变压器", "2025-11-20", 95.0, 74, 1, 2],
    ["3#光伏枢纽站", "升压变", "2026-05-18", 58.6, 91, 1, 0]],
};

export const POWER_GRID_PACK_SAMPLES: Readonly<Record<string, PackPageSampleSpec>> = {
  energy: overview, "energy-energy": consumption, "energy-operations": operation,
  "energy-risk": alerts, "energy-asset": assets,
};
