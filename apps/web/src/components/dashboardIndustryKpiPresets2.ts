import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { metricPreset } from "./dashboardComponentPresetFactory";

/**
 * 行业 KPI 预设扩展(素材数量波次 A):五个行业各追加 4 项高频运营指标,
 * 与 dashboardIndustryKpiPresets 共同构成行业 KPI 族 60 项,达成 420+ 素材目标。
 */

// ── 电力 +4 ───────────────────────────────────────────────────────────────
const POWER_EXTRA = [
  // 电网频率合格带 50±0.2 Hz,越下限触发一次调频关注
  metricPreset("grid-frequency-kpi", "电网频率指标卡", "Grid frequency", "电网实时频率与合格带", "value", "power.frequency", "frequency", "Hz", { min: 48, max: 52, conditionalRules: [{ id: "frequency-low", operator: "lt", value: 49.8, color: "#ff8170", animation: "pulse" }] }),
  // 新能源装机渗透率,指导调峰与储能配置
  metricPreset("renewable-penetration", "新能源渗透率", "Renewable penetration", "新能源出力占最大负荷比例", "progress", "power.renewableShare", "penetration", "%", { min: 0, max: 100 }),
  // 电压偏差允许值 ±7%,越限提示无功补偿调整
  metricPreset("voltage-deviation-kpi", "电压偏差指标卡", "Voltage deviation", "监测点电压偏差与允许带", "value", "power.voltageDeviation", "deviation", "%", { min: -10, max: 10, conditionalRules: [{ id: "deviation-high", operator: "gte", value: 7, color: "#e8bd68" }] }),
  metricPreset("demand-response-flip", "需量响应翻牌卡", "Demand response", "需求响应削峰负荷实时翻牌", "digital-flip", "power.demandResponse", "responseLoad", "kW", { fontSize: 38 }),
] as const;

// ── 水务 +4 ───────────────────────────────────────────────────────────────
const WATER_EXTRA = [
  // 混凝药剂单耗(铝盐折算)对标 45 kg/km³
  metricPreset("dosing-consumption-kpi", "药剂单耗指标卡", "Dosing consumption", "千立方米水药剂投加量", "value", "water.dosing", "dosing", "kg/km³", { min: 0, max: 120, conditionalRules: [{ id: "dosing-high", operator: "gt", value: 45, color: "#e8bd68" }] }),
  // 出厂污泥含水率 ≤80% 满足脱水外运要求
  metricPreset("sludge-moisture-kpi", "污泥含水率指标卡", "Sludge moisture", "脱水后污泥含水率", "value", "water.sludgeMoisture", "moisture", "%", { min: 60, max: 100, conditionalRules: [{ id: "sludge-wet", operator: "gt", value: 80, color: "#ff8170" }] }),
  // 管网服务压力合格率考核 ≥98%
  metricPreset("pressure-qualify-rate", "水压合格率进度", "Pressure compliance", "监测点水压合格率", "progress", "water.pressurePass", "passRate", "%", { min: 90, max: 100, conditionalRules: [{ id: "pressure-pass-low", operator: "lt", value: 98, color: "#e8bd68" }] }),
  metricPreset("pump-station-flip", "泵站流量翻牌卡", "Pump station flow", "泵站瞬时出水流量翻牌", "digital-flip", "water.pumpFlow", "flow", "m³/h", { fontSize: 38 }),
] as const;

