import type { PackPageSampleSpec, PackSampleChart, PackSampleColumn } from "./industryPackSampleApply";

const plant: PackSampleColumn = { key: "水厂", type: "string" };
const text = (key: string): PackSampleColumn => ({ key, type: "string" });
const number = (key: string): PackSampleColumn => ({ key, type: "number" });
const metric = (field: string, titleEn: string, unit: string, unitEn: string, aggregation: "sum" | "average" = "sum"): PackPageSampleSpec["metrics"][number] =>
  ({ field, aggregation, titleZh: field, titleEn, unit, unitEn });
const chart = (type: PackSampleChart["type"], field: string, dimension: string, titleZh: string, titleEn: string, unit: string, unitEn: string, aggregation: "sum" | "average" = "sum"): PackSampleChart =>
  ({ type, measureField: field, dimensionField: dimension, titleZh, titleEn, unit, unitEn, aggregation });
const common = { filterKey: "pack:water-treatment:plant", filterOptions: ["全部", "1#水厂", "2#水厂", "3#水厂"] };

/** 独立业务快照；计数与逐条台账一致，不从其他包改名生成。求和列取整数避免浮点显示歧义。 */
const overview: PackPageSampleSpec = {
  ...common, templateId: "water", titleZh: "水处理 · 供水总览", titleEn: "Water treatment · Supply overview",
  metrics: [metric("今日供水", "Water supplied", "m³", "m³"), metric("供水效率", "Supply efficiency", "%", "%", "average"),
    metric("管网告警", "Network alerts", "条", "alerts"), metric("供水服务率", "Water service", "%", "%", "average")],
  primary: chart("bar", "今日供水", "水厂", "各厂供水量", "Supply by plant", "m³", "m³"),
  secondary: chart("bar", "管网告警", "水厂", "各厂管网告警", "Alerts by plant", "条", "alerts"),
  detailTitleZh: "水厂运行快照", detailTitleEn: "Plant snapshot",
  columns: [plant, number("今日供水"), number("供水效率"), number("管网告警"), number("在线泵站"), number("供水服务率")],
  rowValues: [["1#水厂", 52000, 96.8, 0, 6, 99.9], ["2#水厂", 41000, 93.2, 2, 5, 99.1], ["3#水厂", 28000, 90.4, 1, 4, 97.6]],
};

const operation: PackPageSampleSpec = {
  ...common, templateId: "water-operations", titleZh: "水处理 · 运行调度", titleEn: "Water treatment · Dispatch operation",
  metrics: [metric("泵组台数", "Pump units", "台", "units"), metric("管网流量", "Network flow", "m³/h", "m³/h"),
    metric("泵站能耗", "Pumping energy", "kWh", "kWh"), metric("停运泵组", "Stopped pumps", "台", "units")],
  primary: chart("bar", "管网流量", "泵组", "泵组流量", "Flow by pump", "m³/h", "m³/h"),
  secondary: chart("bar", "泵站能耗", "泵组", "泵组能耗", "Energy by pump", "kWh", "kWh"),
  detailTitleZh: "泵组运行台账", detailTitleEn: "Pump operation ledger",
  columns: [plant, text("泵组"), text("状态"), number("管网流量"), number("泵站能耗"), number("泵组台数"), number("停运泵组")],
  rowValues: [["1#水厂", "1#送水泵", "运行", 1200, 420, 1, 0], ["1#水厂", "2#送水泵", "运行", 1180, 415, 1, 0],
    ["2#水厂", "1#送水泵", "运行", 1050, 398, 1, 0], ["2#水厂", "2#送水泵", "运行", 980, 372, 1, 0],
    ["3#水厂", "1#加压泵", "故障", 0, 0, 1, 1], ["3#水厂", "2#加压泵", "运行", 760, 288, 1, 0]],
};

