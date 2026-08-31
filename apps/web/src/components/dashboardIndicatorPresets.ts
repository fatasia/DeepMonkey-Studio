import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { metricPreset } from "./dashboardComponentPresetFactory";

/** 指标预设覆盖经营、生产、质量、能源、设备和安全，不以换色制造数量。 */
export const DASHBOARD_INDICATOR_PRESETS: readonly DashboardComponentPreset[] = [
  metricPreset("executive-kpi", "经营指标卡", "Executive KPI", "汇总金额并显示业务单位", "value", "business.amount", "amount", "万元", { analysis: { measureField: "amount", aggregation: "sum" } }),
  metricPreset("alarm-kpi", "告警指标卡", "Alarm KPI", "活动告警大数字与超阈值脉冲", "digital-flip", "alarm.count", "count", "条", { conditionalRules: [{ id: "alarm-active", operator: "gt", value: 0, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("target-progress", "目标达成率", "Target progress", "显示计划完成比例与目标差距", "progress", "target.rate", "rate", "%", { min: 0, max: 100 }),
  metricPreset("realtime-flip", "实时翻牌指标", "Realtime output", "用于产量、客流和计数的持续滚动翻牌", "digital-flip", "production.output", "output", "件", { fontSize: 42 }),
  metricPreset("liquid-target", "液位达成率", "Tank level", "表达储罐、水池和库存容量占比", "liquid-fill", "tank.level", "level", "%", { min: 0, max: 100 }),
  metricPreset("device-status", "设备运行状态", "Device status", "布尔在线状态与离线异常高亮", "status", "device.online", "online", "", { conditionalRules: [{ id: "device-offline", operator: "eq", value: false, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("oee-score", "设备综合效率", "OEE score", "综合展示开动率、性能和质量结果", "gauge", "production.oee", "oee", "%", { min: 0, max: 100 }),
  metricPreset("quality-yield", "一次合格率", "First-pass yield", "跟踪首次检验通过的产品比例", "progress", "quality.fpy", "fpy", "%", { min: 0, max: 100 }),
  metricPreset("cycle-time", "平均生产节拍", "Average cycle time", "显示当前工序平均完成时间", "value", "production.cycle", "cycleTime", "s", { analysis: { measureField: "cycleTime", aggregation: "average" } }),
  metricPreset("energy-intensity", "单位产品能耗", "Energy intensity", "按产量归一化展示能源消耗", "value", "energy.intensity", "energyPerUnit", "kWh/件", { analysis: { measureField: "energyPerUnit", aggregation: "average" } }),
  metricPreset("carbon-total", "累计碳排放", "Carbon emissions", "汇总当前统计周期碳排放量", "digital-flip", "carbon.total", "co2e", "tCO₂e", { analysis: { measureField: "co2e", aggregation: "sum" } }),
  metricPreset("inventory-capacity", "库容占用率", "Warehouse capacity", "仓库已用库位与总库位比例", "liquid-fill", "warehouse.capacity", "occupancy", "%", { min: 0, max: 100 }),
  metricPreset("maintenance-health", "设备健康度", "Asset health", "汇总预测维护健康评分", "gauge", "maintenance.health", "health", "%", { min: 0, max: 100 }),
  metricPreset("remaining-life", "预计剩余寿命", "Remaining useful life", "显示关键设备预测剩余使用时间", "value", "maintenance.rul", "rul", "h", { conditionalRules: [{ id: "rul-low", operator: "lt", value: 72, color: "#ff9b73", animation: "pulse" }] }),
  metricPreset("safety-days", "安全运行天数", "Safe operation days", "统计最近一次事故后的连续安全天数", "digital-flip", "safety.days", "days", "天", { fontSize: 40 }),
  metricPreset("environment-risk", "环境风险指数", "Environment risk", "综合温湿度、粉尘和有害气体风险", "gauge", "environment.risk", "risk", "", { min: 0, max: 10, conditionalRules: [{ id: "env-high", operator: "gte", value: 7, color: "#ff8170", animation: "pulse" }] }),
  metricPreset("order-ontime", "订单准交率", "On-time delivery", "按承诺日期统计订单按时交付比例", "progress", "order.ontime", "onTimeRate", "%", { min: 0, max: 100 }),
  metricPreset("line-mode", "产线运行模式", "Line operating mode", "展示自动、手动、维护等当前模式", "status", "line.mode", "mode", "", { conditionalRules: [{ id: "line-maintenance", operator: "eq", value: "维护", color: "#e8bd68" }] }),
] as const;