// ── 化工 +4 ───────────────────────────────────────────────────────────────
const CHEM_EXTRA = [
  // 催化剂剩余寿命 <1000 h 提示计划更换
  metricPreset("catalyst-life-kpi", "催化剂寿命指标卡", "Catalyst life", "催化剂剩余运行寿命", "value", "chem.catalystLife", "remaining", "h", { min: 0, max: 8000, conditionalRules: [{ id: "catalyst-expiring", operator: "lt", value: 1000, color: "#e8bd68" }] }),
  // 精馏塔压差 >45 kPa 提示液泛或填料结垢
  metricPreset("column-dp-kpi", "塔压差指标卡", "Column differential", "精馏塔顶底压差监测", "value", "chem.columnDp", "deltaPressure", "kPa", { min: 0, max: 80, conditionalRules: [{ id: "column-dp-high", operator: "gt", value: 45, color: "#ff8170" }] }),
  // 冷剂温度高于 -5°C 提示冷量不足
  metricPreset("refrigerant-temp-kpi", "冷剂温度指标卡", "Refrigerant temperature", "冷剂循环温度与冷量裕度", "value", "chem.refrigerantTemp", "temp", "°C", { min: -40, max: 20, conditionalRules: [{ id: "refrigerant-warm", operator: "gt", value: -5, color: "#e8bd68" }] }),
  // 罐区 VOCs 浓度 >400 ppm 触发安全报警
  metricPreset("voc-concentration-kpi", "罐区 VOCs 浓度", "Tank VOCs level", "罐区挥发性有机物浓度", "value", "chem.vocs", "vocs", "ppm", { min: 0, max: 1000, conditionalRules: [{ id: "vocs-high", operator: "gt", value: 400, color: "#ff8170", animation: "pulse" }] }),
] as const;

// ── 医院 +4 ───────────────────────────────────────────────────────────────
const HOSPITAL_EXTRA = [
  // 手卫生依从率考核 ≥80%
  metricPreset("hand-hygiene-rate", "手卫生依从率", "Hand hygiene compliance", "医护人员手卫生执行比例", "progress", "hospital.handHygiene", "compliance", "%", { min: 0, max: 100, conditionalRules: [{ id: "hygiene-low", operator: "lt", value: 80, color: "#e8bd68" }] }),
  // 医疗设备完好率考核 ≥95%
  metricPreset("equipment-ready-rate", "医疗设备完好率", "Equipment readiness", "在用医疗设备完好比例", "progress", "hospital.equipmentReady", "readyRate", "%", { min: 0, max: 100, conditionalRules: [{ id: "ready-rate-low", operator: "lt", value: 95, color: "#e8bd68" }] }),
  // 急救平均出车时间 >12 min 超出急救反应考核
  metricPreset("ambulance-response-flip", "急救出车翻牌卡", "Ambulance response", "急救平均出车耗时翻牌", "digital-flip", "hospital.ambulance", "responseMinutes", "min", { fontSize: 38, conditionalRules: [{ id: "response-slow", operator: "gt", value: 12, color: "#ff8170", animation: "pulse" }] }),
  // 药占比管控目标 ≤30%
  metricPreset("drug-ratio-kpi", "药占比指标卡", "Drug ratio", "药品收入占医药收入比例", "value", "hospital.drugRatio", "drugRatio", "%", { min: 0, max: 60, conditionalRules: [{ id: "drug-ratio-high", operator: "gt", value: 30, color: "#e8bd68" }] }),
] as const;

// ── 政务 +4 ───────────────────────────────────────────────────────────────
const GOV_EXTRA = [
  // 即办件比例反映大厅即来即办能力
  metricPreset("instant-case-rate", "即办件比例", "Instant case rate", "即来即办件占受理量比例", "progress", "gov.instantRate", "instantRate", "%", { min: 0, max: 100 }),
  metricPreset("return-case-flip", "退件翻牌卡", "Returned cases", "材料退补件数量实时翻牌", "digital-flip", "gov.returnedCases", "returned", "件", { conditionalRules: [{ id: "returned-high", operator: "gt", value: 0, color: "#e8bd68" }] }),
  // 单窗口排队 >15 人提示叫号分流
  metricPreset("window-queue-kpi", "窗口排队数指标卡", "Window queue depth", "服务窗口当前排队人数", "value", "gov.windowQueue", "queueCount", "人", { min: 0, max: 60, conditionalRules: [{ id: "queue-deep", operator: "gt", value: 15, color: "#e8bd68" }] }),
  metricPreset("service-count-flip", "累计服务人次翻牌卡", "Total served", "累计服务群众人次翻牌", "digital-flip", "gov.servedTotal", "served", "人次", { fontSize: 38 }),
] as const;

export const DASHBOARD_INDUSTRY_KPI_PRESETS_2: readonly DashboardComponentPreset[] = [
  ...POWER_EXTRA,
  ...WATER_EXTRA,
  ...CHEM_EXTRA,
  ...HOSPITAL_EXTRA,
  ...GOV_EXTRA,
] as const;