const quality: PackPageSampleSpec = {
  ...common, templateId: "water-quality", titleZh: "水处理 · 水质管理", titleEn: "Water treatment · Water quality",
  metrics: [metric("水样数", "Samples", "份", "samples"), metric("浊度", "Turbidity", "NTU", "NTU", "average"),
    metric("超标项", "Exceeded items", "项", "items"), metric("余氯", "Chlorine", "mg/L", "mg/L", "average")],
  primary: chart("bar", "浊度", "采样点", "采样点浊度", "Turbidity by point", "NTU", "NTU", "average"),
  secondary: chart("bar", "余氯", "采样点", "采样点余氯", "Chlorine by point", "mg/L", "mg/L", "average"),
  detailTitleZh: "水质采样台账", detailTitleEn: "Quality sampling ledger",
  columns: [plant, text("采样点"), text("指标"), number("浊度"), number("余氯"), number("水样数"), number("超标项")],
  rowValues: [["1#水厂", "出厂水", "浊度/余氯", 0.22, 0.65, 4, 0], ["1#水厂", "管网末梢", "浊度/余氯", 0.35, 0.42, 4, 0],
    ["2#水厂", "出厂水", "浊度/余氯", 0.88, 0.58, 4, 1], ["2#水厂", "管网末梢", "浊度/余氯", 0.91, 0.38, 4, 1],
    ["3#水厂", "出厂水", "浊度/余氯", 0.30, 0.61, 4, 0], ["3#水厂", "管网末梢", "浊度/余氯", 0.44, 0.35, 4, 0]],
};

const risk: PackPageSampleSpec = {
  ...common, templateId: "water-risk", titleZh: "水处理 · 管网风险", titleEn: "Water treatment · Network risk",
  metrics: [metric("管网告警", "Network alerts", "条", "alerts"), metric("高优先级", "High priority risks", "条", "risks"),
    metric("已处置", "Resolved risks", "条", "risks"), metric("平均处置时长", "Avg resolution time", "h", "h", "average")],
  primary: chart("bar", "管网告警", "风险类型", "各类型风险", "Risks by type", "条", "alerts"),
  secondary: chart("bar", "平均处置时长", "风险编号", "逐条处置时长", "Resolution time by risk", "h", "h", "average"),
  detailTitleZh: "风险处置记录", detailTitleEn: "Risk resolution ledger",
  columns: [plant, text("风险编号"), text("风险类型"), text("关联对象"), text("下一步"), number("管网告警"), number("高优先级"), number("已处置"), number("平均处置时长")],
  rowValues: [["1#水厂", "RK-1011", "压力波动", "1#送水泵", "已复核恢复", 0, 0, 1, 0.5],
    ["2#水厂", "RK-2021", "浊度接近限值", "出厂水", "加密检测并调整加药", 1, 1, 0, 1.5],
    ["2#水厂", "RK-2022", "余氯偏低", "管网末梢", "提高投氯量复核", 1, 0, 0, 0.8],
    ["3#水厂", "RK-3031", "加压泵故障", "1#加压泵", "切换备用泵并报修", 1, 1, 0, 2.0]],
};

const assets: PackPageSampleSpec = {
  ...common, templateId: "water-asset", titleZh: "水处理 · 设备资产", titleEn: "Water treatment · Asset health",
  metrics: [metric("设备台数", "Equipment units", "台", "units"), metric("负载率", "Load rate", "%", "%", "average"),
    metric("健康评分", "Health score", "分", "pts", "average"), metric("未闭缺陷", "Open defects", "项", "items")],
  primary: chart("bar", "健康评分", "设备", "设备健康评分", "Health score by asset", "分", "pts", "average"),
  secondary: chart("bar", "负载率", "设备", "设备负载率", "Load rate by asset", "%", "%", "average"),
  detailTitleZh: "关键设备健康台账", detailTitleEn: "Key asset health ledger",
  columns: [plant, text("设备"), text("上次检修"), number("负载率"), number("健康评分"), number("设备台数"), number("未闭缺陷")],
  rowValues: [["1#水厂", "滤池组", "2026-07-02", 72.5, 96, 1, 0], ["1#水厂", "送水泵组", "2026-06-18", 78.2, 94, 1, 0],
    ["2#水厂", "滤池组", "2026-05-20", 84.0, 89, 1, 1], ["2#水厂", "加氯间", "2026-04-11", 66.5, 92, 1, 0],
    ["3#水厂", "1#加压泵", "2025-12-08", 0, 61, 1, 2], ["3#水厂", "2#加压泵", "2026-02-25", 74.0, 88, 1, 0]],
};

export const WATER_PACK_SAMPLES: Readonly<Record<string, PackPageSampleSpec>> = {
  water: overview, "water-operations": operation, "water-quality": quality,
  "water-risk": risk, "water-asset": assets,
};
